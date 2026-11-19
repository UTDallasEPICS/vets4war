"""Parity tool: fill the forecast tables of a SCRATCH SQLite file from the legacy stack.

NOT part of the app, never run against a database a server is using. It exists for
parity rung P3 (docs/testing.md): the OLD final-main code computes, against
the legacy Postgres of the SYNTHETIC reference stack, exactly what the new Python
retrain script writes (docs/architecture.md), so the new TypeScript read API can be
compared with the old API's recorded answers before the new pipeline exists.

Run it from a checkout of the OLD app (final-main) that holds its trained model, so
that folder's `db` package and its `models/` are the ones imported, with the OLD
app's pinned Python environment:

    cd <old app folder> && PYTHON_DOTENV_DISABLED=1 V4W_DATA_SOURCE=synthetic \\
      V4W_DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/<database> \\
      <old app's python> <this repo>/scripts/parity/legacy_export.py \\
      --out <scratch.db> --today 2026-11-19

The output file must already be migrated (`DATABASE_URL=file:<out> pnpm db:migrate`).
Every table this tool writes is emptied first, then filled in ONE transaction:
holidays, forecast_hours, forecast_cells, model_artifacts, forecast_runs,
forecast_state, data_state. Only aggregates are written: no call record.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# The legacy app folder (the current directory) must win over anything else named `db`.
sys.path.insert(0, os.getcwd())

import psycopg  # noqa: E402

from db.aht import RECENCY_HALFLIFE_DAYS, RECENCY_OPTIONS  # noqa: E402
from db.forecast import aht_table, forecast_range  # noqa: E402
from db.patience import estimate_patience  # noqa: E402
from db.quick_abandon import measure_quick_hangups  # noqa: E402
from db.real_calls import estimate_real_share  # noqa: E402
from db.train import METADATA_PATH, MODEL_PATH  # noqa: E402

DEFAULT_HORIZON_DAYS = 800
DOWS = range(1, 8)
HOURS = range(24)
EXPORT_MESSAGE = "Exported from the legacy stack for parity."
SQLITE_TIMEOUT_SEC = 30
WRITTEN_TABLES = (
    "forecast_state",
    "forecast_hours",
    "forecast_cells",
    "model_artifacts",
    "forecast_runs",
    "data_state",
    "holidays",
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", required=True, type=Path, help="migrated SQLite file to fill")
    parser.add_argument("--today", type=date.fromisoformat,
                        default=datetime.now(ZoneInfo("America/New_York")).date(),
                        help="YYYY-MM-DD; the forecast runs through max(today, last call day) + horizon")
    parser.add_argument("--horizon-days", type=int, default=DEFAULT_HORIZON_DAYS)
    return parser.parse_args(argv)


def unix_seconds(iso: str) -> int:
    return int(datetime.fromisoformat(iso).astimezone(timezone.utc).timestamp())


def read_legacy(conn, today: date, horizon_days: int) -> dict:
    """Everything the export writes, computed by the OLD code on one connection."""
    with conn.cursor() as cur:
        cur.execute("SELECT min(start_ts)::date, max(start_ts)::date, count(*) FROM calls")
        data_start, data_end, n_calls = cur.fetchone()
        cur.execute("SELECT holiday_date, holiday_name FROM holidays ORDER BY holiday_date")
        holidays = [(d.isoformat(), name) for d, name in cur.fetchall()]
    if not n_calls:
        raise SystemExit("legacy `calls` is empty; nothing to export")

    horizon_start = data_start
    horizon_end = max(today, data_end) + timedelta(days=horizon_days)
    with_holidays = forecast_range(conn, horizon_start, horizon_end, "weighted", True)
    without_holidays = forecast_range(conn, horizon_start, horizon_end, "weighted", False)
    if not with_holidays["hour_start"].equals(without_holidays["hour_start"]):
        raise SystemExit("the two forecast grids differ; refusing to export")
    hours = [
        (ts.strftime("%Y-%m-%d"), int(ts.hour), float(calls), float(calls_no_holidays))
        for ts, calls, calls_no_holidays in zip(
            with_holidays["hour_start"], with_holidays["predicted_offered"],
            without_holidays["predicted_offered"])
    ]

    cells = []
    for recency in RECENCY_OPTIONS:
        aht = aht_table(conn, recency)
        real_share = estimate_real_share(conn, RECENCY_HALFLIFE_DAYS[recency])
        cells.extend(
            (recency, dow, hour, float(aht[(dow, hour)]), float(real_share[(dow, hour)]))
            for dow in DOWS for hour in HOURS
        )

    return {
        "data_start": data_start.isoformat(),
        "data_end": data_end.isoformat(),
        "n_calls": int(n_calls),
        "horizon_start": horizon_start.isoformat(),
        "horizon_end": horizon_end.isoformat(),
        "holidays": holidays,
        "hours": hours,
        "cells": cells,
        "patience": estimate_patience(conn),
        "quick_hangups": measure_quick_hangups(conn),
    }


def write_sqlite(path: Path, legacy: dict) -> dict:
    model_bytes = MODEL_PATH.read_bytes()
    metadata = json.loads(METADATA_PATH.read_text())
    sha = hashlib.sha256(model_bytes).hexdigest()
    if metadata.get("model_sha256") not in (None, sha):
        raise SystemExit(f"{MODEL_PATH} does not match {METADATA_PATH}")
    now = int(time.time())

    db = sqlite3.connect(path, timeout=SQLITE_TIMEOUT_SEC, isolation_level=None)
    try:
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("BEGIN IMMEDIATE")
        for table in WRITTEN_TABLES:
            db.execute(f"DELETE FROM {table}")  # noqa: S608 (fixed names)
        db.executemany("INSERT INTO holidays (holiday_date, holiday_name) VALUES (?, ?)",
                       legacy["holidays"])
        db.executemany(
            "INSERT INTO forecast_hours (date, hour, predicted_calls, predicted_calls_no_holidays) "
            "VALUES (?, ?, ?, ?)", legacy["hours"])
        db.executemany(
            "INSERT INTO forecast_cells (recency, dow, hour, aht_sec, real_share) VALUES (?, ?, ?, ?, ?)",
            legacy["cells"])
        run_id = db.execute(
            "INSERT INTO forecast_runs (trigger, mode, status, requested_by_label, created_at, "
            "started_at, finished_at, calls_revision, calls_count, data_start, data_end, trained, "
            "gate_passed, gate_json, forecast_written, horizon_start, horizon_end, message) "
            "VALUES ('cli', 'full', 'succeeded', 'cli', ?, ?, ?, 1, ?, ?, ?, 1, 1, ?, 1, ?, ?, ?)",
            (now, now, now, legacy["n_calls"], legacy["data_start"], legacy["data_end"],
             json.dumps(metadata["gate"]), legacy["horizon_start"], legacy["horizon_end"],
             EXPORT_MESSAGE),
        ).lastrowid
        model_id = db.execute(
            "INSERT INTO model_artifacts (run_id, created_at, model_sha256, model_text, metadata_json, "
            "train_start, train_end, train_rows) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (run_id, unix_seconds(metadata["created_at_utc"]), sha, model_bytes.decode("utf-8"),
             json.dumps(metadata), metadata["train_start"], metadata["train_end"],
             int(metadata["train_rows"])),
        ).lastrowid
        db.execute("UPDATE forecast_runs SET model_id = ? WHERE id = ?", (model_id, run_id))
        patience = legacy["patience"]
        db.execute(
            "INSERT INTO forecast_state (id, run_id, model_id, generated_at, calls_revision, calls_count, "
            "data_start, data_end, horizon_start, horizon_end, patience_sec, patience_n_abandoned, "
            "patience_n_calls, quick_hangups_json) VALUES (1, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (run_id, model_id, now, legacy["n_calls"], legacy["data_start"], legacy["data_end"],
             legacy["horizon_start"], legacy["horizon_end"], float(patience["patience_sec"]),
             int(patience["n_abandoned"]), int(patience["n_calls"]),
             json.dumps(legacy["quick_hangups"])),
        )
        db.execute("INSERT INTO data_state (id, calls_revision, rerun_requested, updated_at) "
                   "VALUES (1, 1, 0, ?)", (now,))
        db.execute("COMMIT")
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        raise
    finally:
        db.close()
    return {"run_id": run_id, "model_id": model_id, "model_sha256": sha}


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.out.exists():
        raise SystemExit(f"{args.out} does not exist; migrate it first (pnpm db:migrate)")
    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        raise SystemExit("V4W_DATABASE_URL is not set (the legacy Postgres)")
    started = time.monotonic()
    with psycopg.connect(dsn) as conn:
        legacy = read_legacy(conn, args.today, args.horizon_days)
    written = write_sqlite(args.out, legacy)
    print(json.dumps({
        **written,
        "hours": len(legacy["hours"]),
        "cells": len(legacy["cells"]),
        "holidays": len(legacy["holidays"]),
        "horizon": [legacy["horizon_start"], legacy["horizon_end"]],
        "data": [legacy["data_start"], legacy["data_end"], legacy["n_calls"]],
        "seconds": round(time.monotonic() - started, 1),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
