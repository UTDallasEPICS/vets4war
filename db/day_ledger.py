"""What one calendar day of calls looks like, and how an uploaded day
compares with the same day in the database.

The unit of an upload is a whole calendar day, not a month. For every day in
a file the import has to decide one of three things:

    new        the database has no call on that day          -> insert it
    identical  the database holds exactly these calls        -> skip it
    conflict   the database holds different calls that day   -> do nothing,
               unless the admin explicitly asks to replace that day

"Exactly these calls" cannot be decided by an id: the client's export has no
call id. It is decided by a day summary: the number of rows, and a
fingerprint (SHA-256) of the day's rows in a fixed text form, sorted, so row
order does not matter. One row's text is

    2026-10-20T08:00:00|5.000|300.000|0.000|5.000|0

    start_ts to the second, then in_queue / agent / abandon / routing seconds
    to three decimals (a missing value is written as nothing, so it differs
    from 0), then abandoned as 1 or 0.

Three decimals because the database stores durations as floating point: a
value that went in as 10 must still read as 10 after a round trip, and
nothing in a call log is finer than a millisecond.

    summarize_days(calls)             {day: DaySummary(rows, fingerprint)}
    call_lines(calls)                 each call as its fingerprint line
    plan_days(file_days, current)     {day: NEW | IDENTICAL | CONFLICT}
    describe_plan(file_days, current) the same, as rows for a report or a page

Everything here is pure: no database, no files, inputs are never changed.
The caller (db/pipeline.py) reads the file and the database and hands both
in as frames with the `calls` columns.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date

import pandas as pd

NEW = "new"
IDENTICAL = "identical"
CONFLICT = "conflict"

CALL_COLUMNS = ("start_ts", "in_queue_sec", "agent_sec", "abandon_sec", "routing_sec", "abandoned")
DURATION_COLUMNS = ("in_queue_sec", "agent_sec", "abandon_sec", "routing_sec")
DURATION_DECIMALS = 3
TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%S"
NO_VALUE = ""
ROW_SEPARATOR = "\n"


@dataclass(frozen=True)
class DaySummary:
    rows: int
    fingerprint: str


def _duration_text(values: pd.Series) -> pd.Series:
    """Seconds to three decimals; a missing value becomes the empty text."""
    numbers = pd.to_numeric(values, errors="coerce")
    rounded = numbers.round(DURATION_DECIMALS) + 0.0  # -0.0 becomes 0.0, so both print alike
    text = rounded.map(lambda number: f"{number:.{DURATION_DECIMALS}f}")
    return text.where(numbers.notna(), NO_VALUE)


def _stamps(calls: pd.DataFrame) -> pd.Series:
    """start_ts as timestamps, whether it arrived as timestamps or ISO text
    (with or without fractions of a second)."""
    missing = [column for column in CALL_COLUMNS if column not in calls.columns]
    if missing:
        raise ValueError(f"calls frame is missing columns {missing}")
    stamps = calls["start_ts"]
    return stamps if pd.api.types.is_datetime64_any_dtype(stamps) else pd.to_datetime(stamps, format="ISO8601")


def _row_text(calls: pd.DataFrame, stamps: pd.Series) -> pd.Series:
    """Each call as the one line of text that gets fingerprinted."""
    parts = [stamps.dt.strftime(TIMESTAMP_FORMAT)]
    parts += [_duration_text(calls[column]) for column in DURATION_COLUMNS]
    parts.append(calls["abandoned"].astype(bool).map({True: "1", False: "0"}))
    return parts[0].str.cat(parts[1:], sep="|")


def _fingerprint(lines: pd.Series) -> str:
    return hashlib.sha256(ROW_SEPARATOR.join(sorted(lines)).encode()).hexdigest()


def call_lines(calls: pd.DataFrame) -> pd.Series:
    """Each call as its fingerprint line, indexed like `calls`. Two calls with
    the same line are the same call as far as this ledger can tell."""
    if calls.empty:
        return pd.Series(dtype="object", index=calls.index)
    return _row_text(calls, _stamps(calls))


def summarize_days(calls: pd.DataFrame) -> dict[date, DaySummary]:
    """Row count and fingerprint of every calendar day that has a call.
    `start_ts` may be timestamps or ISO text. Raises ValueError when a
    `calls` column is missing."""
    stamps = _stamps(calls)
    if calls.empty:
        return {}
    lines = _row_text(calls, stamps)
    return {day: DaySummary(len(day_lines), _fingerprint(day_lines))
            for day, day_lines in lines.groupby(stamps.dt.date)}


def plan_days(file_days: dict[date, DaySummary], current_days: dict[date, DaySummary]) -> dict[date, str]:
    """What to do with each day of the file, given what the database holds
    for those days. Days only the database has are not mentioned."""
    def status(day: date) -> str:
        if day not in current_days:
            return NEW
        return IDENTICAL if current_days[day] == file_days[day] else CONFLICT

    return {day: status(day) for day in file_days}


def describe_plan(file_days: dict[date, DaySummary], current_days: dict[date, DaySummary]) -> list[dict]:
    """The plan as plain rows, oldest day first: the day, how many rows the
    file has, how many the database has, and the status."""
    plan = plan_days(file_days, current_days)
    return [{"day": day.isoformat(), "rows": file_days[day].rows,
             "existing_rows": current_days[day].rows if day in current_days else 0,
             "status": plan[day]}
            for day in sorted(file_days)]
