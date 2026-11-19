"""Hourly call-volume and handle-time forecast for a future date range.

    forecast_range(conn, start_date, end_date, recency, include_holidays) -> DataFrame
        hour_start, predicted_offered, predicted_aht_sec, predicted_real  (one row per hour)

    recency: "equal" | "weighted" | "recent" picks the handle-time weighting
        (db.aht.RECENCY_HALFLIFE_DAYS). Call volume is unaffected.
    include_holidays: False neutralises the holiday features so the volume
        model predicts the day as an ordinary weekday. The model itself is
        untouched; only its inputs change.

    holiday_coverage(holidays, end_date) -> dict
        last_known_holiday, covered, message  (message is None when covered)

Loads the trained LightGBM booster from models/volume_lgbm.txt and its
metadata. The booster gives the base profile; calibrated_volume() then
applies what training measured on the most recent weeks (db.calibration):
a level, and a factor per weekday and hour. Metadata written before the
2026-11 final run has only a scalar level_factor and is served exactly as
before (base x level_factor). Features come from
db.features.build_features, the same function training used, anchored to
the training epoch so the trend index lines up. AHT comes from db.aht.
predicted_real = predicted_offered x the real-call share (db.real_calls).

The booster, its metadata, and one AHT and real-share table per recency preset are cached
in this module, keyed on the model file's mtime. A retrain (new mtime)
refreshes all of them on the next call; slider drags between retrains reuse
them.

No fallback forecaster: a missing model file raises.
Connection comes from $V4W_DATABASE_URL via python-dotenv.
"""

from __future__ import annotations

import hashlib
import json
import sys
import warnings
from dataclasses import replace
from datetime import date

import lightgbm as lgb
import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg  # noqa: F401  (callers pass an open connection)
except ImportError:
    sys.exit("psycopg is required:  pip install 'psycopg[binary]'")

from db.aht import DEFAULT_RECENCY, RECENCY_HALFLIFE_DAYS, estimate_aht  # noqa: E402
from db.calibration import IDENTITY_FACTORS, CalibrationFactors, apply_calibration  # noqa: E402
from db.real_calls import estimate_real_share  # noqa: E402
from db.features import HOLIDAY_WINDOW_DAYS, build_features, load_holidays  # noqa: E402
from db.train import METADATA_PATH, MODEL_PATH  # noqa: E402

OUTPUT_COLUMNS = ("hour_start", "predicted_offered", "predicted_aht_sec")
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
# model file's mtime changes. `aht` maps recency preset -> table, filled on
# first use of each preset.
_cache: dict = {"mtime": None, "booster": None, "metadata": None, "aht": {}}

# The holiday-coverage warning goes to stderr once per process; every
# request still gets it as a field via holiday_coverage().
_holiday_warned = False


# =============================================================================
# Model + AHT loading (cached)
# =============================================================================

def _read_metadata() -> dict:
    metadata = json.loads(METADATA_PATH.read_text())
    for key in ("train_start", "features"):
        if key not in metadata:
            raise ValueError(f"{METADATA_PATH} is missing `{key}`")
    return metadata


def check_model_matches(metadata: dict, model_bytes: bytes) -> None:
    """Raise if the metadata names a model file other than this one (a
    request landed between the two files of a retrain, or one file was
    copied without the other). Metadata without a fingerprint, written
    before the 2026-11 final run, is not checked."""
    expected = metadata.get("model_sha256")
    if expected is not None and hashlib.sha256(model_bytes).hexdigest() != expected:
        raise ValueError(f"{MODEL_PATH.name} and {METADATA_PATH.name} are from different training runs; "
                         f"retrain, or wait a moment if a retrain is writing them now")


def _load_cached(conn, recency: str = DEFAULT_RECENCY) -> tuple[lgb.Booster, dict, dict]:
    """Booster, metadata, and the AHT table for `recency`, reloaded only
    when the model file changes on disk."""
    global _cache
    if recency not in RECENCY_HALFLIFE_DAYS:
        raise ValueError(f"recency must be one of {tuple(RECENCY_HALFLIFE_DAYS)}, got {recency!r}")
    if not MODEL_PATH.exists():
        raise FileNotFoundError(
            f"{MODEL_PATH} not found. Run `python -m db.train` first."
        )
    if not METADATA_PATH.exists():
        raise FileNotFoundError(
            f"{METADATA_PATH} not found. Run `python -m db.train` first."
        )

    mtime = MODEL_PATH.stat().st_mtime
    if _cache["mtime"] != mtime:
        check_model_matches(_read_metadata(), MODEL_PATH.read_bytes())
        _cache = {
            "mtime": mtime,
            "booster": lgb.Booster(model_file=str(MODEL_PATH)),
            "metadata": _read_metadata(),
            "aht": {},
            "real_share": {},
        }
    if recency not in _cache["aht"]:
        tables = {**_cache["aht"], recency: estimate_aht(conn, RECENCY_HALFLIFE_DAYS[recency])}
        _cache = {**_cache, "aht": tables}
    if recency not in _cache["real_share"]:
        shares = {**_cache["real_share"], recency: estimate_real_share(conn, RECENCY_HALFLIFE_DAYS[recency])}
        _cache = {**_cache, "real_share": shares}
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


def forecast_range(conn, start_date: date | str, end_date: date | str,
                   recency: str = DEFAULT_RECENCY, include_holidays: bool = True) -> pd.DataFrame:
    """Predicted offered calls and AHT for every hour from start_date 00:00
    through end_date 23:00 (both dates inclusive)."""
    booster, metadata, aht_by_cell, real_share_by_cell = _load_cached(conn, recency)
    holidays = load_holidays(conn)

    coverage = holiday_coverage(holidays, end_date)
    if coverage["message"]:
        _warn_once(coverage["message"])

    grid = _hourly_grid(start_date, end_date)
    featured = build_features(grid, holidays, epoch=metadata["train_start"])
    if not include_holidays:
        featured = _without_holidays(featured)

    features = metadata["features"]
    missing = [f for f in features if f not in featured.columns]
    if missing:
        raise ValueError(f"build_features did not produce trained features: {missing}")

    predicted_offered = calibrated_volume(booster.predict(featured[features]), featured["hour_start"], metadata)
    predicted_aht = [
        aht_by_cell[(int(dow), int(hour))]
        for dow, hour in zip(featured["dow"], featured["hour"])
    ]

    real_share = [
        real_share_by_cell[(int(dow), int(hour))]
        for dow, hour in zip(featured["dow"], featured["hour"])
    ]

    return pd.DataFrame({
        "hour_start": featured["hour_start"].to_numpy(),
        "predicted_offered": predicted_offered,
        "predicted_aht_sec": predicted_aht,
        "predicted_real": predicted_offered * np.asarray(real_share),
    })
