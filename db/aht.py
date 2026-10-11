"""Average handle time (AHT) per (dow, hour), from answered calls only.

Answered calls recorded with zero agent time (about 1.2% of the real data,
mostly 2021 to 2023) are excluded here: they carry no handle-time
information and would pull the mean down. They still count as calls
everywhere else (volume, service level, patience).

    estimate_aht(conn, halflife_days=365) -> {(dow, hour): agent_sec}
    RECENCY_HALFLIFE_DAYS                  -> the three presets the UI offers

Exponentially weighted mean: a call `age` days before the newest call in
the table gets weight 0.5 ** (age / halflife_days), so last year's calls
count about half as much as this year's. Cells with too few answered calls
fall back to the global weighted mean. No ML here.

Keys cover every (dow 1..7, hour 0..23) so callers never miss a lookup.
Connection comes from $V4W_DATABASE_URL (same pattern as db/load_calls.py).
"""

from __future__ import annotations

import sys

import numpy as np
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg
except ImportError:
    sys.exit("psycopg is required:  pip install 'psycopg[binary]'")

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

# dow (1=Mon..7=Sun) and call_hour are derived in the query: the shared
# database has no generated columns and none are added.
ANSWERED_CALLS_SQL = """
    SELECT
        start_ts::date                      AS call_date,
        extract(isodow FROM start_ts)::int  AS dow,
        extract(hour FROM start_ts)::int    AS call_hour,
        agent_sec::float                    AS agent_sec
    FROM calls
    WHERE NOT abandoned
      AND agent_sec > 0
"""


def _load_answered(conn) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(ANSWERED_CALLS_SQL)
        columns = [d.name for d in cur.description]
        rows = cur.fetchall()
    df = pd.DataFrame(rows, columns=columns)
    if df.empty:
        raise ValueError("no answered calls with agent_sec > 0 in `calls`; cannot estimate AHT")
    df["call_date"] = pd.to_datetime(df["call_date"])
    return df


def _recency_weights(call_date: pd.Series, halflife_days: float | None) -> np.ndarray:
    """halflife None = every call weighs 1.0 (equal weighting)."""
    if halflife_days is None:
        return np.ones(len(call_date))
    age_days = (call_date.max() - call_date).dt.days.to_numpy()
    return np.power(0.5, age_days / halflife_days)


def estimate_aht(conn, halflife_days: float | None = DEFAULT_HALFLIFE_DAYS) -> dict[tuple[int, int], float]:
    """Exponentially weighted mean agent_sec per (dow, hour) over answered
    calls. halflife_days None = unweighted mean."""
    if halflife_days is not None and halflife_days <= 0:
        raise ValueError(f"halflife_days must be > 0 or None, got {halflife_days}")

    calls = _load_answered(conn)
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
