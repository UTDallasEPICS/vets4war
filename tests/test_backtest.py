"""Weekly-origin backtest: folds, horizon bands, metrics, acceptance rule.

Hand-built frames with known answers. No database, no model fitting.
"""

import numpy as np
import pandas as pd
import pytest

from db.backtest import compare, map_origins, origin_frames, run_origins, score, weekly_origins

HOURS = 24
CALLS_PER_HOUR = 10.0


def _grid(first: str, last: str) -> pd.DataFrame:
    """Every hour from `first` to `last` (inclusive days), 10 calls each."""
    hours = pd.date_range(first, pd.Timestamp(last) + pd.Timedelta(hours=23), freq="h")
    return pd.DataFrame({"hour_start": hours, "offered": CALLS_PER_HOUR})


def _predictions(origins: list[str], days: int = 28, predicted=lambda frame: frame["actual"]) -> pd.DataFrame:
    """One row per predicted hour for each origin; `predicted` maps the
    frame (origin, hour_start, horizon_day, actual) to predictions."""
    parts = []
    for origin in pd.to_datetime(origins):
        hours = pd.date_range(origin + pd.Timedelta(days=1), periods=days * HOURS, freq="h")
        part = pd.DataFrame({
            "origin": origin,
            "hour_start": hours,
            "horizon_day": (np.arange(days * HOURS) // HOURS) + 1,
            "actual": CALLS_PER_HOUR,
        })
        parts.append(part.assign(predicted=predicted(part)))
    return pd.concat(parts, ignore_index=True)


# Tuesdays, so each test week runs Wednesday to Tuesday like the client's.
ORIGINS = ["2026-06-02", "2026-06-09", "2026-06-16", "2026-06-23"]


# ---- folds ----------------------------------------------------------------------

def test_origins_step_back_one_week_from_the_last_full_test_week():
    days = pd.date_range("2026-01-01", "2026-03-31", freq="D")

    origins = weekly_origins(days, n=3)

    assert [str(o.date()) for o in origins] == ["2026-03-10", "2026-03-17", "2026-03-24"]


def test_skip_moves_the_whole_block_of_origins_back():
    days = pd.date_range("2025-12-01", "2026-03-31", freq="D")

    origins = weekly_origins(days, n=2, skip=3)

    assert [str(o.date()) for o in origins] == ["2026-02-24", "2026-03-03"]


def test_asking_for_more_origins_than_the_history_holds_raises():
    days = pd.date_range("2026-03-01", "2026-03-31", freq="D")

    with pytest.raises(ValueError, match="history"):
        weekly_origins(days, n=10)


def test_train_ends_on_the_origin_day_and_future_starts_the_next_day():
    grid = _grid("2026-05-01", "2026-06-30")

    train, future = origin_frames(grid, pd.Timestamp("2026-06-02"))

    assert train["hour_start"].max() == pd.Timestamp("2026-06-02 23:00")
    assert future["hour_start"].min() == pd.Timestamp("2026-06-03 00:00")
    assert future["horizon_day"].min() == 1
    assert future["horizon_day"].max() == 28
    assert len(future) == 28 * HOURS


def test_future_is_cut_where_the_data_ends():
    grid = _grid("2026-05-01", "2026-06-12")

    _, future = origin_frames(grid, pd.Timestamp("2026-06-02"))

    assert future["horizon_day"].max() == 10


class _TrainMean:
    """Predicts the training mean for every future hour."""

    def __call__(self, train: pd.DataFrame, future: pd.DataFrame) -> np.ndarray:
        return np.full(len(future), train["offered"].mean())


def test_runner_returns_one_row_per_predicted_hour():
    grid = _grid("2026-04-01", "2026-06-30")
    origins = [pd.Timestamp("2026-06-02"), pd.Timestamp("2026-06-09")]

    predictions = run_origins(grid, origins, _TrainMean(), workers=1)

    assert list(predictions.columns) == ["origin", "hour_start", "horizon_day", "actual", "predicted"]
    assert len(predictions) == (28 + 21) * HOURS
    assert (predictions["predicted"] == CALLS_PER_HOUR).all()


def test_runner_gives_the_same_rows_with_worker_processes():
    grid = _grid("2026-04-01", "2026-06-30")
    origins = [pd.Timestamp("2026-06-02"), pd.Timestamp("2026-06-09")]

    serial = run_origins(grid, origins, _TrainMean(), workers=1)
    parallel = run_origins(grid, origins, _TrainMean(), workers=2)

    pd.testing.assert_frame_equal(parallel, serial)


class _TrainRows:
    """A task that returns something other than predictions."""

    def __call__(self, train: pd.DataFrame, future: pd.DataFrame) -> tuple[int, int]:
        return len(train), len(future)


def test_map_origins_returns_each_task_result_in_origin_order():
    grid = _grid("2026-04-01", "2026-06-30")
    origins = [pd.Timestamp("2026-06-02"), pd.Timestamp("2026-06-09")]

    results = map_origins(grid, origins, _TrainRows(), workers=1)

    assert results == [(63 * HOURS, 28 * HOURS), (70 * HOURS, 21 * HOURS)]


# ---- metrics ----------------------------------------------------------------------

def test_a_perfect_forecast_scores_zero_error():
    metrics = score(_predictions(ORIGINS))

    for name in ("daily_mape_1_14", "daily_mape_15_28", "hourly_mae_1_14", "block_wape_1_14",
                 "week_acc_std", "dow_bias_max", "cell_bias_rms", "week_total_ape"):
        assert metrics[name] == pytest.approx(0.0), name
    assert metrics["week_acc_min"] == pytest.approx(100.0)


def test_one_call_too_many_every_hour():
    metrics = score(_predictions(ORIGINS, predicted=lambda f: f["actual"] + 1))

    assert metrics["hourly_mae_1_14"] == pytest.approx(1.0)
    assert metrics["daily_mape_1_14"] == pytest.approx(10.0)       # 24 over on 240
    assert metrics["block_wape_1_14"] == pytest.approx(10.0)       # 4 over on 40 per block
    assert metrics["week_total_ape"] == pytest.approx(10.0)
    assert metrics["bias_pct_1_14"] == pytest.approx(10.0)


def test_a_sunday_only_bias_shows_up_on_sunday():
    def ten_percent_high_on_sundays(frame):
        sunday = frame["hour_start"].dt.dayofweek == 6
        return frame["actual"] * np.where(sunday, 1.10, 1.0)

    metrics = score(_predictions(ORIGINS, predicted=ten_percent_high_on_sundays))

    assert metrics["dow_bias_max"] == pytest.approx(10.0)
    assert metrics["dow_bias"][7] == pytest.approx(10.0)
    assert metrics["dow_bias"][3] == pytest.approx(0.0)
    assert metrics["daily_mape_1_14"] == pytest.approx(10.0 / 7)


def test_errors_cancelling_inside_a_block_do_not_count_against_the_block():
    def plus_minus_one(frame):
        return frame["actual"] + np.where(frame["hour_start"].dt.hour % 2 == 0, 1.0, -1.0)

    metrics = score(_predictions(ORIGINS, predicted=plus_minus_one))

    assert metrics["hourly_mae_1_14"] == pytest.approx(1.0)
    assert metrics["block_wape_1_14"] == pytest.approx(0.0)
    assert metrics["daily_mape_1_14"] == pytest.approx(0.0)


def test_far_horizon_error_stays_out_of_the_near_horizon_metrics():
    def wrong_after_two_weeks(frame):
        return frame["actual"] * np.where(frame["horizon_day"] >= 15, 1.2, 1.0)

    metrics = score(_predictions(ORIGINS, predicted=wrong_after_two_weeks))

    assert metrics["daily_mape_1_14"] == pytest.approx(0.0)
    assert metrics["daily_mape_15_28"] == pytest.approx(20.0)


def test_week_consistency_uses_the_first_test_week_of_each_origin():
    def first_origin_ten_percent_high(frame):
        return frame["actual"] * np.where(frame["origin"] == pd.Timestamp(ORIGINS[0]), 1.10, 1.0)

    metrics = score(_predictions(ORIGINS, predicted=first_origin_ten_percent_high))

    assert metrics["week_acc_min"] == pytest.approx(90.0)
    assert metrics["week_acc_std"] == pytest.approx(np.std([90.0, 100.0, 100.0, 100.0], ddof=1))


def test_an_origin_with_a_short_first_week_is_left_out_of_week_consistency():
    full = _predictions(ORIGINS[:3])
    short = _predictions([ORIGINS[3]], days=5, predicted=lambda f: f["actual"] * 2)

    metrics = score(pd.concat([full, short], ignore_index=True))

    assert metrics["week_acc_min"] == pytest.approx(100.0)
    assert metrics["weeks_scored"] == 3


def test_scoring_rejects_a_frame_with_missing_columns():
    with pytest.raises(ValueError, match="missing columns"):
        score(pd.DataFrame({"hour_start": pd.to_datetime(["2026-06-03"]), "actual": [1.0]}))


# ---- comparison -------------------------------------------------------------------

def _noisy(scale: float) -> pd.DataFrame:
    """Forecast whose error alternates by day and grows with `scale`,
    different in every test week so the paired t statistic is defined."""
    def predicted(frame):
        day = frame["hour_start"].dt.normalize()
        week = ((day - day.min()).dt.days // 7) + 1
        sign = np.where(day.dt.dayofweek % 2 == 0, 1.0, -1.0)
        return frame["actual"] * (1 + sign * scale * (0.04 + 0.002 * week))
    return _predictions(ORIGINS, predicted=predicted)


def test_identical_forecasts_are_not_an_improvement():
    result = compare(_noisy(1.0), _noisy(1.0))

    assert result["delta_pct"]["daily_mape_1_14"] == pytest.approx(0.0)
    assert result["verdict"] == "reject"


def test_a_clear_gain_everywhere_is_accepted():
    result = compare(candidate=_noisy(0.8), incumbent=_noisy(1.0))

    assert result["delta_pct"]["daily_mape_1_14"] == pytest.approx(-20.0)
    assert result["t"]["daily_mape_1_14"] < -1.0
    assert result["verdict"] == "accept"


def test_a_worse_forecast_is_rejected():
    result = compare(candidate=_noisy(1.2), incumbent=_noisy(1.0))

    assert result["delta_pct"]["daily_mape_1_14"] == pytest.approx(20.0)
    assert result["verdict"] == "reject"


def test_a_daily_gain_that_breaks_the_hours_is_rejected():
    def better_days_worse_hours(frame):
        day = frame["hour_start"].dt.normalize()
        week = ((day - day.min()).dt.days // 7) + 1
        sign = np.where(day.dt.dayofweek % 2 == 0, 1.0, -1.0)
        daily = frame["actual"] * (1 + sign * 0.8 * (0.04 + 0.002 * week))
        # +3 / -3 calls on alternating 4-hour blocks: day totals unchanged.
        return daily + np.where((frame["hour_start"].dt.hour // 4) % 2 == 0, 3.0, -3.0)

    result = compare(candidate=_predictions(ORIGINS, predicted=better_days_worse_hours), incumbent=_noisy(1.0))

    assert result["delta_pct"]["daily_mape_1_14"] < -0.5
    assert result["delta_pct"]["block_wape_1_14"] > 1.0
    assert result["verdict"] == "reject"
    assert "block_wape_1_14" in result["reason"]


def test_an_hours_gain_with_flat_days_is_accepted_for_an_hours_change():
    def worse_hours(frame):
        return _noisy_values(frame) + np.where((frame["hour_start"].dt.hour // 4) % 2 == 0, 3.0, -3.0)

    def _noisy_values(frame):
        day = frame["hour_start"].dt.normalize()
        week = ((day - day.min()).dt.days // 7) + 1
        sign = np.where(day.dt.dayofweek % 2 == 0, 1.0, -1.0)
        return frame["actual"] * (1 + sign * (0.04 + 0.002 * week))

    incumbent = _predictions(ORIGINS, predicted=worse_hours)
    candidate = _predictions(ORIGINS, predicted=_noisy_values)

    assert compare(candidate, incumbent)["verdict"] == "reject"          # days did not improve
    assert compare(candidate, incumbent, focus="hours")["verdict"] == "accept"


def test_comparison_requires_the_same_hours_in_both_forecasts():
    with pytest.raises(ValueError, match="same"):
        compare(_predictions(ORIGINS[:2]), _predictions(ORIGINS))


def test_comparison_refuses_forecasts_scored_against_different_actuals():
    candidate = _noisy(0.8)
    incumbent = _noisy(1.0).assign(actual=CALLS_PER_HOUR + 2)

    with pytest.raises(ValueError, match="same"):
        compare(candidate, incumbent)


def test_a_guard_metric_that_cannot_be_computed_blocks_acceptance():
    # Two weeks of horizon only: the 15 to 28 day error does not exist.
    def better(frame):
        return _noisy_frame_values(frame, 0.8)

    def worse(frame):
        return _noisy_frame_values(frame, 1.0)

    result = compare(_predictions(ORIGINS, days=14, predicted=better), _predictions(ORIGINS, days=14, predicted=worse))

    assert result["delta_pct"]["daily_mape_1_14"] == pytest.approx(-20.0)
    assert result["verdict"] == "reject"
    assert "daily_mape_15_28" in result["reason"]


def _noisy_frame_values(frame, scale):
    day = frame["hour_start"].dt.normalize()
    week = ((day - day.min()).dt.days // 7) + 1
    sign = np.where(day.dt.dayofweek % 2 == 0, 1.0, -1.0)
    return frame["actual"] * (1 + sign * scale * (0.04 + 0.002 * week))


def test_scoring_a_frame_with_no_calls_at_all_gives_nan_bias_not_a_crash():
    silent = _predictions(ORIGINS).assign(actual=0.0, predicted=1.0)

    assert np.isnan(score(silent)["bias_pct_1_14"])
