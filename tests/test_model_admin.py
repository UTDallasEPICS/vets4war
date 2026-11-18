from datetime import date
from unittest.mock import MagicMock

from fastapi.testclient import TestClient

from api import model_admin
from api.main import app
from db import candidate, monitor
from db.train import METADATA_PATH, MODEL_PATH


def test_packaged_final_model_identity_and_rolling_gate():
    _, _, identity = monitor.load_model(MODEL_PATH, METADATA_PATH)
    model = model_admin.active_model()
    assert model["version"] == identity["model_sha256"]
    assert model["train_end"].date() == date(2026, 11, 3)
    assert model["historical_backtest"]["origins"] == 26
    assert model["historical_backtest"]["metrics"]["daily_mape_1_14"] > 0
    assert candidate.verify(MODEL_PATH.parent, date(2026, 11, 4), model["version"])["model_sha256"] == model["version"]


def test_model_health_separates_latest_observed_data_and_missing_replay(signed_in_admin, monkeypatch, tmp_path):
    monkeypatch.setenv("V4W_ACCURACY_REPORT_DIR", str(tmp_path))
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.execute.return_value.fetchone.return_value = {"latest": None}
    monkeypatch.setattr(model_admin.pipeline, "connect", lambda: connection)
    client = TestClient(app)
    response = client.get("/api/admin/model-health")
    assert response.status_code == 200
    result = response.json()
    assert result["data_status"] == "empty"
    assert result["evaluation"] is None
    assert result["historical_backtest"]["origins"] == 26
    assert client.get("/api/admin/reports/2026-09").status_code == 404
    assert client.post("/api/admin/retraining", json={"cutoff": "2026-11-04",
                       "complete_history_confirmed": True}).status_code == 403

def test_replay_uses_the_packaged_forecast_calibration(monkeypatch):
    import numpy as np
    import pandas as pd
    from db.forecast import calibrated_volume
    from db.features import build_features

    booster, metadata, _ = monitor.load_model(MODEL_PATH, METADATA_PATH)
    hours = pd.date_range("2026-11-04", periods=24, freq="h")
    hourly = pd.DataFrame({"hour_start": hours, "offered": [2] * 24})
    holidays = pd.DataFrame({"holiday_date": pd.to_datetime(["2026-12-25"])})
    monkeypatch.setattr(monitor, "load_hourly", lambda conn: hourly)
    monkeypatch.setattr(monitor, "load_holidays", lambda conn: holidays)
    result = monitor.evaluate(object(), booster, metadata, date(2026, 11, 4), date(2026, 11, 4),
                              {"complete_start": "2026-11-04", "complete_end": "2026-11-04",
                               "source": "synthetic", "evidence": "test", "offered_count": 48,
                               "timezone": "Eastern naive wall-clock"}, date(2026, 11, 7))
    featured = build_features(hourly, holidays, epoch=metadata["train_start"])
    expected = calibrated_volume(booster.predict(featured[metadata["features"]]), hourly.hour_start, metadata)
    np.testing.assert_array_equal([row["predicted"] for row in result["hourly"]], expected)
    assert result["status"] == "success" and result["metrics"]["actual_calls"] == 48


def test_retraining_dispatch_uses_integrated_incumbent(monkeypatch):
    from api.auth import verify_token

    calls = []
    monkeypatch.setattr(model_admin, "github", lambda path, payload: calls.append((path, payload))
                        or {"workflow_run_id": 12, "html_url": "https://github.com/example/repo/actions/runs/12"})
    monkeypatch.setitem(app.dependency_overrides, verify_token, lambda: {
        "sub": "test", "permissions": ["read:admin", "trigger:retraining"]})
    response = TestClient(app).post("/api/admin/retraining", json={
        "cutoff": "2026-11-04", "complete_history_confirmed": True})
    assert response.status_code == 202
    assert calls[0][1]["ref"] == "final-main"
    assert calls[0][1]["inputs"]["active_version"] == model_admin.active_model()["version"]

def test_list_completed_report_months_requires_admin_and_hides_other_files(signed_in_admin, monkeypatch, tmp_path):
    monkeypatch.setenv("V4W_ACCURACY_REPORT_DIR", str(tmp_path))
    for name in ("2026-10.json", "2026-09.json", "2026-13.json", "2099-01.json", "operator.json"):
        (tmp_path / name).write_text("{}")
    with TestClient(app) as client:
        response = client.get("/api/admin/reports")
        assert response.status_code == 200
        assert response.json() == {"months": ["2026-10", "2026-09"]}
        assert response.headers["Cache-Control"] == "no-store"
        assert client.get("/api/admin/reports/2026-10").status_code == 503
    with monkeypatch.context() as scope:
        from api.auth import verify_token
        scope.delitem(app.dependency_overrides, verify_token)
        assert TestClient(app).get("/api/admin/reports").status_code == 401
