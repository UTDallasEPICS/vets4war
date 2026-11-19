"""Share of calls that are "real", per (dow, hour).

The client defines a real call as one with over 2 minutes of talk time with a
peer, measured by agent_sec. Time waiting in queue does not count, and
abandoned calls are never real. The share is taken over ALL offered calls, so
share x predicted calls gives predicted real calls.

    estimate_real_share(conn, halflife_days) -> {(dow, hour): share}

Weighted the same way as db.aht: a call `age` days before the newest call gets
weight 0.5 ** (age / halflife_days). Cells with too few calls fall back to the
overall weighted share. No ML here, and staffing does not use this number.

Keys cover every (dow 1..7, hour 0..23) so callers never miss a lookup.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from db.aht import DOWS, HOURS, MIN_CELL_CALLS

REAL_CALL_MIN_TALK_SEC = 120

# dow (1=Mon..7=Sun) and call_hour are derived in the query: the shared
# database has no generated columns and none are added.
REAL_COUNTS_SQL = """
    SELECT
        start_ts::date                      AS call_date,
        extract(isodow FROM start_ts)::int  AS dow,
        extract(hour FROM start_ts)::int    AS call_hour,
        count(*)::float                     AS n_calls,
        count(*) FILTER (WHERE NOT abandoned AND agent_sec > %(min_talk_sec)s)::float AS n_real
    FROM calls
    GROUP BY 1, 2, 3
"""


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


def estimate_real_share(conn, halflife_days: float | None) -> dict[tuple[int, int], float]:
    """Read the daily counts from `calls` (read-only) and build the share table."""
    if halflife_days is not None and halflife_days <= 0:
        raise ValueError(f"halflife_days must be > 0 or None, got {halflife_days}")
    with conn.cursor() as cur:
        cur.execute(REAL_COUNTS_SQL, {"min_talk_sec": REAL_CALL_MIN_TALK_SEC})
        columns = [d.name for d in cur.description]
        rows = cur.fetchall()
    counts = pd.DataFrame(rows, columns=columns)
    return real_share_table(counts.assign(call_date=pd.to_datetime(counts["call_date"])), halflife_days)
