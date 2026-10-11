"""Hourly call-volume and handle-time forecast for a future date range.

    forecast_range(conn, start_date, end_date) -> DataFrame
        hour_start, predicted_offered, predicted_aht_sec  (one row per hour)

    holiday_coverage(holidays, end_date) -> dict
        last_known_holiday, covered, message  (message is None when covered)

Loads the trained LightGBM booster from models/volume_lgbm.txt and its
metadata (train_start, feature list). Features come from
db.features.build_features, the same function training used, anchored to
the training epoch so the trend index lines up. AHT comes from db.aht.

The booster, its metadata, and the AHT table are cached in this module,
keyed on the model file's mtime. A retrain (new mtime) refreshes all three
on the next call; slider drags between retrains reuse them.

No fallback forecaster: a missing model file raises.
Connection comes from $V4W_DATABASE_URL via python-dotenv.
"""

from __future__ import annotations

import json
import sys
import warnings
from datetime import date

import lightgbm as lgb
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg  # noqa: F401  (callers pass an open connection)
except ImportError:
    sys.exit("psycopg is required:  pip install 'psycopg[binary]'")

from db.aht import estimate_aht  # noqa: E402
from db.features import build_features, load_holidays  # noqa: E402
from db.train import METADATA_PATH, MODEL_PATH  # noqa: E402

OUTPUT_COLUMNS = ("hour_start", "predicted_offered", "predicted_aht_sec")
LAST_HOUR_OF_DAY = 23

# Process-wide cache. Replaced wholesale (never mutated in place) when the
# model file's mtime changes.
_cache: dict = {"mtime": None, "booster": None, "metadata": None, "aht": None}

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


def _load_cached(conn) -> tuple[lgb.Booster, dict, dict]:
    """Booster, metadata, and AHT table, reloaded only when the model file
    changes on disk."""
    global _cache
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
        _cache = {
            "mtime": mtime,
            "booster": lgb.Booster(model_file=str(MODEL_PATH)),
            "metadata": _read_metadata(),
            "aht": estimate_aht(conn),
        }
    return _cache["booster"], _cache["metadata"], _cache["aht"]


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


def forecast_range(conn, start_date: date | str, end_date: date | str) -> pd.DataFrame:
    """Predicted offered calls and AHT for every hour from start_date 00:00
    through end_date 23:00 (both dates inclusive)."""
    booster, metadata, aht_by_cell = _load_cached(conn)
    holidays = load_holidays(conn)

    coverage = holiday_coverage(holidays, end_date)
    if coverage["message"]:
        _warn_once(coverage["message"])

    grid = _hourly_grid(start_date, end_date)
    featured = build_features(grid, holidays, epoch=metadata["train_start"])

    features = metadata["features"]
    missing = [f for f in features if f not in featured.columns]
    if missing:
        raise ValueError(f"build_features did not produce trained features: {missing}")

    predicted_offered = booster.predict(featured[features])
    predicted_aht = [
        aht_by_cell[(int(dow), int(hour))]
        for dow, hour in zip(featured["dow"], featured["hour"])
    ]

    return pd.DataFrame({
        "hour_start": featured["hour_start"].to_numpy(),
        "predicted_offered": predicted_offered,
        "predicted_aht_sec": predicted_aht,
    })
