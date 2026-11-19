"""The SQLite file the web app and this package share: the only module that talks to it.

    connect(path, readonly=False)        -> sqlite3.Connection (explicit transactions only)
    read_snapshot(conn)                  -> Snapshot(calls, calls_revision), one read transaction
    load_holidays(conn)                  -> holiday_date, holiday_name, by date
    insert_missing_holidays(conn, rows)  -> how many rows were new
    start_run(conn, run_id, ...)         -> claim the run row Node created, or insert a 'cli' one
    serving_model(conn)                  -> the model forecast_state points at, or None
    write_forecast(conn, ...)            -> model, forecast, derived numbers and run row in ONE transaction
    finish_run(conn, run_id, ...)        -> close a run that writes no forecast

The tables belong to the web app (server/db/schema.ts and its drizzle
migrations): nothing here creates or alters one. Python reads `calls`,
`data_state` and `holidays`, and writes the forecast and run tables.

Conventions of that schema: timestamps are unix SECONDS, booleans 0/1, JSON
columns hold json.dumps text, dates 'YYYY-MM-DD', call start times
'YYYY-MM-DDTHH:MM:SS' (naive Eastern wall-clock time, as exported).

Concurrency: the file keeps the rollback journal (never WAL: it may sit on a
network filesystem) and every connection waits up to BUSY_TIMEOUT_SEC for a
lock. Reads that must agree run in one read transaction; the forecast swap is
one `BEGIN IMMEDIATE ... COMMIT`, so a reader sees the old forecast or the
new one, never a mix. Plain SELECT / INSERT / UPDATE / DELETE only: the
image's SQLite is 3.40.
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

CALLS_COLUMNS = ("start_ts", "in_queue_sec", "agent_sec", "abandon_sec", "routing_sec", "abandoned")
DURATION_COLUMNS = CALLS_COLUMNS[1:5]
BUSY_TIMEOUT_SEC = 30
START_TS_FORMAT = "%Y-%m-%dT%H:%M:%S"
DATE_FORMAT = "%Y-%m-%d"
# Old model artifacts kept besides the serving one, for a look back after a
# retrain. Each is about 1.8 MB of model text.
KEEP_ARTIFACTS = 5
SINGLE_ROW_ID = 1

# Callers catch database failures through this name; only this module imports sqlite3.
DatabaseError = sqlite3.Error

# The forecast_runs columns a run may set on its own row.
RUN_COLUMNS = frozenset({
    "status", "finished_at", "calls_revision", "calls_count", "data_start", "data_end", "trained",
    "model_id", "gate_passed", "gate_json", "forecast_written", "horizon_start", "horizon_end", "message",
})
STATE_COLUMNS = (
    "run_id", "model_id", "generated_at", "calls_revision", "calls_count", "data_start", "data_end",
    "horizon_start", "horizon_end", "patience_sec", "patience_n_abandoned", "patience_n_calls",
    "quick_hangups_json",
)
MODEL_COLUMNS = ("model_sha256", "model_text", "metadata_json", "train_start", "train_end", "train_rows")
HOUR_COLUMNS = ("date", "hour", "predicted_calls", "predicted_calls_no_holidays")
CELL_COLUMNS = ("recency", "dow", "hour", "aht_sec", "real_share")


def now_seconds() -> int:
    """The schema's timestamp: whole unix seconds."""
    return int(time.time())


def _sql_value(value):
    """A Python value as the schema stores it: JSON text, 0/1, or as is."""
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value)
    if isinstance(value, (bool, np.bool_)):
        return int(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value)
    return value


# =============================================================================
# Connection and transactions
# =============================================================================

def connect(path: str | Path, *, readonly: bool = False) -> sqlite3.Connection:
    """Open the database file. Every transaction is explicit (BEGIN ... COMMIT).

    A missing file raises FileNotFoundError: sqlite would otherwise create an
    empty database, and a run against it would only report "no calls"."""
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"no database file at {path}")
    if readonly:
        conn = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True,
                               timeout=BUSY_TIMEOUT_SEC, isolation_level=None)
    else:
        conn = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_SEC, isolation_level=None)
    # The web app enforces foreign keys; so does every writer here.
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def _transaction(conn: sqlite3.Connection, write: bool):
    """BEGIN (IMMEDIATE when writing: take the write lock up front) ... COMMIT,
    ROLLBACK on any error and re-raise."""
    conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
    try:
        yield conn
    except BaseException:
        # SQLite may already have rolled back on its own (a full disk, for one).
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


# =============================================================================
# Reading
# =============================================================================

@dataclass(frozen=True)
class Snapshot:
    """Every call and the data revision they belong to, read together.

    calls: CALLS_COLUMNS ordered by start_ts, id. start_ts datetime64,
    durations float64 (NULL -> NaN), abandoned bool."""
    calls: pd.DataFrame
    calls_revision: int


def _calls_frame(rows: list[tuple]) -> pd.DataFrame:
    columns = list(zip(*rows)) if rows else [()] * len(CALLS_COLUMNS)
    frame = {"start_ts": pd.to_datetime(pd.Series(columns[0], dtype="object"), format=START_TS_FORMAT)}
    for name, values in zip(DURATION_COLUMNS, columns[1:5]):
        frame[name] = np.array(values, dtype="float64")       # None -> NaN
    frame["abandoned"] = np.array(columns[5], dtype=bool)
    return pd.DataFrame(frame, columns=list(CALLS_COLUMNS))


def _revision(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT calls_revision FROM data_state WHERE id = ?", (SINGLE_ROW_ID,)).fetchone()
    return int(row[0]) if row else 0


def calls_revision(conn: sqlite3.Connection) -> int:
    """data_state.calls_revision; 0 when the row does not exist yet."""
    return _revision(conn)


def read_snapshot(conn: sqlite3.Connection) -> Snapshot:
    """Every call plus the revision, in ONE read transaction, so an import
    that lands meanwhile is either entirely in or entirely out."""
    with _transaction(conn, write=False):
        revision = _revision(conn)
        rows = conn.execute(
            f"SELECT {', '.join(CALLS_COLUMNS)} FROM calls ORDER BY start_ts, id"
        ).fetchall()
    return Snapshot(calls=_calls_frame(rows), calls_revision=revision)


def load_holidays(conn: sqlite3.Connection) -> pd.DataFrame:
    """Every row of the holidays table, ordered by date."""
    rows = conn.execute("SELECT holiday_date, holiday_name FROM holidays ORDER BY holiday_date").fetchall()
    frame = pd.DataFrame(rows, columns=["holiday_date", "holiday_name"])
    frame["holiday_date"] = pd.to_datetime(frame["holiday_date"], format=DATE_FORMAT)
    return frame


@dataclass(frozen=True)
class ServingModel:
    model_id: int
    model_text: str
    metadata: dict


def serving_model_id(conn: sqlite3.Connection) -> int | None:
    row = conn.execute("SELECT model_id FROM forecast_state WHERE id = ?", (SINGLE_ROW_ID,)).fetchone()
    return int(row[0]) if row else None


def serving_model(conn: sqlite3.Connection) -> ServingModel | None:
    """The model forecast_state points at; None before the first forecast."""
    with _transaction(conn, write=False):
        model_id = serving_model_id(conn)
        if model_id is None:
            return None
        row = conn.execute("SELECT model_text, metadata_json FROM model_artifacts WHERE id = ?",
                           (model_id,)).fetchone()
    if row is None:
        raise ValueError(f"forecast_state names model {model_id}, which is not in model_artifacts")
    return ServingModel(model_id=model_id, model_text=row[0], metadata=json.loads(row[1]))


# =============================================================================
# Writing
# =============================================================================

def insert_missing_holidays(conn: sqlite3.Connection, rows: Iterable[tuple[str, str]]) -> int:
    """INSERT OR IGNORE (holiday_date 'YYYY-MM-DD', holiday_name) rows in one
    short transaction. Returns how many were new."""
    rows = list(rows)
    with _transaction(conn, write=True):
        before = conn.total_changes
        conn.executemany("INSERT OR IGNORE INTO holidays (holiday_date, holiday_name) VALUES (?, ?)", rows)
        return conn.total_changes - before


def _set_clause(columns: dict) -> tuple[str, list]:
    unknown = sorted(set(columns) - RUN_COLUMNS)
    if unknown:
        raise ValueError(f"not a forecast_runs column a run may set: {unknown}")
    names = sorted(columns)
    return ", ".join(f"{name} = ?" for name in names), [_sql_value(columns[name]) for name in names]


def _update_run(conn: sqlite3.Connection, run_id: int, columns: dict) -> None:
    clause, values = _set_clause(columns)
    cursor = conn.execute(f"UPDATE forecast_runs SET {clause} WHERE id = ?", [*values, run_id])
    if cursor.rowcount != 1:
        raise ValueError(f"forecast_runs has no row {run_id}")


def start_run(conn: sqlite3.Connection, run_id: int | None, *, mode: str, pid: int, calls_revision: int,
              calls_count: int, data_start: str | None, data_end: str | None) -> int:
    """Mark the run as running with what it read. With run_id, claim the row
    Node created (its trigger, creator and created_at stay); without, insert
    a row of a person at a shell (trigger 'cli'). Returns the run id."""
    now = now_seconds()
    read = (calls_revision, calls_count, data_start, data_end)
    with _transaction(conn, write=True):
        if run_id is None:
            cursor = conn.execute(
                "INSERT INTO forecast_runs (trigger, mode, status, requested_by_label, created_at, started_at, pid, "
                "calls_revision, calls_count, data_start, data_end) "
                "VALUES ('cli', ?, 'running', 'cli', ?, ?, ?, ?, ?, ?, ?)",
                (mode, now, now, pid, *read),
            )
            return int(cursor.lastrowid)
        cursor = conn.execute(
            "UPDATE forecast_runs SET status = 'running', started_at = COALESCE(started_at, ?), pid = ?, "
            "calls_revision = ?, calls_count = ?, data_start = ?, data_end = ? WHERE id = ?",
            (now, pid, *read, run_id),
        )
        if cursor.rowcount != 1:
            raise ValueError(f"forecast_runs has no row {run_id}")
        return run_id


def finish_run(conn: sqlite3.Connection, run_id: int, *, status: str, message: str, **columns) -> None:
    """Close a run that writes no forecast: status, message, finished_at now,
    plus any other run column given."""
    with _transaction(conn, write=True):
        _update_run(conn, run_id, {**columns, "status": status, "message": message, "finished_at": now_seconds()})


def _prune_artifacts(conn: sqlite3.Connection, serving_id: int) -> None:
    conn.execute(
        "DELETE FROM model_artifacts WHERE id <> ? AND id NOT IN "
        "(SELECT id FROM model_artifacts ORDER BY id DESC LIMIT ?)",
        (serving_id, KEEP_ARTIFACTS),
    )


def write_forecast(conn: sqlite3.Connection, *, run_id: int, new_model: dict | None,
                   hours: Iterable[tuple], cells: Iterable[tuple], state: dict, run: dict) -> int:
    """Swap in a whole forecast in ONE `BEGIN IMMEDIATE ... COMMIT`.

    new_model : MODEL_COLUMNS ('metadata_json' may be a dict), or None to
                keep serving state['model_id']
    hours     : (date, hour, predicted_calls, predicted_calls_no_holidays) rows
    cells     : (recency, dow, hour, aht_sec, real_share) rows
    state     : the forecast_state columns except id, run_id and model_id
                (model_id too when new_model is None)
    run       : run columns to set (RUN_COLUMNS); model_id is added here

    Every table is replaced whole, old artifacts beyond the newest
    KEEP_ARTIFACTS are deleted (never the serving one). On any error nothing
    is changed. Returns the serving model id."""
    hours, cells = list(hours), list(cells)
    with _transaction(conn, write=True):
        if new_model is not None:
            values = [_sql_value(new_model[name]) for name in MODEL_COLUMNS]
            cursor = conn.execute(
                f"INSERT INTO model_artifacts (run_id, created_at, {', '.join(MODEL_COLUMNS)}) "
                f"VALUES (?, ?, {', '.join('?' for _ in MODEL_COLUMNS)})",
                [run_id, now_seconds(), *values],
            )
            model_id = int(cursor.lastrowid)
        else:
            model_id = int(state["model_id"])
        conn.execute("DELETE FROM forecast_hours")
        conn.executemany(f"INSERT INTO forecast_hours ({', '.join(HOUR_COLUMNS)}) VALUES (?, ?, ?, ?)",
                         [tuple(_sql_value(v) for v in row) for row in hours])
        conn.execute("DELETE FROM forecast_cells")
        conn.executemany(f"INSERT INTO forecast_cells ({', '.join(CELL_COLUMNS)}) VALUES (?, ?, ?, ?, ?)",
                         [tuple(_sql_value(v) for v in row) for row in cells])
        full_state = {**state, "run_id": run_id, "model_id": model_id}
        conn.execute(
            f"INSERT OR REPLACE INTO forecast_state (id, {', '.join(STATE_COLUMNS)}) "
            f"VALUES (?, {', '.join('?' for _ in STATE_COLUMNS)})",
            [SINGLE_ROW_ID, *(_sql_value(full_state[name]) for name in STATE_COLUMNS)],
        )
        _update_run(conn, run_id, {**run, "model_id": model_id})
        _prune_artifacts(conn, model_id)
    return model_id
