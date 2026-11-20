"""Run the base model once per origin and keep its numbers.

Fitting LightGBM is the slow part of a backtest; comparing calibration
settings is arithmetic. So the base model's numbers are computed once per
(base config, data, origins) and stored, and any number of calibration
settings can then be scored from the stored numbers in a second or two.

    run_base(featured, origins, config, workers)  -> BaseRun(recent, future)
        recent: origin, hour_start, actual, base   (last RECENT_DAYS of training)
        future: origin, hour_start, horizon_day, actual, base
    calibrated_predictions(run, calibration, special)
        -> the prediction frame db.backtest.score expects. Calls the same
           fit_calibration / apply_calibration as db.procedure.ForecastProcedure,
           and a test pins that both paths give identical forecasts.
    cached_base_run(featured, origins, config, cache_dir, workers)
        -> run_base, stored as a .npz under data/ (never committed)

The cache file name carries a fingerprint of the data, the feature values
and the origins, so changed data or a changed feature never reuses old
numbers.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from db.atomic import atomic_write
from db.backtest import PREDICTION_COLUMNS, map_origins
from db.calibration import CalibrationConfig, apply_calibration, fit_calibration
from db.features import TARGET
from db.procedure import RECENT_DAYS, BaseConfig, fit_base, predict_base, recent_frame

# Bump when fit_base / recent_frame change what a stored run means.
CACHE_VERSION = 2
RECENT_RUN_COLUMNS = ("origin", "hour_start", "actual", "base")
FUTURE_RUN_COLUMNS = ("origin", "hour_start", "horizon_day", "actual", "base")


@dataclass(frozen=True)
class BaseRun:
    recent: pd.DataFrame
    future: pd.DataFrame


class _BaseTask:
    """Per-origin task: fit the base model, return its recent and future numbers."""

    def __init__(self, config: BaseConfig):
        self.config = config

    def __call__(self, train: pd.DataFrame, future: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
        boosters = fit_base(train, self.config)
        origin = train["hour_start"].max().normalize()
        recent = recent_frame(train, boosters, self.config).assign(origin=origin)
        ahead = pd.DataFrame({
            "origin": origin,
            "hour_start": future["hour_start"].to_numpy(),
            "horizon_day": future["horizon_day"].to_numpy(),
            "actual": future[TARGET].to_numpy(dtype="float64"),
            "base": predict_base(boosters, future, self.config),
        })
        return recent[list(RECENT_RUN_COLUMNS)], ahead


def run_base(featured: pd.DataFrame, origins: list[pd.Timestamp], config: BaseConfig, workers: int = 1) -> BaseRun:
    parts = map_origins(featured, origins, _BaseTask(config), workers)
    return BaseRun(
        recent=pd.concat([recent for recent, _ in parts], ignore_index=True),
        future=pd.concat([ahead for _, ahead in parts], ignore_index=True),
    )


def calibrated_predictions(run: BaseRun, calibration: CalibrationConfig,
                           special: frozenset = frozenset()) -> pd.DataFrame:
    """Apply one calibration setting to every origin of a stored base run."""
    recent_by_origin = {origin: frame for origin, frame in run.recent.groupby("origin")}
    parts = []
    for origin, future in run.future.groupby("origin"):
        factors = fit_calibration(recent_by_origin[origin], calibration, special)
        predicted = apply_calibration(future["hour_start"], future["base"].to_numpy(), factors, origin)
        parts.append(future.assign(predicted=predicted))
    return pd.concat(parts, ignore_index=True)[list(PREDICTION_COLUMNS)]


# =============================================================================
# Storage
# =============================================================================

def save_base_run(run: BaseRun, path: Path) -> None:
    arrays = {f"recent_{column}": run.recent[column].to_numpy() for column in RECENT_RUN_COLUMNS}
    arrays.update({f"future_{column}": run.future[column].to_numpy() for column in FUTURE_RUN_COLUMNS})

    def write(temporary: Path) -> None:
        with open(temporary, "wb") as handle:
            np.savez_compressed(handle, **arrays)

    atomic_write(path, write)


def load_base_run(path: Path) -> BaseRun:
    with np.load(path, allow_pickle=False) as stored:
        recent = pd.DataFrame({column: stored[f"recent_{column}"] for column in RECENT_RUN_COLUMNS})
        future = pd.DataFrame({column: stored[f"future_{column}"] for column in FUTURE_RUN_COLUMNS})
    return BaseRun(recent=recent, future=future)


def fingerprint(featured: pd.DataFrame, origins: list[pd.Timestamp], config: BaseConfig) -> str:
    """Changes whenever any row (hour, target or a feature value), the
    origins, the recent-window length, LightGBM or the stored layout change.
    Every row is hashed, so calls moved between hours with unchanged totals
    are seen."""
    columns = ["hour_start", TARGET, *config.features]
    rows = pd.util.hash_pandas_object(featured[columns], index=False).to_numpy()
    digest = hashlib.sha1(rows.tobytes())
    context = (CACHE_VERSION, RECENT_DAYS, lgb.__version__, [str(pd.Timestamp(origin)) for origin in origins])
    digest.update(repr(context).encode())
    return digest.hexdigest()[:12]


def cached_base_run(featured: pd.DataFrame, origins: list[pd.Timestamp], config: BaseConfig,
                    cache_dir: Path, workers: int = 1) -> BaseRun:
    cache_dir = Path(cache_dir)
    path = cache_dir / f"base_{config.key()}_{fingerprint(featured, origins, config)}.npz"
    if path.exists():
        return load_base_run(path)
    run = run_base(featured, origins, config, workers)
    save_base_run(run, path)
    return run
