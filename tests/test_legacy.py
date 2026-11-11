"""The Oct 28 2026 model as a backtest procedure (the comparison baseline).

Small hand-built grid; real (small) LightGBM fits. No database.
"""

import numpy as np
import pandas as pd

from db.features import build_features
from db.legacy import LEGACY_FEATURES, LegacyProcedure

HOLIDAYS = pd.DataFrame({"holiday_date": pd.to_datetime(["2026-05-25", "2026-07-04"]),
                         "holiday_name": ["Memorial Day", "Independence Day"]})


def _featured(first: str, last: str) -> pd.DataFrame:
    hours = pd.date_range(first, pd.Timestamp(last) + pd.Timedelta(hours=23), freq="h")
    calls = 8.0 + 4.0 * (hours.hour >= 16) + 2.0 * (hours.dayofweek == 6)
    return build_features(pd.DataFrame({"hour_start": hours, "offered": calls}), HOLIDAYS)


def test_legacy_features_are_the_nine_the_oct_28_model_was_trained_on():
    assert LEGACY_FEATURES == ("dow", "hour", "hour_sin", "hour_cos", "dow_sin", "dow_cos",
                               "is_weekend", "is_holiday", "days_to_nearest_holiday")


def test_legacy_forecast_is_unchanged_by_feature_columns_added_later():
    train, future = _featured("2026-04-06", "2026-07-12"), _featured("2026-07-13", "2026-07-19")
    with_new_column = lambda frame: frame.assign(holiday_kind=np.arange(len(frame)) % 5)  # noqa: E731

    plain = LegacyProcedure()(train, future)
    extended = LegacyProcedure()(with_new_column(train), with_new_column(future))

    assert np.array_equal(plain, extended)


def test_legacy_forecast_tracks_the_pattern_it_was_trained_on():
    train, future = _featured("2026-04-06", "2026-07-12"), _featured("2026-07-13", "2026-07-19")

    predicted = LegacyProcedure()(train, future)

    assert len(predicted) == len(future)
    assert np.abs(predicted - future["offered"].to_numpy()).mean() < 0.5


def test_legacy_procedure_still_reproduces_the_recorded_baseline():
    """The baseline numbers in docs/final-run/ledger.json came from these
    forecasts; the kept legacy code must still produce them."""
    import pytest

    from db.backtest import run_origins
    from db.dataset import load_snapshot
    from db.train import REPO_ROOT, complete_hourly_grid

    snapshot = REPO_ROOT / "data/cache/final_run"
    recorded_files = sorted((REPO_ROOT / "data/cache").glob("legacy_dev*.csv"), key=lambda p: p.stat().st_mtime)
    if not (snapshot / "hourly.csv").exists() or not recorded_files:
        pytest.skip("local dataset snapshot or recorded baseline not present")
    recorded_path = recorded_files[-1]
    dataset = load_snapshot(snapshot)
    featured = build_features(complete_hourly_grid(dataset.hourly), dataset.holidays)
    recorded = pd.read_csv(recorded_path, parse_dates=["origin", "hour_start"])
    origin = recorded["origin"].max()

    fresh = run_origins(featured, [origin], LegacyProcedure())

    expected = recorded.loc[recorded["origin"] == origin, "predicted"].to_numpy()
    assert np.allclose(fresh["predicted"].to_numpy(), expected, rtol=1e-6)
