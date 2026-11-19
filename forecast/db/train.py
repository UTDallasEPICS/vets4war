"""Fit, gate and describe the hourly call-volume model.

    python -m db.train ...   another name for python -m db.retrain (same flags)

Target    : `offered` per hour, on an hourly grid of every day that has data
            (quiet hours inside such a day are zero calls; days with no calls
            at all are a reporting gap and are left out, never learned as zero).
Procedure : db.procedure.PRODUCTION, the configuration the 2026-11 final run
            ended on (docs/final-run/REPORT.md): a LightGBM base profile on
            calendar features, then a level and an hour-of-day shape measured
            on the most recent weeks (db.calibration).

Gate      : before a model is used, the procedure is backtested on the last
            GATE_ORIGINS weekly origins (db.backtest: train up to a day,
            forecast the next 28 with no access to them) next to the seasonal
            naive baseline. It must beat the baseline on daily error at 1 to
            14 days (passes_gate).

db.retrain runs these steps on the web app's database and stores the model
there. save_model and the models/ paths remain for the tests and the
research tools (db.tune).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from db.atomic import atomic_write
from db.backtest import DAYS_PER_WEEK, HORIZON_DAYS, run_origins, score, weekly_origins
from db.calibration import CalibrationFactors, fit_calibration
from db.dataset import missing_days
from db.diagnostics import SeasonalNaive
from db.features import HOURS_PER_DAY, TARGET, build_features
from db.procedure import (
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
    from db.retrain import main as retrain_main  # db.retrain imports this module
    return retrain_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
