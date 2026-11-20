"""Python side of parity rung P1: the staffing arithmetic of the forecast package.

Reads one JSON object on stdin

    {"staff_for_hour": [...], "erlang_a": [...], "erlang_c": [...],
     "planned_outcome": [...], "verdict": [...], "schedule_people": [...]}

and prints one JSON object with the same keys holding the results of
db.staffing.staff_for_hour, db.erlang.erlang_a, db.erlang.erlang_c,
db.staffing.planned_outcome, db.staffing.verdict and db.staffing.schedule_people,
case by case. A case that raises gives {"error": "<type>: <message>"} instead.

Run by tests/parity/staffing/staffing.parity.test.ts with forecast/.venv/bin/python.
"""

import json
import sys
from pathlib import Path

FORECAST_ROOT = Path(__file__).resolve().parents[3] / "forecast"
sys.path.insert(0, str(FORECAST_ROOT))

import pandas as pd  # noqa: E402

from db.erlang import erlang_a, erlang_c  # noqa: E402
from db.staffing import planned_outcome, schedule_people, staff_for_hour, verdict  # noqa: E402


def _guarded(fn, case):
    try:
        return fn(case)
    except ValueError as error:
        return {"error": f"{type(error).__name__}: {error}"}


def _staff_for_hour(c):
    return staff_for_hour(c["calls"], c["aht"], c["efficiency"], c["target_pct"],
                          c["target_sec"], c["patience_sec"], cap=c["cap"])


def _erlang_a(c):
    return erlang_a(c["agents"], c["load"], c["aht"], c["patience"], c["target"])


def _erlang_c(c):
    return erlang_c(c["agents"], c["load"])


def _planned_outcome(c):
    hours = pd.DataFrame({
        "offered_load_erlangs": [r["load_erlangs"] for r in c["rows"]],
        "predicted_aht_sec": [r["aht_sec"] for r in c["rows"]],
    })
    return planned_outcome(hours, c["planned"], c["efficiency"], c["target_sec"], c["patience_sec"])


def _verdict(c):
    return verdict(c["planned"], c["recommended"], c["cap"])


def _schedule_people(c):
    return list(schedule_people(c["agents"], c["efficiency"]))


HANDLERS = {
    "staff_for_hour": _staff_for_hour,
    "erlang_a": _erlang_a,
    "erlang_c": _erlang_c,
    "planned_outcome": _planned_outcome,
    "verdict": _verdict,
    "schedule_people": _schedule_people,
}


def main() -> None:
    request = json.load(sys.stdin)
    result = {
        name: [_guarded(handler, case) for case in request.get(name, [])]
        for name, handler in HANDLERS.items()
    }
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
