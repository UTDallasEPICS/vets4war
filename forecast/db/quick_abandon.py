"""How many hang-ups happen too fast for staffing to matter.

    quick_hangups_from_calls(calls, threshold_sec, window_days)
        -> dict: threshold_sec, window_days, first_day, last_day, n_calls,
                 n_abandoned, n_quick, quick_share_of_abandoned, quick_share_of_calls
    measure_quick_hangups(conn, threshold_sec, window_days) -> the same, from the database
    quick_hangups(conn)                                     -> the defaults, once per data revision

A quick hang-up = an abandoned call whose abandon_sec is under
QUICK_HANGUP_SEC. The partner reports abandonment two ways (Oct 14-20 2026
file: 14.3% all, 6.6% after 10 seconds); the difference is these calls.
In that week 40% of abandoned callers hung up within 5 s, before any queue
could have answered them.

Shown on the dashboard as context next to the model's expected hang-ups.
NOT added to them: the Erlang A patience estimate already learned from every
abandoned call, and at the partner's real roster the model's total (13.5%)
already matched the actual 14.3%. Adding these on top would double count.

Measured over the last WINDOW_DAYS days of data, anchored on the newest call
(not today), so a reporting gap does not empty the window: every call that
started strictly after newest - WINDOW_DAYS days, to the second.
"""

from __future__ import annotations

import pandas as pd

from db import store

QUICK_HANGUP_SEC = 10
WINDOW_DAYS = 90


def _share(part: int, whole: int) -> float | None:
    return part / whole if whole else None


def quick_hangups_from_calls(calls: pd.DataFrame, threshold_sec: int = QUICK_HANGUP_SEC,
                             window_days: int = WINDOW_DAYS) -> dict:
    """The quick hang-up counts of the last `window_days` days of `calls`
    (the db.store.Snapshot frame)."""
    if calls.empty:
        raise ValueError("no calls in the quick hang-up window")
    newest = calls["start_ts"].max()
    window = calls[calls["start_ts"] > newest - pd.Timedelta(days=window_days)]
    abandoned = window["abandoned"].to_numpy(dtype=bool)
    # A missing abandon_sec is not under the threshold (SQL: NULL < x is not true).
    quick = abandoned & (window["abandon_sec"] < threshold_sec).to_numpy(dtype=bool)
    n_calls, n_abandoned, n_quick = len(window), int(abandoned.sum()), int(quick.sum())
    return {
        "threshold_sec": threshold_sec,
        "window_days": window_days,
        "first_day": str(window["start_ts"].min().date()),
        "last_day": str(window["start_ts"].max().date()),
        "n_calls": int(n_calls),
        "n_abandoned": n_abandoned,
        "n_quick": n_quick,
        "quick_share_of_abandoned": _share(n_quick, n_abandoned),
        "quick_share_of_calls": _share(n_quick, n_calls),
    }


def measure_quick_hangups(conn, threshold_sec: int = QUICK_HANGUP_SEC, window_days: int = WINDOW_DAYS) -> dict:
    return quick_hangups_from_calls(store.read_snapshot(conn).calls, threshold_sec, window_days)


# Process-wide cache, replaced wholesale when the data revision changes.
_cache: dict = {"revision": None, "value": None}


def quick_hangups(conn) -> dict:
    global _cache
    revision = store.calls_revision(conn)
    if _cache["revision"] != revision or _cache["value"] is None:
        _cache = {"revision": revision, "value": measure_quick_hangups(conn)}
    return _cache["value"]
