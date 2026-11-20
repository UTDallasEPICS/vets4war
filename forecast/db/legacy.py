"""The Oct 28 2026 model as a backtest procedure.

This is the model that was live when the 2026-11 final run started (branch
testing-rounds, commit 70aa13f): nine calendar features, LightGBM Poisson
with a 730-day recency half-life, and one level factor measured on the last
7 days with a second, earlier fit and capped at 15%. It is kept, unchanged,
so that every later change can be scored against it on the same folds and
the baseline numbers in docs/final-run/ledger.json stay reproducible:

    LegacyProcedure()(train, future) -> forecast

The feature list and every setting are fixed here on purpose: this file is
a reference point, not something to tune. It runs single-threaded so the
same data always gives the same numbers.
"""

from __future__ import annotations

import lightgbm as lgb
import numpy as np
import pandas as pd

from db.calibration import level_factor, recent_window_start
from db.features import TARGET
from db.procedure import recency_weights

LEGACY_FEATURES = ("dow", "hour", "hour_sin", "hour_cos", "dow_sin", "dow_cos",
                   "is_weekend", "is_holiday", "days_to_nearest_holiday")
LEGACY_HALFLIFE_DAYS = 730.0
LEGACY_BOOST_ROUNDS = 500
LEGACY_LGBM_PARAMS = {
    "objective": "poisson",
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_data_in_leaf": 20,
    "feature_fraction": 0.9,
    "seed": 42,
    "verbose": -1,
    "num_threads": 1,
}


def _fit(train: pd.DataFrame) -> lgb.Booster:
    dataset = lgb.Dataset(train[list(LEGACY_FEATURES)], label=train[TARGET],
                          weight=recency_weights(train["hour_start"], LEGACY_HALFLIFE_DAYS))
    return lgb.train(LEGACY_LGBM_PARAMS, dataset, num_boost_round=LEGACY_BOOST_ROUNDS)


def _level_factor(train: pd.DataFrame) -> float:
    """Out-of-sample level gap of the last 7 data days: fit on the hours
    before them, predict them, compare (db.calibration.level_factor)."""
    window_start = recent_window_start(train["hour_start"])
    before = train[train["hour_start"] < window_start]
    window = train[train["hour_start"] >= window_start]
    predicted = _fit(before).predict(window[list(LEGACY_FEATURES)])
    return level_factor(window[TARGET].to_numpy(), predicted)


class LegacyProcedure:
    """Picklable (train, future) -> forecast, for db.backtest.run_origins."""

    def __call__(self, train: pd.DataFrame, future: pd.DataFrame) -> np.ndarray:
        return _fit(train).predict(future[list(LEGACY_FEATURES)]) * _level_factor(train)
