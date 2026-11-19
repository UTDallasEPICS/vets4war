"""Parse the partner's call records into the `calls` column layout.

The partner sends every new period in the same layout as the original
five-year export: one row per call with these columns

    Skill_Name, Start_Date, start_time, InQueue, Agent_Time,
    Abandon_Time, Routing_Time, Abandon (Y/N)

    parse_call_records(raw) -> DataFrame in `calls` column order

Timestamps are local Eastern wall-clock time, the same convention as the
rows already in `calls` (verified 2026-10-11: hour 2 empty on spring-forward
Sundays).

Loading calls into the database is the web app's job now (upload on the
admin page); this module only parses. db.client_files reads both workbook
layouts with it, and the app's TypeScript parser is checked against it.
"""

from __future__ import annotations

import pandas as pd

REQUIRED_COLUMNS = (
    "Start_Date", "start_time", "InQueue", "Agent_Time",
    "Abandon_Time", "Routing_Time", "Abandon",
)
ABANDON_FLAGS = {"Y": True, "N": False}
CALLS_COLUMNS = ("start_ts", "in_queue_sec", "agent_sec", "abandon_sec", "routing_sec", "abandoned")
SECONDS_COLUMNS = {
    "InQueue": "in_queue_sec",
    "Agent_Time": "agent_sec",
    "Abandon_Time": "abandon_sec",
    "Routing_Time": "routing_sec",
}
# Excel rows are 1-based and the first row is the header.
EXCEL_ROW_OFFSET = 2
MAX_ROWS_IN_ERROR = 10


# =============================================================================
# Parsing (pure)
# =============================================================================

def _validate_columns(raw: pd.DataFrame) -> None:
    missing = [c for c in REQUIRED_COLUMNS if c not in raw.columns]
    if missing:
        raise ValueError(f"file is missing columns {missing}; expected the partner call-records layout")
    if raw.empty:
        raise ValueError("file has no call rows")


def _start_timestamps(raw: pd.DataFrame) -> pd.Series:
    """Start_Date (a date) + start_time (HH:MM:SS) -> naive local timestamp."""
    day = pd.to_datetime(raw["Start_Date"], errors="coerce").dt.normalize()
    clock = pd.to_timedelta(raw["start_time"].astype(str), errors="coerce")
    stamps = day + clock
    bad = stamps.isna()
    if bad.any():
        rows = (raw.index[bad] + EXCEL_ROW_OFFSET).tolist()[:MAX_ROWS_IN_ERROR]
        raise ValueError(f"unreadable Start_Date/start_time on Excel rows {rows}")
    return stamps


def _abandoned_flags(raw: pd.DataFrame) -> pd.Series:
    flags = raw["Abandon"].astype(str).str.strip().str.upper()
    unknown = sorted(set(flags) - set(ABANDON_FLAGS))
    if unknown:
        raise ValueError(f"Abandon must be Y or N, found {unknown}")
    return flags.map(ABANDON_FLAGS).astype(bool)


def _seconds(raw: pd.DataFrame, column: str) -> pd.Series:
    values = pd.to_numeric(raw[column], errors="coerce")
    if values.isna().any():
        raise ValueError(f"{column} has non-numeric or empty values")
    if (values < 0).any():
        raise ValueError(f"{column} has negative values")
    return values.astype(float)


def parse_call_records(raw: pd.DataFrame) -> pd.DataFrame:
    """Return a NEW DataFrame in `calls` column order, sorted by start_ts.
    Raises ValueError with the reason on any malformed input."""
    _validate_columns(raw)
    parsed = pd.DataFrame({
        "start_ts": _start_timestamps(raw),
        **{dest: _seconds(raw, src) for src, dest in SECONDS_COLUMNS.items()},
        "abandoned": _abandoned_flags(raw),
    })
    return parsed[list(CALLS_COLUMNS)].sort_values("start_ts").reset_index(drop=True)
