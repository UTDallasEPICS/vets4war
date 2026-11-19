"""Stopping python -m db.retrain in the middle of its gate leaves nothing behind.

The gate forks worker processes that inherit the script's stdout and stderr.
A worker that outlives the script keeps those pipes open, so whoever started
the script (the web app) never sees its output end. These tests start the
REAL script in a subprocess on SYNTHETIC calls, wait until its gate workers
exist, stop it the ways it gets stopped in production, and check that every
process of the run is gone and the output pipes close.
"""

from __future__ import annotations

import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import pytest

from conftest import apply_migrations, insert_calls, synthetic_calls
from db import store
from db.lifetime import _children

FORECAST_DIR = Path(__file__).resolve().parents[1]
TODAY = "2026-10-20"
# Enough origins that the gate is still busy when the test stops it; 2 workers.
BUSY = ["--gate-origins", "20", "--workers", "2", "--today", TODAY, "--horizon-days", "30"]
WORKERS = 2
# Real processes on a shared machine: generous limits that a fixed run never needs.
APPEAR_SEC = 120
GONE_SEC = 15


@pytest.fixture(scope="module")
def history_db(tmp_path_factory) -> Path:
    path = apply_migrations(tmp_path_factory.mktemp("stop") / "template.db")
    insert_calls(path, synthetic_calls("2026-03-02", 230))
    return path


@pytest.fixture
def db(history_db, tmp_path) -> Path:
    return Path(shutil.copy(history_db, tmp_path / "app.db"))


def _rows(path: Path, sql: str, *params) -> list[tuple]:
    conn = sqlite3.connect(path)
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _locked(path: Path) -> bool:
    """What the web app asks of a shell run's lock: is it held right now?"""
    probe = sqlite3.connect(path, timeout=0, isolation_level=None)
    try:
        probe.execute("BEGIN IMMEDIATE")
        probe.execute("ROLLBACK")
        return False
    except sqlite3.OperationalError:
        return True
    finally:
        probe.close()


def test_a_shell_run_holds_its_lock_while_it_works_and_removes_it_at_the_end(db):
    process = _start(db)
    try:
        _wait_for_workers(process.pid)
        assert _locked(store.cli_lock_path(db, 1))
        process.communicate(timeout=600)
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
    assert process.returncode == 0
    assert not store.cli_lock_path(db, 1).exists()


def _alive(pid: int) -> bool:
    """Running, not a zombie waiting to be reaped."""
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return False
    return stat[stat.rfind(")") + 2] != "Z"


def _wait_for_workers(pid: int, count: int = WORKERS) -> list[int]:
    deadline = time.monotonic() + APPEAR_SEC
    while time.monotonic() < deadline:
        workers = _children(pid)
        if len(workers) >= count:
            return workers
        time.sleep(0.05)
    raise AssertionError(f"the gate of process {pid} never had {count} workers")


def _wait_gone(pids: list[int]) -> list[int]:
    deadline = time.monotonic() + GONE_SEC
    while time.monotonic() < deadline and any(_alive(pid) for pid in pids):
        time.sleep(0.05)
    return [pid for pid in pids if _alive(pid)]


def _start(path: Path, *extra: str) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-m", "db.retrain", "--db", str(path), *BUSY, *extra],
                            cwd=FORECAST_DIR, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGKILL, signal.SIGINT, signal.SIGHUP])
def test_a_run_stopped_mid_gate_leaves_no_process_and_closes_its_output(db, signum):
    process = _start(db)
    try:
        workers = _wait_for_workers(process.pid)
        process.send_signal(signum)
        # Returns only when every holder of the pipes is gone: the workers too.
        out, err = process.communicate(timeout=GONE_SEC)
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
    assert process.returncode == -signum
    assert _wait_gone(workers) == []
    assert "V4W_RESULT" not in out
    status, message = _rows(db, "SELECT status, message FROM forecast_runs")[0]
    lock = store.cli_lock_path(db, 1)
    if signum == signal.SIGKILL:
        # Nothing runs in a killed process: the row stays as it was. Its lock is
        # gone with it (the file stays), which is how the web app knows it ended.
        assert status == "running"
        assert lock.is_file() and not _locked(lock)
    else:
        name = signal.Signals(signum).name
        assert f"Stopped by {name}" in err
        assert status == "failed"
        assert message == (f"Stopped by {name} before it finished. Nothing new was written; "
                           f"the previous forecast is still in use.")
        assert not lock.exists()
    assert _rows(db, "SELECT count(*) FROM forecast_state")[0][0] == 0


def _node_run(path: Path) -> int:
    conn = sqlite3.connect(path)
    try:
        run_id = conn.execute("INSERT INTO forecast_runs (trigger, mode, status, requested_by_label, created_at) "
                              "VALUES ('manual', 'full', 'queued', 'admin@example.org', 1)").lastrowid
        conn.commit()
        return run_id
    finally:
        conn.close()


def test_a_run_of_the_web_app_leaves_its_row_to_the_web_app_when_stopped(db):
    run_id = _node_run(db)
    process = _start(db, "--run-id", str(run_id))
    try:
        workers = _wait_for_workers(process.pid)
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=GONE_SEC)
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()
    assert process.returncode == -signal.SIGTERM
    assert _wait_gone(workers) == []
    # The web app knows why it stopped the run (timeout, shutdown) and records it.
    assert _rows(db, "SELECT status, message FROM forecast_runs WHERE id = ?", run_id) == [("running", None)]


# A stand-in for the web app: starts the script it is given, then waits.
PARENT = "import subprocess, sys, time\nsubprocess.Popen(sys.argv[1:])\ntime.sleep(600)"


def test_a_run_of_the_web_app_ends_when_the_web_app_dies(db):
    run_id = _node_run(db)
    command = [sys.executable, "-m", "db.retrain", "--db", str(db), *BUSY, "--run-id", str(run_id)]
    parent = subprocess.Popen([sys.executable, "-c", PARENT, *command],
                              cwd=FORECAST_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    left = []
    try:
        deadline = time.monotonic() + APPEAR_SEC
        while not _children(parent.pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        script = _children(parent.pid)[0]
        workers = _wait_for_workers(script)
        parent.kill()  # kill -9: the web app gets no chance to stop anything
        parent.wait()
        left = _wait_gone([script, *workers])
    finally:
        if parent.poll() is None:
            parent.kill()
        for pid in left:
            os.kill(pid, signal.SIGKILL)
    assert left == []
    # The next start of the web app finds the row running and marks it interrupted.
    assert _rows(db, "SELECT status FROM forecast_runs WHERE id = ?", run_id) == [("running",)]


@pytest.mark.parametrize("status", [None, "queued-then-run", "interrupted"])
def test_a_run_id_that_is_not_a_queued_row_is_refused_and_left_alone(db, status):
    if status is None:
        run_id, before = 99, []
    else:
        run_id = _node_run(db)
        if status == "interrupted":
            conn = sqlite3.connect(db)
            conn.execute("UPDATE forecast_runs SET status = 'interrupted' WHERE id = ?", (run_id,))
            conn.commit()
            conn.close()
        else:
            first = subprocess.run([sys.executable, "-m", "db.retrain", "--db", str(db), "--run-id", str(run_id),
                                    "--gate-origins", "2", "--workers", "1", "--today", TODAY,
                                    "--horizon-days", "30"], cwd=FORECAST_DIR, capture_output=True, text=True)
            assert first.returncode == 0, first.stderr
        before = _rows(db, "SELECT * FROM forecast_runs")
    process = subprocess.run([sys.executable, "-m", "db.retrain", "--db", str(db), "--run-id", str(run_id),
                              "--mode", "forecast-only"], cwd=FORECAST_DIR, capture_output=True, text=True)
    assert process.returncode == 2
    expected = (f"forecast_runs has no row {run_id}" if status is None else
                f"run {run_id} is {'succeeded' if status == 'queued-then-run' else status}, not queued")
    assert process.stderr.startswith(f"Cannot retrain: {expected}.")
    assert _rows(db, "SELECT * FROM forecast_runs") == before


# Runs db.retrain in-process with one step wrapped, to stop it at a chosen point.
# argv: <module.attribute to wrap> <what to do: "term-during" | "kill-inside"> <retrain args...>
WRAPPED = """
import os, signal, sys, threading
from db import retrain, store
target, action, args = sys.argv[1], sys.argv[2], sys.argv[3:]
module = {"retrain": retrain, "store": store}[target.split(".")[0]]
name = target.split(".")[1]
real = getattr(module, name)

def wrapped(*a, **k):
    if action == "term-during":
        # SIGTERM arrives while the step runs (LightGBM's fit is mostly native code).
        threading.Timer(0.2, os.kill, (os.getpid(), signal.SIGTERM)).start()
        return real(*a, **k)
    os.kill(os.getpid(), signal.SIGKILL)  # kill-inside: dies right here

setattr(module, name, wrapped)
raise SystemExit(retrain.main(args))
"""
FAST = ["--gate-origins", "2", "--workers", "1", "--today", TODAY, "--horizon-days", "30"]


def _wrapped_run(path: Path, target: str, action: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", WRAPPED, target, action, "--db", str(path), *FAST],
                          cwd=FORECAST_DIR, capture_output=True, text=True, timeout=600)


def _served(path: Path) -> list:
    return [_rows(path, f"SELECT * FROM {table} ORDER BY 1, 2") for table in
            ("forecast_state", "model_artifacts", "forecast_hours", "forecast_cells")]


def test_a_run_stopped_during_the_fit_writes_nothing(db):
    process = _wrapped_run(db, "retrain.fit_model", "term-during")
    assert process.returncode == -signal.SIGTERM, process.stderr
    assert "level factor" not in process.stdout  # printed right after the fit: never reached
    assert _rows(db, "SELECT status, message FROM forecast_runs") == [
        ("failed", "Stopped by SIGTERM before it finished. Nothing new was written; "
                   "the previous forecast is still in use.")]
    assert _rows(db, "SELECT count(*) FROM model_artifacts") == [(0,)]


def test_a_run_killed_inside_its_final_write_leaves_the_previous_forecast_whole(db):
    first = subprocess.run([sys.executable, "-m", "db.retrain", "--db", str(db), *FAST],
                           cwd=FORECAST_DIR, capture_output=True, text=True, timeout=600)
    assert first.returncode == 0, first.stderr
    before = _served(db)

    # _prune_artifacts runs inside the write transaction, after every table was replaced.
    killed = _wrapped_run(db, "store._prune_artifacts", "kill-inside")

    assert killed.returncode == -signal.SIGKILL
    assert _served(db) == before  # the next reader rolls the half-done write back
    assert [status for (status,) in _rows(db, "SELECT status FROM forecast_runs ORDER BY id")] == \
        ["succeeded", "running"]
    again = subprocess.run([sys.executable, "-m", "db.retrain", "--db", str(db), *FAST],
                           cwd=FORECAST_DIR, capture_output=True, text=True, timeout=600)
    assert again.returncode == 0, again.stderr
    assert _rows(db, "PRAGMA integrity_check") == [("ok",)]
