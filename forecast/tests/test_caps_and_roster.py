"""Per-shift caps (Evening 6), the partner efficiency default, roster helpers."""

import pandas as pd
import pytest

from db.snapshot import at_roster, core_shift, parse_roster
from db.staffing import (
    DEFAULT_EFFICIENCY,
    MAX_STAFF_PER_SHIFT,
    SHIFT_CAPS,
    cap_for_hour,
    cap_for_shift,
    staff_for_hour,
    verdict,
)


def test_default_efficiency_is_the_partner_calculator():
    assert DEFAULT_EFFICIENCY == pytest.approx(315 / 480)


def test_evening_is_capped_at_six_and_others_at_seven():
    assert SHIFT_CAPS == {"Overnight": MAX_STAFF_PER_SHIFT, "Day": MAX_STAFF_PER_SHIFT, "Evening": 6}
    assert [cap_for_hour(h) for h in (0, 7, 8, 15, 16, 23)] == [7, 7, 7, 7, 6, 6]


def test_unknown_shift_and_hour_are_rejected():
    with pytest.raises(ValueError):
        cap_for_shift("Lunch")
    with pytest.raises(ValueError):
        cap_for_hour(24)


def test_seven_people_is_over_the_evening_cap_only():
    assert verdict(7, 7, cap_for_shift("Evening")) == "exceeds capacity"
    assert verdict(7, 7, cap_for_shift("Day")) == "on target"


def test_staff_for_hour_flags_against_the_given_cap():
    busy = staff_for_hour(40, 600, efficiency=0.65625, cap=6)
    assert busy["capped"] == (busy["scheduled_needed"] > 6)
    relaxed = staff_for_hour(40, 600, efficiency=0.65625, cap=99)
    assert relaxed["capped"] is False


def test_roster_parses_in_shift_order():
    assert parse_roster("4,4,6") == {"Overnight": 4, "Day": 4, "Evening": 6}
    with pytest.raises(ValueError):
        parse_roster("4,4")


def test_hours_map_to_their_core_shift():
    assert [core_shift(h) for h in (0, 8, 16, 23)] == ["Overnight", "Day", "Evening", "Evening"]


def test_at_roster_uses_the_roster_number_of_each_hour():
    hourly = pd.DataFrame({
        "hour_start": pd.to_datetime(["2026-10-21 03:00", "2026-10-21 18:00"]),
        "predicted_offered": [6.0, 9.0],
        "predicted_aht_sec": [600.0, 600.0],
        "offered_load_erlangs": [1.0, 1.5],
        "scheduled_needed": [5, 6],
    })
    frame = at_roster(hourly, {"Overnight": 4, "Day": 4, "Evening": 6}, 0.65625, 30, 256.0)
    assert frame["roster_staff"].tolist() == [4, 6]
    assert frame["shift"].tolist() == ["Overnight", "Evening"]
    assert frame["sl_at_roster"].between(0, 1).all()
    assert frame["abandon_share_at_roster"].between(0, 1).all()
