"""How many hang-ups happen too fast for staffing to matter.

    quick_hangups(conn) -> dict: threshold_sec, window_days, first_day,
                                 last_day, n_calls, n_abandoned, n_quick,
                                 quick_share_of_abandoned, quick_share_of_calls

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
(not today), so a reporting gap does not empty the window.
"""

from __future__ import annotations

QUICK_HANGUP_SEC = 10
WINDOW_DAYS = 90

QUICK_SQL = """
    WITH bounds AS (SELECT max(start_ts) AS newest FROM calls)
    SELECT
        min(start_ts)::date                                                AS first_day,
        max(start_ts)::date                                                AS last_day,
        count(*)                                                           AS n_calls,
        count(*) FILTER (WHERE abandoned)                                  AS n_abandoned,
        count(*) FILTER (WHERE abandoned AND abandon_sec < %(threshold)s)  AS n_quick
    FROM calls, bounds
    WHERE start_ts > bounds.newest - make_interval(days => %(days)s)
"""

# Process-wide cache, replaced wholesale on first use. `calls` only changes
# on a load, after which the server is restarted.
_cache: dict | None = None


def _share(part: int, whole: int) -> float | None:
    return part / whole if whole else None


def measure_quick_hangups(conn, threshold_sec: int = QUICK_HANGUP_SEC, window_days: int = WINDOW_DAYS) -> dict:
    with conn.cursor() as cur:
        cur.execute(QUICK_SQL, {"threshold": threshold_sec, "days": window_days})
        first_day, last_day, n_calls, n_abandoned, n_quick = cur.fetchone()
    if not n_calls:
        raise ValueError("no calls in the quick hang-up window")
    return {
        "threshold_sec": threshold_sec,
        "window_days": window_days,
        "first_day": str(first_day),
        "last_day": str(last_day),
        "n_calls": int(n_calls),
        "n_abandoned": int(n_abandoned),
        "n_quick": int(n_quick),
        "quick_share_of_abandoned": _share(int(n_quick), int(n_abandoned)),
        "quick_share_of_calls": _share(int(n_quick), int(n_calls)),
    }


def quick_hangups(conn) -> dict:
    global _cache
    if _cache is None:
        _cache = measure_quick_hangups(conn)
    return _cache
