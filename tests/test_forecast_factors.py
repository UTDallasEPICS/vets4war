"""How db.forecast turns the base model's numbers into the served forecast.

Hand-built inputs; no model file, no database.
"""

import numpy as np
import pandas as pd
import pytest

from db.calibration import CalibrationConfig, apply_calibration, fit_calibration
from db.forecast import _without_holidays, calibrated_volume, calibration_factors

HOURS = 24
LAST_DAY = pd.Timestamp("2026-11-03")


def _factors():
    hours = pd.date_range(LAST_DAY - pd.Timedelta(days=55), periods=56 * HOURS, freq="h")
    recent = pd.DataFrame({"hour_start": hours, "base": 10.0,
                           "actual": 10.0 * np.where(hours.hour >= 16, 1.3, 1.1)})
    return fit_calibration(recent, CalibrationConfig(level_window_days=56, level_cap=0.5, hour_strength=0.0))


def _future() -> pd.Series:
    return pd.Series(pd.date_range(LAST_DAY + pd.Timedelta(days=1), periods=7 * HOURS, freq="h"))


def test_new_metadata_applies_level_and_shape():
    factors = _factors()
    metadata = {"train_end": "2026-11-03T23:00:00", "calibration": factors.to_dict(), "level_factor": factors.level}
    base = np.full(7 * HOURS, 10.0)

    served = calibrated_volume(base, _future(), metadata)

    hours = _future().dt.hour.to_numpy()
    assert served[hours >= 16] == pytest.approx(13.0)   # recent evenings ran 30% above the base
    assert served[hours < 16] == pytest.approx(11.0)    # the rest of the day 10% above
    assert served == pytest.approx(apply_calibration(_future(), base, factors, LAST_DAY))
    assert calibration_factors(metadata) == factors


def test_metadata_from_before_the_final_run_still_serves_as_base_times_level_factor():
    old = {"train_start": "2021-01-01T00:00:00", "train_end": "2026-10-20T23:00:00", "level_factor": 1.0355}
    base = np.linspace(2.0, 12.0, 7 * HOURS)

    assert calibrated_volume(base, _future(), old) == pytest.approx(base * 1.0355)


def test_metadata_without_any_level_serves_the_base_forecast():
    base = np.linspace(2.0, 12.0, 7 * HOURS)

    assert calibrated_volume(base, _future(), {"train_start": "2021-01-01T00:00:00"}) == pytest.approx(base)


def test_holiday_toggle_off_neutralises_every_holiday_feature():
    featured = pd.DataFrame({"hour_start": _future()[:3], "dow": 3, "is_holiday": 1, "days_to_nearest_holiday": 0,
                             "is_holiday_adjacent": 1, "is_major_holiday": 1, "holiday_kind": 9})

    plain = _without_holidays(featured)

    assert plain[["is_holiday", "is_holiday_adjacent", "is_major_holiday", "holiday_kind"]].to_numpy().sum() == 0
    assert (plain["days_to_nearest_holiday"] == 14).all()
    assert (plain["dow"] == 3).all()
    assert featured["is_holiday"].sum() == 3            # input untouched
