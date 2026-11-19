"""python -m db.retrain against a migrated database of SYNTHETIC calls.

Most cases run the real script in a subprocess, exactly as the web app
starts it. The few that need the gate's verdict or a failure at a chosen
point run main() in-process with one function of db.retrain replaced by the
test (monkeypatch); nothing in the script itself knows about tests.

History: 230 days of SYNTHETIC calls (tests/conftest.py). The gate runs on 2
weekly origins with 1 worker, and --today is pinned, so every run is
deterministic.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pytest

from conftest import apply_migrations, insert_calls, synthetic_calls
from db import retrain, store
from db.forecast import forecast_range

FORECAST_DIR = Path(__file__).resolve().parents[1]
FIRST_DAY = "2026-03-02"
DAYS = 230
LAST_DAY = "2026-10-17"
TODAY = "2026-10-20"
HORIZON_DAYS = 30
FAST = ["--gate-origins", "2", "--workers", "1", "--today", TODAY, "--horizon-days", str(HORIZON_DAYS)]


@pytest.fixture(scope="module")
def history_db(tmp_path_factory) -> Path:
    path = apply_migrations(tmp_path_factory.mktemp("history") / "template.db")
    insert_calls(path, synthetic_calls(FIRST_DAY, DAYS))
    return path


@pytest.fixture
def db(history_db, tmp_path) -> Path:
    """A private copy of the history database for one test."""
    return Path(shutil.copy(history_db, tmp_path / "app.db"))


@pytest.fixture(scope="module")
def trained_db(history_db, tmp_path_factory) -> Path:
    """The history after one successful full run (read it, never change it)."""
    path = Path(shutil.copy(history_db, tmp_path_factory.mktemp("trained") / "app.db"))
    assert _run(path).returncode == 0
    return path


def _run(path: Path, *extra: str, args=FAST) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-m", "db.retrain", "--db", str(path), *args, *extra],
                          cwd=FORECAST_DIR, capture_output=True, text=True, timeout=600)


def _result(process: subprocess.CompletedProcess) -> dict:
    last = process.stdout.strip().splitlines()[-1]
    assert last.startswith("V4W_RESULT "), process.stdout + process.stderr
    return json.loads(last.removeprefix("V4W_RESULT "))


def _rows(path: Path, sql: str, *params) -> list[dict]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in conn.execute(sql, params)]
    finally:
        conn.close()


def _count(path: Path, table: str) -> int:
    return _rows(path, f"SELECT count(*) AS n FROM {table}")[0]["n"]


def _node_run(path: Path, mode="full", trigger="import", created_at=1_700_000_000) -> int:
    conn = sqlite3.connect(path)
    try:
        run_id = conn.execute("INSERT INTO forecast_runs (trigger, mode, status, requested_by_label, created_at) "
                              "VALUES (?, ?, 'queued', 'admin@example.org', ?)", (trigger, mode, created_at)).lastrowid
        conn.commit()
        return run_id
    finally:
        conn.close()


def _in_process(path: Path, *extra: str) -> int:
    return retrain.main(["--db", str(path), *FAST, *extra])


# ---- a full run ---------------------------------------------------------------------------

def test_a_full_run_writes_model_forecast_and_derived_numbers(trained_db):
    run = _rows(trained_db, "SELECT * FROM forecast_runs")[0]
    state = _rows(trained_db, "SELECT * FROM forecast_state")[0]
    artifact = _rows(trained_db, "SELECT * FROM model_artifacts")[0]
    hours = pd.DataFrame(_rows(trained_db, "SELECT * FROM forecast_hours ORDER BY date, hour"))
    horizon_end = str(pd.Timestamp(TODAY).date() + pd.Timedelta(days=HORIZON_DAYS))

    assert (run["status"], run["trigger"], run["requested_by_label"], run["mode"]) == \
        ("succeeded", "cli", "cli", "full")
    assert (run["trained"], run["gate_passed"], run["forecast_written"]) == (1, 1, 1)
    assert run["model_id"] == artifact["id"] == state["model_id"]
    assert run["message"].startswith("Retrained on ") and LAST_DAY in run["message"]
    assert json.loads(run["gate_json"])["passed"] is True
    assert (run["horizon_start"], run["horizon_end"]) == (FIRST_DAY, horizon_end)
    assert _count(trained_db, "model_artifacts") == 1

    metadata = json.loads(artifact["metadata_json"])
    assert metadata["model_sha256"] == artifact["model_sha256"]
    assert metadata["data_sources"][0]["file"] == "database"
    assert (artifact["train_start"], artifact["train_end"]) == (f"{FIRST_DAY}T00:00:00", f"{LAST_DAY}T23:00:00")

    days = pd.date_range(FIRST_DAY, horizon_end, freq="D").strftime("%Y-%m-%d")
    assert len(hours) == 24 * len(days)
    assert sorted(hours["date"].unique()) == list(days)
    assert hours.groupby("date")["hour"].apply(list).map(lambda h: h == list(range(24))).all()
    assert hours[["predicted_calls", "predicted_calls_no_holidays"]].notna().all().all()
    assert (hours["predicted_calls"] > 0).all()

    cells = _rows(trained_db, "SELECT recency, count(*) AS n FROM forecast_cells GROUP BY recency")
    assert {row["recency"]: row["n"] for row in cells} == {"equal": 168, "weighted": 168, "recent": 168}
    assert (state["calls_revision"], state["data_start"], state["data_end"]) == (1, FIRST_DAY, LAST_DAY)
    assert state["calls_count"] == _count(trained_db, "calls")
    assert state["patience_sec"] > 0 and state["patience_n_calls"] == state["calls_count"]
    assert json.loads(state["quick_hangups_json"])["window_days"] == 90


def test_holidays_are_quieter_in_the_forecast_and_neutralised_in_the_other_column(trained_db):
    columbus = _rows(trained_db, "SELECT sum(predicted_calls) AS h, sum(predicted_calls_no_holidays) AS n "
                                 "FROM forecast_hours WHERE date = '2026-10-12'")[0]
    assert columbus["h"] < 0.8 * columbus["n"]


def test_the_result_line_is_last_and_names_the_run_and_model(db):
    process = _run(db)

    result = _result(process)
    run = _rows(db, "SELECT * FROM forecast_runs")[0]
    artifact = _rows(db, "SELECT id, model_sha256 FROM model_artifacts")[0]
    assert process.returncode == 0
    assert result == {"run_id": run["id"], "status": "succeeded", "model_id": artifact["id"],
                      "model_sha256": artifact["model_sha256"]}
    assert "## Gate: last 2 weekly origins" in process.stdout


def test_the_same_calls_give_the_same_model(trained_db, db):
    assert _run(db).returncode == 0

    first = _rows(trained_db, "SELECT model_sha256 FROM model_artifacts")[0]["model_sha256"]
    assert _rows(db, "SELECT model_sha256 FROM model_artifacts")[0]["model_sha256"] == first


def test_a_run_id_claims_the_row_node_created(db):
    run_id = _node_run(db)

    process = _run(db, "--run-id", str(run_id))

    rows = _rows(db, "SELECT * FROM forecast_runs")
    assert process.returncode == 0
    assert len(rows) == 1
    assert (rows[0]["id"], rows[0]["trigger"], rows[0]["created_at"], rows[0]["requested_by_label"]) == \
        (run_id, "import", 1_700_000_000, "admin@example.org")
    assert rows[0]["status"] == "succeeded" and rows[0]["pid"] > 0
    assert rows[0]["started_at"] >= 1_700_000_000 and rows[0]["finished_at"] >= rows[0]["started_at"]
    assert _result(process)["run_id"] == run_id


def test_the_research_forecast_reads_the_same_numbers_from_the_database(trained_db):
    conn = store.connect(trained_db, readonly=True)
    try:
        served = forecast_range(conn, "2026-10-26", "2026-10-28", "recent", include_holidays=False)
    finally:
        conn.close()
    stored = pd.DataFrame(_rows(trained_db, "SELECT h.predicted_calls_no_holidays AS calls, c.aht_sec FROM "
                                            "forecast_hours h JOIN forecast_cells c ON c.recency = 'recent' AND "
                                            "c.hour = h.hour AND c.dow = CAST(strftime('%u', h.date) AS INTEGER) "
                                            "WHERE h.date BETWEEN '2026-10-26' AND '2026-10-28' ORDER BY h.date, h.hour"))

    assert served["predicted_offered"].tolist() == pytest.approx(stored["calls"].tolist(), rel=1e-12)
    assert served["predicted_aht_sec"].tolist() == pytest.approx(stored["aht_sec"].tolist(), rel=1e-12)


# ---- forecast-only ------------------------------------------------------------------------

def test_forecast_only_reuses_the_model_and_moves_the_horizon(trained_db, tmp_path):
    path = Path(shutil.copy(trained_db, tmp_path / "app.db"))
    model_id = _rows(path, "SELECT model_id FROM forecast_state")[0]["model_id"]
    conn = sqlite3.connect(path)
    conn.execute("UPDATE forecast_state SET generated_at = 0")
    conn.commit()
    conn.close()

    process = _run(path, "--mode", "forecast-only",
                   args=["--workers", "1", "--today", "2026-11-05", "--horizon-days", str(HORIZON_DAYS)])

    run = _rows(path, "SELECT * FROM forecast_runs ORDER BY id DESC")[0]
    state = _rows(path, "SELECT * FROM forecast_state")[0]
    assert process.returncode == 0, process.stderr
    assert (run["mode"], run["status"], run["trained"], run["model_id"]) == ("forecast-only", "succeeded", 0, model_id)
    assert run["gate_passed"] is None and run["gate_json"] is None
    assert run["message"] == f"Forecast refreshed from the model in use; data through {LAST_DAY}."
    assert state["model_id"] == model_id and state["generated_at"] > 0
    assert state["horizon_end"] == "2026-12-05" == run["horizon_end"]
    assert _rows(path, "SELECT max(date) AS d FROM forecast_hours")[0]["d"] == "2026-12-05"
    assert _count(path, "model_artifacts") == 1
    assert _result(process)["model_id"] == model_id


def test_forecast_only_without_a_model_is_refused(db):
    process = _run(db, "--mode", "forecast-only")

    run = _rows(db, "SELECT * FROM forecast_runs")[0]
    assert process.returncode == 2
    assert run["status"] == "failed"
    assert run["message"].startswith("Cannot refresh the forecast: no model has been trained yet")
    assert _count(db, "forecast_state") == 0


# ---- refusals -----------------------------------------------------------------------------

def test_no_calls_is_refused(migrated_db):
    process = _run(migrated_db)

    run = _rows(migrated_db, "SELECT * FROM forecast_runs")[0]
    assert process.returncode == 2
    assert run["status"] == "failed" and run["message"].startswith("Cannot retrain: there are no calls")
    assert (run["calls_count"], run["data_start"]) == (0, None)
    assert _result(process) == {"run_id": run["id"], "status": "failed", "model_id": None, "model_sha256": None}


def test_a_missing_recent_day_is_refused(db):
    conn = sqlite3.connect(db)
    conn.execute("DELETE FROM calls WHERE start_ts LIKE '2026-10-05%'")
    conn.commit()
    conn.close()

    process = _run(db)

    message = _rows(db, "SELECT message FROM forecast_runs")[0]["message"]
    assert process.returncode == 2
    assert message.startswith("Cannot retrain: 1 recent day(s) have no calls at all (2026-10-05 to 2026-10-05)")
    assert "Load those days from the admin page" in message


def test_too_little_history_is_refused(migrated_db):
    insert_calls(migrated_db, synthetic_calls("2026-08-01", 60))

    process = _run(migrated_db)

    message = _rows(migrated_db, "SELECT message FROM forecast_runs")[0]["message"]
    assert process.returncode == 2
    assert message.startswith("Cannot retrain: there is not enough call history for the accuracy check")
    assert _count(migrated_db, "model_artifacts") == 0


def test_a_holidays_row_that_disagrees_with_the_rules_is_refused_and_named(db):
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO holidays (holiday_date, holiday_name) VALUES ('2026-09-08', 'Labor Day')")
    conn.commit()
    conn.close()

    process = _run(db)

    message = _rows(db, "SELECT message FROM forecast_runs")[0]["message"]
    assert process.returncode == 2
    assert message.startswith("Cannot retrain: the holidays table has 1 row(s)")
    assert "Labor Day 2026: table 2026-09-08, rule 2026-09-07" in message
    assert _count(db, "holidays") == 1


def test_a_relative_database_path_is_refused_before_anything_is_opened(db):
    process = subprocess.run([sys.executable, "-m", "db.retrain", "--db", "app.db", *FAST],
                             cwd=db.parent, capture_output=True, text=True, timeout=120,
                             env={"PYTHONPATH": str(FORECAST_DIR), "PATH": "/usr/bin:/bin"})

    assert process.returncode == 2
    assert "absolute path" in process.stderr
    assert _count(db, "forecast_runs") == 0


# ---- holidays -----------------------------------------------------------------------------

def test_holidays_are_extended_through_the_requested_year_once(db):
    first = _run(db, "--holidays-through", "2028")
    second = _run(db, "--holidays-through", "2028")

    holidays = _rows(db, "SELECT count(*) AS n, min(holiday_date) AS lo, max(holiday_date) AS hi FROM holidays")[0]
    assert first.returncode == second.returncode == 0
    assert (holidays["n"], holidays["lo"], holidays["hi"]) == (33, "2026-01-01", "2028-12-25")
    assert "(33 added)" in first.stdout and "(0 added)" in second.stdout


def test_by_default_holidays_reach_the_year_after_the_horizon(db):
    process = _run(db, args=["--gate-origins", "2", "--workers", "1", "--today", TODAY, "--horizon-days", "800"])

    assert process.returncode == 0, process.stderr
    # 2026-10-20 + 800 days = 2028-12-28, so official holidays through 2029.
    assert _rows(db, "SELECT max(holiday_date) AS hi FROM holidays")[0]["hi"] == "2029-12-25"


# ---- gate rejection and failures (in-process, one function replaced) ----------------------

def _rejecting_gate(real_gate):
    def gate(*args, **kwargs):
        return {**real_gate(*args, **kwargs), "passed": False}
    return gate


def test_a_rejected_model_keeps_the_previous_one_and_refreshes_the_rest(trained_db, tmp_path, monkeypatch, capsys):
    path = Path(shutil.copy(trained_db, tmp_path / "app.db"))
    serving = _rows(path, "SELECT model_id, model_sha256 FROM forecast_state JOIN model_artifacts a "
                          "ON a.id = model_id")[0]
    insert_calls(path, synthetic_calls("2026-10-18", 1, seed=11))          # revision 2, one more day
    monkeypatch.setattr(retrain, "gate", _rejecting_gate(retrain.gate))

    code = _in_process(path)

    run = _rows(path, "SELECT * FROM forecast_runs ORDER BY id DESC")[0]
    state = _rows(path, "SELECT * FROM forecast_state")[0]
    assert code == 3
    assert (run["status"], run["trained"], run["gate_passed"], run["forecast_written"]) == ("rejected", 0, 0, 1)
    assert run["message"].startswith("The retrained model did not beat the simple baseline on daily error (")
    assert "so the previous model stays in use" in run["message"]
    assert run["model_id"] == state["model_id"] == serving["model_id"]
    assert _count(path, "model_artifacts") == 1
    assert (state["calls_revision"], state["data_end"]) == (2, "2026-10-18")
    out = capsys.readouterr().out.strip().splitlines()[-1]
    assert json.loads(out.removeprefix("V4W_RESULT ")) == {"run_id": run["id"], "status": "rejected",
                                                          "model_id": serving["model_id"],
                                                          "model_sha256": serving["model_sha256"]}


def test_a_rejected_first_model_writes_only_the_run_row(db, monkeypatch):
    monkeypatch.setattr(retrain, "gate", _rejecting_gate(retrain.gate))

    code = _in_process(db)

    run = _rows(db, "SELECT * FROM forecast_runs")[0]
    assert code == 3
    assert (run["status"], run["forecast_written"], run["trained"], run["model_id"]) == ("rejected", 0, 0, None)
    assert run["message"].startswith("The first model did not beat the simple baseline on daily error (")
    assert json.loads(run["gate_json"])["passed"] is False
    for table in ("forecast_hours", "forecast_cells", "forecast_state", "model_artifacts"):
        assert _count(db, table) == 0


def test_an_unexpected_error_exits_1_and_is_recorded_without_its_text(db, monkeypatch, capsys):
    """The text of an error may quote the stored value it failed on (here a
    call's start time): it reaches neither the run row nor the output."""
    stored = "2026-05-04" + "T08:15:00"  # built here so the traceback's code line does not hold it

    def broken(*args, **kwargs):
        raise ValueError(f"time data {stored!r} does not match format")

    monkeypatch.setattr(retrain, "forecast_frame", broken)

    code = _in_process(db)

    run = _rows(db, "SELECT * FROM forecast_runs")[0]
    out = capsys.readouterr()
    assert code == 1
    assert (run["status"], run["message"]) == (
        "failed", "Unexpected error: ValueError (its text is not shown, as it may quote stored data; "
                  "see where it happened in the output)")
    assert _count(db, "forecast_state") == 0 and _count(db, "model_artifacts") == 0
    assert "Traceback" in out.err and "in broken" in out.err
    assert "2026-05-04T08:15:00" not in out.err + out.out


def test_a_database_error_keeps_its_text(db, monkeypatch):
    def locked(*args, **kwargs):
        raise store.DatabaseError("database is locked")

    monkeypatch.setattr(retrain, "forecast_frame", locked)

    assert _in_process(db) == 1
    assert _rows(db, "SELECT message FROM forecast_runs")[0]["message"] == \
        "Unexpected error: Error: database is locked"


def test_an_import_landing_mid_run_does_not_change_what_the_run_read(db, monkeypatch):
    before = _count(db, "calls")
    real_ensure = retrain._ensure_holidays

    def import_meanwhile(conn, calls, through_year, refuse):
        insert_calls(db, synthetic_calls("2026-10-18", 1, seed=5))          # after step 1, revision 2
        return real_ensure(conn, calls, through_year, refuse)

    monkeypatch.setattr(retrain, "_ensure_holidays", import_meanwhile)

    assert _in_process(db) == 0

    state = _rows(db, "SELECT * FROM forecast_state")[0]
    run = _rows(db, "SELECT * FROM forecast_runs")[0]
    assert _rows(db, "SELECT calls_revision FROM data_state")[0]["calls_revision"] == 2
    assert (state["calls_revision"], state["calls_count"], state["data_end"]) == (1, before, LAST_DAY)
    assert (run["calls_revision"], run["calls_count"]) == (1, before)


def test_python_m_db_train_is_another_name_for_the_retrain_script(db):
    process = subprocess.run([sys.executable, "-m", "db.train", "--db", str(db), *FAST],
                             cwd=FORECAST_DIR, capture_output=True, text=True, timeout=600)

    assert process.returncode == 0, process.stderr
    assert _result(process)["status"] == "succeeded"
