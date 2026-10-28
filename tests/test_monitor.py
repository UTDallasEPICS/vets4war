"""Offline monitoring tests: no dotenv, partner database, or model artifacts."""

import importlib
import json
import sys
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Existing shared modules call load_dotenv during import. Disable discovery even
# when this test module is collected alongside database-backed tests.
from unittest.mock import patch

with patch("dotenv.load_dotenv", return_value=False):
    monitor = importlib.import_module("db.monitor")


@pytest.fixture
def setup(monkeypatch):
    metadata = {"train_start": "2020-01-01", "train_end": "2026-01-01T23:00:00",
                "target": "offered", "features": ["hour"]}
    attestation = {"complete_start": "2026-01-02", "complete_end": "2026-01-02",
                   "timezone": "Eastern naive wall-clock", "source": "test loader",
                   "evidence": "batch-42 reconciled to source export", "offered_count": 4}
    hourly = pd.DataFrame({"hour_start": pd.to_datetime(["2026-01-01T12:00", "2026-01-02T00:00", "2026-01-02T01:00"]),
                           "offered": [999, 2, 2]})
    monkeypatch.setattr(monitor, "load_hourly", MagicMock(return_value=hourly))
    monkeypatch.setattr(monitor, "load_holidays", MagicMock(return_value=pd.DataFrame({"holiday_date": pd.to_datetime(["2027-01-01"])})))
    booster = MagicMock()
    booster.predict.return_value = np.ones(24)
    return metadata, attestation, booster


def replay(setup, **kwargs):
    metadata, attestation, booster = setup
    params = dict(conn=MagicMock(), booster=booster, metadata=metadata,
                  start=date(2026, 1, 1), end=date(2026, 1, 2),
                  attestation=attestation, today=date(2026, 1, 5))
    params.update(kwargs)
    return monitor.evaluate(**params)


def test_verified_replay_reuses_features_and_score(setup, monkeypatch):
    features = MagicMock(wraps=monitor.build_features)
    scorer = MagicMock(wraps=monitor.score)
    monkeypatch.setattr(monitor, "build_features", features)
    monkeypatch.setattr(monitor, "score", scorer)
    result = replay(setup)
    assert result["status"] == "success"
    assert result["evaluation_period"]["start"] == "2026-01-02"
    assert result["metrics"] == {"hourly_mae": 1.0, "hourly_rmse": 1.0,
                                 "daily_total_mae": 20.0, "signed_bias": 20 / 24,
                                 "hours": 24, "days": 1, "actual_calls": 4, "predicted_calls": 24.0}
    assert result["completeness"]["zero_filled_hours"] == 22
    assert features.call_args.kwargs["epoch"] == "2020-01-01"
    scorer.assert_called_once()


def test_no_evidence_withholds_metrics_without_reading_calls(setup):
    result = replay(setup, attestation=None)
    assert result["status"] == "incomplete" and result["metrics"] is None
    monitor.load_hourly.assert_not_called()
    setup[2].predict.assert_not_called()


def test_saved_level_factor_calibrates_metrics(setup):
    setup[0]["level_factor"] = 1.25
    result = replay(setup)
    metrics = result["metrics"]
    assert metrics["predicted_calls"] == pytest.approx(30)
    assert metrics["daily_total_mae"] == pytest.approx(26)
    assert metrics["signed_bias"] == pytest.approx(26 / 24)
    assert metrics["hourly_mae"] == pytest.approx((2 * 0.75 + 22 * 1.25) / 24)


@pytest.mark.parametrize("factor", [None, 1.0, 1.050295949343777, 0.85])
def test_replay_volume_matches_production(setup, monkeypatch, factor):
    from db import forecast

    metadata, _, booster = setup
    if factor is not None:
        metadata["level_factor"] = factor
    # Vary volume by hour to catch differences in features, order, and scaling.
    def predict(features):
        return features["hour"].to_numpy(dtype=float) + 1

    booster.predict.side_effect = predict
    observed_features = []

    def record_predict(features):
        observed_features.append(features.copy())
        return predict(features)

    booster.predict.side_effect = record_predict
    holidays = monitor.load_holidays.return_value
    aht = {(dow, hour): 300.0 for dow in range(1, 8) for hour in range(24)}
    monkeypatch.setattr(forecast, "_load_cached", lambda conn, recency: (booster, metadata, aht))
    monkeypatch.setattr(forecast, "load_holidays", lambda conn: holidays)
    production = forecast.forecast_range(MagicMock(), "2026-01-02", "2026-01-02")
    result = replay(setup)

    pd.testing.assert_frame_equal(observed_features[0], observed_features[1])
    predicted = production["predicted_offered"].to_numpy()
    actual = np.array([2, 2] + [0] * 22)
    assert result["status"] == "success"
    assert result["metrics"]["predicted_calls"] == pytest.approx(predicted.sum())
    assert result["metrics"]["hourly_mae"] == pytest.approx(np.abs(predicted - actual).mean())
    assert result["metrics"]["hourly_rmse"] == pytest.approx(np.sqrt(((predicted - actual) ** 2).mean()))
    assert result["metrics"]["daily_total_mae"] == pytest.approx(abs(predicted.sum() - actual.sum()))
    assert result["metrics"]["signed_bias"] == pytest.approx((predicted - actual).mean())


def test_count_mismatch_withholds_metrics(setup):
    setup[1]["offered_count"] = 5
    assert replay(setup)["status"] == "incomplete"
    setup[2].predict.assert_not_called()


def test_wrong_attested_dates_withhold_metrics(setup):
    setup[1]["complete_start"] = "2026-01-01"
    assert replay(setup)["status"] == "incomplete"


def test_empty_post_training_window(setup):
    assert replay(setup, end=date(2026, 1, 1))["status"] == "no_data"
    monitor.load_hourly.assert_not_called()


def test_partial_training_day_excluded(setup):
    setup[0]["train_end"] = "2026-01-01T12:30:00"
    assert replay(setup)["evaluation_period"]["start"] == "2026-01-02"


def test_unfinished_historical_days_excluded(setup):
    assert replay(setup, today=date(2026, 1, 3))["status"] == "no_data"


def test_empty_calls_is_no_data(setup):
    monitor.load_hourly.side_effect = ValueError("`calls` is empty; nothing to aggregate")
    result = replay(setup)
    assert result["status"] == "no_data" and result["metrics"] is None


def test_no_observations_is_not_assumed_zero(setup):
    setup[1]["offered_count"] = 0
    monitor.load_hourly.return_value = monitor.load_hourly.return_value.iloc[:1]
    assert replay(setup)["status"] == "no_data"


@pytest.mark.parametrize("counts", [[-1, 5], [float("nan"), 4], [1.5, 2.5]])
def test_invalid_actual_counts_rejected(setup, counts):
    monitor.load_hourly.return_value["offered"] = monitor.load_hourly.return_value["offered"].astype(float)
    monitor.load_hourly.return_value.loc[1:, "offered"] = counts
    with pytest.raises(ValueError):
        replay(setup)


@pytest.mark.parametrize("prediction", [np.full(24, np.nan), np.full(24, -1), np.ones(23)])
def test_invalid_predictions_rejected(setup, prediction):
    setup[2].predict.return_value = prediction
    with pytest.raises(ValueError):
        replay(setup)


def test_expired_holidays_reported(setup):
    monitor.load_holidays.return_value = pd.DataFrame({"holiday_date": pd.to_datetime(["2025-01-01"])})
    assert any("Holiday calendar ends" in warning for warning in replay(setup)["warnings"])


@pytest.fixture
def artifacts(tmp_path, monkeypatch):
    model = tmp_path / "model.txt"
    metadata = tmp_path / "metadata.json"
    model.write_text("mock model", encoding="utf-8")
    metadata.write_text(json.dumps({"train_start": "2020-01-01", "train_end": "2026-01-01",
                                    "target": "offered", "features": ["hour"]}), encoding="utf-8")
    booster = MagicMock()
    booster.feature_name.return_value = ["hour"]
    monkeypatch.setattr(monitor.lgb, "Booster", MagicMock(return_value=booster))
    return model, metadata, booster


def test_artifact_identity_and_contract(artifacts):
    model, metadata, _ = artifacts
    _, _, identity = monitor.load_model(model, metadata)
    assert identity["model_sha256"] == monitor._sha256(model.read_bytes())
    assert identity["pairing"] == "feature_contract_only"


def test_mismatched_features_rejected(artifacts):
    model, metadata, booster = artifacts
    booster.feature_name.return_value = ["wrong"]
    with pytest.raises(ValueError, match="do not match"):
        monitor.load_model(model, metadata)


def test_mismatched_artifact_hash_rejected(artifacts):
    model, metadata, _ = artifacts
    content = json.loads(metadata.read_text())
    content["model_sha256"] = "wrong"
    metadata.write_text(json.dumps(content))
    with pytest.raises(ValueError, match="hash"):
        monitor.load_model(model, metadata)


def test_missing_model_json_error(tmp_path, capsys):
    assert monitor.main(["--model", str(tmp_path / "missing")]) == 1
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "error" and report["metrics"] is None
    assert report["evaluation_kind"] == "retrospective_replay"


def test_database_errors_redacted(artifacts, monkeypatch, capsys):
    monkeypatch.setenv("V4W_DATABASE_URL", "test-only-dsn")
    connect = MagicMock(side_effect=monitor.psycopg.OperationalError("SECRET connection string"))
    monkeypatch.setattr(monitor.psycopg, "connect", connect)
    model, metadata, _ = artifacts
    assert monitor.main(["--model", str(model), "--metadata", str(metadata)]) == 1
    output = capsys.readouterr().out
    assert "SECRET" not in output and "test-only-dsn" not in output
    assert "default_transaction_read_only=on" in connect.call_args.kwargs["options"]


def test_cli_success_and_read_only_snapshot(artifacts, setup, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("V4W_DATABASE_URL", "mock-dsn")
    connect = MagicMock()
    monkeypatch.setattr(monitor.psycopg, "connect", connect)
    artifacts[2].predict.return_value = np.ones(24)
    evidence = tmp_path / "complete.json"
    evidence.write_text(json.dumps(setup[1]))
    code = monitor.main(["--model", str(artifacts[0]), "--metadata", str(artifacts[1]),
                         "--start", "2026-01-02", "--end", "2026-01-02", "--completeness", str(evidence)])
    assert code == 0
    assert json.loads(capsys.readouterr().out)["status"] == "success"
    assert "repeatable" in connect.call_args.kwargs["options"]


def test_missing_dsn(artifacts, monkeypatch, capsys):
    monkeypatch.delenv("V4W_DATABASE_URL", raising=False)
    assert monitor.main(["--model", str(artifacts[0]), "--metadata", str(artifacts[1])]) == 1
    assert json.loads(capsys.readouterr().out)["status"] == "error"


def test_two_day_metrics_and_negative_bias(setup):
    setup[1].update(complete_end="2026-01-03", offered_count=96)
    monitor.load_hourly.return_value = pd.DataFrame({
        "hour_start": pd.date_range("2026-01-02", periods=48, freq="h"),
        "offered": [1] * 24 + [3] * 24})
    setup[2].predict.return_value = np.ones(48)
    result = replay(setup, end=date(2026, 1, 3))
    assert result["metrics"]["signed_bias"] == -1
    assert result["metrics"]["daily_total_mae"] == 24
    assert result["metrics"]["hourly_rmse"] == pytest.approx(np.sqrt(2))


@pytest.mark.parametrize("field,value", [("timezone", "UTC"), ("evidence", ""),
                                        ("offered_count", True), ("offered_count", -1)])
def test_invalid_attestation(setup, field, value):
    setup[1][field] = value
    with pytest.raises(ValueError):
        replay(setup)


def test_duplicate_hours_rejected(setup):
    monitor.load_hourly.return_value.loc[2, "hour_start"] = pd.Timestamp("2026-01-02")
    with pytest.raises(ValueError, match="unique"):
        replay(setup)


def test_cli_incomplete_json(artifacts, monkeypatch, capsys):
    monkeypatch.setenv("V4W_DATABASE_URL", "mock-dsn")
    monkeypatch.setattr(monitor.psycopg, "connect", MagicMock())
    code = monitor.main(["--model", str(artifacts[0]), "--metadata", str(artifacts[1]),
                         "--start", "2026-01-02", "--end", "2026-01-02"])
    assert code == 2
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "incomplete" and result["metrics"] is None


def test_real_synthetic_booster_roundtrip(tmp_path):
    """Exercise LightGBM's actual text loader with no repository model access."""
    training = pd.DataFrame({"hour": np.arange(48) % 24})
    booster = monitor.lgb.train({"objective": "poisson", "verbosity": -1, "num_threads": 1},
                               monitor.lgb.Dataset(training, label=np.ones(48)), num_boost_round=1)
    model = tmp_path / "model.txt"
    model.write_text(booster.model_to_string(), encoding="utf-8")
    metadata = tmp_path / "metadata.json"
    metadata.write_text(json.dumps({"train_start": "2020-01-01", "train_end": "2026-01-01",
                                    "target": "offered", "features": ["hour"],
                                    "model_sha256": monitor._sha256(model.read_bytes())}))
    loaded, _, identity = monitor.load_model(model, metadata)
    assert identity["pairing"] == "hash_verified"
    np.testing.assert_allclose(loaded.predict(training), booster.predict(training))
