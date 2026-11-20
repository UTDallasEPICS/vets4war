"""Training the production procedure: fit, gate, metadata, save.

Small hand-built grids; the LightGBM fits are real but tiny. No database.
"""

import json

import lightgbm as lgb
import numpy as np
import pandas as pd
import pytest

from db.calibration import CalibrationConfig, CalibrationFactors
from db.features import build_features
from db.forecast import calibrated_volume, check_model_matches
from db.procedure import PRODUCTION, BaseConfig, ForecastProcedure, ProcedureConfig, special_days
from db.train import REPO_ROOT, build_metadata, fit_model, gate, passes_gate, recent_gaps, save_model

HOURS = 24
HOLIDAYS = pd.DataFrame({"holiday_date": pd.to_datetime(["2026-05-25", "2026-07-04", "2026-09-07"]),
                         "holiday_name": ["Memorial Day", "Independence Day", "Labor Day"]})
FAST = ProcedureConfig(
    base=BaseConfig(features=("dow", "hour", "is_holiday", "is_holiday_adjacent"), halflife_days=365.0,
                    num_boost_round=40, min_data_in_leaf=5, learning_rate=0.2),
    calibration=CalibrationConfig(level_window_days=28, level_cap=0.5, shape_window_days=56, hour_strength=100.0),
)
SOURCES = ({"file": "database", "calls": 123},)


def _featured(first: str, last: str, lift_from: str | None = None) -> pd.DataFrame:
    """Evenings busier; optionally 20% more calls from `lift_from` on."""
    hours = pd.date_range(first, pd.Timestamp(last) + pd.Timedelta(hours=23), freq="h")
    calls = 8.0 + 4.0 * (hours.hour >= 16)
    if lift_from:
        calls = calls * np.where(hours >= pd.Timestamp(lift_from), 1.2, 1.0)
    return build_features(pd.DataFrame({"hour_start": hours, "offered": calls}), HOLIDAYS)


# ---- fit ------------------------------------------------------------------------

def test_fit_model_returns_one_booster_the_factors_and_the_training_span():
    featured = _featured("2026-03-02", "2026-09-27")

    model = fit_model(featured, HOLIDAYS, FAST)

    assert isinstance(model.booster, lgb.Booster)
    assert isinstance(model.factors, CalibrationFactors)
    assert model.features == FAST.base.features
    assert (model.train_start, model.train_end) == (featured["hour_start"].min(), featured["hour_start"].max())
    assert model.train_rows == len(featured)


def test_trained_level_picks_up_a_recent_rise_in_volume():
    steady = fit_model(_featured("2026-03-02", "2026-09-27"), HOLIDAYS, FAST)
    risen = fit_model(_featured("2026-03-02", "2026-09-27", lift_from="2026-08-31"), HOLIDAYS, FAST)

    assert steady.factors.level == pytest.approx(1.0, abs=0.02)
    assert risen.factors.level > 1.1


def test_a_config_with_several_seeds_cannot_be_saved_as_one_model_file():
    several = ProcedureConfig(base=BaseConfig(features=("dow", "hour"), seeds=(1, 2), num_boost_round=5),
                              calibration=FAST.calibration)

    with pytest.raises(ValueError, match="one seed"):
        fit_model(_featured("2026-03-02", "2026-09-27"), HOLIDAYS, several)


# ---- metadata and saving -----------------------------------------------------------

def test_metadata_carries_what_serving_and_auditing_need_and_is_json_ready():
    model = fit_model(_featured("2026-03-02", "2026-09-27"), HOLIDAYS, FAST)

    metadata = build_metadata(model, FAST, SOURCES, {"passed": True})

    assert metadata["features"] == list(FAST.base.features)
    assert metadata["train_end"] == "2026-09-27T23:00:00"
    assert metadata["level_factor"] == model.factors.level
    assert CalibrationFactors.from_dict(metadata["calibration"]) == model.factors
    assert ProcedureConfig.from_dict(metadata["procedure"]) == FAST
    assert metadata["data_sources"] == list(SOURCES)
    assert metadata["gate"] == {"passed": True}
    assert "label" in metadata["config"]
    json.dumps(metadata)


def test_saved_model_reloads_and_predicts_the_same(tmp_path):
    featured = _featured("2026-03-02", "2026-09-27")
    model = fit_model(featured, HOLIDAYS, FAST)
    metadata = build_metadata(model, FAST, SOURCES, {"passed": True})

    save_model(model, metadata, tmp_path / "models" / "volume.txt", tmp_path / "models" / "metadata.json")

    reloaded = lgb.Booster(model_file=str(tmp_path / "models" / "volume.txt"))
    week = featured.tail(7 * HOURS)[list(FAST.base.features)]
    assert reloaded.predict(week) == pytest.approx(model.booster.predict(week))
    saved = json.loads((tmp_path / "models" / "metadata.json").read_text())
    assert {key: saved[key] for key in metadata} == json.loads(json.dumps(metadata))
    assert set(saved) - set(metadata) == {"model_sha256"}


# ---- gate ---------------------------------------------------------------------------

def test_gate_passes_only_when_the_model_beats_the_baseline_on_daily_error():
    assert passes_gate({"daily_mape_1_14": 9.3}, {"daily_mape_1_14": 10.3})
    assert not passes_gate({"daily_mape_1_14": 10.3}, {"daily_mape_1_14": 10.3})
    assert not passes_gate({"daily_mape_1_14": 11.0}, {"daily_mape_1_14": 10.3})


def test_gate_scores_the_model_and_the_baseline_on_the_same_weeks():
    featured = _featured("2026-01-05", "2026-09-27")

    result = gate(featured, HOLIDAYS, FAST, n_origins=2, workers=1)

    assert result["origins"] == 2
    assert result["first_origin"] == "2026-09-13" and result["last_origin"] == "2026-09-20"
    assert set(result["model"]) == set(result["naive"])
    assert result["passed"] == (result["model"]["daily_mape_1_14"] < result["naive"]["daily_mape_1_14"])


# ---- the configuration that ships ---------------------------------------------------

def test_production_config_is_the_one_the_final_run_ended_on():
    incumbent = REPO_ROOT / "docs" / "final-run" / "incumbent.json"
    if not incumbent.exists():
        pytest.skip("docs/final-run/incumbent.json not present")

    assert ProcedureConfig.from_dict(json.loads(incumbent.read_text())["config"]) == PRODUCTION


# ---- what is served is what was scored --------------------------------------------------

def test_the_saved_model_serves_exactly_the_forecast_the_backtest_scores(tmp_path):
    featured = _featured("2026-03-02", "2026-09-27", lift_from="2026-08-17")
    train = featured[featured["hour_start"] < pd.Timestamp("2026-09-14")]
    future = featured[featured["hour_start"] >= pd.Timestamp("2026-09-14")]
    model = fit_model(train, HOLIDAYS, FAST)
    save_model(model, build_metadata(model, FAST, SOURCES, {"passed": True}), tmp_path / "m.txt", tmp_path / "m.json")
    metadata = json.loads((tmp_path / "m.json").read_text())
    booster = lgb.Booster(model_file=str(tmp_path / "m.txt"))

    served = calibrated_volume(booster.predict(future[metadata["features"]]), future["hour_start"], metadata)
    scored = ForecastProcedure(FAST, special_days(HOLIDAYS, train["hour_start"]))(train, future)

    assert served == pytest.approx(scored)


def test_saved_metadata_carries_the_fingerprint_of_its_model_file(tmp_path):
    model = fit_model(_featured("2026-03-02", "2026-09-27"), HOLIDAYS, FAST)
    save_model(model, build_metadata(model, FAST, SOURCES, {"passed": True}), tmp_path / "m.txt", tmp_path / "m.json")
    metadata = json.loads((tmp_path / "m.json").read_text())

    check_model_matches(metadata, (tmp_path / "m.txt").read_bytes())             # same run: no error
    with pytest.raises(ValueError, match="different training runs"):
        check_model_matches(metadata, b"another model file")
    check_model_matches({"features": []}, b"anything")                           # older metadata: not checked


def test_saving_leaves_no_temporary_files_behind(tmp_path):
    model = fit_model(_featured("2026-03-02", "2026-09-27"), HOLIDAYS, FAST)

    save_model(model, build_metadata(model, FAST, SOURCES, {"passed": True}), tmp_path / "m.txt", tmp_path / "m.json")

    assert sorted(p.name for p in tmp_path.iterdir()) == ["m.json", "m.txt"]


# ---- gaps the gate cannot work around ---------------------------------------------------

def test_recent_gaps_lists_missing_days_inside_the_span_only():
    # An old gap (Jan 2, then Jan 4 to Sep 19) and a recent one (Oct 2 and 3).
    days = [pd.Timestamp("2026-01-01"), pd.Timestamp("2026-01-03"),
            *pd.date_range("2026-09-20", "2026-10-01"), pd.Timestamp("2026-10-04")]
    hourly = pd.DataFrame({"hour_start": [day + pd.Timedelta(hours=9) for day in days], "offered": 1})

    gaps = recent_gaps(hourly, span_days=10)

    assert [str(day.date()) for day in gaps] == ["2026-10-02", "2026-10-03"]
