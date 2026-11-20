"""Average handle time (AHT) per (dow, hour), from answered calls only.

Answered calls recorded with zero agent time (about 1.2% of the real data,
mostly 2021 to 2023) are excluded here: they carry no handle-time
information and would pull the mean down. They still count as calls
everywhere else (volume, service level, patience).

    aht_from_calls(calls, halflife_days=365) -> {(dow, hour): agent_sec}
    estimate_aht(conn, halflife_days=365)    -> the same, from the database's calls
    RECENCY_HALFLIFE_DAYS                    -> the three presets the UI offers

Exponentially weighted mean: a call `age` days before the newest call in
those answered calls gets weight 0.5 ** (age / halflife_days), so last year's calls
count about half as much as this year's. Cells with too few answered calls
fall back to the global weighted mean. No ML here.

Keys cover every (dow 1..7, hour 0..23) so callers never miss a lookup.
dow is ISO (1 = Monday), hour 0..23, both from the naive Eastern start time.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from db import store

DEFAULT_HALFLIFE_DAYS = 365

# The partner asked (2026-09-02) to choose how much recent calls count.
# "equal" weights every call the same (halflife None); "weighted" is the
# default one-year halflife; "recent" at 90 days makes last quarter dominate.
RECENCY_HALFLIFE_DAYS: dict[str, float | None] = {
    "equal": None,
    "weighted": DEFAULT_HALFLIFE_DAYS,
    "recent": 90,
}
DEFAULT_RECENCY = "weighted"
RECENCY_OPTIONS = tuple(RECENCY_HALFLIFE_DAYS)

# Below this many answered calls a cell's own mean is too noisy to trust.
MIN_CELL_CALLS = 30

DOWS = range(1, 8)
HOURS = range(24)

def answered_calls(calls: pd.DataFrame) -> pd.DataFrame:
    """call_date, dow (ISO), call_hour, agent_sec of the answered calls with
    talk time (agent_sec > 0; a missing agent_sec is not > 0)."""
    answered = calls[~calls["abandoned"] & (calls["agent_sec"] > 0)]
    start = answered["start_ts"]
    return pd.DataFrame({
        "call_date": start.dt.normalize(),
        "dow": start.dt.isocalendar().day.astype("int64"),
        "call_hour": start.dt.hour.astype("int64"),
        "agent_sec": answered["agent_sec"].astype("float64"),
    }).reset_index(drop=True)


def _recency_weights(call_date: pd.Series, halflife_days: float | None) -> np.ndarray:
    """halflife None = every call weighs 1.0 (equal weighting)."""
    if halflife_days is None:
        return np.ones(len(call_date))
    age_days = (call_date.max() - call_date).dt.days.to_numpy()
    return np.power(0.5, age_days / halflife_days)


def aht_from_calls(calls: pd.DataFrame,
                   halflife_days: float | None = DEFAULT_HALFLIFE_DAYS) -> dict[tuple[int, int], float]:
    """Exponentially weighted mean agent_sec per (dow, hour) over answered
    calls (calls: the db.store.Snapshot frame). halflife_days None =
    unweighted mean."""
    if halflife_days is not None and halflife_days <= 0:
        raise ValueError(f"halflife_days must be > 0 or None, got {halflife_days}")

    calls = answered_calls(calls)
    if calls.empty:
        raise ValueError("no answered calls with agent_sec > 0 in `calls`; cannot estimate AHT")
    weights = _recency_weights(calls["call_date"], halflife_days)

    weighted = calls.assign(
        w=weights,
        w_sec=weights * calls["agent_sec"].to_numpy(),
    )
    global_mean = float(weighted["w_sec"].sum() / weighted["w"].sum())

    cells = weighted.groupby(["dow", "call_hour"]).agg(
        n=("agent_sec", "size"),
        w=("w", "sum"),
        w_sec=("w_sec", "sum"),
    )

    result = {}
    for dow in DOWS:
        for hour in HOURS:
            if (dow, hour) in cells.index and cells.loc[(dow, hour), "n"] >= MIN_CELL_CALLS:
                cell = cells.loc[(dow, hour)]
                result[(dow, hour)] = float(cell["w_sec"] / cell["w"])
            else:
                result[(dow, hour)] = global_mean
    return result


def estimate_aht(conn, halflife_days: float | None = DEFAULT_HALFLIFE_DAYS) -> dict[tuple[int, int], float]:
    """aht_from_calls over every call in the database."""
    return aht_from_calls(store.read_snapshot(conn).calls, halflife_days)
