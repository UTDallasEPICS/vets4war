"""Mean caller patience, estimated from the calls table.

    patience_from_calls(calls) -> dict: patience_sec, n_abandoned, n_calls
    estimate_patience(conn)    -> the same, from the database's calls
    cached_patience(conn)      -> estimate_patience, once per data revision

Patience is modelled as exponential (the Erlang A assumption). Every call
gives one observation: an abandoned call waited exactly `abandon_sec`
before hanging up; an answered call waited `in_queue_sec` and would have
hung up later (right-censored). The maximum-likelihood estimate of the
mean under right censoring is

    total waiting time of all calls / number of abandoned calls

A missing waiting time is left out of the total (as SQL's SUM does); the
call still counts in n_calls. No ML here.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from db import store


def patience_from_calls(calls: pd.DataFrame) -> dict:
    """Censored-exponential MLE of mean patience in seconds, with the counts
    it came from so the UI can say where the number comes from."""
    n_calls = len(calls)
    if not n_calls:
        raise ValueError("no rows in `calls`; cannot estimate patience")
    abandoned = calls["abandoned"].to_numpy(dtype=bool)
    n_abandoned = int(abandoned.sum())
    if not n_abandoned:
        raise ValueError("no abandoned calls in `calls`; mean patience is unidentifiable")
    waits = pd.Series(np.where(abandoned, calls["abandon_sec"], calls["in_queue_sec"]), dtype="float64")
    total_wait_sec = waits.sum(min_count=1)          # NaN only when every wait is missing
    if pd.isna(total_wait_sec) or total_wait_sec <= 0:
        raise ValueError("calls have no waiting time recorded; cannot estimate patience")
    return {
        "patience_sec": float(total_wait_sec) / n_abandoned,
        "n_abandoned": n_abandoned,
        "n_calls": int(n_calls),
    }


def estimate_patience(conn) -> dict:
    """patience_from_calls over every call in the database."""
    return patience_from_calls(store.read_snapshot(conn).calls)


# Process-wide cache, replaced wholesale when the data revision changes
# (every import that changes `calls` bumps it).
_cache: dict = {"revision": None, "value": None}


def cached_patience(conn) -> dict:
    global _cache
    revision = store.calls_revision(conn)
    if _cache["revision"] != revision or _cache["value"] is None:
        _cache = {"revision": revision, "value": estimate_patience(conn)}
    return _cache["value"]
