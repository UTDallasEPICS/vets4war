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
    # Abandoned waits are observed through hang-up; answered waits are
    # right-censored at answer. Their combined exposure estimates mean patience.
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


# Process-wide cache, replaced wholesale on first use. The calls table only
# changes on a reload, which also restarts the server.
_cache: dict | None = None


def cached_patience(conn) -> dict:
    global _cache
    if _cache is None:
        # The source call table is treated as static during a server process;
        # loads happen operationally before the server restarts.
        _cache = estimate_patience(conn)
    return _cache


# This module estimates the mean caller patience under an exponential
# right-censoring model. Abandoned callers contribute their observed wait to
# the likelihood, answered callers contribute queue time as censored exposure,
# and explicit validation rejects empty or unidentifiable datasets.
#
# db.staffing requests the cached estimate only for Erlang A when the caller
# has not provided an override; Erlang C intentionally does not use patience.
# The result and sample counts are also exposed by the API so users can see
# whether abandonment estimates came from data or from a manual parameter.
