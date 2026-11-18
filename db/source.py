"""Which data the page is showing: partner or synthetic, and its date range.

    describe_source(conn) -> {"kind", "label", "start", "end"}

The label is an operator decision, not something the code can infer from the
rows, so it comes from $V4W_DATA_SOURCE ("partner" or "synthetic"). When it
is not set the badge says so instead of guessing: demoing synthetic numbers
while believing they are real is the failure this exists to prevent.

The date range is cached by the ingestion ledger revision when available.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

SOURCE_KINDS = ("partner", "synthetic")
UNLABELED = "unlabeled"
LABELS = {
    "partner": "Partner data",
    "synthetic": "Synthetic data",
    UNLABELED: "Data source not set (V4W_DATA_SOURCE)",
}

RANGE_SQL = "SELECT min(start_ts)::date, max(start_ts)::date FROM calls"

_range_cache: tuple[object, tuple[str, str]] | None = None


def source_kind() -> str:
    value = (os.environ.get("V4W_DATA_SOURCE") or "").strip().lower()
    return value if value in SOURCE_KINDS else UNLABELED


def _data_range(conn) -> tuple[str, str]:
    global _range_cache
    key = getattr(conn, "_v4w_call_revision", None)
    cached = _range_cache
    if cached is not None and cached[0] == key:
        return cached[1]
    with conn.cursor() as cur:
        cur.execute(RANGE_SQL)
        start, end = cur.fetchone()
    if start is None:
        raise ValueError("`calls` is empty; no data range")
    value = (start.isoformat(), end.isoformat())
    _range_cache = (key, value)
    return value



def describe_source(conn) -> dict:
    kind = source_kind()
    start, end = _data_range(conn)
    return {"kind": kind, "label": LABELS[kind], "start": start, "end": end}
