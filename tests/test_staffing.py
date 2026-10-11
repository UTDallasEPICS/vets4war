"""Tests for db/staffing.py: the efficiency division and the answer-time
threshold. Pure math, no database.

Run from the repo root:  python -m pytest tests/test_staffing.py -v
"""

import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from db.erlang import required_agents  # noqa: E402
from db.staffing import (  # noqa: E402
    MAX_PLAUSIBLE_STAFF,
    schedule_people,
    staff_for_hour,
)

EFFICIENCY_STEPS_PCT = range(1, 101)     # 1% .. 100%, the widened slider range
AGENT_COUNTS = range(1, 21)              # 1 .. 20 agents required
PCT = 100
CALLS, AHT = 5.0, 600.0                  # load 0.833 erlangs, a typical hour


def test_effective_agents_never_below_required_across_widened_range():
    """floor(scheduled * efficiency) >= agents_required for every 1% step
    from 1% to 100% and every agent count up to 20. Reported, not patched."""
    failures = []
    for pct in EFFICIENCY_STEPS_PCT:
        efficiency = pct / PCT
        for agents in AGENT_COUNTS:
            scheduled, effective = schedule_people(agents, efficiency)
            if effective < agents:
                failures.append((pct, agents, scheduled, effective))
    assert failures == [], f"{len(failures)} violations (pct, agents, scheduled, effective): {failures[:20]}"


def test_scheduled_is_the_smallest_count_that_works():
    """One fewer scheduled person would leave fewer than `agents` on inbound."""
    for pct in EFFICIENCY_STEPS_PCT:
        efficiency = pct / PCT
        for agents in AGENT_COUNTS:
            scheduled, _ = schedule_people(agents, efficiency)
            assert math.floor((scheduled - 1) * efficiency) < agents, (pct, agents, scheduled)


def test_efficiency_zero_is_undefined_not_infinite():
    # Act
    result = staff_for_hour(CALLS, AHT, efficiency=0.0)

    # Assert
    assert result["agents_required"] >= 1
    assert result["scheduled_needed"] is None
    assert result["effective_agents"] is None
    assert result["service_level_at_scheduled"] is None
    assert result["capped"] is None
    assert result["implausible"] is False
    assert "efficiency" in result["reason"] and "0" in result["reason"]


def test_schedule_people_at_zero_efficiency_returns_none_pair():
    assert schedule_people(3, 0.0) == (None, None)


def test_efficiency_one_percent_is_returned_but_flagged_implausible():
    # Act
    result = staff_for_hour(CALLS, AHT, efficiency=0.01)

    # Assert: the number is there, and it is the honest arithmetic
    assert result["scheduled_needed"] == math.ceil(result["agents_required"] / 0.01)
    assert result["scheduled_needed"] > MAX_PLAUSIBLE_STAFF
    assert result["implausible"] is True
    assert str(MAX_PLAUSIBLE_STAFF) in result["reason"]
    assert result["capped"] is True


def test_efficiency_one_schedules_exactly_the_required_agents():
    # Act
    result = staff_for_hour(CALLS, AHT, efficiency=1.0)

    # Assert
    assert result["scheduled_needed"] == result["agents_required"]
    assert result["effective_agents"] == result["agents_required"]
    assert result["implausible"] is False
    assert result["reason"] is None


@pytest.mark.parametrize("efficiency", [-0.01, 1.01])
def test_efficiency_outside_zero_to_one_is_rejected(efficiency):
    with pytest.raises(ValueError):
        staff_for_hour(CALLS, AHT, efficiency=efficiency)


def test_tighter_answer_time_never_needs_fewer_agents():
    # Arrange: 30 calls/hr at 10-minute AHT, 80% target; t = 20, 30, 45 s
    by_t = {t: required_agents(30, AHT, 0.80, t) for t in (20, 30, 45)}

    # Assert: answering faster is at least as hard
    assert by_t[20] >= by_t[30] >= by_t[45], by_t
    assert by_t[30] == 8   # the known case from tests/test_erlang.py


@pytest.mark.parametrize("target_sec", [20, 30, 45])
def test_staff_for_hour_threads_target_sec_through_the_whole_chain(target_sec):
    # Act
    result = staff_for_hour(30, AHT, efficiency=0.65, target_pct=0.80, target_sec=target_sec)

    # Assert: agents come from Erlang at this t, and the delivered service
    # level is evaluated at the same t with the effective agent count.
    assert result["agents_required"] == required_agents(30, AHT, 0.80, target_sec)
    assert result["service_level_at_scheduled"] >= 0.80
    assert result["target_sec"] == target_sec


def test_delivered_service_level_is_reported_and_rises_with_looser_t():
    levels = [staff_for_hour(30, AHT, 0.65, 0.80, t)["service_level_at_scheduled"] for t in (20, 30, 45)]
    scheduled = [staff_for_hour(30, AHT, 0.65, 0.80, t)["scheduled_needed"] for t in (20, 30, 45)]
    # With the same people scheduled, a looser threshold is met by more callers.
    if len(set(scheduled)) == 1:
        assert levels[0] <= levels[1] <= levels[2], levels
    assert all(0.80 <= sl <= 1.0 for sl in levels), levels


PATIENCE = 400.0


def test_erlang_c_path_reports_no_abandonment():
    result = staff_for_hour(CALLS, AHT, efficiency=0.65)
    assert result["queue_model"] == "erlang_c"
    assert result["patience_sec"] is None
    assert result["abandon_share"] is None


def test_erlang_a_path_reports_abandonment_and_meets_target():
    result = staff_for_hour(30, AHT, efficiency=0.65, target_pct=0.80, target_sec=30, patience_sec=PATIENCE)
    assert result["queue_model"] == "erlang_a"
    assert result["patience_sec"] == PATIENCE
    assert 0.0 < result["abandon_share"] < 1.0
    assert result["service_level_at_scheduled"] >= 0.80
    assert result["abandon_share"] <= 1.0 - result["service_level_at_scheduled"] + 1e-12


def test_erlang_a_at_zero_efficiency_is_undefined_but_keeps_the_model():
    result = staff_for_hour(CALLS, AHT, efficiency=0.0, patience_sec=PATIENCE)
    assert result["scheduled_needed"] is None and result["abandon_share"] is None
    assert result["queue_model"] == "erlang_a"
