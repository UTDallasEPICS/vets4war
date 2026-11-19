"""Train the hourly call-volume model and save it.

    python -m db.train                                 database only
    python -m db.train --supplement a.xlsx b.xlsx      plus client call-record files
                                                       for days the database lacks

Target    : `offered` per hour, on an hourly grid of every day that has data
            (quiet hours inside such a day are zero calls; days with no calls
            at all are a reporting gap and are left out, never learned as zero).
Procedure : db.procedure.PRODUCTION, the configuration the 2026-11 final run
            ended on (docs/final-run/REPORT.md): a LightGBM base profile on
            calendar features, then a level and an hour-of-day shape measured
            on the most recent weeks (db.calibration).
Data      : db.dataset.load_dataset. The database is only read.

Gate      : before anything is saved, the procedure is backtested on the last
            GATE_ORIGINS weekly origins (db.backtest: train up to a day,
            forecast the next 28 with no access to them) next to the seasonal
            naive baseline. If the model does not beat the baseline on daily
            error at 1 to 14 days, the script prints STOP and exits 1 without
            saving.

Output    : models/volume_lgbm.txt and models/metadata.json (features, the
            procedure, the calibration factors db.forecast applies, where the
            data came from, the gate result).

Connection comes from $V4W_DATABASE_URL.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

from db.atomic import atomic_write  # noqa: E402
from db.backtest import DAYS_PER_WEEK, HORIZON_DAYS, run_origins, score, weekly_origins  # noqa: E402
from db.calibration import CalibrationFactors, fit_calibration  # noqa: E402
from db.dataset import load_dataset, missing_days  # noqa: E402
from db.diagnostics import SeasonalNaive  # noqa: E402
from db.features import HOURS_PER_DAY, TARGET, build_features  # noqa: E402
from db.procedure import (  # noqa: E402
    PRODUCTION,
    RECENT_DAYS,
    ForecastProcedure,
    ProcedureConfig,
    fit_base,
    recent_frame,
    special_days,
)

# Anchored on this file, not the process cwd, so `python -m db.train` and the
# API find the same models/ from any working directory.
REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = REPO_ROOT / "models"
MODEL_PATH = MODEL_DIR / "volume_lgbm.txt"
METADATA_PATH = MODEL_DIR / "metadata.json"

GATE_ORIGINS = 26
GATE_WORKERS = 8
# Days of recent data the gate touches: its origins, their 28-day horizon and
# the recent history each origin's calibration reads.
GATE_SPAN_DAYS = GATE_ORIGINS * DAYS_PER_WEEK + HORIZON_DAYS + RECENT_DAYS
GATE_METRIC = "daily_mape_1_14"
GATE_REPORTED = ("daily_mape_1_14", "daily_mape_15_28", "hourly_mae_1_14", "block_wape_1_14",
                 "week_acc_mean", "week_acc_std", "week_acc_min", "week_total_ape")
MODEL_LABEL = "final run 2026-11: level half-life 10 d, bursts clipped (training and level), hour-of-day shape, holiday eves"


@dataclass(frozen=True)
class TrainedModel:
    booster: lgb.Booster
    factors: CalibrationFactors
    features: tuple[str, ...]
    train_start: pd.Timestamp
    train_end: pd.Timestamp
    train_rows: int


# =============================================================================
# Data
# =============================================================================

def complete_hourly_grid(hourly: pd.DataFrame) -> pd.DataFrame:
    """All 24 hours of every day that has at least one call, with
    `offered` = 0 where no call started in that hour.

    A day with no calls at all is MISSING data, not a quiet day: the line is
    24/7 and has never had a zero-call day. Such days are left out, so a
    reporting gap is never learned as silence."""
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


def recent_gaps(hourly: pd.DataFrame, span_days: int) -> pd.DatetimeIndex:
    """Days with no calls at all inside the last `span_days` days of the
    data. The weekly backtest gate cannot run across such a gap."""
    gaps = missing_days(hourly)
    cutoff = hourly["hour_start"].max().normalize() - pd.Timedelta(days=span_days)
    return gaps[gaps > cutoff]


def featured_frame(hourly: pd.DataFrame, holidays: pd.DataFrame) -> pd.DataFrame:
    """Hourly grid (days with data only) with every feature column."""
    return build_features(complete_hourly_grid(hourly), holidays)


# =============================================================================
# Fit
# =============================================================================

def fit_model(featured: pd.DataFrame, holidays: pd.DataFrame, config: ProcedureConfig) -> TrainedModel:
    """Fit the base model on every row, then measure the level and shape on
    the most recent weeks."""
    if len(config.base.seeds) != 1:
        raise ValueError(f"the model file holds one booster; the config must have one seed, got {config.base.seeds}")
    boosters = fit_base(featured, config.base)
    recent = recent_frame(featured, boosters, config.base)
    factors = fit_calibration(recent, config.calibration, special_days(holidays, featured["hour_start"]))
    return TrainedModel(
        booster=boosters[0],
        factors=factors,
        features=config.base.features,
        train_start=featured["hour_start"].min(),
        train_end=featured["hour_start"].max(),
        train_rows=len(featured),
    )


# =============================================================================
# Gate
# =============================================================================

def passes_gate(model_metrics: dict, naive_metrics: dict) -> bool:
    return model_metrics[GATE_METRIC] < naive_metrics[GATE_METRIC]


def gate(featured: pd.DataFrame, holidays: pd.DataFrame, config: ProcedureConfig,
         n_origins: int = GATE_ORIGINS, workers: int = GATE_WORKERS) -> dict:
    """Backtest the procedure and the seasonal naive baseline on the last
    `n_origins` weekly origins."""
    days = pd.DatetimeIndex(featured["hour_start"].dt.normalize().unique())
    origins = weekly_origins(days, n_origins)
    procedure = ForecastProcedure(config, special_days(holidays, featured["hour_start"]))
    model = score(run_origins(featured, origins, procedure, workers))
    naive = score(run_origins(featured, origins, SeasonalNaive(), workers=1))
    return {
        "origins": len(origins),
        "first_origin": str(origins[0].date()),
        "last_origin": str(origins[-1].date()),
        "model": {name: model[name] for name in GATE_REPORTED},
        "naive": {name: naive[name] for name in GATE_REPORTED},
        "passed": passes_gate(model, naive),
    }


# =============================================================================
# Persistence
# =============================================================================

def build_metadata(model: TrainedModel, config: ProcedureConfig, sources: tuple[dict, ...], gate_result: dict) -> dict:
    """Everything db.forecast needs to serve the model and a reader needs to
    audit it. JSON-ready."""
    return {
        "created_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "target": TARGET,
        "train_start": model.train_start.isoformat(),
        "train_end": model.train_end.isoformat(),
        "train_rows": int(model.train_rows),
        "features": list(model.features),
        "lgbm_params": config.base.lgbm_params(config.base.seeds[0]),
        "num_boost_rounds": config.base.num_boost_round,
        "config": {"label": MODEL_LABEL},
        "procedure": config.to_dict(),
        # db.forecast multiplies every predicted hour by level x shape[weekday][hour].
        "calibration": model.factors.to_dict(),
        "level_factor": model.factors.level,
        "data_sources": list(sources),
        "gate": gate_result,
    }


def save_model(model: TrainedModel, metadata: dict, model_path: Path = MODEL_PATH,
               metadata_path: Path = METADATA_PATH) -> None:
    """Write the metadata, then the model, each replaced whole. The server
    reloads when the MODEL file changes, so by then its metadata is already
    in place; `model_sha256` lets db.forecast refuse a model and metadata
    from two different runs."""
    text = model.booster.model_to_string()
    stamped = {**metadata, "model_sha256": hashlib.sha256(text.encode()).hexdigest()}
    atomic_write(metadata_path, lambda temporary: temporary.write_text(json.dumps(stamped, indent=2)))
    atomic_write(model_path, lambda temporary: temporary.write_text(text))


# =============================================================================
# CLI
# =============================================================================

def _print_gate(result: dict) -> None:
    print(f"\n## Gate: last {result['origins']} weekly origins, {result['first_origin']} to {result['last_origin']}\n")
    print(f"{'metric':18s} {'model':>9s} {'naive':>9s}")
    for name in GATE_REPORTED:
        print(f"{name:18s} {result['model'][name]:9.3f} {result['naive'][name]:9.3f}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train, gate and save the hourly volume model.")
    parser.add_argument("--supplement", nargs="*", type=Path, default=[],
                        help="client call-record workbooks for days the database lacks")
    args = parser.parse_args(argv)

    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        sys.exit("no connection string. set V4W_DATABASE_URL")
    absent = [str(path) for path in args.supplement if not path.exists()]
    if absent:
        sys.exit(f"file not found: {absent}")

    dataset = load_dataset(dsn, args.supplement)
    print(json.dumps(list(dataset.sources), indent=2))
    gaps = recent_gaps(dataset.hourly, GATE_SPAN_DAYS)
    if len(gaps):
        sys.exit(f"{len(gaps)} recent day(s) have no calls at all ({gaps[0].date()} to {gaps[-1].date()}): "
                 f"that is unreported data, and the backtest gate cannot run across it. Load those days "
                 f"into the database, or pass the client's files with --supplement.")
    featured = featured_frame(dataset.hourly, dataset.holidays)
    print(f"grid rows {len(featured):,}  days {len(featured) // HOURS_PER_DAY:,}  "
          f"{featured['hour_start'].min().date()} to {featured['hour_start'].max().date()}")

    result = gate(featured, dataset.holidays, PRODUCTION)
    _print_gate(result)
    if not result["passed"]:
        print("\nSTOP: the model did not beat seasonal naive on daily error. Nothing saved.")
        return 1

    model = fit_model(featured, dataset.holidays, PRODUCTION)
    save_model(model, build_metadata(model, PRODUCTION, dataset.sources, result))
    print(f"\nlevel factor {model.factors.level:.4f}")
    print("hour-of-day factors:", " ".join(f"{value:.2f}" for value in model.factors.hour))
    print(f"saved {MODEL_PATH} and {METADATA_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
