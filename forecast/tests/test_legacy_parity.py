"""Parity rung P2: this package on SQLite == final-main on Postgres.

Needs the legacy reference stack (SYNTHETIC data only): set V4W_LEGACY_DIR to
its folder (the one with synthetic/ and golden/). Without it the module is
skipped; with it every test must pass.

    cd forecast && V4W_LEGACY_DIR=<legacy dir> .venv/bin/python -m pytest tests/test_legacy_parity.py -q

Both legacy states are rebuilt from nothing in a temp folder: a migrated
SQLite file, the history CSV loaded (state A), python -m db.retrain with the
holidays pinned to the legacy table (2021 to 2027); then week 1 added and
retrained (state B). Each state must give the old model's fingerprint
exactly, and the tables it wrote must hold the numbers the OLD API answered
in the goldens of that state (abs 1e-9 + rel 1e-9).
"""

from __future__ import annotations

import json
import math
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import apply_migrations

LEGACY_DIR = os.environ.get("V4W_LEGACY_DIR", "").strip()
pytestmark = pytest.mark.skipif(not LEGACY_DIR, reason="V4W_LEGACY_DIR is not set (the legacy reference stack)")

FORECAST_DIR = Path(__file__).resolve().parents[1]
FINGERPRINTS = {
    "a": "e68c98b9657bf1cdbbe50ba842e182e4ebf3a0e0bd55a30675993443c967a53a",
    "b": "bc80951482e18a0bbff5929e8a78dd8358718f5984db56a7c60a1afb398f0918",
}
STATE_FILES = {"a": ("calls_history.csv.gz",), "b": ("calls_week1.csv.gz",)}
TODAY = "2026-11-19"
LEGACY_HOLIDAYS_THROUGH = "2027"
ABS_TOL = REL_TOL = 1e-9
# What the old /api/model added to the stored metadata, or stamped per run.
MODEL_KEYS_NOT_STORED = {"created_at_utc", "data_source"}


def _close(new: float, old: float) -> bool:
    return math.isclose(new, old, rel_tol=REL_TOL, abs_tol=ABS_TOL)


def _same(new, old, path: str = "") -> list[str]:
    """Differences between two JSON values: exact for everything but floats."""
    if isinstance(old, dict) and isinstance(new, dict):
        if set(new) != set(old):
            return [f"{path}: keys {sorted(set(new) ^ set(old))}"]
        return [problem for key in old for problem in _same(new[key], old[key], f"{path}.{key}")]
    if isinstance(old, list) and isinstance(new, list):
        if len(new) != len(old):
            return [f"{path}: {len(new)} items, expected {len(old)}"]
        return [problem for i, (n, o) in enumerate(zip(new, old)) for problem in _same(n, o, f"{path}[{i}]")]
    if isinstance(old, float) and not isinstance(new, bool) and isinstance(new, (int, float)):
        return [] if _close(new, old) else [f"{path}: {new!r} != {old!r}"]
    return [] if new == old and type(new) is type(old) else [f"{path}: {new!r} != {old!r}"]


@pytest.fixture(scope="module")
def states(tmp_path_factory) -> dict[str, dict]:
    """State A then state B, each a database file and the run's output."""
    sys.path.insert(0, str(FORECAST_DIR / "tools"))
    from load_calls_csv import load

    legacy = Path(LEGACY_DIR)
    folder = tmp_path_factory.mktemp("legacy-parity")
    db = apply_migrations(folder / "parity.db")
    env = {**os.environ, "V4W_HOLIDAYS_THROUGH_YEAR": LEGACY_HOLIDAYS_THROUGH}
    built = {}
    for state in ("a", "b"):
        for name in STATE_FILES[state]:
            load(db, legacy / "synthetic" / name)
        process = subprocess.run([sys.executable, "-m", "db.retrain", "--db", str(db), "--today", TODAY],
                                 cwd=FORECAST_DIR, env=env, capture_output=True, text=True, timeout=3600)
        assert process.returncode == 0, process.stdout[-4000:] + process.stderr[-4000:]
        result = json.loads(process.stdout.strip().splitlines()[-1].removeprefix("V4W_RESULT "))
        copy = folder / f"parity_{state}.db"
        shutil.copy(db, copy)
        built[state] = {"db": copy, "result": result}
    return built


def _goldens(state: str) -> list[tuple[str, dict]]:
    folder = Path(LEGACY_DIR) / "golden" / state
    return [(path.stem, json.loads(path.read_text())) for path in sorted(folder.glob("*.json"))]


def _forecast_goldens(state: str) -> list[tuple[str, dict]]:
    return [(name, golden) for name, golden in _goldens(state)
            if golden["request"]["path"] == "/api/forecast" and golden["status"] == 200]


def _query(db: Path, sql: str, *params) -> list[dict]:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in conn.execute(sql, params)]
    finally:
        conn.close()


@pytest.mark.parametrize("state", ["a", "b"])
def test_the_model_fingerprint_is_the_old_one(states, state):
    stored = _query(states[state]["db"], "SELECT model_sha256 FROM model_artifacts ORDER BY id DESC LIMIT 1")

    assert states[state]["result"]["model_sha256"] == FINGERPRINTS[state]
    assert stored[0]["model_sha256"] == FINGERPRINTS[state]


@pytest.mark.parametrize("state", ["a", "b"])
def test_the_hourly_tables_hold_the_old_forecast_answers(states, state):
    db = states[state]["db"]
    cells = {(row["recency"], row["dow"], row["hour"]): row
             for row in _query(db, "SELECT * FROM forecast_cells")}
    checked, problems = 0, []
    for name, golden in _forecast_goldens(state):
        params = golden["body"]["params"]
        column = "predicted_calls" if params["include_holidays"] else "predicted_calls_no_holidays"
        stored = {(row["date"], row["hour"]): row for row in _query(
            db, "SELECT date, hour, predicted_calls, predicted_calls_no_holidays, "
                "CAST(strftime('%u', date) AS INTEGER) AS dow FROM forecast_hours WHERE date BETWEEN ? AND ?",
            params["start"], params["end"])}
        for hour in golden["body"]["hours"]:
            row = stored.get((hour["date"], hour["hour"]))
            if row is None:
                problems.append(f"{name} {hour['date']} {hour['hour']}: no forecast_hours row")
                continue
            cell = cells[(params["recency"], row["dow"], hour["hour"])]
            pairs = {"predicted_calls": (row[column], hour["predicted_calls"]),
                     "aht_sec": (cell["aht_sec"], hour["aht_sec"]),
                     "predicted_real_calls": (row[column] * cell["real_share"], hour["predicted_real_calls"])}
            problems += [f"{name} {hour['date']} {hour['hour']} {field}: {new!r} != {old!r}"
                         for field, (new, old) in pairs.items() if not _close(new, old)]
            checked += 1
    assert problems == []
    assert checked > 10_000                       # the 366-day golden alone has 8,808 hours


@pytest.mark.parametrize("state", ["a", "b"])
def test_patience_and_quick_hangups_are_the_old_ones(states, state):
    stored = _query(states[state]["db"], "SELECT * FROM forecast_state")[0]
    estimated = [golden["body"] for _, golden in _forecast_goldens(state)
                 if (golden["body"]["params"]["patience_source"] or {}).get("kind") == "estimated"]

    assert estimated
    for body in estimated:
        params = body["params"]
        assert _close(stored["patience_sec"], params["patience_sec"])
        assert (stored["patience_n_abandoned"], stored["patience_n_calls"]) == \
            (params["patience_source"]["n_abandoned"], params["patience_source"]["n_calls"])
        assert _same(json.loads(stored["quick_hangups_json"]), body["quick_hangups"]) == []
        assert (stored["data_start"], stored["data_end"]) == (body["data_source"]["start"], body["data_source"]["end"])


@pytest.mark.parametrize("state", ["a", "b"])
def test_the_stored_metadata_is_the_old_model_answer(states, state):
    stored = _query(states[state]["db"], "SELECT metadata_json FROM model_artifacts ORDER BY id DESC LIMIT 1")[0]
    golden = dict(_goldens(state))["model"]["body"]
    expected = {key: value for key, value in golden.items() if key not in MODEL_KEYS_NOT_STORED}
    metadata = {key: value for key, value in json.loads(stored["metadata_json"]).items()
                if key not in MODEL_KEYS_NOT_STORED}

    assert _same(metadata, expected) == []
