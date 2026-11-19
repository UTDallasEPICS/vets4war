"""db/store.py against a migrated SQLite file (the web app's own schema).

All calls are SYNTHETIC, written in the test."""

from __future__ import annotations

import json
import sqlite3
import threading

import numpy as np
import pandas as pd
import pytest

from conftest import insert_calls
from db import store

DAY = "2026-03-02"


def _calls(*rows) -> pd.DataFrame:
    frame = pd.DataFrame(rows, columns=list(store.CALLS_COLUMNS))
    return frame.assign(start_ts=pd.to_datetime(frame["start_ts"]))


def _raw(path):
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def _node_run(path, trigger="manual", created_at=1_000) -> int:
    """A forecast_runs row as Node's runner inserts it before spawning."""
    with _raw(path) as conn:
        return conn.execute(
            "INSERT INTO forecast_runs (trigger, mode, status, requested_by_label, created_at) "
            "VALUES (?, 'full', 'queued', 'admin@example.org', ?)", (trigger, created_at)).lastrowid


def _claimed_run(path) -> int:
    """A row Node created and the script has claimed: what a run writes into."""
    run_id = _node_run(path)
    store.start_run(store.connect(path), run_id, mode="full", pid=1, calls_revision=0, calls_count=0,
                    data_start=None, data_end=None)
    return run_id


def _state(**overrides) -> dict:
    return {
        "generated_at": 2_000, "calls_revision": 1, "calls_count": 10, "data_start": "2026-01-01",
        "data_end": "2026-03-01", "horizon_start": "2026-01-01", "horizon_end": "2026-05-01",
        "patience_sec": 250.0, "patience_n_abandoned": 2, "patience_n_calls": 10,
        "quick_hangups_json": {"n_quick": 1}, **overrides,
    }


def _model(tag: str) -> dict:
    return {"model_sha256": f"sha-{tag}", "model_text": f"tree {tag}", "metadata_json": {"tag": tag},
            "train_start": "2026-01-01T00:00:00", "train_end": "2026-03-01T23:00:00", "train_rows": 1440}


def _hours(value: float, days: int = 3) -> list[tuple]:
    return [(str(day.date()), hour, value, value / 2)
            for day in pd.date_range("2026-03-02", periods=days) for hour in range(24)]


def _cells(value: float) -> list[tuple]:
    return [(recency, dow, hour, value, 0.5)
            for recency in ("equal", "weighted", "recent") for dow in range(1, 8) for hour in range(24)]


def _write(path, run_id, value, new_model=True, **state) -> int:
    conn = store.connect(path)
    try:
        return store.write_forecast(
            conn, run_id=run_id, new_model=_model(str(value)) if new_model else None, hours=_hours(value),
            cells=_cells(value), state=_state(**state),
            run={"status": "succeeded", "finished_at": 3_000, "trained": new_model, "forecast_written": True,
                 "message": f"value {value}"})
    finally:
        conn.close()


# ---- connect -------------------------------------------------------------------------

def test_a_missing_file_is_refused_instead_of_created(tmp_path):
    with pytest.raises(FileNotFoundError):
        store.connect(tmp_path / "nothing.db")
    assert not (tmp_path / "nothing.db").exists()


def test_a_readonly_connection_refuses_writes(migrated_db):
    conn = store.connect(migrated_db, readonly=True)
    with pytest.raises(store.DatabaseError):
        conn.execute("INSERT INTO holidays (holiday_date, holiday_name) VALUES ('2026-01-01', 'x')")
    conn.close()


def test_connect_leaves_the_rollback_journal_alone(migrated_db):
    conn = store.connect(migrated_db)
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == store.BUSY_TIMEOUT_SEC * 1000
    conn.close()


# ---- reading -------------------------------------------------------------------------

def test_snapshot_of_an_empty_database(migrated_db):
    snapshot = store.read_snapshot(store.connect(migrated_db))

    assert snapshot.calls_revision == 0
    assert snapshot.calls.empty
    assert list(snapshot.calls.columns) == list(store.CALLS_COLUMNS)
    assert pd.api.types.is_datetime64_any_dtype(snapshot.calls["start_ts"])


def test_null_durations_become_nan_and_types_are_set(migrated_db):
    insert_calls(migrated_db, _calls((f"{DAY} 09:00:00", np.nan, 300.0, 0.0, 12.0, False),
                                     (f"{DAY} 09:30:00", 40.0, np.nan, 40.0, np.nan, True)))

    calls = store.read_snapshot(store.connect(migrated_db)).calls

    assert calls["in_queue_sec"].isna().tolist() == [True, False]
    assert calls["agent_sec"].isna().tolist() == [False, True]
    assert calls["routing_sec"].isna().tolist() == [False, True]
    assert all(calls[name].dtype == "float64" for name in store.DURATION_COLUMNS)
    assert calls["abandoned"].dtype == bool and calls["abandoned"].tolist() == [False, True]
    assert calls["start_ts"].tolist() == [pd.Timestamp(f"{DAY} 09:00:00"), pd.Timestamp(f"{DAY} 09:30:00")]


def test_revision_is_zero_without_a_data_state_row(migrated_db):
    with _raw(migrated_db) as conn:
        upload = conn.execute("INSERT INTO uploads (source, status, filename, file_sha256, file_bytes, "
                              "uploaded_by_label, created_at) VALUES ('upload', 'imported', 'f', 's', 0, 'cli', 0)"
                              ).lastrowid
        conn.execute("INSERT INTO calls (start_ts, abandoned, upload_id) VALUES ('2026-03-02T01:00:00', 0, ?)",
                     (upload,))

    snapshot = store.read_snapshot(store.connect(migrated_db))

    assert snapshot.calls_revision == 0
    assert len(snapshot.calls) == 1


def test_calls_come_ordered_by_start_then_id(migrated_db):
    # Two uploads written out of time order; equal start times keep insertion (id) order.
    insert_calls(migrated_db, _calls((f"{DAY} 10:00:00", 1.0, 100.0, 0.0, 1.0, False),
                                     (f"{DAY} 08:00:00", 2.0, 200.0, 0.0, 1.0, False)))
    insert_calls(migrated_db, _calls((f"{DAY} 08:00:00", 3.0, 300.0, 0.0, 1.0, False),
                                     (f"{DAY} 07:00:00", 4.0, 400.0, 0.0, 1.0, False)))

    snapshot = store.read_snapshot(store.connect(migrated_db))

    assert snapshot.calls["in_queue_sec"].tolist() == [4.0, 2.0, 3.0, 1.0]
    assert snapshot.calls_revision == 2


def test_holidays_come_back_as_dates_in_order(migrated_db):
    conn = store.connect(migrated_db)
    added = store.insert_missing_holidays(conn, [("2026-12-25", "Christmas"), ("2026-01-01", "New Year's Day")])
    again = store.insert_missing_holidays(conn, [("2026-12-25", "Christmas")])

    holidays = store.load_holidays(conn)

    assert (added, again) == (2, 0)
    assert holidays["holiday_date"].tolist() == [pd.Timestamp("2026-01-01"), pd.Timestamp("2026-12-25")]
    assert holidays["holiday_name"].tolist() == ["New Year's Day", "Christmas"]


# ---- run rows ------------------------------------------------------------------------

def test_start_run_claims_the_row_node_created(migrated_db):
    run_id = _node_run(migrated_db, trigger="import", created_at=1_234)

    claimed = store.start_run(store.connect(migrated_db), run_id, mode="full", pid=4321, calls_revision=3,
                              calls_count=99, data_start="2026-01-01", data_end="2026-03-01")

    row = dict(_raw(migrated_db).execute("SELECT * FROM forecast_runs WHERE id = ?", (run_id,)).fetchone())
    assert claimed == run_id
    assert row["status"] == "running" and row["pid"] == 4321
    assert (row["trigger"], row["created_at"], row["requested_by_label"]) == ("import", 1_234, "admin@example.org")
    assert row["started_at"] >= 1_234
    assert (row["calls_revision"], row["calls_count"], row["data_start"], row["data_end"]) == \
        (3, 99, "2026-01-01", "2026-03-01")


def test_start_run_keeps_a_start_time_node_already_set(migrated_db):
    run_id = _node_run(migrated_db)
    with _raw(migrated_db) as conn:
        conn.execute("UPDATE forecast_runs SET started_at = 1500 WHERE id = ?", (run_id,))

    store.start_run(store.connect(migrated_db), run_id, mode="full", pid=1, calls_revision=0, calls_count=0,
                    data_start=None, data_end=None)

    assert _raw(migrated_db).execute("SELECT started_at FROM forecast_runs").fetchone()[0] == 1500


def test_start_run_without_an_id_inserts_a_cli_row(migrated_db):
    run_id = store.start_run(store.connect(migrated_db), None, mode="forecast-only", pid=7, calls_revision=1,
                             calls_count=5, data_start="2026-01-01", data_end="2026-01-02")

    row = dict(_raw(migrated_db).execute("SELECT * FROM forecast_runs WHERE id = ?", (run_id,)).fetchone())
    assert (row["trigger"], row["mode"], row["status"], row["requested_by_label"]) == \
        ("cli", "forecast-only", "running", "cli")
    assert row["created_at"] == row["started_at"] > 0


def _locked(path) -> bool:
    """What the web app asks: can another process take the lock now?"""
    probe = sqlite3.connect(path, timeout=0, isolation_level=None)
    try:
        probe.execute("BEGIN IMMEDIATE")
        probe.execute("ROLLBACK")
        return False
    except sqlite3.OperationalError as error:
        assert "locked" in str(error)
        return True
    finally:
        probe.close()


def test_a_shell_run_holds_a_lock_next_to_the_database_until_released(migrated_db):
    run_id = store.start_run(store.connect(migrated_db), None, mode="full", pid=7, calls_revision=1,
                             calls_count=0, data_start=None, data_end=None)
    lock = migrated_db.with_name(f"{migrated_db.name}-cli-run-{run_id}.lock")
    assert store.cli_lock_path(migrated_db, run_id) == lock.resolve()
    assert lock.is_file() and _locked(lock)

    store.release_cli_lock(run_id)

    assert not lock.exists()


def test_another_spelling_of_the_database_finds_the_same_lock(migrated_db, tmp_path):
    (tmp_path / "elsewhere").mkdir()
    link = tmp_path / "elsewhere" / "link.db"
    link.symlink_to(migrated_db)
    spellings = [link, tmp_path / "elsewhere" / ".." / migrated_db.name, migrated_db]
    assert {store.cli_lock_path(path, 3) for path in spellings} == {store.cli_lock_path(migrated_db, 3)}


def test_start_run_with_an_unknown_id_raises(migrated_db):
    with pytest.raises(ValueError, match="no row 42"):
        store.start_run(store.connect(migrated_db), 42, mode="full", pid=1, calls_revision=0, calls_count=0,
                        data_start=None, data_end=None)


@pytest.mark.parametrize("status", ["running", "succeeded", "failed", "interrupted"])
def test_start_run_claims_only_a_queued_row(migrated_db, status):
    run_id = _node_run(migrated_db)
    with _raw(migrated_db) as conn:
        conn.execute("UPDATE forecast_runs SET status = ? WHERE id = ?", (status, run_id))
    with pytest.raises(store.RunNotOpen, match=f"run {run_id} is {status}, not queued"):
        store.start_run(store.connect(migrated_db), run_id, mode="full", pid=1, calls_revision=0, calls_count=0,
                        data_start=None, data_end=None)
    assert tuple(_raw(migrated_db).execute("SELECT status, pid FROM forecast_runs").fetchone()) == (status, None)


def test_a_run_the_web_app_closed_writes_nothing(migrated_db):
    """A server restart marks a run interrupted while its process may still be
    going: that process must not overwrite the row or swap in its forecast."""
    served = _write(migrated_db, _claimed_run(migrated_db), 1.0)
    late = _claimed_run(migrated_db)
    with _raw(migrated_db) as conn:
        conn.execute("UPDATE forecast_runs SET status = 'interrupted', message = 'restart' WHERE id = ?", (late,))
    before = {table: _raw(migrated_db).execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall()
              for table in ("forecast_hours", "forecast_cells", "forecast_state", "forecast_runs", "model_artifacts")}

    with pytest.raises(store.RunNotOpen, match=f"run {late} is interrupted, not running"):
        _write(migrated_db, late, 2.0)
    with pytest.raises(store.RunNotOpen):
        store.finish_run(store.connect(migrated_db), late, status="failed", message="late")

    after = {table: _raw(migrated_db).execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall() for table in before}
    assert after == before
    assert _raw(migrated_db).execute("SELECT model_id FROM forecast_state").fetchone()[0] == served


def test_finish_run_records_status_message_and_json(migrated_db):
    run_id = _claimed_run(migrated_db)

    store.finish_run(store.connect(migrated_db), run_id, status="rejected", message="kept nothing",
                     gate_passed=False, gate_json={"passed": False}, forecast_written=False)

    row = dict(_raw(migrated_db).execute("SELECT * FROM forecast_runs").fetchone())
    assert (row["status"], row["message"], row["gate_passed"], row["forecast_written"]) == \
        ("rejected", "kept nothing", 0, 0)
    assert json.loads(row["gate_json"]) == {"passed": False}
    assert row["finished_at"] > 0


def test_a_gate_metric_with_no_data_is_stored_as_null(migrated_db):
    """A gate over few origins has metrics with no data (NaN). JSON has no NaN and
    the web app parses the column with JSON.parse: it must arrive as null."""
    run_id = _claimed_run(migrated_db)
    gate = {"passed": False, "model": {"daily_mape_1_14": float("nan"), "week_acc_std": np.float64("inf"),
                                       "hourly_mae_1_14": np.float64(3.5)},
            "naive": {"daily_mape_1_14": 9.0, "week_acc_std": float("-inf")}}

    store.finish_run(store.connect(migrated_db), run_id, status="rejected", message="m", gate_json=gate)

    text = _raw(migrated_db).execute("SELECT gate_json FROM forecast_runs").fetchone()[0]
    assert "NaN" not in text and "Infinity" not in text
    assert json.loads(text) == {"passed": False,
                                "model": {"daily_mape_1_14": None, "week_acc_std": None, "hourly_mae_1_14": 3.5},
                                "naive": {"daily_mape_1_14": 9.0, "week_acc_std": None}}


def test_a_run_column_outside_the_list_is_refused(migrated_db):
    run_id = _claimed_run(migrated_db)
    with pytest.raises(ValueError, match="trigger"):
        store.finish_run(store.connect(migrated_db), run_id, status="failed", message="x", trigger="cli")


# ---- the forecast swap ---------------------------------------------------------------

def test_write_forecast_fills_every_table_and_points_the_state_at_the_model(migrated_db):
    run_id = _claimed_run(migrated_db)

    model_id = _write(migrated_db, run_id, 5.0)

    conn = _raw(migrated_db)
    state = dict(conn.execute("SELECT * FROM forecast_state").fetchone())
    run = dict(conn.execute("SELECT * FROM forecast_runs").fetchone())
    assert (state["id"], state["run_id"], state["model_id"]) == (1, run_id, model_id)
    assert json.loads(state["quick_hangups_json"]) == {"n_quick": 1}
    assert tuple(conn.execute("SELECT count(*), min(predicted_calls) FROM forecast_hours").fetchone()) == (72, 5.0)
    assert conn.execute("SELECT count(*) FROM forecast_cells").fetchone()[0] == 3 * 7 * 24
    assert (run["status"], run["model_id"], run["trained"], run["forecast_written"]) == ("succeeded", model_id, 1, 1)
    serving = store.serving_model(store.connect(migrated_db))
    assert (serving.model_id, serving.model_text, serving.metadata) == (model_id, "tree 5.0", {"tag": "5.0"})


def test_without_a_new_model_the_given_model_keeps_serving(migrated_db):
    first = _write(migrated_db, _claimed_run(migrated_db), 1.0)
    second_run = _claimed_run(migrated_db)

    model_id = _write(migrated_db, second_run, 2.0, new_model=False, model_id=first)

    conn = _raw(migrated_db)
    assert model_id == first
    assert conn.execute("SELECT count(*) FROM model_artifacts").fetchone()[0] == 1
    assert tuple(conn.execute("SELECT run_id, model_id FROM forecast_state").fetchone()) == (second_run, first)


def test_a_failure_half_way_through_changes_nothing(migrated_db):
    run_id = _claimed_run(migrated_db)
    _write(migrated_db, run_id, 1.0)
    before = {table: _raw(migrated_db).execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall()
              for table in ("forecast_hours", "forecast_cells", "forecast_state", "forecast_runs", "model_artifacts")}
    broken_hours = _hours(9.0)
    broken_hours[40] = (broken_hours[40][0], broken_hours[40][1], None, 1.0)   # NOT NULL violated mid-insert

    conn = store.connect(migrated_db)
    with pytest.raises(store.DatabaseError):
        store.write_forecast(conn, run_id=_claimed_run(migrated_db), new_model=_model("broken"), hours=broken_hours,
                             cells=_cells(9.0), state=_state(), run={"status": "succeeded"})

    after = {table: _raw(migrated_db).execute(f"SELECT * FROM {table} ORDER BY 1, 2").fetchall()
             for table in before}
    assert {t: [tuple(r) for r in rows] for t, rows in after.items() if t != "forecast_runs"} == \
        {t: [tuple(r) for r in rows] for t, rows in before.items() if t != "forecast_runs"}
    assert tuple(_raw(migrated_db).execute("SELECT * FROM forecast_runs WHERE id = ?", (run_id,)).fetchone()) == \
        tuple(before["forecast_runs"][0])
    assert not conn.in_transaction


def test_old_artifacts_are_pruned_except_the_newest_five_and_the_serving_one(migrated_db):
    first = _write(migrated_db, _claimed_run(migrated_db), 0.0)
    # Make the first model the serving one while six newer artifacts arrive behind it.
    for value in range(1, 7):
        with _raw(migrated_db) as conn:
            conn.execute("INSERT INTO model_artifacts (run_id, created_at, model_sha256, model_text, metadata_json, "
                         "train_start, train_end, train_rows) VALUES (0, 0, ?, 't', '{}', 'a', 'b', 1)",
                         (f"newer-{value}",))
    _write(migrated_db, _claimed_run(migrated_db), 9.0, new_model=False, model_id=first)

    ids = [row[0] for row in _raw(migrated_db).execute("SELECT id FROM model_artifacts ORDER BY id")]
    assert ids == [first, 3, 4, 5, 6, 7]

    newest = _write(migrated_db, _claimed_run(migrated_db), 10.0)
    ids = [row[0] for row in _raw(migrated_db).execute("SELECT id FROM model_artifacts ORDER BY id")]
    assert ids == [4, 5, 6, 7, newest]


def test_a_reader_sees_the_old_or_the_new_forecast_never_a_mix(migrated_db):
    _write(migrated_db, _claimed_run(migrated_db), 0.0, calls_count=0)
    run_ids = [_claimed_run(migrated_db) for _ in range(12)]
    seen, problems = set(), []
    done = threading.Event()

    def writer():
        try:
            for value, run_id in enumerate(run_ids, start=1):
                _write(migrated_db, run_id, float(value), new_model=False, model_id=1, calls_count=value)
        finally:
            done.set()

    def reader():
        conn = store.connect(migrated_db, readonly=True)
        while not done.is_set():
            conn.execute("BEGIN")
            count = conn.execute("SELECT calls_count FROM forecast_state").fetchone()[0]
            values = {row[0] for row in conn.execute("SELECT DISTINCT predicted_calls FROM forecast_hours")}
            cells = {row[0] for row in conn.execute("SELECT DISTINCT aht_sec FROM forecast_cells")}
            conn.execute("COMMIT")
            seen.add(count)
            if values != {float(count)} or cells != {float(count)}:
                problems.append((count, values, cells))
        conn.close()

    threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=120)

    assert problems == []
    assert len(seen) >= 2
