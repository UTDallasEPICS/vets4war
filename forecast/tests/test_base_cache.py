"""Cached base-model runs: one fit per origin, any calibration afterwards.

Small hand-built grids; the LightGBM fits are real but tiny. No database.
"""

import numpy as np
import pandas as pd

from db.backtest import run_origins
from db.base_cache import (
    cached_base_run,
    calibrated_predictions,
    fingerprint,
    load_base_run,
    run_base,
    save_base_run,
)
from db.calibration import CalibrationConfig
from db.procedure import RECENT_DAYS, BaseConfig, ForecastProcedure, ProcedureConfig

HOURS = 24
SUNDAY = 6
FAST = BaseConfig(features=("dow", "hour"), halflife_days=None, num_boost_round=40,
                  min_data_in_leaf=5, learning_rate=0.2)
ORIGINS = [pd.Timestamp("2026-08-04"), pd.Timestamp("2026-08-11")]


def _featured(scale: float = 1.0) -> pd.DataFrame:
    """Jan to Sep 2026; Sundays busier; the last eight weeks 15% higher."""
    hours = pd.date_range("2026-01-05", "2026-09-06 23:00", freq="h")
    calls = np.where(hours.dayofweek == SUNDAY, 14.0, 10.0) * np.where(hours >= pd.Timestamp("2026-06-15"), 1.15, 1.0)
    return pd.DataFrame({"hour_start": hours, "offered": calls * scale, "dow": hours.dayofweek + 1, "hour": hours.hour})


def test_run_keeps_recent_and_future_base_numbers_for_every_origin():
    run = run_base(_featured(), ORIGINS, FAST)

    assert list(run.recent.columns) == ["origin", "hour_start", "actual", "base"]
    assert list(run.future.columns) == ["origin", "hour_start", "horizon_day", "actual", "base"]
    assert len(run.recent) == 2 * RECENT_DAYS * HOURS
    assert len(run.future) == (28 + 26) * HOURS
    assert run.recent.groupby("origin")["hour_start"].max().tolist() == [o + pd.Timedelta(hours=23) for o in ORIGINS]


def test_cached_numbers_give_the_same_forecast_as_running_the_whole_procedure():
    featured = _featured()
    calibration = CalibrationConfig(level_window_days=28, shape_window_days=56, level_cap=0.5,
                                    dow_strength=200.0, hour_strength=200.0, cell_strength=50.0, level_damping=0.9)
    special = frozenset({pd.Timestamp("2026-07-04")})

    direct = run_origins(featured, ORIGINS, ForecastProcedure(ProcedureConfig(FAST, calibration), special))
    from_cache = calibrated_predictions(run_base(featured, ORIGINS, FAST), calibration, special)

    pd.testing.assert_frame_equal(from_cache, direct)


def test_a_run_survives_saving_and_loading(tmp_path):
    run = run_base(_featured(), ORIGINS, FAST)

    save_base_run(run, tmp_path / "run.npz")
    loaded = load_base_run(tmp_path / "run.npz")

    pd.testing.assert_frame_equal(loaded.recent, run.recent)
    pd.testing.assert_frame_equal(loaded.future, run.future)


def test_second_request_for_the_same_run_reads_the_file_instead_of_refitting(tmp_path):
    featured = _featured()

    first = cached_base_run(featured, ORIGINS, FAST, tmp_path)
    files = sorted(tmp_path.iterdir())
    written_at = files[0].stat().st_mtime_ns
    second = cached_base_run(featured, ORIGINS, FAST, tmp_path)

    assert len(files) == 1
    assert sorted(tmp_path.iterdir())[0].stat().st_mtime_ns == written_at
    pd.testing.assert_frame_equal(second.future, first.future)


def test_different_data_or_config_gets_its_own_cache_file(tmp_path):
    slower = BaseConfig(features=("dow", "hour"), halflife_days=None, num_boost_round=20,
                        min_data_in_leaf=5, learning_rate=0.2)

    cached_base_run(_featured(), ORIGINS, FAST, tmp_path)
    cached_base_run(_featured(scale=2.0), ORIGINS, FAST, tmp_path)
    cached_base_run(_featured(), ORIGINS, slower, tmp_path)

    assert len(list(tmp_path.iterdir())) == 3


def test_fingerprint_changes_when_calls_move_between_hours_with_the_same_totals():
    featured = _featured()
    moved = featured.copy()
    first, second = moved.index[100], moved.index[101]
    moved.loc[first, "offered"] += 3
    moved.loc[second, "offered"] -= 3

    assert moved["offered"].sum() == featured["offered"].sum()
    assert fingerprint(moved, ORIGINS, FAST) != fingerprint(featured, ORIGINS, FAST)


def test_fingerprint_is_the_same_for_the_same_rows_and_origins():
    assert fingerprint(_featured(), ORIGINS, FAST) == fingerprint(_featured(), list(ORIGINS), FAST)
