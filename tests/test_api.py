"""Tests for the /api/forecast hour-level response shape.

Needs V4W_DATABASE_URL and a trained models/ directory. The only data
source is the database; if it is unreachable these tests fail, they do not
fall back to synthetic input.

Run from the repo root:  python -m pytest tests/test_api.py -v
"""

import json
import math
import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import psycopg  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import db.forecast as forecast_module  # noqa: E402
from api.main import app, format_duration  # noqa: E402
from db.patience import estimate_patience  # noqa: E402
from db.staffing import MAX_STAFF_PER_SHIFT, SHIFT_ORDER, staff_for_hour  # noqa: E402
from db.train import METADATA_PATH  # noqa: E402

HOURS_PER_DAY = 24
HOUR_KEYS = {
    "date", "hour", "predicted_calls", "aht_sec", "load_erlangs", "agents_required",
    "staff_to_schedule", "effective_agents", "service_level_delivered", "over_cap",
    "implausible", "reason", "expected_talk_sec", "expected_talk", "abandon_share",
}
DAY_KEYS = {"date", "is_weekend", "holiday", "predicted_calls", "shifts", "expected_talk_sec", "expected_talk"}
WINDOW_KEYS = {"start", "end", "expected_calls", "expected_talk_sec", "expected_talk", "mean_aht_sec",
               "expected_abandoned_calls", "abandon_share", "expected_abandoned_one_fewer",
               "recency", "recency_effect_pct", "caveat"}
SOURCE_KEYS = {"kind", "label", "start", "end"}
PLANNED_KEYS = {"date", "shift", "planned", "recommended", "delta", "verdict", "effective_agents",
                "service_level_at_planned", "abandon_share_at_planned"}
PATIENCE_RANGE_SEC = (60, 3600)   # sanity bounds; the exact value is checked against db.patience below
TALK_TOLERANCE = 1e-6
SHIFT_KEYS = {"predicted_calls", "agents_required", "staff_needed", "capped", "service_level_delivered", "abandon_share"}
SAMPLE_HOURS = 6
SECONDS_PER_HOUR = 3600
LOAD_TOLERANCE = 1e-6
EFFICIENCY = 0.65
TARGET_PCT = 0.80
THREE_DAYS = {"start": "2026-10-01", "end": "2026-10-03"}
THIRTY_ONE_DAYS = {"start": "2026-10-01", "end": "2026-10-31"}
CELLS_IN_31_DAYS = 31 * HOURS_PER_DAY

# Hours that feed each shift's staffing max: core hours plus the overlap hour.
SHIFT_HOURS = {
    "Overnight": list(range(0, 9)),
    "Day": list(range(8, 17)),
    "Evening": list(range(16, 24)) + [HOURS_PER_DAY],  # 24 = hour 0 of the next day
}


@pytest.fixture(scope="module")
def client():
    if not os.environ.get("V4W_DATABASE_URL"):
        pytest.skip("V4W_DATABASE_URL is not set; API tests need the database")
    return TestClient(app)


@pytest.fixture(scope="module")
def forecast(client):
    params = {**THREE_DAYS, "efficiency": EFFICIENCY, "target_pct": TARGET_PCT}
    response = client.get("/api/forecast", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_hours_cover_every_hour_of_every_date(forecast):
    # Arrange
    hours = forecast["hours"]
    dates = sorted({h["date"] for h in hours})

    # Assert
    assert dates == ["2026-10-01", "2026-10-02", "2026-10-03"]
    assert len(hours) == len(dates) * HOURS_PER_DAY
    for d in dates:
        assert [h["hour"] for h in hours if h["date"] == d] == list(range(HOURS_PER_DAY))
    assert [(h["date"], h["hour"]) for h in hours] == sorted((h["date"], h["hour"]) for h in hours)


def test_hour_rows_have_exactly_the_documented_keys_and_types(forecast):
    for row in forecast["hours"]:
        assert set(row) == HOUR_KEYS, set(row) ^ HOUR_KEYS
        assert isinstance(row["hour"], int)
        assert isinstance(row["agents_required"], int)
        assert isinstance(row["staff_to_schedule"], int)
        assert isinstance(row["effective_agents"], int)
        assert isinstance(row["over_cap"], bool)
        assert row["implausible"] is False and row["reason"] is None
        assert row["predicted_calls"] >= 0
        assert row["aht_sec"] > 0
        assert 0 <= row["service_level_delivered"] <= 1


def test_hour_rows_are_traceable_by_hand(forecast):
    """load = calls * AHT / 3600; effective = floor(staff * efficiency);
    over_cap = staff > 7. The chain the popover shows must hold exactly."""
    for row in forecast["hours"]:
        expected_load = row["predicted_calls"] * row["aht_sec"] / SECONDS_PER_HOUR
        assert math.isclose(row["load_erlangs"], expected_load, abs_tol=LOAD_TOLERANCE)
        assert row["staff_to_schedule"] == math.ceil(row["agents_required"] / EFFICIENCY)
        assert row["effective_agents"] == math.floor(row["staff_to_schedule"] * EFFICIENCY)
        assert row["effective_agents"] >= row["agents_required"]
        assert row["over_cap"] == (row["staff_to_schedule"] > MAX_STAFF_PER_SHIFT)
        assert row["service_level_delivered"] >= TARGET_PCT


def test_days_carry_shift_rollup_weekend_and_holiday(forecast):
    days = forecast["days"]
    assert [d["date"] for d in days] == ["2026-10-01", "2026-10-02", "2026-10-03"]
    for d in days:
        assert set(d) == DAY_KEYS
        assert d["is_weekend"] == (date.fromisoformat(d["date"]).isoweekday() >= 6)
        assert d["holiday"] is None or isinstance(d["holiday"], str)
        assert list(d["shifts"]) == list(SHIFT_ORDER)
        for shift in d["shifts"].values():
            assert set(shift) == SHIFT_KEYS
            assert TARGET_PCT <= shift["service_level_delivered"] <= 1


def test_shift_staff_is_max_of_its_hours(forecast):
    by_key = {(h["date"], h["hour"]): h for h in forecast["hours"]}
    dates = [d["date"] for d in forecast["days"]]
    for i, d in enumerate(forecast["days"]):
        next_date = dates[i + 1] if i + 1 < len(dates) else None
        for name, hours in SHIFT_HOURS.items():
            cells = []
            for hour in hours:
                key = (next_date, 0) if hour == HOURS_PER_DAY else (d["date"], hour)
                if key in by_key:
                    cells.append(by_key[key]["staff_to_schedule"])
            assert d["shifts"][name]["staff_needed"] == max(cells), (d["date"], name)


def test_days_match_the_staffing_endpoint(client, forecast):
    params = {**THREE_DAYS, "efficiency": EFFICIENCY, "target_pct": TARGET_PCT}
    staffing = client.get("/api/staffing", params=params).json()
    forecast_shifts = [(d["date"], d["predicted_calls"], d["shifts"]) for d in forecast["days"]]
    staffing_shifts = [(d["date"], d["predicted_calls"], d["shifts"]) for d in staffing["days"]]
    assert forecast_shifts == staffing_shifts


def test_features_built_once_for_the_whole_grid_with_metadata_epoch(client, monkeypatch):
    # Arrange: count calls to the shared build_features and capture the epoch.
    calls = []
    real = forecast_module.build_features

    def counting(df, holidays, epoch=None):
        calls.append({"rows": len(df), "epoch": epoch})
        return real(df, holidays, epoch=epoch)

    monkeypatch.setattr(forecast_module, "build_features", counting)
    train_start = json.loads(METADATA_PATH.read_text())["train_start"]

    # Act
    response = client.get("/api/forecast", params=THIRTY_ONE_DAYS)

    # Assert
    assert response.status_code == 200, response.text
    assert len(response.json()["hours"]) == CELLS_IN_31_DAYS
    assert calls == [{"rows": CELLS_IN_31_DAYS, "epoch": train_start}]


def test_end_before_start_is_400(client):
    response = client.get("/api/forecast", params={"start": "2026-10-03", "end": "2026-10-01"})
    assert response.status_code == 400


def test_efficiency_above_one_is_422(client):
    response = client.get("/api/forecast", params={**THREE_DAYS, "efficiency": 1.5})
    assert response.status_code == 422


def test_efficiency_zero_returns_undefined_staffing_with_reason(client):
    # Act
    response = client.get("/api/forecast", params={**THREE_DAYS, "efficiency": 0})

    # Assert: 200, agents still computed, scheduling fields null, reason present
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["params"]["efficiency"] == 0
    for row in body["hours"]:
        assert row["agents_required"] >= 0
        assert row["staff_to_schedule"] is None
        assert row["effective_agents"] is None
        assert row["service_level_delivered"] is None
        assert row["over_cap"] is None
        assert row["implausible"] is False
        assert "efficiency is 0" in row["reason"]
    for day in body["days"]:
        for shift in day["shifts"].values():
            assert shift["staff_needed"] is None and shift["capped"] is None


def test_efficiency_one_percent_is_flagged_implausible(client):
    body = client.get("/api/forecast", params={**THREE_DAYS, "efficiency": 0.01}).json()
    flagged = [r for r in body["hours"] if r["implausible"]]
    assert flagged, "expected at least one implausible hour at 1% efficiency"
    for row in flagged:
        assert row["staff_to_schedule"] == math.ceil(row["agents_required"] / 0.01)
        assert "50" in row["reason"]


@pytest.mark.parametrize("target_sec", [20, 30, 45])
def test_target_sec_is_threaded_through_the_api(client, target_sec):
    # Act
    params = {**THREE_DAYS, "efficiency": EFFICIENCY, "target_pct": TARGET_PCT, "target_sec": target_sec}
    body = client.get("/api/forecast", params=params).json()

    # Assert: every sampled hour equals staff_for_hour evaluated at this t
    assert body["params"]["target_sec"] == target_sec
    for row in body["hours"][:SAMPLE_HOURS] + body["hours"][-SAMPLE_HOURS:]:
        expected = staff_for_hour(row["predicted_calls"], row["aht_sec"], EFFICIENCY, TARGET_PCT, target_sec,
                                  body["params"]["patience_sec"])
        assert row["agents_required"] == expected["agents_required"]
        assert row["staff_to_schedule"] == expected["scheduled_needed"]
        assert math.isclose(row["service_level_delivered"], expected["service_level_at_scheduled"])


def test_default_target_sec_is_thirty(client):
    params = {**THREE_DAYS, "efficiency": EFFICIENCY, "target_pct": TARGET_PCT}
    default = client.get("/api/forecast", params=params).json()
    explicit = client.get("/api/forecast", params={**params, "target_sec": 30}).json()
    assert default["params"]["target_sec"] == 30
    assert default["hours"] == explicit["hours"]


def test_tighter_target_sec_never_needs_fewer_agents_in_any_hour(client):
    params = {**THREE_DAYS, "efficiency": EFFICIENCY, "target_pct": TARGET_PCT}
    t20 = client.get("/api/forecast", params={**params, "target_sec": 20}).json()["hours"]
    t45 = client.get("/api/forecast", params={**params, "target_sec": 45}).json()["hours"]
    for a, b in zip(t20, t45):
        assert a["agents_required"] >= b["agents_required"], (a["date"], a["hour"])


@pytest.mark.parametrize("bad", [{"target_sec": -1}, {"target_sec": 3601}, {"efficiency": -0.1}])
def test_out_of_range_params_are_422(client, bad):
    response = client.get("/api/forecast", params={**THREE_DAYS, **bad})
    assert response.status_code == 422


@pytest.mark.parametrize("seconds, expected", [(0, "0m"), (29, "0m"), (30, "1m"), (3600, "1h 0m"), (152280, "42h 18m"), (5 * 3600 + 7 * 60, "5h 7m")])
def test_format_duration_reads_as_hours_and_minutes(seconds, expected):
    assert format_duration(seconds) == expected


def test_expected_talk_time_is_the_load_in_seconds(forecast):
    """expected_talk_sec = predicted_calls * aht_sec = load_erlangs * 3600, per hour."""
    for row in forecast["hours"]:
        assert math.isclose(row["expected_talk_sec"], row["load_erlangs"] * SECONDS_PER_HOUR, rel_tol=TALK_TOLERANCE)
        assert math.isclose(row["expected_talk_sec"], row["predicted_calls"] * row["aht_sec"], rel_tol=TALK_TOLERANCE)
        assert row["expected_talk"] == format_duration(row["expected_talk_sec"])


def test_talk_time_aggregates_per_date_and_window(forecast):
    hours, days, window = forecast["hours"], forecast["days"], forecast["window"]
    assert set(window) == WINDOW_KEYS
    for day in days:
        mine = [h for h in hours if h["date"] == day["date"]]
        assert math.isclose(day["expected_talk_sec"], sum(h["expected_talk_sec"] for h in mine), rel_tol=TALK_TOLERANCE)
        assert math.isclose(day["predicted_calls"], sum(h["predicted_calls"] for h in mine), abs_tol=0.01)
        assert day["expected_talk"] == format_duration(day["expected_talk_sec"])
    total_talk = sum(h["expected_talk_sec"] for h in hours)
    total_calls = sum(h["predicted_calls"] for h in hours)
    assert math.isclose(window["expected_talk_sec"], total_talk, rel_tol=TALK_TOLERANCE)
    assert math.isclose(window["expected_calls"], total_calls, rel_tol=TALK_TOLERANCE)
    assert math.isclose(window["mean_aht_sec"], total_talk / total_calls, rel_tol=TALK_TOLERANCE)
    assert window["expected_talk"] == format_duration(total_talk)
    assert (window["start"], window["end"]) == (THREE_DAYS["start"], THREE_DAYS["end"])


def test_window_caveat_names_every_exclusion(forecast):
    caveat = forecast["window"]["caveat"].lower()
    for phrase in ("inbound", "forecast", "outbound", "after-call", "zero agent time"):
        assert phrase in caveat, phrase


def test_default_model_is_erlang_a_with_estimated_patience(forecast):
    params = forecast["params"]
    assert params["queue_model"] == "erlang_a"
    assert PATIENCE_RANGE_SEC[0] < params["patience_sec"] < PATIENCE_RANGE_SEC[1]
    with psycopg.connect(os.environ["V4W_DATABASE_URL"]) as conn:
        estimate = estimate_patience(conn)
    assert math.isclose(params["patience_sec"], estimate["patience_sec"], rel_tol=1e-9)
    assert params["patience_source"]["n_abandoned"] == estimate["n_abandoned"]
    assert params["patience_source"]["kind"] == "estimated"
    assert params["patience_source"]["n_abandoned"] > 0
    for row in forecast["hours"]:
        assert 0.0 <= row["abandon_share"] <= 1.0
        assert row["abandon_share"] <= 1.0 - row["service_level_delivered"] + 1e-9
    for day in forecast["days"]:
        for shift in day["shifts"].values():
            assert 0.0 <= shift["abandon_share"] <= 1.0
    window = forecast["window"]
    expected = sum(h["predicted_calls"] * h["abandon_share"] for h in forecast["hours"])
    assert math.isclose(window["expected_abandoned_calls"], expected, rel_tol=1e-9)
    assert math.isclose(window["abandon_share"], expected / window["expected_calls"], rel_tol=1e-9)


def test_erlang_c_reports_no_abandonment(client):
    params = {**THREE_DAYS, "efficiency": EFFICIENCY, "target_pct": TARGET_PCT, "queue_model": "erlang_c"}
    body = client.get("/api/forecast", params=params).json()
    assert body["params"]["queue_model"] == "erlang_c"
    assert body["params"]["patience_sec"] is None and body["params"]["patience_source"] is None
    assert all(h["abandon_share"] is None for h in body["hours"])
    assert all(s["abandon_share"] is None for d in body["days"] for s in d["shifts"].values())
    assert body["window"]["expected_abandoned_calls"] is None and body["window"]["abandon_share"] is None
    # Erlang C hours equal staff_for_hour with no patience
    for row in body["hours"][:SAMPLE_HOURS]:
        expected = staff_for_hour(row["predicted_calls"], row["aht_sec"], EFFICIENCY, TARGET_PCT, 30)
        assert row["agents_required"] == expected["agents_required"]


def test_patience_override_changes_abandonment(client, forecast):
    params = {**THREE_DAYS, "efficiency": EFFICIENCY, "target_pct": TARGET_PCT, "patience_sec": 60}
    body = client.get("/api/forecast", params=params).json()
    assert body["params"]["patience_sec"] == 60
    assert body["params"]["patience_source"] == {"kind": "override"}
    assert body["window"]["expected_abandoned_calls"] != forecast["window"]["expected_abandoned_calls"]


@pytest.mark.parametrize("bad", [{"queue_model": "erlang_x"}, {"patience_sec": 0}, {"patience_sec": -5}])
def test_bad_queue_params_are_422(client, bad):
    assert client.get("/api/forecast", params={**THREE_DAYS, **bad}).status_code == 422


# ---- [API] additions for the operations console ----

def test_every_response_names_its_data_source(client, forecast):
    for body in (forecast, client.get("/api/staffing", params=THREE_DAYS).json(), client.get("/api/model").json()):
        source = body["data_source"]
        assert set(source) == SOURCE_KEYS
        assert source["kind"] in ("partner", "synthetic", "unlabeled")
        assert source["start"] <= source["end"]
        assert source["label"]


def test_recency_changes_handle_time_not_volume(client):
    params = {**THREE_DAYS, "efficiency": EFFICIENCY, "target_pct": TARGET_PCT}
    equal = client.get("/api/forecast", params={**params, "recency": "equal"}).json()
    weighted = client.get("/api/forecast", params={**params, "recency": "weighted"}).json()
    recent = client.get("/api/forecast", params={**params, "recency": "recent"}).json()
    assert [h["predicted_calls"] for h in equal["hours"]] == [h["predicted_calls"] for h in weighted["hours"]]
    assert equal["window"]["recency_effect_pct"] == 0.0
    for body in (weighted, recent):
        expected = (body["window"]["expected_talk_sec"] / equal["window"]["expected_talk_sec"] - 1) * 100
        assert math.isclose(body["window"]["recency_effect_pct"], expected, rel_tol=1e-9)
        assert body["window"]["recency"] == body["params"]["recency"]
    assert any(a["aht_sec"] != b["aht_sec"] for a, b in zip(equal["hours"], recent["hours"]))


def test_bad_recency_is_422(client):
    assert client.get("/api/forecast", params={**THREE_DAYS, "recency": "latest"}).status_code == 422


def test_excluding_holidays_changes_a_holiday_and_marks_it_still(client):
    # 2026-12-25 is in the holidays table
    params = {"start": "2026-12-25", "end": "2026-12-25"}
    with_h = client.get("/api/forecast", params=params).json()
    without = client.get("/api/forecast", params={**params, "include_holidays": "false"}).json()
    assert with_h["days"][0]["holiday"] and without["days"][0]["holiday"]
    assert without["params"]["include_holidays"] is False
    assert with_h["window"]["expected_calls"] != without["window"]["expected_calls"]


def test_one_fewer_person_raises_abandonment(forecast):
    window = forecast["window"]
    assert window["expected_abandoned_one_fewer"] > window["expected_abandoned_calls"]


def test_one_fewer_is_none_under_erlang_c(client):
    body = client.get("/api/forecast", params={**THREE_DAYS, "queue_model": "erlang_c"}).json()
    assert body["window"]["expected_abandoned_one_fewer"] is None


def test_planned_roster_verdicts_and_consequences(client, forecast):
    day = forecast["days"][0]
    rec = {name: day["shifts"][name]["staff_needed"] for name in SHIFT_ORDER}
    body = {
        **THREE_DAYS, "efficiency": EFFICIENCY, "target_pct": TARGET_PCT,
        "planned": [
            {"date": day["date"], "shift": "Day", "planned": rec["Day"]},
            {"date": day["date"], "shift": "Evening", "planned": max(rec["Evening"] - 1, 0)},
            {"date": day["date"], "shift": "Overnight", "planned": rec["Overnight"] + 1},
            {"date": day["date"], "shift": "Day", "planned": MAX_STAFF_PER_SHIFT + 1},
        ],
    }
    response = client.post("/api/planned", json=body)
    assert response.status_code == 200, response.text
    shifts = response.json()["shifts"]
    assert [set(s) for s in shifts] == [PLANNED_KEYS] * 4
    on, under, over, beyond = shifts
    assert on["verdict"] == "on target" and on["delta"] == 0
    assert under["verdict"] == "understaffed" and under["delta"] == -1
    assert over["verdict"] == "overstaffed" and over["delta"] == 1
    assert beyond["verdict"] == "exceeds capacity"
    # the consequence: fewer people, lower service level, more hang-ups
    assert under["service_level_at_planned"] <= on["service_level_at_planned"] or under["shift"] != on["shift"]
    assert over["effective_agents"] == math.floor((rec["Overnight"] + 1) * EFFICIENCY)
    assert on["service_level_at_planned"] >= TARGET_PCT - 1e-9
    assert 0 <= on["abandon_share_at_planned"] <= 1


def test_planned_outside_window_is_400(client):
    body = {**THREE_DAYS, "planned": [{"date": "2026-11-01", "shift": "Day", "planned": 5}]}
    assert client.post("/api/planned", json=body).status_code == 400


def test_planned_bad_shift_is_422(client):
    body = {**THREE_DAYS, "planned": [{"date": THREE_DAYS["start"], "shift": "Night", "planned": 5}]}
    assert client.post("/api/planned", json=body).status_code == 422
