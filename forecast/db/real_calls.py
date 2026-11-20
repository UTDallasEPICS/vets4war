"""Share of calls that are "real", per (dow, hour).

The client defines a real call as one with over 2 minutes of talk time with a
peer, measured by agent_sec. Time waiting in queue does not count, and
abandoned calls are never real. The share is taken over ALL offered calls, so
share x predicted calls gives predicted real calls.

    real_counts(calls)                        -> n_calls, n_real per (call_date, dow, call_hour)
    real_share_table(counts, halflife_days)   -> {(dow, hour): share}
    estimate_real_share(conn, halflife_days)  -> the same, from the database's calls

Weighted the same way as db.aht: a call `age` days before the newest call (of
ALL calls, abandoned ones included) gets
weight 0.5 ** (age / halflife_days). Cells with too few calls fall back to the
overall weighted share. No ML here, and staffing does not use this number.

Keys cover every (dow 1..7, hour 0..23) so callers never miss a lookup.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from db import store
from db.aht import DOWS, HOURS, MIN_CELL_CALLS

REAL_CALL_MIN_TALK_SEC = 120

def _age_weights(call_date: pd.Series, halflife_days: float | None) -> np.ndarray:
    if halflife_days is None:
        return np.ones(len(call_date))
    age_days = (call_date.max() - call_date).dt.days.to_numpy()
    return np.power(0.5, age_days / halflife_days)


def real_share_table(counts: pd.DataFrame, halflife_days: float | None) -> dict[tuple[int, int], float]:
    """counts: call_date, dow, call_hour, n_calls, n_real, one row per date and hour."""
    if counts.empty or counts["n_calls"].sum() == 0:
        raise ValueError("no calls in `calls`; cannot estimate the real-call share")

    weights = _age_weights(counts["call_date"], halflife_days)
    weighted = counts.assign(w_calls=weights * counts["n_calls"], w_real=weights * counts["n_real"])
    overall = float(weighted["w_real"].sum() / weighted["w_calls"].sum())
    cells = weighted.groupby(["dow", "call_hour"])[["n_calls", "w_calls", "w_real"]].sum()

    def share(cell: tuple[int, int]) -> float:
        if cell not in cells.index or cells.loc[cell, "n_calls"] < MIN_CELL_CALLS:
            return overall
        return float(cells.loc[cell, "w_real"] / cells.loc[cell, "w_calls"])

    return {(dow, hour): share((dow, hour)) for dow in DOWS for hour in HOURS}


def real_counts(calls: pd.DataFrame) -> pd.DataFrame:
    """call_date, dow (ISO), call_hour, n_calls, n_real (floats): one row per
    date and hour that has calls. Real = answered with agent_sec over
    REAL_CALL_MIN_TALK_SEC (a missing agent_sec is not real)."""
    start = calls["start_ts"]
    per_call = pd.DataFrame({
        "call_date": start.dt.normalize(),
        "dow": start.dt.isocalendar().day.astype("int64"),
        "call_hour": start.dt.hour.astype("int64"),
        "n_calls": 1.0,
        "n_real": (~calls["abandoned"] & (calls["agent_sec"] > REAL_CALL_MIN_TALK_SEC)).astype("float64"),
    })
    return per_call.groupby(["call_date", "dow", "call_hour"], as_index=False)[["n_calls", "n_real"]].sum()


def estimate_real_share(conn, halflife_days: float | None) -> dict[tuple[int, int], float]:
    """real_share_table over every call in the database (read-only)."""
    if halflife_days is not None and halflife_days <= 0:
        raise ValueError(f"halflife_days must be > 0 or None, got {halflife_days}")
    return real_share_table(real_counts(store.read_snapshot(conn).calls), halflife_days)
