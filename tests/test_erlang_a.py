"""Tests for Erlang A (M/M/N+M) in db/erlang.py.

Pure math. The simulation check uses Python's `random` with a fixed seed;
it is a cross-check of the closed form, not a data source.

Run from the repo root:  python -m pytest tests/test_erlang_a.py -v
"""

import heapq
import math
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from db.erlang import erlang_a, erlang_c, required_agents  # noqa: E402

AHT = 600.0
PATIENCE = 400.0
TARGET_SEC = 30.0
HUGE_PATIENCE = 1e12            # Erlang A -> Erlang C limit
LIMIT_TOLERANCE = 1e-6
SIM_ARRIVALS = 200_000
SIM_TOLERANCE = 0.01            # absolute, on probabilities
SEED = 20260918


def erlang_c_service_level(agents, load, aht, t):
    return 1.0 - erlang_c(agents, load) * math.exp(-(agents - load) * t / aht)


@pytest.mark.parametrize("agents, load", [(2, 0.5), (3, 1.5), (8, 5.0), (12, 10.0)])
def test_infinite_patience_recovers_erlang_c(agents, load):
    a = erlang_a(agents, load, AHT, HUGE_PATIENCE, TARGET_SEC)
    assert math.isclose(a["wait_prob"], erlang_c(agents, load), abs_tol=LIMIT_TOLERANCE)
    assert math.isclose(a["service_level"], erlang_c_service_level(agents, load, AHT, TARGET_SEC), abs_tol=LIMIT_TOLERANCE)
    assert a["abandon_prob"] < LIMIT_TOLERANCE


@pytest.mark.parametrize("agents, load", [(1, 0.3), (2, 1.5), (4, 3.0), (6, 5.0), (3, 6.0)])
def test_probabilities_are_consistent(agents, load):
    a = erlang_a(agents, load, AHT, PATIENCE, TARGET_SEC)
    assert 0.0 <= a["abandon_prob"] <= a["wait_prob"] <= 1.0
    assert 0.0 <= a["service_level"] <= 1.0
    # answered within t + answered later + abandoned = 1, so SL <= 1 - abandon
    assert a["service_level"] <= 1.0 - a["abandon_prob"] + 1e-12


def test_more_agents_means_fewer_hangups_and_better_service():
    results = [erlang_a(n, 5.0, AHT, PATIENCE, TARGET_SEC) for n in range(1, 15)]
    for lower, higher in zip(results, results[1:]):
        assert higher["abandon_prob"] <= lower["abandon_prob"] + 1e-12
        assert higher["service_level"] >= lower["service_level"] - 1e-12
        assert higher["wait_prob"] <= lower["wait_prob"] + 1e-12


def test_less_patient_callers_abandon_more():
    patient = erlang_a(6, 5.0, AHT, 900.0, TARGET_SEC)
    impatient = erlang_a(6, 5.0, AHT, 60.0, TARGET_SEC)
    assert impatient["abandon_prob"] > patient["abandon_prob"]


def test_edge_cases():
    assert erlang_a(4, 0.0, AHT, PATIENCE, TARGET_SEC) == {"wait_prob": 0.0, "abandon_prob": 0.0, "service_level": 1.0}
    assert erlang_a(0, 2.0, AHT, PATIENCE, TARGET_SEC) == {"wait_prob": 1.0, "abandon_prob": 1.0, "service_level": 0.0}
    with pytest.raises(ValueError):
        erlang_a(3, 2.0, AHT, 0.0, TARGET_SEC)


def test_required_agents_with_patience_meets_target():
    n = required_agents(30, AHT, 0.80, TARGET_SEC, patience_sec=PATIENCE)
    assert n >= 1
    assert erlang_a(n, 5.0, AHT, PATIENCE, TARGET_SEC)["service_level"] >= 0.80
    if n > 1:
        assert erlang_a(n - 1, 5.0, AHT, PATIENCE, TARGET_SEC)["service_level"] < 0.80


def test_required_agents_without_patience_is_unchanged():
    assert required_agents(30, AHT, 0.80, TARGET_SEC) == 8
    assert required_agents(30, AHT, 0.80, TARGET_SEC, patience_sec=None) == 8


def simulate(agents, load, aht, patience, t, arrivals, seed):
    """Event-driven M/M/N+M. Returns (abandon share, answered-within-t share)."""
    rng = random.Random(seed)
    lam, mu, theta = load / aht, 1.0 / aht, 1.0 / patience
    clock, busy, queue = 0.0, 0, []             # queue: (deadline, arrival_time, id)
    events = []                                 # (time, kind, payload)
    next_id, abandoned, answered_in_t = 0, 0, 0
    heapq.heappush(events, (rng.expovariate(lam), "arrive", 0))
    served_or_lost = 0
    while served_or_lost < arrivals:
        clock, kind, payload = heapq.heappop(events)
        if kind == "arrive":
            next_id += 1
            if next_id <= arrivals:
                heapq.heappush(events, (clock + rng.expovariate(lam), "arrive", 0))
            if busy < agents:
                busy += 1
                answered_in_t += 1
                served_or_lost += 1
                heapq.heappush(events, (clock + rng.expovariate(mu), "done", 0))
            else:
                deadline = clock + rng.expovariate(theta)
                queue.append([deadline, clock, next_id])
                heapq.heappush(events, (deadline, "abandon", next_id))
        elif kind == "done":
            busy -= 1
            # drop callers whose deadline already passed, then serve the head
            queue = [q for q in queue if q[0] > clock]
            if queue:
                _, arrived, _ = queue.pop(0)
                busy += 1
                if clock - arrived <= t:
                    answered_in_t += 1
                served_or_lost += 1
                heapq.heappush(events, (clock + rng.expovariate(mu), "done", 0))
        else:  # abandon event fires for a caller still queued
            still = [q for q in queue if q[2] == payload]
            if still:
                queue = [q for q in queue if q[2] != payload]
                abandoned += 1
                served_or_lost += 1
    return abandoned / arrivals, answered_in_t / arrivals


@pytest.mark.parametrize("agents, load", [(3, 2.5), (6, 5.0)])
def test_closed_form_matches_simulation(agents, load):
    abandon_sim, sl_sim = simulate(agents, load, AHT, PATIENCE, TARGET_SEC, SIM_ARRIVALS, SEED)
    a = erlang_a(agents, load, AHT, PATIENCE, TARGET_SEC)
    assert math.isclose(a["abandon_prob"], abandon_sim, abs_tol=SIM_TOLERANCE), (a, abandon_sim)
    assert math.isclose(a["service_level"], sl_sim, abs_tol=SIM_TOLERANCE), (a, sl_sim)
