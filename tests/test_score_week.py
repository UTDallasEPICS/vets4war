"""db.score_week.score_week: frozen forecast vs actual calls. Synthetic."""

import pandas as pd
import pytest

from db.score_week import score_week


def _calls() -> pd.DataFrame:
    """Day 1: 3 calls (one abandoned). Day 2: 1 call."""
    return pd.DataFrame({
        "start_ts": pd.to_datetime(["2026-10-21 09:05", "2026-10-21 09:40", "2026-10-21 10:10", "2026-10-22 09:00"]),
        "in_queue_sec": [10.0, 50.0, 5.0, 20.0],
        "agent_sec": [600.0, 0.0, 300.0, 900.0],
        "abandon_sec": [0.0, 50.0, 0.0, 0.0],
        "routing_sec": [10.0, 50.0, 5.0, 20.0],
        "abandoned": [False, True, False, False],
    })


def _snapshot(day1_calls: float = 4.0) -> pd.DataFrame:
    return pd.DataFrame({
        "date": ["2026-10-21", "2026-10-22", "2026-10-23"],
        "hour": [9, 9, 9],
        "predicted_calls": [day1_calls, 1.0, 50.0],
        "aht_sec": [600.0, 600.0, 600.0],
        "sl_at_roster": [0.8, 0.8, 0.8],
        "abandon_share_at_roster": [0.1, 0.1, 0.1],
    })


def test_only_shared_dates_are_scored():
    result = score_week(_calls(), _snapshot())
    assert result["dates"] == ["2026-10-21", "2026-10-22"]
    assert result["week_actual"] == 4


def test_daily_accuracy_and_week_error():
    result = score_week(_calls(), _snapshot(day1_calls=4.0))
    # day 1: predicted 4 vs 3 actual (33.3% off); day 2: 1 vs 1 (exact)
    assert result["daily"]["actual_calls"].tolist() == [3, 1]
    assert result["daily_accuracy_pct"] == pytest.approx(100 - (100 / 3 + 0) / 2)
    assert result["week_error_pct"] == pytest.approx((5 - 4) / 4 * 100)


def test_hourly_mae_over_snapshot_hours():
    result = score_week(_calls(), _snapshot(day1_calls=4.0))
    assert result["hourly_mae"] == pytest.approx((2 + 0) / 2)


def test_handle_time_abandonment_and_service_level():
    result = score_week(_calls(), _snapshot())
    assert result["aht_actual_sec"] == pytest.approx((600 + 300 + 900) / 3)
    assert result["abandon_share_actual"] == pytest.approx(1 / 4)
    assert result["service_level_actual"] == pytest.approx(3 / 4)
    assert result["abandon_share_predicted_at_roster"] == pytest.approx(0.1)


def test_disjoint_dates_are_an_error():
    snap = _snapshot().assign(date=["2027-01-01", "2027-01-02", "2027-01-03"])
    with pytest.raises(ValueError, match="share no dates"):
        score_week(_calls(), snap)


def test_snapshot_without_required_columns_is_rejected():
    with pytest.raises(ValueError, match="missing columns"):
        score_week(_calls(), _snapshot().drop(columns="sl_at_roster"))
