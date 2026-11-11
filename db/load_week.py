"""Append a partner call-records Excel file to the shared `calls` table.

The partner sends every new period in the same layout as the original
five-year export: one row per call with these columns

    Skill_Name, Start_Date, start_time, InQueue, Agent_Time,
    Abandon_Time, Routing_Time, Abandon (Y/N)

    parse_call_records(raw)          -> DataFrame in `calls` column order
    insert_calls(conn, rows, commit) -> dict: rows, first/last day

Safety:
  * Dry run by default. Nothing is written without --commit.
  * Refuses to load if `calls` already has ANY row inside the file's date
    range, so loading the same file twice cannot duplicate calls.
  * id is an identity column; the database assigns it. The duplicate check
    and the insert run under one table lock in one transaction.
  * The schema is never altered. Only INSERT is issued.

Timestamps are local Eastern wall-clock time, the same convention as the
rows already in `calls` (verified 2026-10-11: hour 2 empty on spring-forward
Sundays).

Both client layouts are read (db.client_files): the raw export with the
calls on its only sheet, and the "Actual Data for Validity Testing"
workbook with the calls on a later sheet. A file cut off part-way through
a day is refused.

Run from the repo root:
    python -m db.load_week "path/to/file.xlsx"            # dry run
    python -m db.load_week "path/to/file.xlsx" --commit   # write
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg
except ImportError:
    sys.exit("psycopg is required:  pip install 'psycopg[binary]'")

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


class CallRecordsError(ValueError):
    """This is not a usable call-records file. The message names columns and
    Excel row numbers, never cell contents, so it is safe to show to whoever
    uploaded the file. Still a ValueError for callers that catch that."""


# =============================================================================
# Parsing (pure)
# =============================================================================

def _validate_columns(raw: pd.DataFrame) -> None:
    missing = [c for c in REQUIRED_COLUMNS if c not in raw.columns]
    if missing:
        raise CallRecordsError(f"file is missing columns {missing}; expected the partner call-records layout")
    if raw.empty:
        raise CallRecordsError("file has no call rows")


def _start_timestamps(raw: pd.DataFrame) -> pd.Series:
    """Start_Date (a date) + start_time (HH:MM:SS) -> naive local timestamp."""
    day = pd.to_datetime(raw["Start_Date"], errors="coerce").dt.normalize()
    clock = pd.to_timedelta(raw["start_time"].astype(str), errors="coerce")
    stamps = day + clock
    bad = stamps.isna()
    if bad.any():
        rows = (raw.index[bad] + EXCEL_ROW_OFFSET).tolist()[:MAX_ROWS_IN_ERROR]
        raise CallRecordsError(f"unreadable Start_Date/start_time on Excel rows {rows}")
    return stamps


def _abandoned_flags(raw: pd.DataFrame) -> pd.Series:
    flags = raw["Abandon"].astype(str).str.strip().str.upper()
    unknown = sorted(set(flags) - set(ABANDON_FLAGS))
    if unknown:
        raise CallRecordsError(f"Abandon must be Y or N on every row; {len(unknown)} other value(s) found")
    return flags.map(ABANDON_FLAGS).astype(bool)


def _seconds(raw: pd.DataFrame, column: str) -> pd.Series:
    values = pd.to_numeric(raw[column], errors="coerce")
    if values.isna().any():
        raise CallRecordsError(f"{column} has non-numeric or empty values")
    if (values < 0).any():
        raise CallRecordsError(f"{column} has negative values")
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


# =============================================================================
# Database
# =============================================================================

def _existing_rows(cur, first_day: pd.Timestamp, end_exclusive: pd.Timestamp) -> int:
    cur.execute(
        "SELECT count(*) FROM calls WHERE start_ts >= %s AND start_ts < %s",
        (first_day.to_pydatetime(), end_exclusive.to_pydatetime()),
    )
    return int(cur.fetchone()[0])


def insert_calls(conn, rows: pd.DataFrame, commit: bool = False) -> dict:
    """Insert `rows` (parse_call_records output). Dry run unless commit."""
    first_day = rows["start_ts"].min().normalize()
    end_exclusive = rows["start_ts"].max().normalize() + pd.Timedelta(days=1)
    last_day = end_exclusive - pd.Timedelta(days=1)
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("LOCK TABLE calls IN SHARE ROW EXCLUSIVE MODE")
            existing = _existing_rows(cur, first_day, end_exclusive)
            if existing:
                raise ValueError(
                    f"`calls` already has {existing} rows between {first_day.date()} and "
                    f"{last_day.date()}; refusing to load twice"
                )
            summary = {
                "rows": len(rows),
                "first_day": str(first_day.date()),
                "last_day": str(last_day.date()),
                "committed": commit,
            }
            if not commit:
                return summary
            records = [
                (r.start_ts.to_pydatetime(), r.in_queue_sec, r.agent_sec,
                 r.abandon_sec, r.routing_sec, bool(r.abandoned))
                for r in rows.itertuples(index=False)
            ]
            # id is GENERATED ALWAYS AS IDENTITY: the database assigns it.
            cur.executemany(
                "INSERT INTO calls (start_ts, in_queue_sec, agent_sec, abandon_sec, routing_sec, abandoned) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                records,
            )
    return summary


# =============================================================================
# CLI
# =============================================================================

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("xlsx", type=Path, help="partner call-records Excel file")
    parser.add_argument("--commit", action="store_true", help="write the rows (default: dry run)")
    args = parser.parse_args()

    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        sys.exit("no connection string. set V4W_DATABASE_URL")
    if not args.xlsx.exists():
        sys.exit(f"file not found: {args.xlsx}")

    # Imported here: db.client_files itself imports this module's parser.
    from db.client_files import hourly_from_calls, read_call_records
    from db.dataset import partial_edge_days

    rows = read_call_records(args.xlsx)
    cut_short = partial_edge_days(hourly_from_calls(rows))
    if cut_short:
        sys.exit(f"{args.xlsx.name} starts or stops part-way through a day ({', '.join(cut_short)}); export whole days")
    print(f"parsed {len(rows):,} calls, {int(rows['abandoned'].sum()):,} abandoned, "
          f"{rows['start_ts'].min()} to {rows['start_ts'].max()}")
    with psycopg.connect(dsn) as conn:
        summary = insert_calls(conn, rows, commit=args.commit)
    print(summary)
    if not args.commit:
        print("dry run: nothing written. Re-run with --commit to insert.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
