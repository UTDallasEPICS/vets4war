"""The forecasting procedure: a LightGBM base profile plus recent-data calibration.

    BaseConfig         how the base model is fitted (features, memory, trees)
    ProcedureConfig    BaseConfig + db.calibration.CalibrationConfig
    fit_base(train, config)                 -> boosters (one per seed)
    predict_base(boosters, frame, config)   -> base forecast, mean over seeds
    recent_frame(train, boosters, config)   -> last weeks: hour_start, actual, base
    special_days(holidays, hour_start)      -> holiday-type days as a frozenset
    ForecastProcedure(config, special)      -> callable (train, future) -> forecast

One procedure, three users: db.backtest scores it, db.train fits it on all
the data and saves it, db.forecast serves what was saved. The base model
sees only calendar features, so it cannot memorise individual days; its
numbers for the recent weeks are therefore a fair statement of "what the
profile expects", which is what db.calibration compares with reality.

LightGBM runs single-threaded and deterministic here, so the same data and
config always give the same model, on any machine and inside worker
processes.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass

import lightgbm as lgb
import numpy as np
import pandas as pd

from db.calibration import CalibrationConfig, apply_calibration, clip_bursts, fit_calibration
from db.features import TARGET
from db.holiday_calendar import holiday_type_days

# Days of training history handed to the calibration (20 weeks): the longest
# window the calibration may look back over.
RECENT_DAYS = 140
DAYS_PER_YEAR = 365.25

LGBM_FIXED = {
    "objective": "poisson",
    "verbose": -1,
    "num_threads": 1,
    "deterministic": True,
    "force_row_wise": True,
}
TUPLE_FIELDS = ("features", "categorical", "seeds")


@dataclass(frozen=True)
class BaseConfig:
    """How the base model is fitted.

    features      : feature columns (must exist in the frame)
    halflife_days : an hour `age` days before the newest training hour
                    weighs 0.5 ** (age / halflife); None = equal weights
    train_years   : use only the last N years of training rows; None = all
    categorical   : features LightGBM treats as categories, not numbers
    seeds         : one model per seed; the forecast is their average
    target_clip_z : fit once, then refit with every hour's count clipped at
                    what that first fit expects plus z burst-deviations
                    (db.calibration.clip_bursts); None = train on raw counts
    recent_out_of_sample : the base model's numbers for the recent weeks come
                    from a second model fitted only on the hours BEFORE those
                    weeks, instead of from the model that has seen them
    The rest are LightGBM's own knobs.
    """
    features: tuple[str, ...]
    halflife_days: float | None = 730.0
    train_years: float | None = None
    learning_rate: float = 0.05
    num_leaves: int = 31
    min_data_in_leaf: int = 20
    feature_fraction: float = 0.9
    lambda_l2: float = 0.0
    num_boost_round: int = 500
    categorical: tuple[str, ...] = ()
    seeds: tuple[int, ...] = (42,)
    target_clip_z: float | None = None
    recent_out_of_sample: bool = False

    def __post_init__(self):
        if not self.features:
            raise ValueError("features must not be empty")
        if not self.seeds:
            raise ValueError("seeds must not be empty")
        if self.num_boost_round < 1:
            raise ValueError(f"num_boost_round must be >= 1, got {self.num_boost_round}")
        for name in ("halflife_days", "train_years", "target_clip_z"):
            value = getattr(self, name)
            if value is not None and value <= 0:
                raise ValueError(f"{name} must be > 0 or None, got {value}")
        unknown = [f for f in self.categorical if f not in self.features]
        if unknown:
            raise ValueError(f"categorical features {unknown} are not in features")

    def lgbm_params(self, seed: int) -> dict:
        return {**LGBM_FIXED, "learning_rate": self.learning_rate, "num_leaves": self.num_leaves,
                "min_data_in_leaf": self.min_data_in_leaf, "feature_fraction": self.feature_fraction,
                "lambda_l2": self.lambda_l2, "seed": seed}

    def key(self) -> str:
        """Short stable id of this config, used to name cached runs."""
        text = json.dumps(asdict(self), sort_keys=True, default=list)
        return hashlib.sha1(text.encode()).hexdigest()[:12]


@dataclass(frozen=True)
class ProcedureConfig:
    base: BaseConfig
    calibration: CalibrationConfig

    def __post_init__(self):
        longest = max(self.calibration.level_window_days, self.calibration.shape_window_days)
        if longest > RECENT_DAYS:
            raise ValueError(f"calibration windows may not exceed {RECENT_DAYS} days (the recent history "
                             f"handed to the calibration), got {longest}")

    def to_dict(self) -> dict:
        base = {k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(self.base).items()}
        return {"base": base, "calibration": asdict(self.calibration)}

    @classmethod
    def from_dict(cls, data: dict) -> "ProcedureConfig":
        base = {k: (tuple(v) if k in TUPLE_FIELDS else v) for k, v in data["base"].items()}
        return cls(base=BaseConfig(**base), calibration=CalibrationConfig(**data["calibration"]))


# The procedure chosen by the 2026-11 final run (docs/final-run/REPORT.md):
# the Oct 28 base model plus the client's four holiday-type days as a flag,
# trained on burst-clipped counts; level from the recent weeks with a 10-day
# half-life, bursts clipped; hour-of-day shape from the last 20 weeks. tests/test_train.py checks this
# equals docs/final-run/incumbent.json.
PRODUCTION = ProcedureConfig(
    base=BaseConfig(
        features=("dow", "hour", "hour_sin", "hour_cos", "dow_sin", "dow_cos", "is_weekend",
                  "is_holiday", "days_to_nearest_holiday", "is_holiday_adjacent"),
        halflife_days=730.0,
        target_clip_z=4.0,
    ),
    calibration=CalibrationConfig(
        level_window_days=140, level_halflife_days=10.0, level_cap=0.15, burst_z=4.0,
        shape_window_days=140, hour_strength=200.0,
    ),
)


# =============================================================================
# Base model
# =============================================================================

def recency_weights(hour_start: pd.Series, halflife_days: float | None) -> np.ndarray | None:
    """0.5 ** (age_days / halflife) with age measured back from the newest
    hour. None (no weighting) when halflife_days is None."""
    if halflife_days is None:
        return None
    age_days = (hour_start.max() - hour_start).dt.total_seconds().to_numpy() / 86_400
    return np.power(0.5, age_days / halflife_days)


def _training_rows(train: pd.DataFrame, config: BaseConfig) -> pd.DataFrame:
    if config.train_years is None:
        return train
    cutoff = train["hour_start"].max() - pd.Timedelta(days=DAYS_PER_YEAR * config.train_years)
    return train[train["hour_start"] > cutoff]


def _fit_boosters(rows: pd.DataFrame, label: np.ndarray, config: BaseConfig) -> tuple[lgb.Booster, ...]:
    weights = recency_weights(rows["hour_start"], config.halflife_days)
    categorical = list(config.categorical) if config.categorical else "auto"
    boosters = []
    for seed in config.seeds:
        dataset = lgb.Dataset(rows[list(config.features)], label=label, weight=weights,
                              categorical_feature=categorical)
        boosters.append(lgb.train(config.lgbm_params(seed), dataset, num_boost_round=config.num_boost_round))
    return tuple(boosters)


def fit_base(train: pd.DataFrame, config: BaseConfig) -> tuple[lgb.Booster, ...]:
    """One booster per seed, fitted on `train` with recency weights. With
    target_clip_z, a first fit says what each hour should look like and the
    boosters are refitted on counts clipped against it."""
    missing = [f for f in config.features if f not in train.columns]
    if missing:
        raise ValueError(f"training frame is missing features {missing}")
    rows = _training_rows(train, config)
    label = rows[TARGET].to_numpy(dtype="float64")
    if config.target_clip_z is not None:
        expected = predict_base(_fit_boosters(rows, label, config), rows, config)
        label = clip_bursts(label, expected, config.target_clip_z)
    return _fit_boosters(rows, label, config)


def predict_base(boosters: tuple[lgb.Booster, ...], frame: pd.DataFrame, config: BaseConfig) -> np.ndarray:
    features = frame[list(config.features)]
    return np.mean([booster.predict(features) for booster in boosters], axis=0)


def recent_frame(train: pd.DataFrame, boosters: tuple[lgb.Booster, ...], config: BaseConfig,
                 days: int = RECENT_DAYS) -> pd.DataFrame:
    """The last `days` calendar days of training: what happened (`actual`)
    next to what the base model says for the same hours (`base`)."""
    start = train["hour_start"].max().normalize() - pd.Timedelta(days=days - 1)
    recent = train[train["hour_start"] >= start]
    scorers = fit_base(train[train["hour_start"] < start], config) if config.recent_out_of_sample else boosters
    return pd.DataFrame({
        "hour_start": recent["hour_start"].to_numpy(),
        "actual": recent[TARGET].to_numpy(dtype="float64"),
        "base": predict_base(scorers, recent, config),
    })


# =============================================================================
# Holiday-type days and the whole procedure
# =============================================================================

def special_days(holidays: pd.DataFrame, hour_start: pd.Series) -> frozenset:
    """Official holidays plus the client's four adjacent days, for every
    year the hours touch and the year after (forecasts run past December)."""
    years = pd.to_datetime(hour_start).dt.year
    days = holiday_type_days(holidays, int(years.min()), int(years.max()) + 1)["holiday_date"]
    return frozenset(pd.Timestamp(day) for day in days)


class ForecastProcedure:
    """(train, future) -> calibrated forecast for the future hours.
    Picklable, so db.backtest can run it in worker processes."""

    def __init__(self, config: ProcedureConfig, special: frozenset = frozenset()):
        self.config = config
        self.special = special

    def __call__(self, train: pd.DataFrame, future: pd.DataFrame) -> np.ndarray:
        boosters = fit_base(train, self.config.base)
        factors = fit_calibration(recent_frame(train, boosters, self.config.base),
                                  self.config.calibration, self.special)
        origin = train["hour_start"].max().normalize()
        base = predict_base(boosters, future, self.config.base)
        return apply_calibration(future["hour_start"], base, factors, origin)
