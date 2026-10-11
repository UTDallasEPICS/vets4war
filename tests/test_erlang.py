"""Tests for db/erlang.py.

Run from the repo root:  python -m pytest tests/test_erlang.py -v
"""

import os
import sys

import pytest

# Make `db` importable without packaging the repo.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from db.erlang import erlang_c, required_agents  # noqa: E402


def test_zero_calls_returns_zero_agents():
    # Arrange / Act
    agents = required_agents(calls_per_hour=0, aht_sec=600)

    # Assert
    assert agents == 0


def test_required_agents_monotonic_in_calls_per_hour():
    # Arrange
    volumes = [1, 5, 10, 20, 30, 45, 60, 90, 120]

    # Act
    results = [required_agents(v, 600, 0.80, 30) for v in volumes]

    # Assert: never fewer agents for more calls
    for lower, higher in zip(results, results[1:]):
        assert higher >= lower, results


def test_required_agents_monotonic_in_target_pct():
    # Arrange
    targets = [0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95]

    # Act
    results = [required_agents(30, 600, t, 30) for t in targets]

    # Assert: a stricter target never needs fewer agents
    for lower, higher in zip(results, results[1:]):
        assert higher >= lower, results


@pytest.mark.parametrize(
    "agents, load",
    [
        (1, 0.1),
        (2, 1.5),
        (5, 4.9),
        (6, 5.0),
        (10, 2.0),
        (50, 40.0),
        (3, 3.0),   # unstable: agents == load
        (2, 5.0),   # unstable: agents < load
        (4, 0.0),   # no load
    ],
)
def test_erlang_c_in_unit_interval(agents, load):
    # Act
    prob = erlang_c(agents, load)

    # Assert
    assert 0.0 <= prob <= 1.0


def test_required_agents_known_case():
    # Arrange: 30 calls/hr, 10-minute AHT, 80% within 30 s -> load 5.0 erlangs.
    # Service level by agent count under the stated formula:
    #   N=6 -> 0.441, N=7 -> 0.707, N=8 -> 0.856. First >= 0.80 is 8.
    # Act
    agents = required_agents(30, 600, 0.80, 30)

    # Assert
    assert agents == 8
