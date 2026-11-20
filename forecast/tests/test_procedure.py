"""Base model (LightGBM profile) plus calibration as one forecasting procedure.

Small hand-built grids with an obvious pattern; the LightGBM fits are real
but tiny. No database.
"""

from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from db.calibration import CalibrationConfig
from db.procedure import (
    BaseConfig,
    ForecastProcedure,
    ProcedureConfig,
    fit_base,
    predict_base,
    recent_frame,
    special_days,
)

HOURS = 24
SUNDAY = 6          # pandas dayofweek


def _featured(first: str, last: str, calls=lambda hours: 10.0) -> pd.DataFrame:
    """Hourly grid with the two features the tests train on."""
    hours = pd.date_range(first, pd.Timestamp(last) + pd.Timedelta(hours=23), freq="h")
    return pd.DataFrame({"hour_start": hours, "offered": calls(hours),
                         "dow": hours.dayofweek + 1, "hour": hours.hour})


def _sunday_evening_double(hours: pd.DatetimeIndex) -> np.ndarray:
    return np.where((hours.dayofweek == SUNDAY) & (hours.hour >= 18), 20.0, 10.0)


FAST = BaseConfig(features=("dow", "hour"), halflife_days=None, num_boost_round=60,
                  min_data_in_leaf=5, learning_rate=0.2)
NO_SHAPE = dict(dow_strength=None, hour_strength=None, cell_strength=None)


# ---- base model -------------------------------------------------------------------

def test_base_model_learns_the_weekday_hour_pattern():
    train = _featured("2026-01-05", "2026-03-29", _sunday_evening_double)
    future = _featured("2026-03-30", "2026-04-05")

    predicted = predict_base(fit_base(train, FAST), future, FAST)

    is_peak = (future["hour_start"].dt.dayofweek == SUNDAY) & (future["hour_start"].dt.hour >= 18)
    assert predicted[is_peak.to_numpy()] == pytest.approx(20.0, abs=0.5)
    assert predicted[~is_peak.to_numpy()] == pytest.approx(10.0, abs=0.5)


def _level_step(hours: pd.DatetimeIndex) -> np.ndarray:
    return np.where(hours >= pd.Timestamp("2026-05-25"), 20.0, 10.0)        # 20 weeks low, 20 weeks high


def test_a_short_halflife_follows_the_newer_level():
    train = _featured("2026-01-05", "2026-10-11", _level_step)
    future = _featured("2026-10-12", "2026-10-12")
    recent_only = BaseConfig(features=("dow", "hour"), halflife_days=14.0, num_boost_round=60,
                             min_data_in_leaf=5, learning_rate=0.2)

    weighted = predict_base(fit_base(train, recent_only), future, recent_only).mean()
    unweighted = predict_base(fit_base(train, FAST), future, FAST).mean()

    assert weighted > 19.5
    assert unweighted == pytest.approx(15.0, abs=0.5)


def test_train_years_leaves_out_older_rows():
    def old_low_new_high(hours):
        return np.where(hours >= pd.Timestamp("2026-01-01"), 20.0, 10.0)

    train = _featured("2024-01-01", "2026-12-31", old_low_new_high)
    future = _featured("2027-01-01", "2027-01-01")
    last_year = BaseConfig(features=("dow", "hour"), halflife_days=None, train_years=1.0,
                           num_boost_round=60, min_data_in_leaf=5, learning_rate=0.2)

    assert predict_base(fit_base(train, last_year), future, last_year).mean() == pytest.approx(20.0, abs=0.3)


def test_several_seeds_give_the_average_of_the_single_seed_models():
    train = _featured("2026-01-05", "2026-03-29", _sunday_evening_double)
    future = _featured("2026-03-30", "2026-04-05")

    def config(seeds):
        # 3 rounds, one feature per tree: seeds 1 and 2 pick different features first.
        return BaseConfig(features=("dow", "hour"), halflife_days=None, num_boost_round=3,
                          min_data_in_leaf=5, feature_fraction=0.5, seeds=seeds)

    one = predict_base(fit_base(train, config((1,))), future, config((1,)))
    two = predict_base(fit_base(train, config((2,))), future, config((2,)))
    both = predict_base(fit_base(train, config((1, 2))), future, config((1, 2)))

    assert not np.allclose(one, two)
    assert both == pytest.approx((one + two) / 2)


def test_fitting_twice_gives_the_same_model():
    train = _featured("2026-01-05", "2026-03-29", _sunday_evening_double)
    future = _featured("2026-03-30", "2026-04-05")

    first = predict_base(fit_base(train, FAST), future, FAST)
    second = predict_base(fit_base(train, FAST), future, FAST)

    assert np.array_equal(first, second)


def test_a_feature_missing_from_the_frame_raises():
    train = _featured("2026-01-05", "2026-03-29")
    wants_more = BaseConfig(features=("dow", "hour", "is_holiday"))

    with pytest.raises(ValueError, match="is_holiday"):
        fit_base(train, wants_more)


def test_recent_frame_holds_the_last_days_with_actual_and_base():
    train = _featured("2026-01-05", "2026-03-29", _sunday_evening_double)
    boosters = fit_base(train, FAST)

    recent = recent_frame(train, boosters, FAST, days=14)

    assert list(recent.columns) == ["hour_start", "actual", "base"]
    assert len(recent) == 14 * HOURS
    assert recent["hour_start"].max() == train["hour_start"].max()
    assert recent["actual"].tolist() == train["offered"].tail(14 * HOURS).tolist()


# ---- whole procedure ----------------------------------------------------------------

def test_procedure_follows_a_recent_level_shift_the_base_model_has_not_caught():
    def last_four_weeks_higher(hours):
        return np.where(hours >= pd.Timestamp("2026-09-14"), 12.0, 10.0)

    train = _featured("2026-01-05", "2026-10-11", last_four_weeks_higher)
    future = _featured("2026-10-12", "2026-10-18").assign(horizon_day=lambda f: (f.index // HOURS) + 1)
    config = ProcedureConfig(base=FAST, calibration=CalibrationConfig(level_window_days=28, level_cap=0.5, **NO_SHAPE))

    base_only = predict_base(fit_base(train, FAST), future, FAST).mean()
    calibrated = ForecastProcedure(config)(train, future)

    assert base_only < 10.5
    assert len(calibrated) == len(future)
    assert calibrated.mean() == pytest.approx(12.0, abs=0.1)


# ---- config -----------------------------------------------------------------------

def test_procedure_config_survives_a_round_trip_through_json_ready_dicts():
    config = ProcedureConfig(
        base=BaseConfig(features=("dow", "hour"), categorical=("dow",), seeds=(1, 2), train_years=3.0),
        calibration=CalibrationConfig(level_window_days=21, dow_strength=800.0, level_damping=0.9),
    )

    assert ProcedureConfig.from_dict(config.to_dict()) == config


def test_base_key_is_stable_and_changes_with_the_config():
    one = BaseConfig(features=("dow", "hour"))
    same = BaseConfig(features=("dow", "hour"))
    other = BaseConfig(features=("dow", "hour"), halflife_days=365.0)

    assert one.key() == same.key()
    assert one.key() != other.key()


@pytest.mark.parametrize("bad", [
    dict(features=()), dict(halflife_days=0.0), dict(num_boost_round=0), dict(seeds=()),
    dict(train_years=0.0), dict(categorical=("month",)),
])
def test_base_config_rejects_values_outside_their_range(bad):
    with pytest.raises(ValueError):
        BaseConfig(**{"features": ("dow", "hour"), **bad})


# ---- special days -------------------------------------------------------------------

def test_special_days_are_the_table_plus_the_client_days_for_every_year_in_range():
    holidays = pd.DataFrame({"holiday_date": pd.to_datetime(["2026-11-26"]), "holiday_name": ["Thanksgiving"]})
    hours = pd.Series(pd.date_range("2026-11-01", "2026-12-31 23:00", freq="h"))

    days = special_days(holidays, hours)

    for expected in ("2026-11-25", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-31", "2027-12-24"):
        assert pd.Timestamp(expected) in days
    assert pd.Timestamp("2026-11-24") not in days


@pytest.mark.parametrize("window", [dict(level_window_days=141), dict(shape_window_days=365)])
def test_a_calibration_window_longer_than_the_recent_history_is_refused(window):
    with pytest.raises(ValueError, match="140"):
        ProcedureConfig(base=FAST, calibration=CalibrationConfig(**window))


# ---- burst-robust training target --------------------------------------------------

def test_clipping_the_training_target_keeps_one_burst_from_lifting_its_weekday_hour():
    def one_burst(hours):
        return np.where(hours == pd.Timestamp("2026-03-22 19:00"), 200.0, 10.0)        # a Sunday evening

    train = _featured("2026-01-05", "2026-03-29", one_burst)
    future = _featured("2026-03-30", "2026-04-05")
    robust = replace(FAST, target_clip_z=4.0)

    plain_forecast = predict_base(fit_base(train, FAST), future, FAST)
    robust_forecast = predict_base(fit_base(train, robust), future, robust)

    cell = ((future["hour_start"].dt.dayofweek == SUNDAY) & (future["hour_start"].dt.hour == 19)).to_numpy()
    assert plain_forecast[cell][0] > 20                      # 11 normal Sundays and one of 200
    assert robust_forecast[cell][0] < 15
    assert robust_forecast[~cell] == pytest.approx(plain_forecast[~cell], abs=0.5)


def test_target_clipping_changes_nothing_when_there_are_no_bursts():
    train = _featured("2026-01-05", "2026-03-29", _sunday_evening_double)
    future = _featured("2026-03-30", "2026-04-05")
    robust = replace(FAST, target_clip_z=4.0)

    assert np.allclose(predict_base(fit_base(train, robust), future, robust),
                       predict_base(fit_base(train, FAST), future, FAST))


def test_target_clip_must_be_positive():
    with pytest.raises(ValueError, match="target_clip_z"):
        replace(FAST, target_clip_z=0.0)


# ---- recent base from a model that has not seen the window ---------------------------

def test_out_of_sample_recent_base_does_not_see_the_weeks_it_is_compared_with():
    def last_four_weeks_higher(hours):
        return np.where(hours >= pd.Timestamp("2026-03-02"), 15.0, 10.0)               # 8 weeks at 10, 4 at 15

    train = _featured("2026-01-05", "2026-03-29", last_four_weeks_higher)
    outside = replace(FAST, recent_out_of_sample=True)

    seen = recent_frame(train, fit_base(train, FAST), FAST, days=28)
    unseen = recent_frame(train, fit_base(train, outside), outside, days=28)

    assert seen["base"].mean() == pytest.approx((8 * 10 + 4 * 15) / 12, abs=0.3)
    assert unseen["base"].mean() == pytest.approx(10.0, abs=0.3)
    assert unseen["actual"].tolist() == seen["actual"].tolist()
