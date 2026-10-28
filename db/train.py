"""Train and backtest the hourly call-volume model.

Target    : `offered` per hour, aggregated from `calls`, on an hourly grid
            of every day that has data (quiet hours inside such a day are
            zero calls; days with no calls at all are a reporting gap and
            are left out, never learned as zero).
Model     : LightGBM, objective="poisson" (count data).
Features  : db.features.build_features. Imported, never reimplemented.
Config    : TrainConfig (CLI flags): recency half-life sample weights,
            features to drop, capped recent level correction
            (db.calibration). db.tune compares configs; the chosen one is
            stored in models/metadata.json with its level_factor.

Backtest  : rolling origin over the last HOLDOUT_MONTHS COMPLETE months
            (every day present). Each fold trains on everything before its
            test month with the same config and predicts that whole month
            with no access to it. Data after the last complete month (e.g.
            the partner's Oct 14-20 2026 validation week) is scored
            separately as `recent_period`, trained only on data before it.

Baselines : (a) seasonal naive = median `offered` for the same (dow, hour)
                over the 8 weeks before the test month
            (b) overall mean of the training window

Gate      : if LightGBM does not beat seasonal naive on daily-total MAE
            (pooled over all folds), the script prints STOP and exits 1
            without saving anything.

Run from the repo root:  python -m db.train
Connection comes from $V4W_DATABASE_URL (same pattern as db/load_calls.py).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg
except ImportError:
    sys.exit("psycopg is required:  pip install 'psycopg[binary]'")

from db.calibration import LEVEL_CAP, LEVEL_WINDOW_DAYS, level_factor, recent_window_start  # noqa: E402
from db.features import HOURS_PER_DAY, build_features, load_holidays, load_hourly  # noqa: E402

TARGET = "offered"
NON_FEATURE_COLUMNS = ("hour_start", TARGET)

# Held-out period for the accuracy report: the last 12 complete months.
HOLDOUT_MONTHS = 12
NAIVE_WINDOW_DAYS = 8 * 7

# Fixed. Not tuned: the gate below decides whether this is good enough.
LGBM_PARAMS = {
    "objective": "poisson",
    "learning_rate": 0.03,
    "num_leaves": 28,
    "min_data_in_leaf": 30,
    "feature_fraction": 0.85,
    "seed": 42,
    "verbose": -1,
}
NUM_BOOST_ROUNDS = 500

# Anchored on this file, not the process cwd, so `python -m db.train` and the
# API find the same models/ from any working directory.
REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = REPO_ROOT / "models"
MODEL_PATH = MODEL_DIR / "volume_lgbm.txt"
METADATA_PATH = MODEL_DIR / "metadata.json"

MODEL_NAMES = ("lgbm_poisson", "seasonal_naive", "overall_mean")

# Feature sets the tuning compares (db.tune). Calendar features that let the
# trees memorise a level by date: `month`/`week_of_year` learned "October is
# slow" from Oct 2025 alone, and `days_since_epoch` freezes the last level
# seen because trees cannot extrapolate.
DROPPABLE_FEATURES = ("month", "week_of_year", "days_since_epoch")


@dataclass(frozen=True)
class TrainConfig:
    """How one model is trained. Defaults reproduce the 2026-10-11 model.

    halflife_days : None = every hour weighs the same; else an hour `age`
                    days before the newest training hour weighs
                    0.5 ** (age / halflife_days)
    drop_features : feature columns left out of the model
    calibrate     : multiply the forecast by the capped recent level factor
                    (db.calibration)
    """
    halflife_days: float | None = None
    drop_features: tuple[str, ...] = ()
    calibrate: bool = False

    def __post_init__(self):
        if self.halflife_days is not None and self.halflife_days <= 0:
            raise ValueError(f"halflife_days must be > 0, got {self.halflife_days}")
        unknown = [f for f in self.drop_features if f not in DROPPABLE_FEATURES]
        if unknown:
            raise ValueError(f"cannot drop {unknown}; droppable: {DROPPABLE_FEATURES}")

    def label(self) -> str:
        half = "equal" if self.halflife_days is None else f"half{int(self.halflife_days)}d"
        drop = "all-features" if not self.drop_features else "no-" + "-".join(self.drop_features)
        return f"{half} {drop}{' +level' if self.calibrate else ''}"


# =============================================================================
# Data
# =============================================================================

def complete_hourly_grid(hourly: pd.DataFrame) -> pd.DataFrame:
    """All 24 hours of every day that has at least one call, with
    `offered` = 0 where no call started in that hour.

    A day with no calls at all is MISSING data, not a quiet day: the line is
    24/7 and has never had a zero-call day. Such days (e.g. Sep 1 - Oct 13
    2026, not yet reported by the partner) are left out, so a reporting gap
    is never learned as silence."""
    # Only expand dates that appear in the source. A date absent altogether
    # represents a reporting gap, not evidence that the line received zero calls.
    days = np.sort(hourly["hour_start"].dt.normalize().unique())
    offsets = pd.to_timedelta(np.arange(HOURS_PER_DAY), unit="h")
    grid = pd.DatetimeIndex(
        pd.DatetimeIndex(np.repeat(days, HOURS_PER_DAY)) + np.tile(offsets, len(days)),
        name="hour_start",
    )

    offered = (
        hourly.set_index("hour_start")[TARGET]
        .reindex(grid, fill_value=0)
        .astype("int64")
    )
    return pd.DataFrame({"hour_start": grid, TARGET: offered.to_numpy()})


def feature_columns(featured: pd.DataFrame, drop: tuple[str, ...] = ()) -> list[str]:
    return [c for c in featured.columns if c not in NON_FEATURE_COLUMNS and c not in drop]


def complete_months(hour_start: pd.Series) -> pd.DatetimeIndex:
    """Month starts of every month in which EVERY calendar day has data."""
    days = pd.Series(hour_start.dt.normalize().unique())
    # Since `days` contains unique dates, a month is complete when its distinct
    # date count matches the actual number of calendar days in that month.
    per_month = days.groupby(days.dt.to_period("M")).size()
    full = [p for p, n in per_month.items() if n == p.days_in_month]
    return pd.DatetimeIndex([p.to_timestamp() for p in sorted(full)])


def backtest_months(hour_start: pd.Series, holdout_months: int = HOLDOUT_MONTHS) -> pd.DatetimeIndex:
    """Month starts of the last `holdout_months` COMPLETE months in the data.

    A month counts as complete only if every one of its days has data, so a
    trailing partial month or a month inside a reporting gap is never a
    test month.
    """
    if holdout_months < 1:
        raise ValueError(f"holdout_months must be >= 1, got {holdout_months}")
    months = complete_months(hour_start)[-holdout_months:]
    if len(months) < holdout_months:
        raise ValueError(f"only {len(months)} complete months of data; need {holdout_months}")
    if hour_start.min().normalize() >= months[0]:
        raise ValueError(
            f"data starts {hour_start.min().date()}, inside the hold-out "
            f"window from {months[0].date()}; nothing left to train on"
        )
    return months


def recent_period(hour_start: pd.Series) -> tuple[pd.Timestamp, pd.Timestamp] | None:
    """(first, last) day of data AFTER the last complete month, e.g. a
    partner validation week. None when the data ends on a month end."""
    last_month = complete_months(hour_start)[-1]
    after = hour_start[hour_start >= last_month + pd.offsets.MonthBegin(1)]
    if after.empty:
        return None
    return after.min().normalize(), after.max().normalize()


# =============================================================================
# Models
# =============================================================================

def recency_weights(hour_start: pd.Series, halflife_days: float | None) -> np.ndarray | None:
    """0.5 ** (age_days / halflife) with age measured back from the newest
    hour. None (no weighting) when halflife_days is None."""
    if halflife_days is None:
        return None
    # Measure age relative to this training fold's newest observation, not
    # today's date, so historical folds remain reproducible and leakage-free.
    age_days = (hour_start.max() - hour_start).dt.total_seconds().to_numpy() / 86_400
    return np.power(0.5, age_days / halflife_days)


def fit_lgbm(train: pd.DataFrame, features: list[str], halflife_days: float | None = None) -> lgb.Booster:
    # LightGBM receives only the selected feature columns and the hourly call
    # target; optional recency weights are aligned row-for-row with that data.
    dataset = lgb.Dataset(train[features], label=train[TARGET],
                          weight=recency_weights(train["hour_start"], halflife_days))
    return lgb.train(LGBM_PARAMS, dataset, num_boost_round=NUM_BOOST_ROUNDS)


def fit_level_factor(train: pd.DataFrame, features: list[str], config: TrainConfig) -> float:
    """Out-of-sample recent level gap (db.calibration): fit on hours before
    the last LEVEL_WINDOW_DAYS data days, predict those days, compare.
    1.0 when the config does not calibrate."""
    if not config.calibrate:
        return 1.0
    # Estimate the correction on a tail window excluded from this calibration
    # fit, then apply it to a separately fitted final model.
    window_start = recent_window_start(train["hour_start"])
    before = train[train["hour_start"] < window_start]
    window = train[train["hour_start"] >= window_start]
    booster = fit_lgbm(before, features, config.halflife_days)
    return level_factor(window[TARGET].to_numpy(), predict_lgbm(booster, window, features))


def fit_and_predict(train: pd.DataFrame, test: pd.DataFrame, config: TrainConfig) -> np.ndarray:
    """The full procedure for one config: weighted fit, then level factor."""
    features = feature_columns(train, config.drop_features)
    booster = fit_lgbm(train, features, config.halflife_days)
    return predict_lgbm(booster, test, features) * fit_level_factor(train, features, config)


def predict_lgbm(booster: lgb.Booster, test: pd.DataFrame, features: list[str]) -> np.ndarray:
    return booster.predict(test[features])


def predict_seasonal_naive(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    """Median `offered` per (dow, hour) over the trailing 8 weeks of train."""
    # The trailing window ends immediately before the test period, preserving
    # the same information boundary as the machine-learning model.
    window_start = test["hour_start"].min() - pd.Timedelta(days=NAIVE_WINDOW_DAYS)
    window = train[train["hour_start"] >= window_start]
    medians = window.groupby(["dow", "hour"])[TARGET].median()

    keys = pd.MultiIndex.from_frame(test[["dow", "hour"]])
    predicted = medians.reindex(keys).to_numpy()
    if np.isnan(predicted).any():
        raise ValueError("seasonal naive: some (dow, hour) cells have no trailing history")
    return predicted


def predict_overall_mean(train: pd.DataFrame, test: pd.DataFrame) -> np.ndarray:
    return np.full(len(test), train[TARGET].mean())


# =============================================================================
# Scoring
# =============================================================================

def score(hour_start: pd.Series, actual: np.ndarray, predicted: np.ndarray) -> dict:
    """MAE, RMSE, MAPE (hours with offered > 0), daily-total MAE."""
    error = predicted - actual
    # MAPE is undefined for zero-call hours; retain all hours in MAE/RMSE and
    # daily totals, but use only positive actuals for percentage error.
    positive = actual > 0

    daily = (
        pd.DataFrame({"day": hour_start.dt.normalize().to_numpy(),
                      "actual": actual, "predicted": predicted})
        .groupby("day")[["actual", "predicted"]].sum()
    )

    return {
        "mae": float(np.mean(np.abs(error))),
        "rmse": float(np.sqrt(np.mean(error ** 2))),
        "mape_pct": float(np.mean(np.abs(error[positive]) / actual[positive]) * 100),
        "daily_mae": float(np.mean(np.abs(daily["predicted"] - daily["actual"]))),
    }


# =============================================================================
# Backtest
# =============================================================================

def split_fold(featured: pd.DataFrame, month_start: pd.Timestamp):
    # Each fold is a strict forward-in-time split: no row from the test month
    # is allowed to contribute to training or feature-derived fit parameters.
    month_end = month_start + pd.offsets.MonthBegin(1)
    is_test = (featured["hour_start"] >= month_start) & (featured["hour_start"] < month_end)
    train = featured[featured["hour_start"] < month_start]
    test = featured[is_test]
    if train.empty or test.empty:
        raise ValueError(f"fold {month_start:%Y-%m}: empty train or test window")
    return train, test


def predict_fold(train: pd.DataFrame, test: pd.DataFrame, config: TrainConfig) -> dict[str, np.ndarray]:
    return {
        "lgbm_poisson": fit_and_predict(train, test, config),
        "seasonal_naive": predict_seasonal_naive(train, test),
        "overall_mean": predict_overall_mean(train, test),
    }


def score_recent(featured: pd.DataFrame, config: TrainConfig) -> dict | None:
    """Score the data after the last complete month (e.g. the partner's
    Oct 14-20 2026 validation week): train on everything before it with the
    same procedure, predict it, report the hourly metrics plus the daily
    accuracy the partner quotes (100 - mean daily absolute % error) and the
    week-total bias. None when there is no such period."""
    period = recent_period(featured["hour_start"])
    if period is None:
        return None
    first, last = period
    train = featured[featured["hour_start"] < first]
    test = featured[featured["hour_start"] >= first]
    predicted = fit_and_predict(train, test, config)
    actual = test[TARGET].to_numpy()
    daily = (pd.DataFrame({"day": test["hour_start"].dt.normalize().to_numpy(),
                           "actual": actual, "predicted": predicted})
             .groupby("day")[["actual", "predicted"]].sum())
    # The partner-facing daily accuracy is computed on daily totals, not by
    # averaging hourly percentages, so high-volume and quiet days each count once.
    daily_ape = (daily["predicted"] - daily["actual"]).abs() / daily["actual"]
    return {
        "first_day": str(first.date()),
        "last_day": str(last.date()),
        **score(test["hour_start"], actual, predicted),
        "daily_accuracy_pct": float(100 - daily_ape.mean() * 100),
        "week_bias_pct": float((daily["predicted"].sum() - daily["actual"].sum()) / daily["actual"].sum() * 100),
    }


def run_backtest(featured: pd.DataFrame, config: TrainConfig, months: pd.DatetimeIndex):
    """Returns (per_fold DataFrame, overall DataFrame). Overall metrics are
    pooled over every test hour of every fold, not averaged across folds."""
    fold_rows = []
    pooled = {name: [] for name in MODEL_NAMES}
    pooled_hours = []
    pooled_actual = []

    # Accumulate predictions across all folds before computing overall scores;
    # this weights each held-out hour equally instead of each month equally.
    for month_start in months:
        train, test = split_fold(featured, month_start)
        predictions = predict_fold(train, test, config)
        actual = test[TARGET].to_numpy()

        for name in MODEL_NAMES:
            metrics = score(test["hour_start"], actual, predictions[name])
            fold_rows.append({"fold": f"{month_start:%Y-%m}", "model": name, **metrics})
            pooled[name].append(predictions[name])
        pooled_hours.append(test["hour_start"])
        pooled_actual.append(actual)
        print(f"fold {month_start:%Y-%m}  train={len(train):,}  test={len(test):,}", file=sys.stderr)

    hours = pd.concat(pooled_hours, ignore_index=True)
    actual = np.concatenate(pooled_actual)
    overall_rows = [
        {"model": name, **score(hours, actual, np.concatenate(pooled[name]))}
        for name in MODEL_NAMES
    ]
    return pd.DataFrame(fold_rows), pd.DataFrame(overall_rows)


# =============================================================================
# Reporting
# =============================================================================

def markdown_table(df: pd.DataFrame) -> str:
    header = "| " + " | ".join(df.columns) + " |"
    rule = "|" + "|".join("---" for _ in df.columns) + "|"
    body = []
    for row in df.itertuples(index=False):
        cells = [f"{v:.3f}" if isinstance(v, float) else str(v) for v in row]
        body.append("| " + " | ".join(cells) + " |")
    return "\n".join([header, rule, *body])


def passes_gate(overall: pd.DataFrame) -> bool:
    # The model is persisted only if it beats the simple seasonal baseline on
    # the pre-agreed daily-total error metric.
    by_model = overall.set_index("model")["daily_mae"]
    return by_model["lgbm_poisson"] < by_model["seasonal_naive"]


# =============================================================================
# Persistence
# =============================================================================

def save_model(booster: lgb.Booster, featured: pd.DataFrame, features: list[str], config: TrainConfig,
               factor: float, per_fold: pd.DataFrame, overall: pd.DataFrame,
               months: pd.DatetimeIndex, recent: dict | None) -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    # Save the model and its exact inference contract together: forecast code
    # reads the feature order, training epoch, calibration and backtest report.
    booster.save_model(str(MODEL_PATH))

    metadata = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target": TARGET,
        "train_start": featured["hour_start"].min().isoformat(),
        "train_end": featured["hour_start"].max().isoformat(),
        "train_rows": int(len(featured)),
        "features": features,
        "lgbm_params": LGBM_PARAMS,
        "num_boost_rounds": NUM_BOOST_ROUNDS,
        "config": {**asdict(config), "drop_features": list(config.drop_features), "label": config.label()},
        # db.forecast multiplies every predicted hour by this (1.0 = off).
        "level_factor": factor,
        "level_window_days": LEVEL_WINDOW_DAYS,
        "level_cap": LEVEL_CAP,
        "backtest": {
            "holdout_months": int(len(months)),
            "first_test_month": months[0].strftime("%Y-%m-%d"),
            "last_test_month": months[-1].strftime("%Y-%m-%d"),
            "overall": overall.to_dict(orient="records"),
            "per_fold": per_fold.to_dict(orient="records"),
        },
        "recent_period": recent,
    }
    METADATA_PATH.write_text(json.dumps(metadata, indent=2))


# =============================================================================
# CLI
# =============================================================================

def load_featured(dsn: str) -> pd.DataFrame:
    """Hourly grid (days with data only) with every feature column."""
    with psycopg.connect(dsn) as conn:
        hourly = load_hourly(conn)
        holidays = load_holidays(conn)
    grid = complete_hourly_grid(hourly)
    print(f"grid rows {len(grid):,}  (hours with calls {len(hourly):,}, "
          f"zero-filled {len(grid) - len(hourly):,}, days {len(grid) // HOURS_PER_DAY:,})")
    return build_features(grid, holidays)


def parse_config(argv: list[str] | None = None) -> TrainConfig:
    parser = argparse.ArgumentParser(description="Train and backtest the hourly volume model.")
    parser.add_argument("--halflife", type=float, default=None,
                        help="recency half-life in days (default: equal weights)")
    parser.add_argument("--drop", default="",
                        help=f"comma-separated features to leave out, from {','.join(DROPPABLE_FEATURES)}")
    parser.add_argument("--calibrate", action="store_true", help="apply the capped recent level factor")
    args = parser.parse_args(argv)
    drop = tuple(f for f in args.drop.split(",") if f)
    return TrainConfig(halflife_days=args.halflife, drop_features=drop, calibrate=args.calibrate)


def main(argv: list[str] | None = None) -> int:
    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        sys.exit("no connection string. set V4W_DATABASE_URL")
    config = parse_config(argv)
    print(f"config: {config.label()}")

    featured = load_featured(dsn)
    features = feature_columns(featured, config.drop_features)
    months = backtest_months(featured["hour_start"])
    print(f"hold-out: {len(months)} months, {months[0]:%Y-%m} to {months[-1]:%Y-%m}")

    per_fold, overall = run_backtest(featured, config, months)
    print("\n## Per fold\n")
    print(markdown_table(per_fold))
    print("\n## Overall (pooled over all test hours)\n")
    print(markdown_table(overall))

    recent = score_recent(featured, config)
    if recent:
        print(f"\n## Recent period {recent['first_day']} to {recent['last_day']} (trained only on data before it)\n")
        print(json.dumps(recent, indent=2))

    if not passes_gate(overall):
        print("\nSTOP: LightGBM did not beat seasonal naive on daily-total MAE. "
              "Nothing saved.")
        return 1

    booster = fit_lgbm(featured, features, config.halflife_days)
    factor = fit_level_factor(featured, features, config)
    print(f"\nlevel factor applied to forecasts: {factor:.4f}")
    save_model(booster, featured, features, config, factor, per_fold, overall, months, recent)
    print(f"saved {MODEL_PATH} and {METADATA_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())


# This module owns the full training lifecycle: loading and completing the
# hourly target, constructing shared features, fitting LightGBM candidates,
# evaluating forward-in-time monthly folds, scoring the recent validation
# period, applying the baseline gate, and persisting the accepted artifacts.
# Training configuration and scoring definitions live here to keep one
# authoritative implementation of the deployed procedure.
#
# db.tune reuses the configuration, fold, metric and fitting helpers to compare
# candidate settings without introducing a second training implementation.
# A passing model is saved with metadata describing its feature order, epoch,
# parameters, calibration and backtest results; db.forecast consumes those
# artifacts, and db.staffing plus api.main turn its hourly calls and AHT into
# the staffing outputs presented by the application.
