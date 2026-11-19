"""DB hourly + supplemental client files -> one training frame.

Hand-built frames only, except the last test, which reads the real database
(skipped when V4W_DATABASE_URL is not set).
"""

import os

import pandas as pd
import pytest

from db.dataset import (
    Dataset,
    describe_supplement,
    load_dataset,
    load_snapshot,
    merge_hourly,
    missing_days,
    partial_edge_days,
    save_snapshot,
)

COLUMNS = ["hour_start", "offered", "answered", "abandoned", "answered_30s", "talk_sec"]


def _hourly(rows: list[tuple[str, int]]) -> pd.DataFrame:
    """(hour, offered) pairs -> hourly frame; every call answered in time."""
    return pd.DataFrame({
        "hour_start": pd.to_datetime([hour for hour, _ in rows]),
        "offered": [n for _, n in rows],
        "answered": [n for _, n in rows],
        "abandoned": [0 for _ in rows],
        "answered_30s": [n for _, n in rows],
        "talk_sec": [60.0 * n for _, n in rows],
    })[COLUMNS]


DB = _hourly([("2026-08-31 09:00", 4), ("2026-10-14 09:00", 5), ("2026-10-14 22:00", 2)])


# ---- merge_hourly ---------------------------------------------------------------

def test_days_missing_from_the_database_are_added():
    extra = _hourly([("2026-09-01 10:00", 3), ("2026-09-02 11:00", 6)])

    merged = merge_hourly(DB, extra)

    assert merged["offered"].sum() == DB["offered"].sum() + 9
    assert merged["hour_start"].is_monotonic_increasing


def test_a_day_already_in_the_database_is_not_counted_twice():
    same_day_same_total = _hourly([("2026-10-14 09:00", 5), ("2026-10-14 22:00", 2)])

    merged = merge_hourly(DB, same_day_same_total)

    pd.testing.assert_frame_equal(merged, DB)


def test_a_shared_day_with_a_different_total_raises():
    conflicting = _hourly([("2026-10-14 09:00", 6)])

    with pytest.raises(ValueError, match="2026-10-14"):
        merge_hourly(DB, conflicting)


def test_database_rows_win_hour_by_hour_on_a_shared_day():
    # Same day total (7) but split over different hours: the DB split is kept.
    regrouped = _hourly([("2026-10-14 08:00", 7)])

    merged = merge_hourly(DB, regrouped)

    assert pd.Timestamp("2026-10-14 08:00") not in set(merged["hour_start"])


def test_merge_does_not_change_its_inputs():
    extra = _hourly([("2026-09-01 10:00", 3)])
    before_db, before_extra = DB.copy(), extra.copy()

    merge_hourly(DB, extra)

    pd.testing.assert_frame_equal(DB, before_db)
    pd.testing.assert_frame_equal(extra, before_extra)


# ---- describe_supplement ----------------------------------------------------------

def test_supplement_summary_counts_new_and_known_days():
    extra = _hourly([("2026-09-01 10:00", 3), ("2026-10-14 09:00", 5), ("2026-10-14 22:00", 2)])

    summary = describe_supplement("week.xlsx", DB, extra)

    assert summary == {
        "file": "week.xlsx", "calls": 10, "first_day": "2026-09-01", "last_day": "2026-10-14",
        "days_added": 1, "days_already_in_db": 1, "calls_added": 3,
    }


# ---- missing_days ------------------------------------------------------------------

def test_missing_days_lists_every_day_without_calls_between_first_and_last():
    hourly = _hourly([("2026-08-30 09:00", 1), ("2026-09-02 09:00", 1)])

    assert [str(d.date()) for d in missing_days(hourly)] == ["2026-08-31", "2026-09-01"]


def test_no_missing_days_when_every_day_has_a_call():
    hourly = _hourly([("2026-08-30 09:00", 1), ("2026-08-31 23:00", 1)])

    assert len(missing_days(hourly)) == 0


# ---- snapshot ----------------------------------------------------------------------

def test_snapshot_round_trip(tmp_path):
    holidays = pd.DataFrame({
        "holiday_date": pd.to_datetime(["2026-09-07", "2026-11-26"]),
        "holiday_name": ["Labor Day", "Thanksgiving"],
    })
    dataset = Dataset(hourly=DB, holidays=holidays, sources=({"file": "database", "calls": 11},))

    save_snapshot(dataset, tmp_path / "snap")
    loaded = load_snapshot(tmp_path / "snap")

    pd.testing.assert_frame_equal(loaded.hourly, DB)
    pd.testing.assert_frame_equal(loaded.holidays, holidays)
    assert loaded.sources == dataset.sources


def test_loading_a_missing_snapshot_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_snapshot(tmp_path / "nothing-here")


# ---- real database ------------------------------------------------------------------

def test_database_only_dataset_counts_every_call():
    dsn = os.environ.get("V4W_DATABASE_URL")
    if not dsn:
        pytest.skip("V4W_DATABASE_URL is not set")
    import psycopg

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM calls")
        total_calls = cur.fetchone()[0]

    dataset = load_dataset(dsn, supplement=[])

    assert dataset.hourly["offered"].sum() == total_calls
    assert dataset.sources[0]["file"] == "database"
    assert len(dataset.holidays) > 0


# ---- files cut part-way through a day -------------------------------------------------

def _every_hour(first: str, last: str) -> pd.DataFrame:
    hours = pd.date_range(first, last, freq="h")
    return _hourly([(str(hour), 5) for hour in hours])


def test_a_file_of_whole_days_has_no_partial_edge():
    assert partial_edge_days(_every_hour("2026-09-01 00:00", "2026-09-03 23:00")) == []


def test_a_file_that_starts_mid_morning_or_stops_mid_afternoon_is_flagged():
    cut = _every_hour("2026-09-01 10:00", "2026-09-03 14:00")

    assert partial_edge_days(cut) == ["2026-09-01", "2026-09-03"]
