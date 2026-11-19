"""Noise floor, hindsight oracle, reference forecast and bias tables.

Hand-built frames with known answers. No database, no model fitting.
"""

import math

import numpy as np
import pandas as pd
import pytest

from db.diagnostics import SeasonalNaive, bias_tables, oracle_predictions, poisson_floor, poisson_mad

HOURS = 24


def _grid(first: str, last: str, calls: float = 10.0) -> pd.DataFrame:
    """Hourly frame with the weekday (1 = Mon) and hour columns of a featured frame."""
    hours = pd.date_range(first, pd.Timestamp(last) + pd.Timedelta(hours=23), freq="h")
    return pd.DataFrame({"hour_start": hours, "offered": calls,
                         "dow": hours.dayofweek + 1, "hour": hours.hour})


def _predictions(origin: str, days: int, actual: float, predicted) -> pd.DataFrame:
    hours = pd.date_range(pd.Timestamp(origin) + pd.Timedelta(days=1), periods=days * HOURS, freq="h")
    frame = pd.DataFrame({
        "origin": pd.Timestamp(origin),
        "hour_start": hours,
        "horizon_day": (np.arange(days * HOURS) // HOURS) + 1,
        "actual": actual,
    })
    return frame.assign(predicted=predicted(frame))


def _poisson_mad_by_summation(mean: float) -> float:
    """Sum |k - mean| * P(k) far enough into the upper tail to be exact."""
    terms = int(mean + 20 * math.sqrt(mean) + 50)
    return sum(abs(k - mean) * math.exp(-mean + k * math.log(mean) - math.lgamma(k + 1)) for k in range(terms))


# ---- Poisson floor ------------------------------------------------------------------

@pytest.mark.parametrize("mean", [0.5, 1.0, 3.7, 9.0, 180.0])
def test_poisson_mad_matches_direct_summation(mean):
    assert poisson_mad(np.array([mean]))[0] == pytest.approx(_poisson_mad_by_summation(mean), rel=1e-9)


def test_poisson_mad_of_a_zero_mean_is_zero():
    assert poisson_mad(np.array([0.0]))[0] == 0.0


def test_poisson_mad_rejects_negative_means():
    with pytest.raises(ValueError, match="negative"):
        poisson_mad(np.array([-1.0]))


def test_floor_uses_the_forecast_as_the_true_mean():
    predictions = _predictions("2026-06-02", days=14, actual=1.0, predicted=lambda f: np.full(len(f), 1.0))

    floor = poisson_floor(predictions)

    assert floor["hourly_mae_1_14"] == pytest.approx(_poisson_mad_by_summation(1.0))
    assert floor["daily_mape_1_14"] == pytest.approx(_poisson_mad_by_summation(24.0) / 24.0 * 100)


# ---- hindsight oracle ----------------------------------------------------------------

def test_oracle_on_a_flat_series_is_exact():
    grid = _grid("2026-01-01", "2026-06-30")

    oracle = oracle_predictions(grid, [pd.Timestamp("2026-04-07")])

    assert list(oracle.columns) == ["origin", "hour_start", "horizon_day", "actual", "predicted"]
    assert (oracle["predicted"] == 10.0).all()
    assert len(oracle) == 28 * HOURS


def test_oracle_never_uses_the_hour_it_is_predicting():
    grid = _grid("2026-01-01", "2026-06-30")
    spike = pd.Timestamp("2026-04-15 19:00")
    grid = grid.assign(offered=np.where(grid["hour_start"] == spike, 100.0, grid["offered"]))

    oracle = oracle_predictions(grid, [pd.Timestamp("2026-04-07")]).set_index("hour_start")

    assert oracle.loc[spike, "predicted"] == pytest.approx(10.0)
    one_week_later = spike + pd.Timedelta(days=7)
    assert oracle.loc[one_week_later, "predicted"] == pytest.approx((7 * 10.0 + 100.0) / 8)


def test_oracle_uses_only_the_weeks_that_exist_at_the_edge_of_the_data():
    grid = _grid("2026-01-01", "2026-04-21")

    oracle = oracle_predictions(grid, [pd.Timestamp("2026-04-07")])

    assert oracle["horizon_day"].max() == 14
    assert (oracle["predicted"] == 10.0).all()


# ---- reference forecast ----------------------------------------------------------------

def test_seasonal_naive_repeats_the_recent_weekday_hour_level():
    grid = _grid("2026-01-01", "2026-04-07")
    is_sunday_noon = (grid["hour_start"].dt.dayofweek == 6) & (grid["hour_start"].dt.hour == 12)
    train = grid.assign(offered=np.where(is_sunday_noon, 30.0, grid["offered"]))
    future = _grid("2026-04-08", "2026-04-14")

    predicted = pd.Series(SeasonalNaive()(train, future), index=future["hour_start"])

    assert predicted[pd.Timestamp("2026-04-12 12:00")] == pytest.approx(30.0)   # a Sunday
    assert predicted[pd.Timestamp("2026-04-13 12:00")] == pytest.approx(10.0)


def test_seasonal_naive_ignores_data_older_than_its_window():
    old = _grid("2026-01-01", "2026-02-10", calls=50.0)
    recent = _grid("2026-02-11", "2026-04-07", calls=10.0)          # exactly 8 weeks
    future = _grid("2026-04-08", "2026-04-08")

    predicted = SeasonalNaive()(pd.concat([old, recent], ignore_index=True), future)

    assert predicted == pytest.approx(np.full(HOURS, 10.0))


# ---- bias tables -------------------------------------------------------------------------

def test_bias_tables_point_at_the_weekday_and_hour_that_are_off():
    def high_on_sunday_evenings(frame):
        off = (frame["hour_start"].dt.dayofweek == 6) & (frame["hour_start"].dt.hour >= 16)
        return frame["actual"] * np.where(off, 1.25, 1.0)

    tables = bias_tables(_predictions("2026-06-02", days=14, actual=8.0, predicted=high_on_sunday_evenings))

    assert tables["dow"].loc[7, "bias_pct"] == pytest.approx(25.0 * 8 / 24)
    assert tables["dow"].loc[1, "bias_pct"] == pytest.approx(0.0)
    assert tables["hour"].loc[20, "bias_pct"] == pytest.approx(25.0 / 7)
    assert tables["cell"].loc[7, 20] == pytest.approx(25.0)
    assert tables["cell"].loc[7, 10] == pytest.approx(0.0)
    assert tables["cell"].shape == (7, 24)


def test_bias_by_horizon_week_separates_near_and_far_errors():
    def high_in_week_three(frame):
        return frame["actual"] * np.where(frame["horizon_day"].between(15, 21), 1.10, 1.0)

    tables = bias_tables(_predictions("2026-06-02", days=28, actual=8.0, predicted=high_in_week_three))

    assert tables["horizon_week"]["bias_pct"].round(6).tolist() == [0.0, 0.0, 10.0, 0.0]


# ---- "what if the weekly total were known" -------------------------------------------

def test_perfect_weekly_level_rescales_each_test_week_to_its_actual_total():
    from db.diagnostics import with_perfect_weekly_level

    def high_then_low(frame):
        return frame["actual"] * np.where(frame["horizon_day"] <= 7, 1.2, 0.9)

    rescaled = with_perfect_weekly_level(_predictions("2026-06-02", days=14, actual=8.0, predicted=high_then_low))

    week = (rescaled["horizon_day"] - 1) // 7
    totals = rescaled.groupby(week)[["actual", "predicted"]].sum()
    assert totals["predicted"].tolist() == pytest.approx(totals["actual"].tolist())
    assert rescaled["predicted"].to_numpy() == pytest.approx(8.0)


def test_perfect_weekly_level_keeps_the_shape_inside_the_week():
    from db.diagnostics import with_perfect_weekly_level

    def evenings_double(frame):
        return frame["actual"] * np.where(frame["hour_start"].dt.hour >= 16, 2.0, 1.0)

    original = _predictions("2026-06-02", days=7, actual=8.0, predicted=evenings_double)
    rescaled = with_perfect_weekly_level(original)

    evening = rescaled["hour_start"].dt.hour >= 16
    assert rescaled.loc[evening, "predicted"].iloc[0] == pytest.approx(2 * rescaled.loc[~evening, "predicted"].iloc[0])
    assert rescaled["predicted"].sum() == pytest.approx(original["actual"].sum())
    assert original["predicted"].max() == 16.0                      # input untouched
