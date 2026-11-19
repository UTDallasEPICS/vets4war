"""Shared pytest fixtures.

migrated_db builds the web app's schema WITHOUT Node: the drizzle migrations
of the repository (<repo>/drizzle/*.sql) applied in file-name order, split on
drizzle's statement marker. The tables are therefore exactly the ones the
app creates; nothing here defines a table of its own.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = REPO_ROOT / "drizzle"
STATEMENT_BREAKPOINT = "--> statement-breakpoint"


def apply_migrations(path: Path) -> Path:
    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        raise FileNotFoundError(f"no drizzle migrations in {MIGRATIONS}")
    conn = sqlite3.connect(path)
    try:
        for file in files:
            for statement in file.read_text().split(STATEMENT_BREAKPOINT):
                if statement.strip():
                    conn.execute(statement)
        conn.commit()
    finally:
        conn.close()
    return path


@pytest.fixture
def migrated_db(tmp_path) -> Path:
    """Path of an empty, migrated SQLite file."""
    return apply_migrations(tmp_path / "app.db")


# =============================================================================
# SYNTHETIC calls for tests (never real data)
# =============================================================================

CALL_COLUMNS = ("start_ts", "in_queue_sec", "agent_sec", "abandon_sec", "routing_sec", "abandoned")
# A day-shaped arrival rate: quiet nights, busy afternoons (calls per hour).
HOURLY_RATE = (3, 2, 2, 1, 1, 2, 4, 6, 8, 10, 11, 12, 12, 12, 11, 11, 10, 10, 9, 9, 8, 7, 5, 4)
WEEKEND_FACTOR = 0.8


def synthetic_calls(first_day: str, days: int, seed: int = 7) -> pd.DataFrame:
    """SYNTHETIC calls, every day from first_day, in the `calls` column layout:
    Poisson arrivals per hour, about 15% abandoned, handle time around 600 s."""
    rng = np.random.default_rng(seed)
    rows = []
    for day in pd.date_range(first_day, periods=days, freq="D"):
        factor = WEEKEND_FACTOR if day.dayofweek >= 5 else 1.0
        for hour, rate in enumerate(HOURLY_RATE):
            for _ in range(rng.poisson(rate * factor)):
                start = day + pd.Timedelta(hours=hour, seconds=int(rng.integers(0, 3600)))
                abandoned = bool(rng.random() < 0.15)
                wait = float(rng.integers(0, 300))
                rows.append((start, wait, 0.0 if abandoned else float(rng.integers(30, 1500)),
                             wait if abandoned else 0.0, float(rng.integers(5, 30)), abandoned))
    frame = pd.DataFrame(rows, columns=list(CALL_COLUMNS))
    return frame.sort_values("start_ts", kind="stable").reset_index(drop=True)


def insert_calls(path: Path, calls: pd.DataFrame, label: str = "SYNTHETIC test calls") -> int:
    """Write calls into a migrated test database the way an import does: one
    uploads row, the calls, data_state revision + 1, in one transaction.
    Returns the upload id."""
    conn = sqlite3.connect(path, isolation_level=None)
    try:
        conn.execute("BEGIN IMMEDIATE")
        upload_id = conn.execute(
            "INSERT INTO uploads (source, status, filename, file_sha256, file_bytes, uploaded_by_label, created_at) "
            "VALUES ('upload', 'imported', ?, 'test', 0, 'cli', 0)", (label,)).lastrowid
        conn.executemany(
            "INSERT INTO calls (start_ts, in_queue_sec, agent_sec, abandon_sec, routing_sec, abandoned, upload_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(row.start_ts.strftime("%Y-%m-%dT%H:%M:%S"),
              *(None if pd.isna(value) else float(value)
                for value in (row.in_queue_sec, row.agent_sec, row.abandon_sec, row.routing_sec)),
              int(row.abandoned), upload_id) for row in calls.itertuples(index=False)])
        conn.execute(
            "INSERT INTO data_state (id, calls_revision, updated_at) VALUES (1, 1, 0) "
            "ON CONFLICT(id) DO UPDATE SET calls_revision = calls_revision + 1")
        conn.execute("COMMIT")
    finally:
        conn.close()
    return int(upload_id)


# The seeded database most read-only tests share: 120 days of SYNTHETIC
# calls from a Monday, and the official holidays of their year.
SEEDED_FIRST_DAY = "2026-01-05"
SEEDED_DAYS = 120


@pytest.fixture(scope="session")
def seeded_db(tmp_path_factory) -> Path:
    """A migrated database holding SYNTHETIC calls and the 2026 holidays.
    Shared by the whole session: tests must only read it."""
    from db.add_holidays import official_holidays

    path = apply_migrations(tmp_path_factory.mktemp("seeded") / "app.db")
    insert_calls(path, synthetic_calls(SEEDED_FIRST_DAY, SEEDED_DAYS))
    holidays = official_holidays(2026)
    conn = sqlite3.connect(path)
    conn.executemany("INSERT INTO holidays (holiday_date, holiday_name) VALUES (?, ?)",
                     [(day.strftime("%Y-%m-%d"), name) for day, name in zip(holidays["holiday_date"],
                                                                             holidays["holiday_name"])])
    conn.commit()
    conn.close()
    return path
