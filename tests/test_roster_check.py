"""db.roster_check.roster_check: per-shift actuals vs the model at the roster. Synthetic."""

import pandas as pd
import pytest

from db.roster_check import ALL_SHIFTS, _format, roster_check


def _calls() -> pd.DataFrame:
    """Overnight: 2 calls (1 abandoned). Day: 4 calls (all answered, one slow).
    Evening: 2 calls (both answered fast, one with no talk time)."""
    return pd.DataFrame({
        "start_ts": pd.to_datetime([
            "2026-10-21 02:05", "2026-10-21 03:40",
            "2026-10-21 09:00", "2026-10-21 10:00", "2026-10-21 11:00", "2026-10-22 12:00",
            "2026-10-21 17:00", "2026-10-21 23:30",
        ]),
        "in_queue_sec": [10.0, 90.0, 5.0, 30.0, 31.0, 0.0, 1.0, 2.0],
        "agent_sec": [600.0, 0.0, 300.0, 500.0, 700.0, 500.0, 400.0, 0.0],
        "abandon_sec": [0.0, 90.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        "routing_sec": [10.0, 90.0, 5.0, 30.0, 31.0, 0.0, 1.0, 2.0],
        "abandoned": [False, True, False, False, False, False, False, False],
    })


def _expected() -> pd.DataFrame:
    """Two hours per shift; the second hour of each carries 3x the calls."""
    return pd.DataFrame({
        "date": ["2026-10-21", "2026-10-21", "2026-10-21", "2026-10-22", "2026-10-21", "2026-10-21"],
        "shift": ["Overnight", "Overnight", "Day", "Day", "Evening", "Evening"],
        "predicted_calls": [1.0, 3.0, 1.0, 3.0, 1.0, 3.0],
        "aht_sec": [600.0, 600.0, 400.0, 800.0, 500.0, 500.0],
        "sl_at_roster": [0.9, 0.5, 0.4, 0.8, 1.0, 0.6],
        "abandon_share_at_roster": [0.0, 0.4, 0.1, 0.1, 0.0, 0.2],
    })


def _row(result: pd.DataFrame, shift: str) -> pd.Series:
    return result.set_index("shift").loc[shift]


def test_one_row_per_shift_in_shift_order_then_all():
    result = roster_check(_calls(), _expected())
    assert list(result["shift"]) == ["Overnight", "Day", "Evening", ALL_SHIFTS]


def test_actual_shares_are_counted_per_shift():
    result = roster_check(_calls(), _expected())
    overnight, day = _row(result, "Overnight"), _row(result, "Day")
    assert overnight["calls"] == 2
    assert overnight["answered_actual"] == pytest.approx(0.5)
    assert overnight["abandon_actual"] == pytest.approx(0.5)
    # 30 s exactly counts as answered in time, 31 s does not.
    assert day["answered_actual"] == pytest.approx(0.75)
    assert day["abandon_actual"] == 0


def test_actual_handle_time_skips_abandoned_and_zero_talk_calls():
    result = roster_check(_calls(), _expected())
    assert _row(result, "Overnight")["aht_actual_sec"] == pytest.approx(600.0)
    assert _row(result, "Evening")["aht_actual_sec"] == pytest.approx(400.0)


def test_predictions_are_weighted_by_predicted_calls():
    result = roster_check(_calls(), _expected())
    overnight, day = _row(result, "Overnight"), _row(result, "Day")
    assert overnight["predicted_calls"] == pytest.approx(4.0)
    assert overnight["answered_predicted"] == pytest.approx((0.9 + 3 * 0.5) / 4)
    assert overnight["abandon_predicted"] == pytest.approx(0.3)
    assert day["aht_predicted_sec"] == pytest.approx(700.0)


def test_gap_is_predicted_minus_actual_in_points():
    result = roster_check(_calls(), _expected())
    overnight = _row(result, "Overnight")
    assert overnight["answered_gap_pts"] == pytest.approx((0.6 - 0.5) * 100)
    assert overnight["abandon_gap_pts"] == pytest.approx((0.3 - 0.5) * 100)


def test_all_row_covers_every_call_and_every_forecast_hour():
    result = roster_check(_calls(), _expected())
    everything = _row(result, ALL_SHIFTS)
    assert everything["calls"] == 8
    assert everything["predicted_calls"] == pytest.approx(12.0)
    assert everything["answered_actual"] == pytest.approx(6 / 8)
    assert everything["abandon_actual"] == pytest.approx(1 / 8)


def test_inputs_are_not_changed():
    calls, expected = _calls(), _expected()
    roster_check(calls, expected)
    pd.testing.assert_frame_equal(calls, _calls())
    pd.testing.assert_frame_equal(expected, _expected())


def test_missing_forecast_column_is_rejected():
    with pytest.raises(ValueError, match="sl_at_roster"):
        roster_check(_calls(), _expected().drop(columns=["sl_at_roster"]))


def test_no_calls_is_rejected():
    with pytest.raises(ValueError, match="no calls"):
        roster_check(_calls().iloc[0:0], _expected())


def test_shift_without_calls_is_rejected():
    only_day = _calls().iloc[2:6]
    with pytest.raises(ValueError, match="Overnight"):
        roster_check(only_day, _expected())


def test_day_predictions_weight_the_busier_hour_more():
    day = _row(roster_check(_calls(), _expected()), "Day")
    assert day["answered_predicted"] == pytest.approx((0.4 + 3 * 0.8) / 4)


def test_all_row_predictions_are_weighted_over_every_hour():
    everything = _row(roster_check(_calls(), _expected()), ALL_SHIFTS)
    assert everything["answered_predicted"] == pytest.approx((0.9 + 1.5 + 0.4 + 2.4 + 1.0 + 1.8) / 12)
    assert everything["abandon_predicted"] == pytest.approx((1.2 + 0.1 + 0.3 + 0.6) / 12)


def test_abandoned_call_with_a_short_wait_is_not_answered_in_time():
    calls = _calls().assign(in_queue_sec=[10.0, 5.0, 5.0, 30.0, 31.0, 0.0, 1.0, 2.0])
    assert _row(roster_check(calls, _expected()), "Overnight")["answered_actual"] == pytest.approx(0.5)


def test_calls_on_the_shift_boundaries_go_to_the_shift_that_starts():
    calls = _calls().assign(start_ts=pd.to_datetime([
        "2026-10-21 00:00", "2026-10-21 07:59",
        "2026-10-21 08:00", "2026-10-21 10:00", "2026-10-21 11:00", "2026-10-22 15:59",
        "2026-10-21 16:00", "2026-10-21 23:59",
    ]))
    result = roster_check(calls, _expected())
    assert list(result["calls"]) == [2, 4, 2, 8]


def test_forecast_hours_on_dates_without_calls_are_left_out():
    extra_day = _expected().assign(date="2026-10-30", predicted_calls=100.0, sl_at_roster=0.0)
    widened = pd.concat([_expected(), extra_day], ignore_index=True)
    pd.testing.assert_frame_equal(roster_check(_calls(), widened), roster_check(_calls(), _expected()))


def test_shift_with_no_talk_time_shows_no_actual_handle_time():
    calls = _calls().assign(agent_sec=[600.0, 0.0, 300.0, 500.0, 700.0, 500.0, 0.0, 0.0])
    result = roster_check(calls, _expected())
    assert pd.isna(_row(result, "Evening")["aht_actual_sec"])
    evening_line = _format(result).splitlines()[4]
    assert "n/a" in evening_line and "nan" not in evening_line


def test_shift_with_no_forecast_volume_is_rejected():
    with pytest.raises(ValueError, match="no predicted calls"):
        roster_check(_calls(), _expected().assign(predicted_calls=0.0))
