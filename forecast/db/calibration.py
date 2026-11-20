"""Level correction for the volume forecast, from the most recent weeks.

The partner's Oct 14-20 2026 validation showed every day under-forecast
(week total 8.6% low). Trees cannot extrapolate a level they have not seen,
so the model repeats old levels. This module measures the recent level gap
OUT OF SAMPLE and scales the forecast by it, within a cap.

    recent_window_start(hour_start, window_days) -> first hour of the window
        the window = the last `window_days` calendar days that HAVE data
        (days missing from the data, e.g. an unreported gap, are skipped)
    level_factor(actual, predicted, cap) -> float in [1 - cap, 1 + cap]
        sum(actual) / sum(predicted), clipped

How training uses it (db.train.fit_level_factor):
    1. fit the model on every hour BEFORE the window
    2. predict the window, compare with what actually happened
    3. factor = level_factor(...); the final model's forecast is multiplied by it
The backtest (db.tune) runs the same three steps inside every fold, so the
reported accuracy is the accuracy of this exact procedure.

The cap stops one odd week from swinging the forecast too far.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

LEVEL_WINDOW_DAYS = 7
LEVEL_CAP = 0.15


def recent_window_start(hour_start: pd.Series, window_days: int = LEVEL_WINDOW_DAYS) -> pd.Timestamp:
    """Midnight of the earliest of the last `window_days` days present in
    `hour_start`. Raises if the data has no more days than the window (then
    nothing would be left to fit on)."""
    if window_days < 1:
        raise ValueError(f"window_days must be >= 1, got {window_days}")
    days = pd.Series(pd.to_datetime(hour_start).dt.normalize().unique()).sort_values()
    if len(days) <= window_days:
        raise ValueError(f"only {len(days)} days of data; need more than {window_days} for a level window")
    return pd.Timestamp(days.iloc[-window_days])


def level_factor(actual: np.ndarray, predicted: np.ndarray, cap: float = LEVEL_CAP) -> float:
    """Ratio of actual to predicted totals, clipped to [1 - cap, 1 + cap]."""
    if not 0 <= cap < 1:
        raise ValueError(f"cap must be in [0, 1), got {cap}")
    actual_total = float(np.sum(actual))
    predicted_total = float(np.sum(predicted))
    if predicted_total <= 0:
        raise ValueError("predicted total is not positive; level factor is undefined")
    return float(np.clip(actual_total / predicted_total, 1 - cap, 1 + cap))


# =============================================================================
# Level + shape calibration (2026-11 final run)
# =============================================================================
#
# The base model is a slow-moving profile: what a typical Tuesday 2 PM looks
# like over the years. It is compared with what actually happened in the most
# recent weeks, and the forecast is scaled by what that comparison shows:
#
#   level   one number: recent calls / what the base model says for the same
#           hours. Capped. Optionally fades toward 1 further into the future.
#   shape   a 7 x 24 table: which weekdays and hours have recently run above
#           or below the base model, AFTER the level is taken out. Built in
#           three steps (weekday, hour of day, weekday-hour cell), each shrunk
#           toward 1 so that a cell with few calls cannot swing on noise.
#
#   fit_calibration(recent, config, special_days) -> CalibrationFactors
#   apply_calibration(hour_start, base, factors, origin) -> calibrated forecast
#
# `recent` holds the last weeks of training data: hour_start, actual, base
# (the base model's own number for that hour). The same two functions run in
# the backtest, in training and when serving, so the reported accuracy is
# the accuracy of exactly this procedure.

DAYS_PER_WEEK = 7
HOURS_PER_DAY = 24
RECENT_COLUMNS = ("hour_start", "actual", "base")

# Hourly call counts vary more than a Poisson count would: variance / mean of
# `offered` within a (weekday, hour) cell, median over the 168 cells, May to
# Nov 2026, was 1.58. Used only to decide what counts as a burst.
BURST_DISPERSION = 1.6


@dataclass(frozen=True)
class CalibrationConfig:
    """How the recent weeks are compared with the base model.

    level_window_days   : days back from the last training day used for the level
    level_halflife_days : inside that window a day `age` days old weighs
                          0.5 ** (age / halflife); None = equal weights
    level_cap           : level is clipped to [1 - cap, 1 + cap]
    level_damping       : per week of horizon the level's distance from 1
                          shrinks by this factor (on the log scale); 1 = never
    burst_z             : an hour's count above mean + z * sqrt(1.6 * mean) is
                          clipped to that value before any ratio; None = off
    shape_window_days / shape_halflife_days : the same two knobs for the shape
    dow_strength / hour_strength / cell_strength : shrinkage, in calls. A
                          group's factor is (actual + s) / (expected + s), so
                          a group needs about `s` expected calls before its
                          own data outweighs "no change". None = step off.
    shape_cap           : every shape factor is clipped to [1 - cap, 1 + cap]
    skip_special_days   : leave holiday-type days out of both windows
    """
    level_window_days: int = 28
    level_halflife_days: float | None = None
    level_cap: float = 0.15
    level_damping: float = 1.0
    burst_z: float | None = None
    shape_window_days: int = 56
    shape_halflife_days: float | None = None
    dow_strength: float | None = None
    hour_strength: float | None = None
    cell_strength: float | None = None
    shape_cap: float = 0.5
    skip_special_days: bool = False

    def __post_init__(self):
        if self.level_window_days < 1 or self.shape_window_days < 1:
            raise ValueError("window days must be >= 1")
        if not 0 <= self.level_cap < 1 or not 0 <= self.shape_cap < 1:
            raise ValueError("caps must be in [0, 1)")
        if not 0 < self.level_damping <= 1:
            raise ValueError(f"level_damping must be in (0, 1], got {self.level_damping}")
        for name in ("level_halflife_days", "shape_halflife_days", "burst_z"):
            value = getattr(self, name)
            if value is not None and value <= 0:
                raise ValueError(f"{name} must be > 0 or None, got {value}")
        for name in ("dow_strength", "hour_strength", "cell_strength"):
            value = getattr(self, name)
            if value is not None and value < 0:
                raise ValueError(f"{name} must be >= 0 or None, got {value}")


@dataclass(frozen=True)
class CalibrationFactors:
    """What training learned from the recent weeks. `shape[d][h]` multiplies
    the forecast for weekday d (0 = Monday .. 6 = Sunday) at hour h; `dow`
    and `hour` are the first two steps of the shape, kept for the report."""
    level: float
    shape: tuple[tuple[float, ...], ...]
    level_damping: float
    dow: tuple[float, ...]
    hour: tuple[float, ...]

    def to_dict(self) -> dict:
        return {"level": self.level, "level_damping": self.level_damping,
                "dow": list(self.dow), "hour": list(self.hour), "shape": [list(row) for row in self.shape]}

    @classmethod
    def from_dict(cls, data: dict) -> "CalibrationFactors":
        return cls(level=float(data["level"]), level_damping=float(data["level_damping"]),
                   dow=tuple(float(v) for v in data["dow"]), hour=tuple(float(v) for v in data["hour"]),
                   shape=tuple(tuple(float(v) for v in row) for row in data["shape"]))


IDENTITY_FACTORS = CalibrationFactors(
    level=1.0,
    shape=tuple(tuple(1.0 for _ in range(HOURS_PER_DAY)) for _ in range(DAYS_PER_WEEK)),
    level_damping=1.0,
    dow=tuple(1.0 for _ in range(DAYS_PER_WEEK)),
    hour=tuple(1.0 for _ in range(HOURS_PER_DAY)),
)


def _age_weights(age_days: np.ndarray, window_days: int, halflife_days: float | None,
                 usable: np.ndarray) -> np.ndarray:
    """Weight of each recent hour: 0 outside the window or on a skipped day,
    else 1 or the half-life decay."""
    inside = (age_days < window_days) & usable
    decay = np.ones(len(age_days)) if halflife_days is None else np.power(0.5, age_days / halflife_days)
    return np.where(inside, decay, 0.0)


def clip_bursts(actual: np.ndarray, expected: np.ndarray, z: float | None) -> np.ndarray:
    """Counts far above what is plausible for the hour are cut back to the
    edge of plausible, so one caller ringing 40 times does not look like a
    busier month."""
    if z is None:
        return actual
    ceiling = expected + z * np.sqrt(BURST_DISPERSION * expected)
    return np.minimum(actual, ceiling)


def _ratio(actual: np.ndarray, expected: np.ndarray, weights: np.ndarray) -> float:
    total = float(np.sum(weights * expected))
    return float(np.sum(weights * actual)) / total if total > 0 else 1.0


def _shrunk_factors(actual: np.ndarray, expected: np.ndarray, weights: np.ndarray,
                    groups: np.ndarray, n_groups: int, strength: float | None) -> np.ndarray:
    """One factor per group: (actual + s) / (expected + s), then rescaled so
    the factors leave the window's expected total unchanged. All ones when
    the step is off."""
    if strength is None:
        return np.ones(n_groups)
    seen = np.bincount(groups, weights=weights * actual, minlength=n_groups)
    due = np.bincount(groups, weights=weights * expected, minlength=n_groups)
    denominator = due + strength
    factors = np.where(denominator > 0, (seen + strength) / np.where(denominator > 0, denominator, 1.0), 1.0)
    total_due = due.sum()
    scale = float((due * factors).sum() / total_due) if total_due > 0 else 1.0
    return factors / scale if scale > 0 else factors


def _shape_table(actual: np.ndarray, expected: np.ndarray, weights: np.ndarray, dow: np.ndarray,
                 hour: np.ndarray, config: CalibrationConfig) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(dow factors, hour factors, 7 x 24 shape). Each step explains what the
    step before left over."""
    dow_factors = _shrunk_factors(actual, expected, weights, dow, DAYS_PER_WEEK, config.dow_strength)
    after_dow = expected * dow_factors[dow]
    hour_factors = _shrunk_factors(actual, after_dow, weights, hour, HOURS_PER_DAY, config.hour_strength)
    after_hour = after_dow * hour_factors[hour]
    cell = dow * HOURS_PER_DAY + hour
    cell_factors = _shrunk_factors(actual, after_hour, weights, cell, DAYS_PER_WEEK * HOURS_PER_DAY,
                                   config.cell_strength).reshape(DAYS_PER_WEEK, HOURS_PER_DAY)
    shape = dow_factors[:, None] * hour_factors[None, :] * cell_factors
    return dow_factors, hour_factors, np.clip(shape, 1 - config.shape_cap, 1 + config.shape_cap)


def fit_calibration(recent: pd.DataFrame, config: CalibrationConfig,
                    special_days: frozenset = frozenset()) -> CalibrationFactors:
    """Compare the recent weeks with the base model. `recent` needs
    hour_start, actual, base and must end on the last training day. Pure:
    `recent` is not changed."""
    missing = [c for c in RECENT_COLUMNS if c not in recent.columns]
    if missing:
        raise ValueError(f"recent is missing columns {missing}")
    hour_start = pd.to_datetime(recent["hour_start"])
    day = hour_start.dt.normalize()
    age_days = (day.max() - day).dt.days.to_numpy()
    base = recent["base"].to_numpy(dtype="float64")
    usable = ~day.isin(list(special_days)).to_numpy() if config.skip_special_days else np.ones(len(recent), dtype=bool)

    shape_weights = _age_weights(age_days, config.shape_window_days, config.shape_halflife_days, usable)
    raw = recent["actual"].to_numpy(dtype="float64")
    rough_level = _ratio(raw, base, shape_weights)
    actual = clip_bursts(raw, base * rough_level, config.burst_z)

    level_weights = _age_weights(age_days, config.level_window_days, config.level_halflife_days, usable)
    level = float(np.clip(_ratio(actual, base, level_weights), 1 - config.level_cap, 1 + config.level_cap))

    expected = base * _ratio(actual, base, shape_weights)
    dow_factors, hour_factors, shape = _shape_table(
        actual, expected, shape_weights, hour_start.dt.dayofweek.to_numpy(), hour_start.dt.hour.to_numpy(), config)
    return CalibrationFactors(
        level=level,
        shape=tuple(tuple(float(v) for v in row) for row in shape),
        level_damping=config.level_damping,
        dow=tuple(float(v) for v in dow_factors),
        hour=tuple(float(v) for v in hour_factors),
    )


def apply_calibration(hour_start: pd.Series, base: np.ndarray, factors: CalibrationFactors,
                      origin: pd.Timestamp) -> np.ndarray:
    """base x level (faded by horizon) x shape[weekday][hour]. `origin` is
    the last training day; hours on or before it get the full level."""
    hour_start = pd.to_datetime(pd.Series(hour_start).reset_index(drop=True))
    horizon_day = (hour_start.dt.normalize() - pd.Timestamp(origin).normalize()).dt.days.to_numpy()
    weeks_ahead = np.clip((horizon_day - 1) / DAYS_PER_WEEK, 0, None)
    level = np.exp(np.log(factors.level) * np.power(factors.level_damping, weeks_ahead))
    shape = np.asarray(factors.shape)[hour_start.dt.dayofweek.to_numpy(), hour_start.dt.hour.to_numpy()]
    return np.asarray(base, dtype="float64") * level * shape
