"""The SYNTHETIC data tools: generator determinism and the scratch-database loader."""

from __future__ import annotations

import gzip
import hashlib
import sqlite3
import subprocess
import sys
from pathlib import Path

import pandas as pd

from conftest import synthetic_calls

FORECAST_DIR = Path(__file__).resolve().parents[1]
TOOLS = FORECAST_DIR / "tools"


def _tool(name: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(TOOLS / name), *args], cwd=FORECAST_DIR,
                          capture_output=True, text=True, timeout=300)


def _csv(path: Path, calls: pd.DataFrame) -> Path:
    calls.to_csv(path, index=False)
    return path


def test_the_generator_is_deterministic_and_names_its_output_synthetic(tmp_path):
    for folder in ("a", "b"):
        process = _tool("gen_synthetic.py", str(tmp_path / folder), "--start", "2026-01-01", "--end", "2026-01-20")
        assert process.returncode == 0, process.stderr

    files = [tmp_path / folder / "SYNTHETIC_calls_all.csv.gz" for folder in ("a", "b")]
    contents = [gzip.decompress(path.read_bytes()) for path in files]
    assert contents[0] == contents[1]
    assert contents[0].startswith(b"start_ts,in_queue_sec,agent_sec,abandon_sec,routing_sec,abandoned\n")


def test_the_loader_imports_one_upload_and_bumps_the_revision(migrated_db, tmp_path):
    first = _csv(tmp_path / "SYNTHETIC_first.csv", synthetic_calls("2026-03-02", 3))
    second = _csv(tmp_path / "SYNTHETIC_second.csv", synthetic_calls("2026-03-05", 2, seed=3))

    assert _tool("load_calls_csv.py", "--db", str(migrated_db), str(first)).returncode == 0
    process = _tool("load_calls_csv.py", "--db", str(migrated_db), str(second), "--label", "week two")

    conn = sqlite3.connect(migrated_db)
    uploads = conn.execute("SELECT id, source, status, filename, file_sha256, file_bytes, uploaded_by_label, "
                           "total_rows, first_day, last_day FROM uploads ORDER BY id").fetchall()
    calls = conn.execute("SELECT upload_id, count(*), min(start_ts), max(start_ts) FROM calls GROUP BY upload_id "
                         "ORDER BY upload_id").fetchall()
    revision = conn.execute("SELECT calls_revision FROM data_state WHERE id = 1").fetchone()[0]
    assert process.returncode == 0, process.stderr
    assert uploads[1][1:] == ("upload", "imported", "week two", hashlib.sha256(second.read_bytes()).hexdigest(),
                              second.stat().st_size, "cli", calls[1][1], "2026-03-05", "2026-03-06")
    assert uploads[0][3] == "SYNTHETIC_first.csv"
    assert [row[0] for row in calls] == [1, 2]
    assert calls[1][2].startswith("2026-03-05T") and calls[1][3].startswith("2026-03-06T")
    assert revision == 2


def test_the_loader_refuses_a_file_with_a_day_already_loaded(migrated_db, tmp_path):
    loaded = _csv(tmp_path / "SYNTHETIC_a.csv", synthetic_calls("2026-03-02", 3))
    overlapping = _csv(tmp_path / "SYNTHETIC_b.csv", synthetic_calls("2026-03-04", 2, seed=9))
    _tool("load_calls_csv.py", "--db", str(migrated_db), str(loaded))

    process = _tool("load_calls_csv.py", "--db", str(migrated_db), str(overlapping))

    conn = sqlite3.connect(migrated_db)
    assert process.returncode == 1
    assert "already has calls on 1 day(s) of this file (2026-03-04 to 2026-03-04)" in process.stderr
    assert conn.execute("SELECT count(*) FROM uploads").fetchone()[0] == 1
    assert conn.execute("SELECT calls_revision FROM data_state").fetchone()[0] == 1
