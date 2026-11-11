"""Candidate families of the improvement loop.

Each family takes the current configuration and returns the alternatives
to score against it, as (label, ProcedureConfig) pairs. A family changes
ONE thing, so an accepted candidate says which change helped. The order in
which families are tried and the rule for keeping a candidate are fixed in
docs/superpowers/plans/2026-11-10-model-final-run.md; db.tune runs them.

    candidates(name, config) -> [(label, ProcedureConfig), ...]
    legacy_equivalent()      -> the Oct 28 settings, expressed in db.procedure
"""

from __future__ import annotations

from dataclasses import replace
from typing import Callable

from db.calibration import CalibrationConfig
from db.legacy import LEGACY_FEATURES
from db.procedure import BaseConfig, ProcedureConfig

Candidates = list[tuple[str, ProcedureConfig]]


def legacy_equivalent() -> ProcedureConfig:
    """The Oct 28 model's settings in the new procedure: same features and
    memory; the 7-day, 15%-capped level factor from ONE fit instead of two."""
    return ProcedureConfig(
        base=BaseConfig(features=LEGACY_FEATURES, halflife_days=730.0),
        calibration=CalibrationConfig(level_window_days=7, level_cap=0.15),
    )


def _cal(config: ProcedureConfig, **changes) -> ProcedureConfig:
    return replace(config, calibration=replace(config.calibration, **changes))


def _base(config: ProcedureConfig, **changes) -> ProcedureConfig:
    return replace(config, base=replace(config.base, **changes))


# ---- family 1: level calibration ---------------------------------------------------

def level_single_fit(config: ProcedureConfig) -> Candidates:
    return [("one fit, 7 days, cap 15%", legacy_equivalent())]


def level_window(config: ProcedureConfig) -> Candidates:
    return [(f"{days} days", _cal(config, level_window_days=days, level_halflife_days=None))
            for days in (7, 14, 21, 28, 35, 42, 56, 70, 84, 112, 140)]


def level_halflife(config: ProcedureConfig) -> Candidates:
    return [(f"half-life {days} days", _cal(config, level_window_days=140, level_halflife_days=float(days)))
            for days in (5, 7, 10, 14, 21, 28, 42, 56)]


def level_cap(config: ProcedureConfig) -> Candidates:
    return [(f"cap {round(cap * 100)}%", _cal(config, level_cap=cap)) for cap in (0.05, 0.10, 0.15, 0.20, 0.30)]


def level_damping(config: ProcedureConfig) -> Candidates:
    return [(f"damping {factor}", _cal(config, level_damping=factor)) for factor in (0.95, 0.9, 0.8, 0.7, 0.5)]


def burst_clip(config: ProcedureConfig) -> Candidates:
    return [(f"clip bursts at z={z:g}", _cal(config, burst_z=z)) for z in (3.0, 4.0, 5.0, 6.0, 8.0)]


def skip_special(config: ProcedureConfig) -> Candidates:
    return [("leave holiday-type days out of the windows", _cal(config, skip_special_days=True))]


# ---- family 2: shape calibration ---------------------------------------------------
# Strengths are in calls. Over 8 weeks a weekday sees about 1,400 calls, an
# hour of the day about 420, one (weekday, hour) cell about 60, so each grid
# runs from "trust the recent weeks fully" to "barely move".

SHAPE_WINDOWS = (28, 42, 56, 84, 112, 140)


def dow_shape(config: ProcedureConfig) -> Candidates:
    return [(f"weekday strength {strength:g}, {days} days", _cal(config, dow_strength=strength, shape_window_days=days))
            for days in SHAPE_WINDOWS for strength in (0.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0)]


def hour_shape(config: ProcedureConfig) -> Candidates:
    return [(f"hour strength {strength:g}, {days} days", _cal(config, hour_strength=strength, shape_window_days=days))
            for days in SHAPE_WINDOWS for strength in (0.0, 50.0, 100.0, 200.0, 400.0, 800.0, 1600.0)]


def cell_shape(config: ProcedureConfig) -> Candidates:
    return [(f"cell strength {strength:g}, {days} days", _cal(config, cell_strength=strength, shape_window_days=days))
            for days in SHAPE_WINDOWS for strength in (25.0, 50.0, 100.0, 200.0, 400.0, 800.0)]


def shape_halflife(config: ProcedureConfig) -> Candidates:
    return [(f"shape half-life {days} days", _cal(config, shape_window_days=140, shape_halflife_days=float(days)))
            for days in (14, 21, 28, 42, 56, 84)]


def shape_cap(config: ProcedureConfig) -> Candidates:
    return [(f"shape cap {round(cap * 100)}%", _cal(config, shape_cap=cap)) for cap in (0.15, 0.25, 0.35, 0.5, 0.75)]


# ---- family 3: holiday-type days ----------------------------------------------------

def _with_features(config: ProcedureConfig, extra: tuple[str, ...], categorical: tuple[str, ...] = ()) -> ProcedureConfig:
    features = config.base.features + tuple(f for f in extra if f not in config.base.features)
    return _base(config, features=features, categorical=config.base.categorical + categorical)


def holiday_features(config: ProcedureConfig) -> Candidates:
    return [
        ("client days as a flag", _with_features(config, ("is_holiday_adjacent",))),
        ("holiday identity", _with_features(config, ("holiday_kind",), ("holiday_kind",))),
        ("client days flag + holiday identity",
         _with_features(config, ("is_holiday_adjacent", "holiday_kind"), ("holiday_kind",))),
        ("major-holiday flag", _with_features(config, ("is_major_holiday",))),
        ("major-holiday flag + client days flag", _with_features(config, ("is_major_holiday", "is_holiday_adjacent"))),
    ]


# ---- family 5: base model features --------------------------------------------------

CYCLIC_DUPLICATES = ("hour_sin", "hour_cos", "dow_sin", "dow_cos", "is_weekend")


def calendar_features(config: ProcedureConfig) -> Candidates:
    lean = tuple(f for f in config.base.features if f not in CYCLIC_DUPLICATES)
    return [
        ("hour of week as a category", _with_features(config, ("hour_of_week",), ("hour_of_week",))),
        ("hour of week as a number", _with_features(config, ("hour_of_week",))),
        ("day of month", _with_features(config, ("day_of_month",))),
        ("payday window flag", _with_features(config, ("is_payday_window",))),
        ("yearly cycle, 1 harmonic", _with_features(config, ("doy_sin", "doy_cos"))),
        ("yearly cycle, 2 harmonics", _with_features(config, ("doy_sin", "doy_cos", "doy_sin2", "doy_cos2"))),
        ("month number", _with_features(config, ("month",))),
        ("without the duplicate cyclic encodings", _base(config, features=lean)),
    ]


# ---- family 6: base model fitting ---------------------------------------------------

def tree_fitting(config: ProcedureConfig) -> Candidates:
    return [
        ("slower learning, same rounds (0.03 x 500)", _base(config, learning_rate=0.03)),
        ("slower learning, more rounds (0.02 x 1000)", _base(config, learning_rate=0.02, num_boost_round=1000)),
        ("faster learning, fewer rounds (0.1 x 250)", _base(config, learning_rate=0.1, num_boost_round=250)),
        ("fewer rounds (0.05 x 250)", _base(config, num_boost_round=250)),
        ("15 leaves", _base(config, num_leaves=15)),
        ("63 leaves", _base(config, num_leaves=63)),
        ("leaf size 50", _base(config, min_data_in_leaf=50)),
        ("leaf size 100", _base(config, min_data_in_leaf=100)),
        ("leaf size 200", _base(config, min_data_in_leaf=200)),
        ("L2 penalty 5", _base(config, lambda_l2=5.0)),
        ("L2 penalty 20", _base(config, lambda_l2=20.0)),
        ("every feature in every tree", _base(config, feature_fraction=1.0)),
        ("70% of features per tree", _base(config, feature_fraction=0.7)),
    ]


def target_clip(config: ProcedureConfig) -> Candidates:
    """Burst-robust training target (planned in family 6; run after review)."""
    return [(f"clip training bursts at z={z:g}", _base(config, target_clip_z=z)) for z in (3.0, 4.0, 5.0, 6.0, 8.0)]


def out_of_sample_recent(config: ProcedureConfig) -> Candidates:
    """Measure level and shape against a model that has not seen the recent
    weeks (suggested by the ML review: the in-sample comparison understates
    the gap by about 15%)."""
    outside = _base(config, recent_out_of_sample=True)
    return [
        ("recent weeks scored by a model fitted before them", outside),
        ("same, hour strength 400", _cal(outside, hour_strength=400.0)),
        ("same, hour strength 800", _cal(outside, hour_strength=800.0)),
        ("same, level half-life 7 days", _cal(outside, level_halflife_days=7.0)),
        ("same, level half-life 14 days", _cal(outside, level_halflife_days=14.0)),
    ]


# ---- family 7: stability -------------------------------------------------------------

def seed_averaging(config: ProcedureConfig) -> Candidates:
    return [("average of 3 seeds", _base(config, seeds=(42, 43, 44))),
            ("average of 5 seeds", _base(config, seeds=(42, 43, 44, 45, 46)))]


# ---- family 4: base model memory ----------------------------------------------------

def base_halflife(config: ProcedureConfig) -> Candidates:
    options = (None, 1460.0, 1095.0, 730.0, 545.0, 365.0, 270.0, 180.0, 120.0, 90.0)
    return [("equal weights" if days is None else f"base half-life {days:g} days", _base(config, halflife_days=days))
            for days in options if days != config.base.halflife_days]


def base_train_years(config: ProcedureConfig) -> Candidates:
    return [(f"last {years:g} years only", _base(config, train_years=years)) for years in (4.0, 3.0, 2.0, 1.5, 1.0)]


EXPERIMENTS: dict[str, Callable[[ProcedureConfig], Candidates]] = {
    "holiday_features": holiday_features,
    "calendar_features": calendar_features,
    "tree_fitting": tree_fitting,
    "target_clip": target_clip,
    "out_of_sample_recent": out_of_sample_recent,
    "seed_averaging": seed_averaging,
    "base_halflife": base_halflife,
    "base_train_years": base_train_years,
    "level_single_fit": level_single_fit,
    "level_window": level_window,
    "level_halflife": level_halflife,
    "level_cap": level_cap,
    "level_damping": level_damping,
    "burst_clip": burst_clip,
    "skip_special": skip_special,
    "dow_shape": dow_shape,
    "hour_shape": hour_shape,
    "cell_shape": cell_shape,
    "shape_halflife": shape_halflife,
    "shape_cap": shape_cap,
}


def candidates(name: str, config: ProcedureConfig) -> Candidates:
    if name not in EXPERIMENTS:
        raise ValueError(f"unknown experiment {name!r}; known: {', '.join(sorted(EXPERIMENTS))}")
    return EXPERIMENTS[name](config)
