"""The pandas twins that replace final-main's Postgres SQL, each against a
short row-by-row oracle written here from the SQL's definition.

The calls are a small hand-made SYNTHETIC frame with the awkward cases in it:
missing durations, an answered call with zero talk time, one (dow, hour)
cell with 30+ answered calls next to thin ones, the quick hang-up window
edge to the second, and both daylight-saving Sundays (naive Eastern times:
02:00 empty in spring, 01:00 doubled in autumn).
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from conftest import insert_calls
from db import store
from db.aht import MIN_CELL_CALLS, aht_from_calls, estimate_aht
from db.client_files import hourly_from_calls
from db.features import load_hourly
from db.patience import estimate_patience, patience_from_calls
from db.quick_abandon import measure_quick_hangups, quick_hangups_from_calls
from db.real_calls import estimate_real_share, real_counts, real_share_table

NAN = np.nan
NEWEST = pd.Timestamp("2026-11-01 01:59:59")          # fall-back Sunday, second 01:00 hour
WINDOW_EDGE = NEWEST - pd.Timedelta(days=90)          # 2026-08-03 01:59:59, excluded
BUSY_MONDAY = pd.Timestamp("2026-08-03 09:00:00")     # one cell with enough answered calls
CELLS = [(dow, hour) for dow in range(1, 8) for hour in range(24)]


def _frame() -> pd.DataFrame:
    rows = [
        # A busy cell: Monday 09:00, 35 answered calls, plus one with zero talk
        # time and one with no talk time recorded (neither is handle time).
        *[(BUSY_MONDAY + pd.Timedelta(minutes=minute), 20.0, 300.0 + 10 * minute, 0.0, 15.0, False)
          for minute in range(35)],
        (BUSY_MONDAY + pd.Timedelta(minutes=40), 25.0, 0.0, 0.0, 15.0, False),
        (BUSY_MONDAY + pd.Timedelta(minutes=41), 25.0, NAN, 0.0, 15.0, False),
        # The window edge: exactly 90 days before the newest call is out, one second later is in.
        (WINDOW_EDGE, 30.0, 500.0, 0.0, 10.0, False),
        (WINDOW_EDGE + pd.Timedelta(seconds=1), 5.0, 0.0, 5.0, 10.0, True),
        # Hang-ups: quick, slow, and one with no abandon time recorded.
        (pd.Timestamp("2026-09-15 14:10:00"), 3.0, 0.0, 3.0, 9.0, True),
        (pd.Timestamp("2026-09-15 14:20:00"), 400.0, 0.0, 400.0, 9.0, True),
        (pd.Timestamp("2026-09-15 14:30:00"), 50.0, 0.0, NAN, 9.0, True),
        # An answered call with no queue time recorded (patience skips it).
        (pd.Timestamp("2026-09-15 14:40:00"), NAN, 180.0, 0.0, 9.0, False),
        # Spring forward: 01:30 then 03:10, nothing at 02:00.
        (pd.Timestamp("2026-03-08 01:30:00"), 12.0, 700.0, 0.0, 8.0, False),
        (pd.Timestamp("2026-03-08 03:10:00"), 14.0, 90.0, 0.0, 8.0, False),
        # Fall back: three calls in the doubled 01:00 hour, the last one the newest call.
        (pd.Timestamp("2026-11-01 01:10:00"), 40.0, 650.0, 0.0, 12.0, False),
        (pd.Timestamp("2026-11-01 01:10:00"), 60.0, 0.0, 9.0, 12.0, True),
        (NEWEST, 22.0, 130.0, 0.0, 12.0, False),
    ]
    frame = pd.DataFrame(rows, columns=list(store.CALLS_COLUMNS))
    return frame.sort_values("start_ts", kind="stable").reset_index(drop=True)


CALLS = _frame()


def _weight(day: pd.Timestamp, newest_day: pd.Timestamp, halflife) -> float:
    return 1.0 if halflife is None else 0.5 ** ((newest_day - day).days / halflife)


# ---- oracles: one row at a time, straight from the SQL ---------------------------------

def oracle_aht(calls, halflife):
    rows = [(r.start_ts, r.agent_sec) for r in calls.itertuples() if not r.abandoned and r.agent_sec > 0]
    newest = max(ts.normalize() for ts, _ in rows)
    weigh = lambda ts: _weight(ts.normalize(), newest, halflife)  # noqa: E731
    overall = sum(weigh(ts) * sec for ts, sec in rows) / sum(weigh(ts) for ts, _ in rows)
    table = {}
    for dow, hour in CELLS:
        cell = [(ts, sec) for ts, sec in rows if ts.isoweekday() == dow and ts.hour == hour]
        enough = len(cell) >= MIN_CELL_CALLS
        table[(dow, hour)] = sum(weigh(ts) * sec for ts, sec in cell) / sum(weigh(ts) for ts, _ in cell) \
            if enough else overall
    return table


def oracle_real_share(calls, halflife):
    newest = max(r.start_ts.normalize() for r in calls.itertuples())
    real = lambda r: (not r.abandoned) and r.agent_sec > 120  # noqa: E731
    weigh = lambda r: _weight(r.start_ts.normalize(), newest, halflife)  # noqa: E731
    rows = list(calls.itertuples())
    overall = sum(weigh(r) * real(r) for r in rows) / sum(weigh(r) for r in rows)
    table = {}
    for dow, hour in CELLS:
        cell = [r for r in rows if r.start_ts.isoweekday() == dow and r.start_ts.hour == hour]
        table[(dow, hour)] = sum(weigh(r) * real(r) for r in cell) / sum(weigh(r) for r in cell) \
            if len(cell) >= MIN_CELL_CALLS else overall
    return table


def oracle_patience(calls):
    waits = [r.abandon_sec if r.abandoned else r.in_queue_sec for r in calls.itertuples()]
    total = sum(w for w in waits if not math.isnan(w))
    n_abandoned = sum(bool(r.abandoned) for r in calls.itertuples())
    return {"patience_sec": total / n_abandoned, "n_abandoned": n_abandoned, "n_calls": len(calls)}


def oracle_quick(calls, threshold, days):
    newest = calls["start_ts"].max()
    rows = [r for r in calls.itertuples() if r.start_ts > newest - pd.Timedelta(days=days)]
    n_abandoned = sum(bool(r.abandoned) for r in rows)
    n_quick = sum(bool(r.abandoned) and r.abandon_sec < threshold for r in rows)
    return {"threshold_sec": threshold, "window_days": days,
            "first_day": str(min(r.start_ts for r in rows).date()), "last_day": str(max(r.start_ts for r in rows).date()),
            "n_calls": len(rows), "n_abandoned": n_abandoned, "n_quick": n_quick,
            "quick_share_of_abandoned": n_quick / n_abandoned if n_abandoned else None,
            "quick_share_of_calls": n_quick / len(rows) if rows else None}


# ---- twins against oracles ---------------------------------------------------------------

@pytest.mark.parametrize("halflife", [None, 365, 90])
def test_handle_time_matches_the_oracle(halflife):
    twin = aht_from_calls(CALLS, halflife)

    assert twin == pytest.approx(oracle_aht(CALLS, halflife), rel=1e-12)


def test_handle_time_uses_its_own_cell_only_with_enough_calls_and_skips_zero_and_missing_talk():
    table = aht_from_calls(CALLS, None)

    assert table[(1, 9)] == pytest.approx(np.mean([300.0 + 10 * m for m in range(35)]))
    others = {table[cell] for cell in CELLS if cell != (1, 9)}
    assert len(others) == 1                                     # every thin cell: the global mean


def test_handle_time_ages_from_the_newest_answered_call_with_talk_time():
    # The newest call overall is an abandoned one; the weights must not age from it.
    calls = pd.concat([CALLS, pd.DataFrame([(pd.Timestamp("2026-12-31 10:00:00"), 5.0, 0.0, 5.0, 1.0, True)],
                                           columns=list(store.CALLS_COLUMNS))], ignore_index=True)

    assert aht_from_calls(calls, 90) == pytest.approx(aht_from_calls(CALLS, 90), rel=1e-12)


@pytest.mark.parametrize("halflife", [None, 365, 90])
def test_real_share_matches_the_oracle(halflife):
    twin = real_share_table(real_counts(CALLS), halflife)

    assert twin == pytest.approx(oracle_real_share(CALLS, halflife), rel=1e-12)


def test_real_counts_count_the_doubled_fall_back_hour_once_per_call():
    counts = real_counts(CALLS)
    fall_back = counts[(counts["call_date"] == pd.Timestamp("2026-11-01")) & (counts["call_hour"] == 1)]

    assert fall_back[["dow", "n_calls", "n_real"]].values.tolist() == [[7, 3.0, 2.0]]


def test_patience_matches_the_oracle_and_skips_missing_waits():
    assert patience_from_calls(CALLS) == pytest.approx(oracle_patience(CALLS), rel=1e-12)
    assert patience_from_calls(CALLS)["n_calls"] == len(CALLS)


@pytest.mark.parametrize("threshold, days", [(10, 90), (5, 90), (10, 30)])
def test_quick_hangups_match_the_oracle(threshold, days):
    assert quick_hangups_from_calls(CALLS, threshold, days) == oracle_quick(CALLS, threshold, days)


def test_the_quick_hangup_window_is_strict_to_the_second():
    result = quick_hangups_from_calls(CALLS)

    assert result["first_day"] == "2026-08-03"
    # Out: the call exactly on the edge and the two March calls; everything later is in.
    assert result["n_calls"] == len(CALLS) - 3
    assert result["n_quick"] == 3                              # 5 s, 3 s and 9 s; not 400 s or the missing one


def test_hourly_grain_keeps_daylight_saving_as_exported():
    hourly = hourly_from_calls(CALLS).set_index("hour_start")

    assert hourly.loc[pd.Timestamp("2026-11-01 01:00"), "offered"] == 3
    assert pd.Timestamp("2026-03-08 02:00") not in hourly.index
    assert hourly.loc[pd.Timestamp("2026-03-08 03:00"), "offered"] == 1


def test_no_calls_raise_instead_of_inventing_numbers():
    empty = CALLS.iloc[0:0]
    for twin in (lambda: aht_from_calls(empty, None), lambda: real_share_table(real_counts(empty), None),
                 lambda: patience_from_calls(empty), lambda: quick_hangups_from_calls(empty)):
        with pytest.raises(ValueError):
            twin()


# ---- the database versions read through the store and agree ------------------------------

def test_the_connection_versions_equal_the_twins(migrated_db):
    insert_calls(migrated_db, CALLS)
    conn = store.connect(migrated_db, readonly=True)
    stored = store.read_snapshot(conn).calls

    pd.testing.assert_frame_equal(stored, CALLS, check_dtype=False)
    assert estimate_aht(conn, 90) == aht_from_calls(CALLS, 90)
    assert estimate_real_share(conn, 365) == real_share_table(real_counts(CALLS), 365)
    assert estimate_patience(conn) == patience_from_calls(CALLS)
    assert measure_quick_hangups(conn) == quick_hangups_from_calls(CALLS)
    pd.testing.assert_frame_equal(load_hourly(conn), hourly_from_calls(CALLS))
