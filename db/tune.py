"""Compare training configs on the same backtest and pick the best one.

Grid (db.train.TrainConfig):
    recency half-life : equal, 730, 365, 180 days
    feature set       : all, without days_since_epoch, without all three
                        level-memorising calendar features
    level correction  : off, on (db.calibration, capped)

Every config runs the full procedure inside every fold: the 12 complete
hold-out months, plus the recent period after the last complete month (the
partner's Oct 14-20 2026 week). Selection rule, fixed BEFORE looking at the
results: lowest pooled daily-total MAE over the 12 months. The recent week
is one week, so it is reported, not used to choose.

Run from the repo root:  python -m db.tune
Prints a table and the exact `python -m db.train ...` command for the winner.
Writes nothing.
"""

from __future__ import annotations

import itertools
import os
import sys

import pandas as pd

from db.train import (
    DROPPABLE_FEATURES,
    TrainConfig,
    backtest_months,
    load_featured,
    markdown_table,
    run_backtest,
    score_recent,
)

HALFLIVES = (None, 730.0, 365.0, 180.0)
FEATURE_SETS = ((), ("days_since_epoch",), DROPPABLE_FEATURES)
CALIBRATE = (False, True)


def grid() -> list[TrainConfig]:
    return [TrainConfig(halflife_days=h, drop_features=d, calibrate=c)
            for h, d, c in itertools.product(HALFLIVES, FEATURE_SETS, CALIBRATE)]


def evaluate(featured: pd.DataFrame, config: TrainConfig, months: pd.DatetimeIndex) -> dict:
    _, overall = run_backtest(featured, config, months)
    by_model = overall.set_index("model")
    lgbm = by_model.loc["lgbm_poisson"]
    recent = score_recent(featured, config) or {}
    return {
        "config": config.label(),
        "daily_mae_12mo": lgbm["daily_mae"],
        "hourly_mae_12mo": lgbm["mae"],
        "naive_daily_mae": by_model.loc["seasonal_naive", "daily_mae"],
        "recent_daily_acc_pct": recent.get("daily_accuracy_pct"),
        "recent_week_bias_pct": recent.get("week_bias_pct"),
    }


def train_command(config: TrainConfig) -> str:
    parts = ["python -m db.train"]
    if config.halflife_days is not None:
        parts.append(f"--halflife {int(config.halflife_days)}")
    if config.drop_features:
        parts.append("--drop " + ",".join(config.drop_features))
    if config.calibrate:
        parts.append("--calibrate")
    return " ".join(parts)


def main() -> int:
    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        sys.exit("no connection string. set V4W_DATABASE_URL")
    featured = load_featured(dsn)
    months = backtest_months(featured["hour_start"])
    configs = grid()
    rows = []
    for i, config in enumerate(configs, 1):
        print(f"[{i}/{len(configs)}] {config.label()}", file=sys.stderr, flush=True)
        rows.append({**evaluate(featured, config, months), "_config": config})

    table = pd.DataFrame(rows).sort_values("daily_mae_12mo").reset_index(drop=True)
    print(f"\n## Configs, best first (12 months {months[0]:%Y-%m} to {months[-1]:%Y-%m} + recent week)\n")
    print(markdown_table(table.drop(columns="_config")))
    best = table.iloc[0]["_config"]
    print(f"\nwinner: {best.label()}\ntrain it with:  {train_command(best)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
