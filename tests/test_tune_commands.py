"""The loop's commands end to end on a small hand-built series: baseline,
run, promote, hold-out, weeks, diagnose. Real (small) LightGBM fits, files
in a temp folder, no database and no client data."""

import json

import numpy as np
import pandas as pd
import pytest

import db.tune as tune
from db.backtest import weekly_origins
from db.features import build_features

HOURS = 24
HOLIDAYS = pd.DataFrame({"holiday_date": pd.to_datetime(["2026-05-25", "2026-07-04", "2026-09-07"]),
                         "holiday_name": ["Memorial Day", "Independence Day", "Labor Day"]})


def _context() -> tune.Context:
    """Jan to Oct 2026: evenings busier, weekends quieter, a slow rise, and a
    fixed wobble so no two weeks are identical."""
    hours = pd.date_range("2026-01-05", "2026-10-25 23:00", freq="h")
    day_number = (hours.normalize() - hours[0]).days.to_numpy()
    calls = (8.0 + 4.0 * (hours.hour >= 16) - 1.5 * (hours.dayofweek >= 5)) * (1 + 0.0005 * day_number)
    wobble = 1 + 0.08 * np.sin(day_number * 1.7) + 0.05 * np.cos(hours.hour.to_numpy() * 2.3 + day_number)
    featured = build_features(pd.DataFrame({"hour_start": hours, "offered": np.round(calls * wobble)}), HOLIDAYS)
    days = pd.DatetimeIndex(featured["hour_start"].dt.normalize().unique())
    origins = {"dev": weekly_origins(days, 3), "holdout": weekly_origins(days, 2, skip=3)}
    return tune.Context(featured=featured, special=frozenset(), origins=origins, workers=1)


@pytest.fixture(scope="module")
def context() -> tune.Context:
    return _context()


@pytest.fixture()
def run_dir(tmp_path, monkeypatch):
    """Point every file the commands write at a temp folder."""
    monkeypatch.setattr(tune, "LEDGER_PATH", tmp_path / "ledger.json")
    monkeypatch.setattr(tune, "INCUMBENT_PATH", tmp_path / "incumbent.json")
    monkeypatch.setattr(tune, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(tune, "BASE_RUN_DIR", tmp_path / "cache" / "base_runs")
    (tmp_path / "cache").mkdir()
    return tmp_path


def _ledger(run_dir) -> list[dict]:
    return json.loads((run_dir / "ledger.json").read_text())


def test_baseline_records_old_model_naive_oracle_and_floor_for_both_sets(context, run_dir):
    tune.command_baseline(context)

    entries = _ledger(run_dir)
    assert [(e["kind"], e["set"], e["origins"]) for e in entries] == [("baseline", "dev", 3), ("baseline", "holdout", 2)]
    assert [row["label"] for row in entries[0]["rows"]] == ["legacy", "seasonal naive", "hindsight oracle"]
    assert entries[0]["poisson_floor"]["daily_mape_1_14"] > 0
    assert len(list((run_dir / "cache").glob("legacy_dev_*.csv"))) == 1
    assert len(list((run_dir / "cache").glob("legacy_holdout_*.csv"))) == 1


def test_run_scores_every_candidate_of_a_family_against_the_old_model(context, run_dir):
    tune.command_run(context, "level_cap", "daily")

    entry = _ledger(run_dir)[-1]
    assert (entry["kind"], entry["experiment"], entry["incumbent"]) == ("experiment", "level_cap", "legacy")
    assert len(entry["rows"]) == 5
    assert all(row["verdict"] in ("accept", "reject") and "special_days" in row for row in entry["rows"])
    primary = [row["metrics"]["daily_mape_1_14"] for row in entry["rows"]]
    assert primary == sorted(primary)


def test_promote_then_hold_out_then_named_weeks_and_diagnosis(context, run_dir, capsys):
    tune.command_run(context, "level_cap", "daily")
    label = _ledger(run_dir)[-1]["rows"][0]["label"]

    tune.command_promote("level_cap", label, why="test promotion", override=True)
    tune.command_holdout(context)
    tune.command_weeks(context, [str(context.origins["dev"][-1].date())])
    tune.command_diagnose(context)
    tune.command_show()

    kinds = [entry["kind"] for entry in _ledger(run_dir)]
    assert kinds == ["experiment", "promote", "holdout", "weeks", "diagnose"]
    incumbent = json.loads((run_dir / "incumbent.json").read_text())
    assert (incumbent["experiment"], incumbent["label"]) == ("level_cap", label)
    holdout, weeks, diagnose = _ledger(run_dir)[2:]
    assert set(holdout["final"]) == set(holdout["legacy"])
    assert [row["model"] for row in weeks["rows"]] == ["legacy", "incumbent"]
    assert len(diagnose["models"]["incumbent"]["hour_bias_pct"]) == HOURS
    assert "promoted level_cap" in capsys.readouterr().out


def test_hold_out_refuses_to_run_before_anything_was_promoted(context, run_dir):
    with pytest.raises(ValueError, match="nothing has been promoted"):
        tune.command_holdout(context)


def test_promoting_a_label_that_is_not_a_candidate_raises(context, run_dir):
    tune.command_run(context, "level_cap", "daily")

    with pytest.raises(ValueError, match="no scored"):
        tune.command_promote("level_cap", "cap 99%", why="typo", override=True)


@pytest.mark.parametrize("argv", [["run"], ["promote", "level_cap"], ["weeks"]])
def test_commands_missing_their_arguments_exit_with_a_message(argv, run_dir):
    with pytest.raises(SystemExit) as stop:
        tune.main(argv)

    assert "needs" in str(stop.value)
