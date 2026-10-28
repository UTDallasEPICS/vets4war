"""Feature engineering for the Vets4Warriors hourly call-volume model.

This is the ONLY place feature logic lives. Training and prediction both
call build_features(), so the two can never drift apart.

    build_features(df, holidays) -> df with feature columns added
    load_hourly(conn)            -> hourly counts aggregated from `calls`
    load_holidays(conn)          -> the holidays table

Deliberate omissions:
  * No lag features. The model forecasts 30 days out; lagged actuals would
    not exist at prediction time.
  * Holiday rows are kept, not dropped. The model learns them from the
    is_holiday flag and days_to_nearest_holiday.
  * No holiday multipliers. The holidays table has none measured (all NULL),
    so the model learns each holiday's effect from the data instead.

The database is shared with teammates and is read as-is: no views, generated
columns or constraints are added. Weekday and hour are derived here in pandas.
Connection comes from $V4W_DATABASE_URL.
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg
except ImportError:
    sys.exit("psycopg is required:  pip install 'psycopg[binary]'")


# days_to_nearest_holiday is clipped to this window. Beyond two weeks the
# distance carries no signal and would only stretch the feature's range.
HOLIDAY_WINDOW_DAYS = 14

HOURS_PER_DAY = 24
DAYS_PER_WEEK = 7
SATURDAY_ISODOW = 6

REQUIRED_HOLIDAY_COLUMNS = ("holiday_date",)

# Service-level rule, defined once: answered and waited at most this long.
SERVICE_LEVEL_SEC = 30

# Hourly grain, aggregated straight from `calls`. Hours with no calls have no
# row here; db.train.complete_hourly_grid zero-fills them.
HOURLY_SQL = f"""
    SELECT
        date_trunc('hour', start_ts)                                             AS hour_start,
        count(*)::int                                                            AS offered,
        count(*) FILTER (WHERE NOT abandoned)::int                               AS answered,
        count(*) FILTER (WHERE abandoned)::int                                   AS abandoned,
        count(*) FILTER (WHERE NOT abandoned
                           AND in_queue_sec <= {SERVICE_LEVEL_SEC})::int         AS answered_30s,
        coalesce(sum(agent_sec), 0)::float                                       AS talk_sec
    FROM calls
    GROUP BY 1
    ORDER BY 1
"""


# =============================================================================
# Loading
# =============================================================================

def _read_table(conn, sql: str) -> pd.DataFrame:
    """Run one SELECT and return a DataFrame with the cursor's column names.

    Uses a plain cursor rather than pd.read_sql so psycopg3 connections
    work without SQLAlchemy.
    """
    with conn.cursor() as cur:
        # Capture names before fetching so returned records stay aligned with
        # the database's SELECT order without requiring an ORM or SQLAlchemy.
        cur.execute(sql)
        columns = [d.name for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=columns)


def load_hourly(conn) -> pd.DataFrame:
    """One row per hour that had at least one call: hour_start, offered,
    answered, abandoned, answered_30s, talk_sec. Ordered by hour_start."""
    df = _read_table(conn, HOURLY_SQL)
    # An empty source cannot produce either training labels or useful features;
    # fail here rather than letting downstream reductions operate on emptiness.
    if df.empty:
        raise ValueError("`calls` is empty; nothing to aggregate")
    df["hour_start"] = pd.to_datetime(df["hour_start"])
    return df


def load_holidays(conn) -> pd.DataFrame:
    """Every row of the holidays table, ordered by date."""
    # Preserve optional calendar columns (such as holiday_name) for consumers
    # while normalizing the date type used by feature calculations.
    df = _read_table(conn, "SELECT * FROM holidays ORDER BY holiday_date")
    df["holiday_date"] = pd.to_datetime(df["holiday_date"])
    return df


# =============================================================================
# Features
# =============================================================================

def _validate_inputs(df: pd.DataFrame, holidays: pd.DataFrame) -> None:
    # Fail early with an actionable message instead of allowing pandas date
    # operations below to produce misleading or misaligned features.
    if "hour_start" not in df.columns:
        raise ValueError("df must have an `hour_start` column")
    if not pd.api.types.is_datetime64_any_dtype(df["hour_start"]):
        raise ValueError("df.hour_start must be a datetime column")
    if df["hour_start"].isna().any():
        raise ValueError("df.hour_start contains nulls")
    missing = [c for c in REQUIRED_HOLIDAY_COLUMNS if c not in holidays.columns]
    if missing:
        raise ValueError(f"holidays is missing columns: {missing}")
    if len(holidays) == 0:
        raise ValueError(
            "holidays is empty; days_to_nearest_holiday is undefined"
        )


def _calendar_features(hour_start: pd.Series, epoch: pd.Timestamp) -> pd.DataFrame:
    """dow, hour, month, week_of_year, trend index, cyclic encodings, weekend."""
    # Keep both integer calendar identifiers (for tree splits) and cyclic
    # encodings (so adjacent times remain mathematically close).
    dow = hour_start.dt.isocalendar().day.astype("int64")       # 1=Mon..7=Sun
    hour = hour_start.dt.hour.astype("int64")
    # Day-of-month supports the deliberately coarse payday window below;
    # it is not used as a high-cardinality exact-date identifier.
    day = hour_start.dt.day.astype("int64")

    return pd.DataFrame({
        "dow": dow,
        "hour": hour,
        "month": hour_start.dt.month.astype("int64"),
        "week_of_year": hour_start.dt.isocalendar().week.astype("int64"),
        # The caller supplies the training epoch at inference so this trend
        # coordinate remains in the same frame as the values learned by trees.
        "days_since_epoch": (hour_start.dt.normalize() - epoch).dt.days.astype("int64"),
        "hour_sin": np.sin(2 * np.pi * hour / HOURS_PER_DAY),
        "hour_cos": np.cos(2 * np.pi * hour / HOURS_PER_DAY),
        "dow_sin": np.sin(2 * np.pi * (dow - 1) / DAYS_PER_WEEK),
        "dow_cos": np.cos(2 * np.pi * (dow - 1) / DAYS_PER_WEEK),
        "is_weekend": (dow >= SATURDAY_ISODOW).astype("int64"),
        "is_sunday": (dow == 7).astype("int64"),
        "is_evening_peak": ((hour >= 16) & (hour <= 20)).astype("int64"),
        "sunday_evening": ((dow == 7) & (hour >= 16) & (hour <= 20)).astype("int64"),
        "is_payday_window": day.isin([1, 2, 3, 14, 15, 16]).astype("int64"),
    }, index=hour_start.index)


def _days_to_nearest_holiday(dates: pd.Series, holiday_dates: np.ndarray) -> pd.Series:
    """Signed days from each date to the nearest holiday.

    Positive = holiday is ahead, negative = holiday has passed, 0 = today.
    Ties go to the upcoming holiday. Clipped to +/- HOLIDAY_WINDOW_DAYS.
    """
    # Integer day coordinates make the nearest previous/next holiday lookup
    # vectorized and avoid a per-row scan through the calendar.
    day_values = dates.to_numpy(dtype="datetime64[D]").astype("int64")
    holiday_values = np.sort(holiday_dates.astype("datetime64[D]").astype("int64"))

    next_idx = np.searchsorted(holiday_values, day_values, side="left")
    prev_idx = next_idx - 1

    has_next = next_idx < len(holiday_values)
    has_prev = prev_idx >= 0

    to_next = np.where(
        has_next,
        holiday_values[np.minimum(next_idx, len(holiday_values) - 1)] - day_values,
        np.iinfo("int64").max,
    )
    to_prev = np.where(
        has_prev,
        holiday_values[np.maximum(prev_idx, 0)] - day_values,
        np.iinfo("int64").min,
    )

    # On an equal-distance tie, prefer the next holiday for deterministic
    # signed values on both sides of the calendar.
    pick_next = np.abs(to_next) <= np.abs(to_prev)
    signed = np.where(pick_next, to_next, to_prev)
    clipped = np.clip(signed, -HOLIDAY_WINDOW_DAYS, HOLIDAY_WINDOW_DAYS)
    return pd.Series(clipped.astype("int64"), index=dates.index)


def _holiday_features(hour_start: pd.Series, holidays: pd.DataFrame) -> pd.DataFrame:
    """is_holiday and days_to_nearest_holiday. The model learns each
    holiday's size from the flag; no multipliers are read from the table."""
    calendar = holidays.copy()
    # Normalize and deduplicate so time-of-day or repeated holiday records
    # cannot change whether a calendar date is considered a holiday.
    calendar["holiday_date"] = pd.to_datetime(calendar["holiday_date"]).dt.normalize()
    calendar = calendar.drop_duplicates(subset="holiday_date")

    # Work at date granularity: holiday rows and call hours can carry different
    # time components, but holiday membership is a property of the whole day.
    row_dates = hour_start.dt.normalize()
    holiday_dates = calendar["holiday_date"]

    return pd.DataFrame({
        "is_holiday": row_dates.isin(holiday_dates).astype("int64"),
        "days_to_nearest_holiday": _days_to_nearest_holiday(
            row_dates, holiday_dates.to_numpy()
        ),
    }, index=hour_start.index)


def build_features(
    df: pd.DataFrame,
    holidays: pd.DataFrame,
    epoch: pd.Timestamp | str | None = None,
) -> pd.DataFrame:
    """Return a NEW DataFrame: every input column plus the feature columns.

    Input `df` needs a datetime column `hour_start`. Input `holidays` needs
    holiday_date. Neither input is mutated. Row count and order are preserved.

    `epoch` anchors days_since_epoch. Training leaves it None (= the data's
    first day, recorded in models/metadata.json as train_start). Prediction
    MUST pass that recorded train_start, otherwise the trend index restarts
    at 0 and the model forecasts the past.
    """
    _validate_inputs(df, holidays)

    # Normalize timestamps once and anchor trend features consistently; at
    # inference the caller supplies the training epoch recorded in metadata.
    hour_start = pd.to_datetime(df["hour_start"])
    anchor = hour_start.min() if epoch is None else pd.Timestamp(epoch)
    calendar = _calendar_features(hour_start, anchor.normalize())
    holiday = _holiday_features(hour_start, holidays)

    # Concatenation preserves the caller's original data and row/index order.
    return pd.concat([df, calendar, holiday], axis=1)


# This module is the shared feature contract for both offline model fitting and
# live forecast generation. It defines calendar encodings, the stable trend
# coordinate, and holiday proximity, with input checks that catch malformed
# timestamps or an unusable holiday calendar before the model is invoked.
#
# The database loaders aggregate historical calls and retrieve holiday records;
# build_features enriches those hourly rows without modifying the caller's
# frame. db.train uses the resulting columns to fit and validate LightGBM,
# while db.forecast calls the same builder with the persisted training epoch.
# That shared path is essential: a feature definition or anchor mismatch would
# make otherwise valid saved models receive different inputs in production.
