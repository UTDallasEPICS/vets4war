"""Hourly call-volume and handle-time forecast for a future date range.

    forecast_range(conn, start_date, end_date, recency, include_holidays) -> DataFrame
        hour_start, predicted_offered, predicted_aht_sec  (one row per hour)

    recency: "equal" | "weighted" | "recent" picks the handle-time weighting
        (db.aht.RECENCY_HALFLIFE_DAYS). Call volume is unaffected.
    include_holidays: False neutralises the holiday features so the volume
        model predicts the day as an ordinary weekday. The model itself is
        untouched; only its inputs change.

    holiday_coverage(holidays, end_date) -> dict
        last_known_holiday, covered, message  (message is None when covered)

Loads the trained LightGBM booster from models/volume_lgbm.txt and its
metadata (train_start, feature list, level_factor). Predicted calls are
multiplied by level_factor (1.0 when absent). Features come from
db.features.build_features, the same function training used, anchored to
the training epoch so the trend index lines up. AHT comes from db.aht.

The booster, its metadata, and one AHT table per recency preset are cached
in this module, keyed on the model file's mtime. A retrain (new mtime)
refreshes all of them on the next call; slider drags between retrains reuse
them.

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

from db.aht import DEFAULT_RECENCY, RECENCY_HALFLIFE_DAYS, estimate_aht  # noqa: E402
from db.features import HOLIDAY_WINDOW_DAYS, build_features, load_holidays  # noqa: E402
from db.train import METADATA_PATH, MODEL_PATH  # noqa: E402

OUTPUT_COLUMNS = ("hour_start", "predicted_offered", "predicted_aht_sec")
LAST_HOUR_OF_DAY = 23

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
    # Validate the minimum inference contract explicitly before any feature
    # indexing, so a stale or incomplete artifact fails with a useful message.
    metadata = json.loads(METADATA_PATH.read_text())
    for key in ("train_start", "features"):
        if key not in metadata:
            raise ValueError(f"{METADATA_PATH} is missing `{key}`")
    return metadata


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

    # A model replacement invalidates the booster, metadata and every
    # recency-specific AHT table as one coherent cache generation.
    mtime = MODEL_PATH.stat().st_mtime
    if _cache["mtime"] != mtime:
        _cache = {
            "mtime": mtime,
            "booster": lgb.Booster(model_file=str(MODEL_PATH)),
            "metadata": _read_metadata(),
            "aht": {},
        }
    if recency not in _cache["aht"]:
        tables = {**_cache["aht"], recency: estimate_aht(conn, RECENCY_HALFLIFE_DAYS[recency])}
        _cache = {**_cache, "aht": tables}
    return _cache["booster"], _cache["metadata"], _cache["aht"][recency]


# =============================================================================
# Holiday coverage
# =============================================================================

def holiday_coverage(holidays: pd.DataFrame, end_date) -> dict:
    """Whether the holidays table reaches end_date. Pure; no side effects."""
    # Compare normalized calendar dates; timestamps within the final date
    # should not make a covered forecast appear to extend beyond the calendar.
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
    # Adding 23 hours includes the final date's last hourly start while keeping
    # the requested end date inclusive.
    hours = pd.date_range(start, end + pd.Timedelta(hours=LAST_HOUR_OF_DAY), freq="h")
    return pd.DataFrame({"hour_start": hours})


def aht_table(conn, recency: str = DEFAULT_RECENCY) -> dict:
    """The cached {(dow, hour): agent_sec} table for a recency preset."""
    return _load_cached(conn, recency)[2]


def _without_holidays(featured: pd.DataFrame) -> pd.DataFrame:
    """The same rows with holiday features set to their 'no holiday nearby'
    values: flag 0, and distance at the clip limit, which is what the model
    saw for every ordinary hour more than two weeks from a holiday."""
    # This represents the model's ordinary-day inputs, not removal of the
    # trained columns; preserving schema keeps prediction compatible.
    return featured.assign(is_holiday=0, days_to_nearest_holiday=HOLIDAY_WINDOW_DAYS)


def forecast_range(conn, start_date: date | str, end_date: date | str,
                   recency: str = DEFAULT_RECENCY, include_holidays: bool = True) -> pd.DataFrame:
    """Predicted offered calls and AHT for every hour from start_date 00:00
    through end_date 23:00 (both dates inclusive)."""
    booster, metadata, aht_by_cell = _load_cached(conn, recency)
    holidays = load_holidays(conn)

    # Coverage is returned even if the caller neutralizes holiday features, so
    # the UI can still explain whether holiday data is current.
    coverage = holiday_coverage(holidays, end_date)
    if coverage["message"]:
        _warn_once(coverage["message"])

    grid = _hourly_grid(start_date, end_date)
    featured = build_features(grid, holidays, epoch=metadata["train_start"])
    if not include_holidays:
        featured = _without_holidays(featured)

    # Respect the exact trained feature list and order; this is part of the
    # serialized model contract, not a feature set to infer at runtime.
    features = metadata["features"]
    missing = [f for f in features if f not in featured.columns]
    if missing:
        raise ValueError(f"build_features did not produce trained features: {missing}")

    # Capped recent level correction chosen at training time (db.calibration).
    # Older metadata without the key means no correction.
    predicted_offered = booster.predict(featured[features]) * float(metadata.get("level_factor", 1.0))
    predicted_aht = [
        aht_by_cell[(int(dow), int(hour))]
        for dow, hour in zip(featured["dow"], featured["hour"])
    ]

    return pd.DataFrame({
        "hour_start": featured["hour_start"].to_numpy(),
        "predicted_offered": predicted_offered,
        "predicted_aht_sec": predicted_aht,
    })


# This module is the inference boundary between the persisted training
# artifacts and the rest of the application. It validates model metadata,
# builds a complete inclusive hourly grid, runs the shared calendar/holiday
# feature builder, applies the saved level factor, and looks up AHT by
# weekday-hour and selected recency preset.
#
# db.staffing consumes the returned calls and AHT to calculate offered load
# and Erlang-based headcount; api.main then shapes those domain results for
# the browser. Booster, metadata and AHT results are cached for repeated
# requests, with model-file modification time invalidating the cache after a
# retrain. Missing artifacts and incompatible features remain explicit errors,
# rather than silently switching to a fallback forecast.
