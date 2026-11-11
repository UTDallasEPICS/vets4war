"""Gap-aware grid, recency weights, the 7-day level factor of the Oct 28 model.
Synthetic data only; no database."""

import numpy as np
import pandas as pd
import pytest

from db.calibration import level_factor, recent_window_start
from db.procedure import recency_weights
from db.train import complete_hourly_grid


def _hourly(days: list[str]) -> pd.DataFrame:
    """One call at 09:00 on each listed day (the shape load_hourly returns)."""
    return pd.DataFrame({"hour_start": pd.to_datetime([f"{d} 09:00" for d in days]), "offered": 1})


def _days(start: str, end: str) -> list[str]:
    return [d.strftime("%Y-%m-%d") for d in pd.date_range(start, end)]


# ---- grid ------------------------------------------------------------------

def test_grid_leaves_out_days_with_no_calls():
    grid = complete_hourly_grid(_hourly(["2026-08-30", "2026-08-31", "2026-10-14"]))
    assert len(grid) == 3 * 24
    assert not (grid["hour_start"].dt.month == 9).any()


def test_grid_zero_fills_quiet_hours_inside_a_day():
    grid = complete_hourly_grid(_hourly(["2026-08-31"]))
    assert grid["offered"].sum() == 1
    assert grid.loc[grid["hour_start"].dt.hour == 9, "offered"].item() == 1


# ---- recency weights ------------------------------------------------------------

def test_weight_halves_every_halflife():
    hs = pd.Series(pd.to_datetime(["2026-01-01", "2026-01-11", "2026-01-21"]))
    np.testing.assert_allclose(recency_weights(hs, 10.0), [0.25, 0.5, 1.0])


def test_no_halflife_means_no_weights():
    assert recency_weights(pd.Series(pd.to_datetime(["2026-01-01"])), None) is None


# ---- level factor ---------------------------------------------------------------

def test_level_factor_is_actual_over_predicted():
    assert level_factor(np.array([105.0]), np.array([100.0])) == pytest.approx(1.05)


def test_level_factor_is_capped_both_ways():
    assert level_factor(np.array([150.0]), np.array([100.0]), cap=0.10) == pytest.approx(1.10)
    assert level_factor(np.array([50.0]), np.array([100.0]), cap=0.10) == pytest.approx(0.90)


def test_level_factor_rejects_zero_prediction():
    with pytest.raises(ValueError, match="not positive"):
        level_factor(np.array([5.0]), np.array([0.0]))


def test_window_counts_only_days_with_data():
    hs = complete_hourly_grid(_hourly(_days("2026-08-01", "2026-08-31") + _days("2026-10-14", "2026-10-20")))["hour_start"]
    # last 10 data days = Aug 29..31 (3) + Oct 14..20 (7) -> starts Aug 29
    assert str(recent_window_start(hs, 10).date()) == "2026-08-29"
