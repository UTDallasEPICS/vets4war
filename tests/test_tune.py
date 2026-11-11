"""The loop's bookkeeping: ledger, incumbent file, candidate table, promotion rule.

Hand-built prediction frames; no model fitting, no database.
"""

import numpy as np
import pandas as pd
import pytest

from db.experiments import legacy_equivalent
from db.tune import (
    append_ledger,
    best_accepted,
    check_promotable,
    current_config,
    experiment_rows,
    first_week_report,
    read_incumbent,
    read_ledger,
    write_incumbent,
)

HOURS = 24
ORIGINS = pd.to_datetime(["2026-06-02", "2026-06-09", "2026-06-16", "2026-06-23"])


def _predictions(scale: float) -> pd.DataFrame:
    """Error alternates by day, differs by week, and grows with `scale`."""
    parts = []
    for origin in ORIGINS:
        hours = pd.date_range(origin + pd.Timedelta(days=1), periods=28 * HOURS, freq="h")
        horizon_day = (np.arange(28 * HOURS) // HOURS) + 1
        sign = np.where(hours.dayofweek % 2 == 0, 1.0, -1.0)
        week = (horizon_day - 1) // 7 + 1
        parts.append(pd.DataFrame({"origin": origin, "hour_start": hours, "horizon_day": horizon_day,
                                   "actual": 10.0, "predicted": 10.0 * (1 + sign * scale * (0.04 + 0.002 * week))}))
    return pd.concat(parts, ignore_index=True)


# ---- ledger and incumbent --------------------------------------------------------

def test_ledger_keeps_every_entry_in_the_order_written(tmp_path):
    path = tmp_path / "run" / "ledger.json"

    append_ledger(path, {"kind": "baseline", "note": "first"})
    append_ledger(path, {"kind": "experiment", "note": "second"})

    assert [entry["note"] for entry in read_ledger(path)] == ["first", "second"]
    assert all("at" in entry for entry in read_ledger(path))


def test_a_missing_ledger_reads_as_empty(tmp_path):
    assert read_ledger(tmp_path / "ledger.json") == []


def test_incumbent_round_trip_and_default(tmp_path):
    path = tmp_path / "incumbent.json"
    config = legacy_equivalent()

    assert read_incumbent(path) is None
    assert current_config(None) == config

    write_incumbent(path, config, label="single fit", experiment="level_single_fit")
    record = read_incumbent(path)

    assert current_config(record) == config
    assert (record["label"], record["experiment"]) == ("single fit", "level_single_fit")


# ---- candidate table ----------------------------------------------------------------

def test_rows_carry_metrics_verdicts_and_come_best_first():
    offered = [("worse", legacy_equivalent()), ("better", legacy_equivalent())]
    forecasts = {"worse": _predictions(1.2), "better": _predictions(0.8)}

    rows = experiment_rows(offered, incumbent=_predictions(1.0), evaluate=lambda label, config: forecasts[label])

    assert [row["label"] for row in rows] == ["better", "worse"]
    assert [row["verdict"] for row in rows] == ["accept", "reject"]
    assert rows[0]["delta_pct"]["daily_mape_1_14"] == pytest.approx(-20.0)
    assert rows[0]["config"] == legacy_equivalent().to_dict()


def test_rows_report_the_error_on_holiday_type_days_when_asked():
    offered = [("same", legacy_equivalent())]
    special = frozenset({pd.Timestamp("2026-06-10"), pd.Timestamp("2026-06-19")})

    rows = experiment_rows(offered, incumbent=_predictions(1.0), special=special,
                           evaluate=lambda label, config: _predictions(1.0))

    assert rows[0]["special_days"]["days"] > 0
    assert rows[0]["special_days"]["daily_mape"] > 0


def test_best_accepted_is_the_accepted_row_with_the_lowest_primary_metric():
    rows = [
        {"label": "a", "verdict": "accept", "metrics": {"daily_mape_1_14": 9.5}},
        {"label": "b", "verdict": "accept", "metrics": {"daily_mape_1_14": 9.2}},
        {"label": "c", "verdict": "reject", "metrics": {"daily_mape_1_14": 9.0}},
    ]

    assert best_accepted(rows)["label"] == "b"
    assert best_accepted([rows[2]]) is None


# ---- promotion rule -----------------------------------------------------------------

LEDGER = [{"kind": "experiment", "experiment": "level_window",
           "rows": [{"label": "28 days", "verdict": "accept"}, {"label": "7 days", "verdict": "reject"}]}]


def test_an_accepted_candidate_can_be_promoted():
    check_promotable(LEDGER, "level_window", "28 days", override=False)


def test_a_rejected_candidate_cannot_be_promoted_without_an_override():
    with pytest.raises(ValueError, match="rejected"):
        check_promotable(LEDGER, "level_window", "7 days", override=False)
    check_promotable(LEDGER, "level_window", "7 days", override=True)


def test_a_candidate_that_was_never_scored_cannot_be_promoted():
    with pytest.raises(ValueError, match="no scored"):
        check_promotable(LEDGER, "level_window", "56 days", override=True)


# ---- one named week ------------------------------------------------------------------

def test_first_week_report_gives_the_client_numbers_for_one_origin():
    predictions = _predictions(1.0)
    origin = ORIGINS[1]

    report = first_week_report(predictions, origin)

    week = predictions[(predictions["origin"] == origin) & (predictions["horizon_day"] <= 7)]
    assert report["first_day"] == "2026-06-10" and report["last_day"] == "2026-06-16"
    assert report["actual_calls"] == 7 * HOURS * 10
    assert report["predicted_calls"] == pytest.approx(week["predicted"].sum())
    assert 80 < report["daily_accuracy_pct"] < 100
    assert report["hourly_mae"] == pytest.approx((week["predicted"] - week["actual"]).abs().mean())


def test_first_week_report_refuses_an_origin_that_was_not_scored():
    with pytest.raises(ValueError, match="not among"):
        first_week_report(_predictions(1.0), pd.Timestamp("2026-01-06"))


def test_a_hold_out_look_never_makes_a_candidate_promotable():
    ledger = [{"kind": "experiment", "experiment": "target_clip", "set": "holdout",
               "rows": [{"label": "z=4", "verdict": "accept"}]}]

    with pytest.raises(ValueError, match="no scored"):
        check_promotable(ledger, "target_clip", "z=4", override=True)
