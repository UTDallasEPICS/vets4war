"""db.day_ledger: what one calendar day of calls looks like, and whether an
uploaded day is new, already loaded, or different. Pure; synthetic rows."""

from datetime import date

import pandas as pd
import pytest

from db.day_ledger import CONFLICT, IDENTICAL, NEW, DaySummary, describe_plan, plan_days, summarize_days

MONDAY, TUESDAY, WEDNESDAY = date(2026, 10, 19), date(2026, 10, 20), date(2026, 10, 21)


def _calls(rows) -> pd.DataFrame:
    """rows: (timestamp text, in_queue, agent, abandon, routing, abandoned)."""
    frame = pd.DataFrame(rows, columns=["start_ts", "in_queue_sec", "agent_sec", "abandon_sec", "routing_sec", "abandoned"])
    return frame.assign(start_ts=pd.to_datetime(frame["start_ts"]))


def _two_days() -> pd.DataFrame:
    return _calls([
        ("2026-10-19 00:05:00", 10.0, 600.0, 0.0, 10.0, False),
        ("2026-10-19 23:59:59", 45.0, 0.0, 45.0, 45.0, True),
        ("2026-10-20 08:00:00", 5.0, 300.0, 0.0, 5.0, False),
    ])


# --- summarize_days ----------------------------------------------------------

def test_rows_are_counted_per_calendar_day():
    days = summarize_days(_two_days())
    assert sorted(days) == [MONDAY, TUESDAY]
    assert days[MONDAY].rows == 2
    assert days[TUESDAY].rows == 1


def test_no_calls_gives_no_days():
    assert summarize_days(_two_days().iloc[0:0]) == {}


def test_fingerprint_does_not_depend_on_row_order():
    shuffled = _two_days().iloc[[2, 1, 0]].reset_index(drop=True)
    assert summarize_days(shuffled) == summarize_days(_two_days())


def test_fingerprint_changes_when_a_duration_changes():
    changed = _two_days().assign(agent_sec=[600.5, 0.0, 300.0])
    before, after = summarize_days(_two_days()), summarize_days(changed)
    assert after[MONDAY].fingerprint != before[MONDAY].fingerprint
    assert after[TUESDAY] == before[TUESDAY]


def test_fingerprint_changes_when_the_abandoned_flag_changes():
    flipped = _two_days().assign(abandoned=[True, True, False])
    assert summarize_days(flipped)[MONDAY].fingerprint != summarize_days(_two_days())[MONDAY].fingerprint


def test_fingerprint_changes_when_a_call_moves_by_a_second():
    moved = _calls([("2026-10-20 08:00:01", 5.0, 300.0, 0.0, 5.0, False)])
    assert summarize_days(moved)[TUESDAY].fingerprint != summarize_days(_two_days())[TUESDAY].fingerprint


def test_fingerprint_ignores_noise_far_below_a_millisecond():
    noisy = _two_days().assign(in_queue_sec=[10.0000000001, 45.0, 4.9999999999])
    assert summarize_days(noisy) == summarize_days(_two_days())


def test_two_identical_calls_are_two_rows_not_one():
    twice = _calls([("2026-10-20 08:00:00", 5.0, 300.0, 0.0, 5.0, False)] * 2)
    once = _calls([("2026-10-20 08:00:00", 5.0, 300.0, 0.0, 5.0, False)])
    assert summarize_days(twice)[TUESDAY].rows == 2
    assert summarize_days(twice)[TUESDAY].fingerprint != summarize_days(once)[TUESDAY].fingerprint


def test_missing_durations_are_allowed_and_distinct_from_zero():
    blank = _calls([("2026-10-20 08:00:00", None, 300.0, None, 5.0, False)])
    zero = _calls([("2026-10-20 08:00:00", 0.0, 300.0, 0.0, 5.0, False)])
    assert summarize_days(blank)[TUESDAY].rows == 1
    assert summarize_days(blank)[TUESDAY].fingerprint != summarize_days(zero)[TUESDAY].fingerprint


def test_text_and_real_timestamps_give_the_same_day():
    as_text = _two_days().assign(start_ts=["2026-10-19T00:05:00", "2026-10-19T23:59:59", "2026-10-20T08:00:00"])
    assert summarize_days(as_text) == summarize_days(_two_days())


def test_input_is_not_changed():
    calls = _two_days()
    summarize_days(calls)
    pd.testing.assert_frame_equal(calls, _two_days())


def test_missing_column_is_rejected():
    with pytest.raises(ValueError, match="agent_sec"):
        summarize_days(_two_days().drop(columns=["agent_sec"]))


# --- plan_days ---------------------------------------------------------------

def test_day_not_in_the_database_is_new():
    assert plan_days({MONDAY: DaySummary(2, "a")}, {}) == {MONDAY: NEW}


def test_same_count_and_fingerprint_is_identical():
    assert plan_days({MONDAY: DaySummary(2, "a")}, {MONDAY: DaySummary(2, "a")}) == {MONDAY: IDENTICAL}


@pytest.mark.parametrize("existing", [DaySummary(3, "a"), DaySummary(2, "b")])
def test_different_count_or_content_is_a_conflict(existing):
    assert plan_days({MONDAY: DaySummary(2, "a")}, {MONDAY: existing}) == {MONDAY: CONFLICT}


def test_days_only_in_the_database_are_not_part_of_the_plan():
    plan = plan_days({TUESDAY: DaySummary(1, "t")}, {MONDAY: DaySummary(2, "a"), TUESDAY: DaySummary(1, "t")})
    assert plan == {TUESDAY: IDENTICAL}


# --- describe_plan -----------------------------------------------------------

def test_plan_is_described_one_row_per_day_oldest_first():
    file_days = {WEDNESDAY: DaySummary(4, "w"), MONDAY: DaySummary(2, "a"), TUESDAY: DaySummary(1, "t")}
    current = {MONDAY: DaySummary(2, "a"), TUESDAY: DaySummary(9, "x")}
    assert describe_plan(file_days, current) == [
        {"day": "2026-10-19", "rows": 2, "existing_rows": 2, "status": IDENTICAL},
        {"day": "2026-10-20", "rows": 1, "existing_rows": 9, "status": CONFLICT},
        {"day": "2026-10-21", "rows": 4, "existing_rows": 0, "status": NEW},
    ]


def test_end_to_end_a_reloaded_file_is_identical_and_an_edited_one_conflicts():
    stored = summarize_days(_two_days())
    assert set(plan_days(summarize_days(_two_days()), stored).values()) == {IDENTICAL}
    edited = _two_days().assign(routing_sec=[10.0, 45.0, 6.0])
    assert plan_days(summarize_days(edited), stored) == {MONDAY: IDENTICAL, TUESDAY: CONFLICT}
