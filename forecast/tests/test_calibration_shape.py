"""Recent-data calibration: level, weekday / hour / cell shape, shrinkage,
burst clipping, holiday skipping, horizon damping.

Hand-built frames with known answers. No database, no model fitting.
"""

import numpy as np
import pandas as pd
import pytest

from db.calibration import (
    IDENTITY_FACTORS,
    CalibrationConfig,
    CalibrationFactors,
    apply_calibration,
    fit_calibration,
)

HOURS = 24
BASE = 10.0
LAST_DAY = pd.Timestamp("2026-10-27")          # a Tuesday
SUNDAY, TUESDAY = 6, 1                          # pandas dayofweek


def _recent(days: int = 56, ratio=lambda frame: 1.0) -> pd.DataFrame:
    """`days` full days ending on LAST_DAY; base 10 calls/hour;
    actual = base * ratio(frame)."""
    first = LAST_DAY - pd.Timedelta(days=days - 1)
    frame = pd.DataFrame({"hour_start": pd.date_range(first, periods=days * HOURS, freq="h"), "base": BASE})
    return frame.assign(actual=BASE * ratio(frame))


def _future(days: int = 28) -> pd.Series:
    return pd.Series(pd.date_range(LAST_DAY + pd.Timedelta(days=1), periods=days * HOURS, freq="h"))


def _apply(factors: CalibrationFactors, days: int = 28) -> pd.Series:
    hours = _future(days)
    return pd.Series(apply_calibration(hours, np.full(len(hours), BASE), factors, LAST_DAY), index=hours)


NO_SHAPE = dict(dow_strength=None, hour_strength=None, cell_strength=None)


# ---- level ----------------------------------------------------------------------

def test_level_is_recent_actual_over_recent_base():
    factors = fit_calibration(_recent(ratio=lambda f: 1.10), CalibrationConfig(level_window_days=28, **NO_SHAPE))

    assert factors.level == pytest.approx(1.10)


def test_level_is_capped_both_ways():
    high = fit_calibration(_recent(ratio=lambda f: 1.30), CalibrationConfig(level_cap=0.15, **NO_SHAPE))
    low = fit_calibration(_recent(ratio=lambda f: 0.70), CalibrationConfig(level_cap=0.15, **NO_SHAPE))

    assert (high.level, low.level) == (pytest.approx(1.15), pytest.approx(0.85))


def _last_week_high(frame):
    age = (LAST_DAY - frame["hour_start"].dt.normalize()).dt.days
    return np.where(age < 7, 1.2, 1.0)


def test_a_short_window_sees_only_the_latest_days():
    config = CalibrationConfig(level_window_days=7, level_cap=0.5, **NO_SHAPE)

    assert fit_calibration(_recent(ratio=_last_week_high), config).level == pytest.approx(1.2)


def test_a_long_window_averages_the_latest_days_with_earlier_ones():
    config = CalibrationConfig(level_window_days=28, level_cap=0.5, **NO_SHAPE)

    assert fit_calibration(_recent(ratio=_last_week_high), config).level == pytest.approx((7 * 1.2 + 21 * 1.0) / 28)


def test_a_halflife_weights_the_latest_days_more_inside_the_window():
    config = CalibrationConfig(level_window_days=28, level_halflife_days=7.0, level_cap=0.5, **NO_SHAPE)
    weights = 0.5 ** (np.arange(28) / 7.0)
    ratios = np.where(np.arange(28) < 7, 1.2, 1.0)

    level = fit_calibration(_recent(ratio=_last_week_high), config).level

    assert level == pytest.approx(float((weights * ratios).sum() / weights.sum()))
    assert (7 * 1.2 + 21) / 28 < level < 1.2


# ---- shape ------------------------------------------------------------------------

def test_weekday_factors_recover_a_sunday_that_runs_high():
    sunday_high = lambda f: np.where(f["hour_start"].dt.dayofweek == SUNDAY, 1.2, 1.0)  # noqa: E731
    config = CalibrationConfig(level_window_days=56, shape_window_days=56, level_cap=0.5,
                               dow_strength=0.0, hour_strength=None, cell_strength=None)

    predicted = _apply(fit_calibration(_recent(ratio=sunday_high), config))

    is_sunday = predicted.index.dayofweek == SUNDAY
    assert predicted[is_sunday].to_numpy() == pytest.approx(12.0)
    assert predicted[~is_sunday].to_numpy() == pytest.approx(10.0)


def test_shrinkage_pulls_a_weekday_factor_toward_one():
    sunday_high = lambda f: np.where(f["hour_start"].dt.dayofweek == SUNDAY, 1.2, 1.0)  # noqa: E731
    overall = (1.2 + 6) / 7
    expected_calls_per_weekday = 8 * HOURS * BASE * overall           # 8 Sundays in 56 days
    config = CalibrationConfig(shape_window_days=56, dow_strength=expected_calls_per_weekday,
                               hour_strength=None, cell_strength=None)

    factors = fit_calibration(_recent(ratio=sunday_high), config)

    unshrunk = 1.2 / overall
    assert factors.dow[SUNDAY] == pytest.approx(1 + (unshrunk - 1) / 2)   # prior as heavy as the data: halfway


def test_hour_factors_recover_an_hour_that_runs_low():
    six_am_low = lambda f: np.where(f["hour_start"].dt.hour == 6, 0.8, 1.0)  # noqa: E731
    config = CalibrationConfig(level_window_days=56, shape_window_days=56, level_cap=0.5,
                               dow_strength=None, hour_strength=0.0, cell_strength=None)

    predicted = _apply(fit_calibration(_recent(ratio=six_am_low), config))

    assert predicted[predicted.index.hour == 6].to_numpy() == pytest.approx(8.0)
    assert predicted[predicted.index.hour != 6].to_numpy() == pytest.approx(10.0)


def test_cell_factors_recover_one_weekday_hour_without_moving_the_rest():
    def tuesday_six_am_high(frame):
        cell = (frame["hour_start"].dt.dayofweek == TUESDAY) & (frame["hour_start"].dt.hour == 6)
        return np.where(cell, 1.5, 1.0)

    config = CalibrationConfig(level_window_days=56, shape_window_days=56, level_cap=0.5,
                               dow_strength=0.0, hour_strength=0.0, cell_strength=0.0)

    predicted = _apply(fit_calibration(_recent(ratio=tuesday_six_am_high), config))

    is_cell = (predicted.index.dayofweek == TUESDAY) & (predicted.index.hour == 6)
    assert predicted[is_cell].to_numpy() == pytest.approx(15.0)
    assert predicted[~is_cell].to_numpy() == pytest.approx(10.0)


def test_shape_factors_do_not_change_the_weekly_total():
    sunday_high = lambda f: np.where(f["hour_start"].dt.dayofweek == SUNDAY, 1.2, 1.0)  # noqa: E731
    with_shape = CalibrationConfig(level_window_days=56, shape_window_days=56, dow_strength=500.0,
                                   hour_strength=500.0, cell_strength=200.0)
    level_only = CalibrationConfig(level_window_days=56, **NO_SHAPE)
    recent = _recent(ratio=sunday_high)

    shaped = _apply(fit_calibration(recent, with_shape), days=7).sum()
    flat = _apply(fit_calibration(recent, level_only), days=7).sum()

    assert shaped == pytest.approx(flat)


def test_shape_factors_are_capped_above():
    sunday_triple = lambda f: np.where(f["hour_start"].dt.dayofweek == SUNDAY, 3.0, 1.0)  # noqa: E731
    config = CalibrationConfig(shape_window_days=56, shape_cap=0.25, dow_strength=0.0,
                               hour_strength=None, cell_strength=None)

    factors = fit_calibration(_recent(ratio=sunday_triple), config)

    assert max(max(row) for row in factors.shape) == pytest.approx(1.25)


def test_shape_factors_are_capped_below():
    sunday_tenth = lambda f: np.where(f["hour_start"].dt.dayofweek == SUNDAY, 0.1, 1.0)  # noqa: E731
    config = CalibrationConfig(shape_window_days=56, shape_cap=0.25, dow_strength=0.0,
                               hour_strength=None, cell_strength=None)

    factors = fit_calibration(_recent(ratio=sunday_tenth), config)

    assert min(min(row) for row in factors.shape) == pytest.approx(0.75)


def test_a_cell_with_nothing_expected_and_nothing_seen_keeps_factor_one():
    recent = _recent()
    silent = recent["hour_start"].dt.hour == 3
    recent = recent.assign(base=np.where(silent, 0.0, recent["base"]), actual=np.where(silent, 0.0, recent["actual"]))
    config = CalibrationConfig(dow_strength=0.0, hour_strength=0.0, cell_strength=0.0)

    factors = fit_calibration(recent, config)

    assert np.isfinite(np.array(factors.shape)).all()
    assert factors.hour[3] == pytest.approx(1.0)


# ---- robustness -------------------------------------------------------------------

def test_one_burst_hour_does_not_move_the_level_when_bursts_are_clipped():
    def one_burst(frame):
        return np.where(frame["hour_start"] == pd.Timestamp("2026-10-20 19:00"), 50.0, 1.0)

    recent = _recent(ratio=one_burst)
    plain = fit_calibration(recent, CalibrationConfig(level_window_days=28, level_cap=0.5, **NO_SHAPE))
    clipped = fit_calibration(recent, CalibrationConfig(level_window_days=28, level_cap=0.5, burst_z=4.0, **NO_SHAPE))

    assert plain.level == pytest.approx(1 + 490 / (28 * HOURS * BASE))
    assert 1.0 < clipped.level < 1.003


def test_holiday_type_days_can_be_left_out_of_the_window():
    holiday = pd.Timestamp("2026-10-12")
    half_volume_on_holiday = lambda f: np.where(f["hour_start"].dt.normalize() == holiday, 0.5, 1.0)  # noqa: E731
    recent = _recent(ratio=half_volume_on_holiday)
    skipping = CalibrationConfig(level_window_days=28, skip_special_days=True, **NO_SHAPE)
    keeping = CalibrationConfig(level_window_days=28, skip_special_days=False, **NO_SHAPE)

    assert fit_calibration(recent, skipping, special_days=frozenset({holiday})).level == pytest.approx(1.0)
    assert fit_calibration(recent, keeping, special_days=frozenset({holiday})).level == pytest.approx(1 - 0.5 / 28)


def test_fitting_does_not_change_the_recent_frame():
    recent = _recent(ratio=lambda f: 1.1)
    before = recent.copy()

    fit_calibration(recent, CalibrationConfig(burst_z=4.0))

    pd.testing.assert_frame_equal(recent, before)


def test_recent_frame_must_have_the_three_columns():
    with pytest.raises(ValueError, match="missing columns"):
        fit_calibration(_recent().drop(columns="base"), CalibrationConfig())


# ---- applying ---------------------------------------------------------------------

def test_identity_factors_return_the_base_forecast():
    assert _apply(IDENTITY_FACTORS).to_numpy() == pytest.approx(BASE)


def test_level_fades_toward_one_with_the_horizon_when_damped():
    factors = fit_calibration(_recent(ratio=lambda f: 1.2),
                              CalibrationConfig(level_cap=0.5, level_damping=0.5, **NO_SHAPE))

    predicted = _apply(factors, days=28)

    def on_day(horizon_day: int) -> float:
        return predicted[LAST_DAY + pd.Timedelta(days=horizon_day)]

    assert on_day(1) == pytest.approx(BASE * 1.2)
    assert on_day(8) == pytest.approx(BASE * 1.2 ** 0.5)
    assert on_day(15) == pytest.approx(BASE * 1.2 ** 0.25)
    assert on_day(22) == pytest.approx(BASE * 1.2 ** 0.125)


def test_no_damping_keeps_the_level_at_every_horizon():
    factors = fit_calibration(_recent(ratio=lambda f: 1.2), CalibrationConfig(level_cap=0.5, **NO_SHAPE))

    assert _apply(factors, days=28).to_numpy() == pytest.approx(BASE * 1.2)


def test_dates_on_or_before_the_origin_get_the_full_level():
    factors = fit_calibration(_recent(ratio=lambda f: 1.2),
                              CalibrationConfig(level_cap=0.5, level_damping=0.5, **NO_SHAPE))
    past = pd.Series(pd.date_range(LAST_DAY - pd.Timedelta(days=3), periods=HOURS, freq="h"))

    predicted = apply_calibration(past, np.full(HOURS, BASE), factors, LAST_DAY)

    assert predicted == pytest.approx(BASE * 1.2)


# ---- config and round trip ----------------------------------------------------------

@pytest.mark.parametrize("bad", [
    dict(level_window_days=0), dict(shape_window_days=0), dict(level_cap=1.0), dict(level_cap=-0.1),
    dict(shape_cap=1.5), dict(level_damping=0.0), dict(level_damping=1.1), dict(dow_strength=-1.0),
    dict(level_halflife_days=0.0), dict(burst_z=0.0),
])
def test_config_rejects_values_outside_their_range(bad):
    with pytest.raises(ValueError):
        CalibrationConfig(**bad)


def test_factors_survive_a_round_trip_through_json_ready_dicts():
    sunday_high = lambda f: np.where(f["hour_start"].dt.dayofweek == SUNDAY, 1.2, 1.0)  # noqa: E731
    factors = fit_calibration(_recent(ratio=sunday_high), CalibrationConfig(level_damping=0.8))

    assert CalibrationFactors.from_dict(factors.to_dict()) == factors
