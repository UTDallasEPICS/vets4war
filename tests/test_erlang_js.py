"""Parity test: web/erlang.js must reproduce db/staffing.staff_for_hour.

The page recomputes staffing client-side on slider moves, so the JS port is
a deliberate duplicate of the Python math. This test runs the port under
node over a grid of inputs and compares every field. Skips if node is not
installed.

Run from the repo root:  python -m pytest tests/test_erlang_js.py -v
"""

import json
import math
import os
import shutil
import subprocess
import sys
from itertools import product

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from db.staffing import staff_for_hour  # noqa: E402

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
JS_PATH = os.path.join(REPO_ROOT, "web", "erlang.js")

CALLS = (0, 0.5, 1, 2.5, 5, 10, 30, 60)
AHT_SEC = (300, 600, 936, 1200)
EFFICIENCY = (0, 0.01, 0.2, 0.65, 1.0)
TARGET_PCT = (0.80, 0.90, 0.95)
TARGET_SEC = (20, 30, 45)
PATIENCE_SEC = (None, 60, 400)    # None = Erlang C
FLOAT_TOLERANCE = 1e-9   # uniformization sums differ in the last digits between libm and V8

FIELD_MAP = {  # JS/API name -> Python key
    "load_erlangs": "offered_load_erlangs",
    "agents_required": "agents_required",
    "staff_to_schedule": "scheduled_needed",
    "effective_agents": "effective_agents",
    "service_level_delivered": "service_level_at_scheduled",
    "over_cap": "capped",
    "implausible": "implausible",
    "reason": "reason",
    "abandon_share": "abandon_share",
    "queue_model": "queue_model",
}

NODE_RUNNER = """
const V4W = require(process.argv[1]);
let input = "";
process.stdin.on("data", (c) => input += c);
process.stdin.on("end", () => {
  const cases = JSON.parse(input);
  const out = cases.map((c) => V4W.staffForHour(c.calls, c.aht, c.efficiency, c.target_pct, c.target_sec, c.patience_sec));
  process.stdout.write(JSON.stringify(out));
});
"""


@pytest.fixture(scope="module")
def js_results():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed; cannot run the JS parity test")
    cases = [
        {"calls": c, "aht": a, "efficiency": e, "target_pct": p, "target_sec": t, "patience_sec": q}
        for c, a, e, p, t, q in product(CALLS, AHT_SEC, EFFICIENCY, TARGET_PCT, TARGET_SEC, PATIENCE_SEC)
    ]
    completed = subprocess.run(
        [node, "-e", NODE_RUNNER, os.path.abspath(JS_PATH)],
        input=json.dumps(cases), capture_output=True, text=True, check=True,
    )
    return cases, json.loads(completed.stdout)


def test_grid_is_large_enough(js_results):
    cases, results = js_results
    assert len(cases) == len(results) == (len(CALLS) * len(AHT_SEC) * len(EFFICIENCY) * len(TARGET_PCT)
                                           * len(TARGET_SEC) * len(PATIENCE_SEC))


def test_js_matches_python_on_every_field(js_results):
    cases, results = js_results
    mismatches = []
    for case, js in zip(cases, results):
        py = staff_for_hour(case["calls"], case["aht"], case["efficiency"], case["target_pct"], case["target_sec"],
                            case["patience_sec"])
        for js_key, py_key in FIELD_MAP.items():
            a, b = js[js_key], py[py_key]
            same = (
                math.isclose(a, b, rel_tol=FLOAT_TOLERANCE, abs_tol=FLOAT_TOLERANCE)
                if isinstance(b, float) and a is not None else a == b
            )
            if not same:
                mismatches.append((case, js_key, a, b))
    assert mismatches == [], f"{len(mismatches)} mismatches, first: {mismatches[:5]}"
