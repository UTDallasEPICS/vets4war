"""Mean caller patience, estimated from the calls table.

    estimate_patience(conn) -> dict: patience_sec, n_abandoned, n_calls

Patience is modelled as exponential (the Erlang A assumption). Every call
gives one observation: an abandoned call waited exactly `abandon_sec`
before hanging up; an answered call waited `in_queue_sec` and would have
hung up later (right-censored). The maximum-likelihood estimate of the
mean under right censoring is

    total waiting time of all calls / number of abandoned calls

No ML here. Connection comes from $V4W_DATABASE_URL.
"""

from __future__ import annotations

import sys

from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg  # noqa: F401  (callers pass an open connection)
except ImportError:
    sys.exit("psycopg is required:  pip install 'psycopg[binary]'")

PATIENCE_SQL = """
    SELECT
        SUM(CASE WHEN abandoned THEN abandon_sec ELSE in_queue_sec END)::float AS total_wait_sec,
        SUM(abandoned::int)                                                AS n_abandoned,
        COUNT(*)                                                           AS n_calls
    FROM calls
"""


def estimate_patience(conn) -> dict:
    """Censored-exponential MLE of mean patience in seconds, with the counts
    it came from so the UI can say where the number comes from."""
    with conn.cursor() as cur:
        cur.execute(PATIENCE_SQL)
        total_wait_sec, n_abandoned, n_calls = cur.fetchone()
    if not n_calls:
        raise ValueError("no rows in `calls`; cannot estimate patience")
    if not n_abandoned:
        raise ValueError("no abandoned calls in `calls`; mean patience is unidentifiable")
    if total_wait_sec is None or total_wait_sec <= 0:
        raise ValueError("calls have no waiting time recorded; cannot estimate patience")
    return {
        "patience_sec": float(total_wait_sec) / int(n_abandoned),
        "n_abandoned": int(n_abandoned),
        "n_calls": int(n_calls),
    }


# Process-wide cache. db.freshness clears it after committed monthly imports.
_cache: dict | None = None


def cached_patience(conn) -> dict:
    global _cache
    if _cache is None:
        _cache = estimate_patience(conn)
    return _cache
