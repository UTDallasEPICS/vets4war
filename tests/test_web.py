"""Tests for the dashboard's pure logic (web/logic.js) and its stylesheet.

Runs tests/web_checks.js under node and asserts on what it prints. Covers
the four behaviours the rebuild promised: the three cap states render
distinctly, planned-roster values survive a reload, the CSV export has the
expected header, and a recompute on the 168-hour grid stays under budget.
Skips if node is not installed.

Run from the repo root:  python -m pytest tests/test_web.py -v
"""

import json
import os
import shutil
import subprocess

import pytest

CHECKS = os.path.join(os.path.dirname(__file__), "web_checks.js")
RECOMPUTE_BUDGET_MS = 50
HOURS_IN_WEEK = 168
EXPECTED_HEADER = ("date,hour,shift,predicted_calls,aht_sec,load_erlangs,agents_required,staff_to_schedule,"
                   "effective_agents,service_level_delivered,abandon_share,cap_state,service_level_if_capped,"
                   "planned_shift_staff,verdict,service_level_at_planned")


@pytest.fixture(scope="module")
def checks():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed; cannot run the web logic checks")
    completed = subprocess.run([node, CHECKS], capture_output=True, text=True, check=True)
    return json.loads(completed.stdout)


def test_three_cap_states_are_distinct_and_each_has_a_style(checks):
    states = checks["capStates"]
    assert states == {"under": "under", "at": "at", "over": "over", "undef": "undef"}
    assert len({states["under"], states["at"], states["over"]}) == 3
    assert all(n >= 1 for n in checks["capCssRules"]), checks["capCssRules"]
    assert checks["legendEntries"] == 3


def test_planned_roster_persists_across_a_simulated_reload(checks):
    assert checks["persisted"] == {"day": 6, "evening": 9, "missing": None}
    assert checks["cleared"] is None


def test_planned_store_survives_broken_or_missing_storage(checks):
    assert checks["throwingStorage"] == {"get": 4, "size": 1}
    assert checks["nullStorage"] is None


def test_csv_export_has_header_and_one_line_per_hour(checks):
    csv = checks["csv"]
    assert csv["nonEmpty"]
    assert csv["header"] == EXPECTED_HEADER
    assert csv["lineCount"] == HOURS_IN_WEEK + 1
    assert csv["sampleRow"].startswith("2026-10-05,0,Overnight,")


def test_recompute_on_168_hour_grid_is_under_budget(checks):
    assert checks["gridHours"] == HOURS_IN_WEEK
    assert checks["recomputeMs"] < RECOMPUTE_BUDGET_MS, f"{checks['recomputeMs']:.1f} ms"


def test_discrete_scale_has_one_step_per_integer(checks):
    scale = checks["scale"]
    assert scale["steps"] == scale["hi"] - scale["lo"] + 1


def test_verdicts_and_consequences(checks):
    assert checks["verdictCases"] == {"under": "understaffed", "on": "on target", "over": "overstaffed", "beyond": "exceeds capacity"}
    assert checks["sampleVerdict"] == "on target"
    assert checks["plannedFewerLowersServiceLevel"] is True
    assert checks["oneFewerRaises"] is True


def test_period_report_covers_the_selected_window_and_matches_the_page_totals(checks):
    report = checks["report"]
    assert report["isDocument"]
    assert report["hasPeriod"]
    assert report["dayRows"] == 7
    assert report["totalCalls"] == report["expectedCalls"]
    assert report["totalPersonHours"] == report["expectedPersonHours"]
    assert report["holidayShown"]


def test_period_report_escapes_text_from_the_server(checks):
    assert checks["report"]["escaped"]


def test_period_report_shows_undefined_staffing_as_a_dash_not_a_number(checks):
    assert checks["reportUndefined"] == "-"


def test_period_report_refuses_an_empty_window(checks):
    assert checks["reportEmptyError"] == "no forecast hours in the selected period"


def test_evening_cap_is_six_and_others_seven(checks):
    caps = checks["caps"]
    assert caps["byHour"] == [7, 7, 6, 6]
    assert caps["eveningSevenVerdict"] == "exceeds capacity"
    assert caps["daySevenVerdict"] == "on target"
    assert caps["eveningHoursCarryCap"] is True
    assert caps["eveningShiftCap"] == 6


def test_current_roster_outcome_moves_the_right_way(checks):
    roster = checks["roster"]
    assert roster["callsMatch"] and roster["inRange"]
    assert roster["fewerHangups"] and roster["betterService"]
    assert roster["undefinedAtZeroEfficiency"] is None


def test_staff_tradeoff_table_runs_to_the_cap_and_moves_the_right_way(checks):
    t = checks["tradeoff"]
    assert t["rows"] == [1, 2, 3, 4, 5, 6]          # Evening: 1 up to its cap of 6
    assert t["lostFallsWithStaff"] and t["serviceRisesWithStaff"]
    assert t["partsAddUp"]                          # lost + in time + late = calls
    assert t["coreCallsOnly"]                       # each call counted once
    assert t["plannedHasTotals"]
    assert t["undefinedAtZeroEfficiency"] is None
