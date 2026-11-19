"""Hourly call-volume and handle-time forecast for a date range.

    forecast_frame(booster, metadata, holidays, start_date, end_date) -> DataFrame
        hour_start, predicted, predicted_no_holidays  (one row per hour)
        The served volume twice: with the holiday features, and with them
        neutralised so the model predicts every day as an ordinary weekday.
        Pure: db.retrain writes this into forecast_hours.

    forecast_range(conn, start_date, end_date, recency, include_holidays) -> DataFrame
        hour_start, predicted_offered, predicted_aht_sec, predicted_real  (one row per hour)
        The same for the research tools (db.snapshot, db.roster_check), read
        from the database: the serving model and the calls.

    recency: "equal" | "weighted" | "recent" picks the handle-time weighting
        (db.aht.RECENCY_HALFLIFE_DAYS). Call volume is unaffected.
    include_holidays: False neutralises the holiday features. The model
        itself is untouched; only its inputs change.

    holiday_coverage(holidays, end_date) -> dict
        last_known_holiday, covered, message  (message is None when covered)

The booster gives the base profile; calibrated_volume() then applies what
training measured on the most recent weeks (db.calibration): a level, and a
factor per weekday and hour. Metadata written before the 2026-11 final run
has only a scalar level_factor and is served exactly as before (base x
level_factor). Features come from db.features.build_features, the same
function training used, anchored to the training epoch so the trend index
lines up. AHT comes from db.aht. predicted_real = predicted_offered x the
real-call share (db.real_calls).

forecast_range caches the booster, its metadata, and one AHT and real-share
table per recency preset, keyed on the serving model id and the data
revision: a retrain or an import refreshes them on the next call.

No fallback forecaster: no serving model raises.
"""

from __future__ import annotations

import hashlib
import warnings
from dataclasses import replace
from datetime import date

import lightgbm as lgb
import numpy as np
import pandas as pd

from db import store
from db.aht import DEFAULT_RECENCY, RECENCY_HALFLIFE_DAYS, aht_from_calls
from db.calibration import IDENTITY_FACTORS, CalibrationFactors, apply_calibration
from db.features import HOLIDAY_WINDOW_DAYS, build_features, load_holidays
from db.real_calls import real_counts, real_share_table

OUTPUT_COLUMNS = ("hour_start", "predicted_offered", "predicted_aht_sec", "predicted_real")
LAST_HOUR_OF_DAY = 23

# What each holiday feature holds on an ordinary day far from any holiday.
HOLIDAY_NEUTRAL = {
    "is_holiday": 0,
    "days_to_nearest_holiday": HOLIDAY_WINDOW_DAYS,
    "is_holiday_adjacent": 0,
    "is_major_holiday": 0,
    "holiday_kind": 0,
}

# Process-wide cache. Replaced wholesale (never mutated in place) when the
# serving model or the data revision changes. `aht` and `real_share` map
# recency preset -> table, filled on first use of each preset.
_cache: dict = {"key": None, "booster": None, "metadata": None, "calls": None, "aht": {}, "real_share": {}}

# The holiday-coverage warning goes to stderr once per process; every
# request still gets it as a field via holiday_coverage().
_holiday_warned = False


# =============================================================================
# Model + AHT loading (cached)
# =============================================================================

def check_model_matches(metadata: dict, model_bytes: bytes) -> None:
    """Raise if the metadata names a model other than this one (the model
    text and its metadata come from two different training runs). Metadata
    without a fingerprint, written before the 2026-11 final run, is not checked."""
    expected = metadata.get("model_sha256")
    if expected is not None and hashlib.sha256(model_bytes).hexdigest() != expected:
        raise ValueError("the model and its metadata are from different training runs; retrain")


def load_booster(model_text: str, metadata: dict) -> lgb.Booster:
    """The booster stored as text, after checking it against its metadata."""
    for key in ("train_start", "features"):
        if key not in metadata:
            raise ValueError(f"the model metadata is missing `{key}`")
    check_model_matches(metadata, model_text.encode())
    return lgb.Booster(model_str=model_text)


def _load_cached(conn, recency: str = DEFAULT_RECENCY) -> tuple[lgb.Booster, dict, dict, dict]:
    """Booster, metadata, and the AHT and real-share tables for `recency`,
    reloaded only when the serving model or the data revision changes."""
    global _cache
    if recency not in RECENCY_HALFLIFE_DAYS:
        raise ValueError(f"recency must be one of {tuple(RECENCY_HALFLIFE_DAYS)}, got {recency!r}")
    key = (store.serving_model_id(conn), store.calls_revision(conn))
    if key[0] is None:
        raise LookupError("no model is serving yet. Run `python -m db.retrain --db <file>` first.")
    if _cache["key"] != key:
        serving = store.serving_model(conn)
        snapshot = store.read_snapshot(conn)
        _cache = {
            "key": (serving.model_id, snapshot.calls_revision),
            "booster": load_booster(serving.model_text, serving.metadata),
            "metadata": serving.metadata,
            "calls": snapshot.calls,
            "aht": {},
            "real_share": {},
        }
    halflife = RECENCY_HALFLIFE_DAYS[recency]
    if recency not in _cache["aht"]:
        _cache = {**_cache, "aht": {**_cache["aht"], recency: aht_from_calls(_cache["calls"], halflife)}}
    if recency not in _cache["real_share"]:
        shares = real_share_table(real_counts(_cache["calls"]), halflife)
        _cache = {**_cache, "real_share": {**_cache["real_share"], recency: shares}}
    return _cache["booster"], _cache["metadata"], _cache["aht"][recency], _cache["real_share"][recency]


# =============================================================================
# Holiday coverage
# =============================================================================

def holiday_coverage(holidays: pd.DataFrame, end_date) -> dict:
    """Whether the holidays table reaches end_date. Pure; no side effects."""
    last_known = pd.Timestamp(holidays["holiday_date"].max()).normalize()
    covered = bool(pd.Timestamp(end_date).normalize() <= last_known)
    message = None
    if not covered:
        message = (
            f"Holiday calendar ends {last_known.date()}. Holidays after that "
            f"date are not reflected in this forecast; load them into the "
            f"holidays table."
        )
    return {
        "last_known_holiday": last_known.date().isoformat(),
        "covered": covered,
        "message": message,
    }


def _warn_once(message: str) -> None:
    global _holiday_warned
    if _holiday_warned:
        return
    _holiday_warned = True
    warnings.warn(message, stacklevel=3)


# =============================================================================
# Forecast
# =============================================================================

def _hourly_grid(start_date, end_date) -> pd.DataFrame:
    start = pd.Timestamp(start_date).normalize()
    end = pd.Timestamp(end_date).normalize()
    if end < start:
        raise ValueError(f"end_date {end.date()} is before start_date {start.date()}")
    hours = pd.date_range(start, end + pd.Timedelta(hours=LAST_HOUR_OF_DAY), freq="h")
    return pd.DataFrame({"hour_start": hours})


def aht_table(conn, recency: str = DEFAULT_RECENCY) -> dict:
    """The cached {(dow, hour): agent_sec} table for a recency preset."""
    return _load_cached(conn, recency)[2]


def _without_holidays(featured: pd.DataFrame) -> pd.DataFrame:
    """The same rows with every holiday feature set to its 'no holiday
    nearby' value: flags 0, and distance at the clip limit, which is what
    the model saw for every ordinary hour more than two weeks from a holiday."""
    return featured.assign(**{name: value for name, value in HOLIDAY_NEUTRAL.items() if name in featured.columns})


def calibration_factors(metadata: dict) -> CalibrationFactors:
    """The factors training stored. Older metadata has only `level_factor`
    (or nothing): that is a level with a flat shape."""
    if "calibration" in metadata:
        return CalibrationFactors.from_dict(metadata["calibration"])
    return replace(IDENTITY_FACTORS, level=float(metadata.get("level_factor", 1.0)))


def calibrated_volume(base: np.ndarray, hour_start: pd.Series, metadata: dict) -> np.ndarray:
    """Base model output -> served forecast: level x shape[weekday][hour]
    (db.calibration.apply_calibration). The horizon is counted from the last
    training day."""
    origin = pd.Timestamp(metadata["train_end"]) if "train_end" in metadata else pd.Timestamp(hour_start.min())
    return apply_calibration(hour_start, base, calibration_factors(metadata), origin)


def forecast_frame(booster: lgb.Booster, metadata: dict, holidays: pd.DataFrame,
                   start_date: date | str, end_date: date | str) -> pd.DataFrame:
    """Served volume for every hour from start_date 00:00 through end_date
    23:00 (both inclusive), with and without the holiday features. Each hour
    depends on its own features only, so a long range gives every hour the
    number a shorter request for it would."""
    grid = _hourly_grid(start_date, end_date)
    featured = build_features(grid, holidays, epoch=metadata["train_start"])

    features = metadata["features"]
    missing = [f for f in features if f not in featured.columns]
    if missing:
        raise ValueError(f"build_features did not produce trained features: {missing}")

    def served(frame: pd.DataFrame) -> np.ndarray:
        return calibrated_volume(booster.predict(frame[features]), frame["hour_start"], metadata)

    return pd.DataFrame({
        "hour_start": featured["hour_start"].to_numpy(),
        "predicted": served(featured),
        "predicted_no_holidays": served(_without_holidays(featured)),
    })


def forecast_range(conn, start_date: date | str, end_date: date | str,
                   recency: str = DEFAULT_RECENCY, include_holidays: bool = True) -> pd.DataFrame:
    """Predicted offered calls and AHT for every hour from start_date 00:00
    through end_date 23:00 (both dates inclusive), from the serving model."""
    booster, metadata, aht_by_cell, real_share_by_cell = _load_cached(conn, recency)
    holidays = load_holidays(conn)

    coverage = holiday_coverage(holidays, end_date)
    if coverage["message"]:
        _warn_once(coverage["message"])

    frame = forecast_frame(booster, metadata, holidays, start_date, end_date)
    predicted_offered = frame["predicted" if include_holidays else "predicted_no_holidays"].to_numpy()
    cells = list(zip(frame["hour_start"].dt.isocalendar().day.astype("int64"), frame["hour_start"].dt.hour))
    predicted_aht = [aht_by_cell[(int(dow), int(hour))] for dow, hour in cells]
    real_share = [real_share_by_cell[(int(dow), int(hour))] for dow, hour in cells]

    return pd.DataFrame({
        "hour_start": frame["hour_start"].to_numpy(),
        "predicted_offered": predicted_offered,
        "predicted_aht_sec": predicted_aht,
        "predicted_real": predicted_offered * np.asarray(real_share),
    })
