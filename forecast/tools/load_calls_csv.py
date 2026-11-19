#!/usr/bin/env python3
"""Load a SYNTHETIC calls CSV into a SCRATCH database. A test tool, not an importer.

    cd forecast && .venv/bin/python tools/load_calls_csv.py --db PATH FILE.csv.gz [--label TEXT]

FILE is a calls CSV as tools/make_workbooks.py writes it (start_ts,
in_queue_sec, agent_sec, abandon_sec, routing_sec, abandoned). The database
must already be migrated (pnpm db:migrate with DATABASE_URL=file:PATH).

In ONE transaction, the way the web app's import leaves the tables:
    uploads     one row: source 'upload', status 'imported', filename = the
                file name (or --label), file_sha256 and size of the file,
                uploaded_by_label 'cli', timestamps now, total_rows,
                first_day, last_day
    calls       every row, with that upload_id, start_ts 'YYYY-MM-DDTHH:MM:SS'
    data_state  calls_revision + 1 (row 1 is created when missing)
Refuses (exit 1, nothing written) when any day of the file already has calls.

Production data comes in through the admin page of the web app, which checks
every day before importing. Use this only on a scratch database that no
server is using: for tests, parity runs and demos.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db import store  # noqa: E402

START_TS_FORMAT = "%Y-%m-%dT%H:%M:%S"
DURATIONS = ("in_queue_sec", "agent_sec", "abandon_sec", "routing_sec")


def _column(calls: pd.DataFrame, name: str) -> list:
    """Floats, with a missing value as None (SQL NULL)."""
    return [None if value != value else value for value in calls[name].astype("float64").tolist()]


def load(db_path: Path, csv_path: Path, label: str | None = None) -> dict:
    """Insert the file's calls as one imported upload. Returns a summary."""
    calls = pd.read_csv(csv_path, parse_dates=["start_ts"])
    if calls.empty:
        raise ValueError(f"{csv_path.name} has no calls")
    if calls["abandoned"].dtype != bool:
        raise ValueError(f"{csv_path.name}: `abandoned` must be True/False in every row")
    calls = calls.sort_values("start_ts", kind="stable").reset_index(drop=True)
    days = calls["start_ts"].dt.strftime("%Y-%m-%d")
    first_day, last_day = days.min(), days.max()
    content = csv_path.read_bytes()
    now = store.now_seconds()
    rows = list(zip(calls["start_ts"].dt.strftime(START_TS_FORMAT).tolist(),
                    *(_column(calls, name) for name in DURATIONS),
                    calls["abandoned"].astype("int64").tolist()))

    conn = store.connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            present = {day for (day,) in conn.execute(
                "SELECT DISTINCT substr(start_ts, 1, 10) FROM calls WHERE start_ts >= ? AND start_ts < ?",
                (first_day, (pd.Timestamp(last_day) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")))}
            overlap = sorted(present & set(days))
            if overlap:
                raise ValueError(f"the database already has calls on {len(overlap)} day(s) of this file "
                                 f"({overlap[0]} to {overlap[-1]}); nothing loaded")
            upload_id = conn.execute(
                "INSERT INTO uploads (source, status, filename, file_sha256, file_bytes, uploaded_by_label, "
                "created_at, parsed_at, imported_at, imported_by_label, total_rows, first_day, last_day) "
                "VALUES ('upload', 'imported', ?, ?, ?, 'cli', ?, ?, ?, 'cli', ?, ?, ?)",
                (label or csv_path.name, hashlib.sha256(content).hexdigest(), len(content), now, now, now,
                 len(rows), first_day, last_day)).lastrowid
            conn.executemany(
                "INSERT INTO calls (start_ts, in_queue_sec, agent_sec, abandon_sec, routing_sec, abandoned, upload_id) "
                f"VALUES (?, ?, ?, ?, ?, ?, {int(upload_id)})", rows)
            if conn.execute("UPDATE data_state SET calls_revision = calls_revision + 1, updated_at = ? WHERE id = 1",
                            (now,)).rowcount == 0:
                conn.execute("INSERT INTO data_state (id, calls_revision, rerun_requested, updated_at) "
                             "VALUES (1, 1, 0, ?)", (now,))
            revision = conn.execute("SELECT calls_revision FROM data_state WHERE id = 1").fetchone()[0]
            conn.execute("COMMIT")
        except BaseException:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return {"upload_id": int(upload_id), "calls": len(rows), "first_day": first_day, "last_day": last_day,
            "calls_revision": int(revision)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Load a SYNTHETIC calls CSV into a scratch database (test tool).")
    parser.add_argument("--db", type=Path, required=True, help="a migrated scratch SQLite file")
    parser.add_argument("csv", type=Path, help="calls CSV (.csv or .csv.gz)")
    parser.add_argument("--label", default=None, help="name shown for the upload (default: the file name)")
    args = parser.parse_args(argv)
    try:
        summary = load(args.db, args.csv, args.label)
    except (ValueError, FileNotFoundError, store.DatabaseError) as error:
        print(f"not loaded: {error}", file=sys.stderr)
        return 1
    print(f"loaded {summary['calls']:,} calls, {summary['first_day']} to {summary['last_day']} "
          f"(upload {summary['upload_id']}, data revision {summary['calls_revision']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
