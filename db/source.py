"""Which data the page is showing: partner or synthetic, and its date range.

    describe_source(conn) -> {"kind", "label", "start", "end"}

The label is an operator decision, not something the code can infer from the
rows, so it comes from $V4W_DATA_SOURCE ("partner" or "synthetic"). When it
is not set the badge says so instead of guessing: demoing synthetic numbers
while believing they are real is the failure this exists to prevent.

The date range is read once per process from `calls`; the table only
changes on a reload, which also restarts the server.
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

_range_cache: tuple[str, str] | None = None


def source_kind() -> str:
    # The label is deployment metadata, not something inferred from table
    # values; invalid or missing values remain explicitly unlabeled.
    value = (os.environ.get("V4W_DATA_SOURCE") or "").strip().lower()
    return value if value in SOURCE_KINDS else UNLABELED


def _data_range(conn) -> tuple[str, str]:
    global _range_cache
    if _range_cache is None:
        # Calls are ingested before the application starts, so this process
        # cache avoids repeating the same range query on every API response.
        with conn.cursor() as cur:
            cur.execute(RANGE_SQL)
            start, end = cur.fetchone()
        if start is None:
            raise ValueError("`calls` is empty; no data range")
        _range_cache = (start.isoformat(), end.isoformat())
    return _range_cache


def describe_source(conn) -> dict:
    kind = source_kind()
    start, end = _data_range(conn)
    return {"kind": kind, "label": LABELS[kind], "start": start, "end": end}


# This module combines an explicit deployment label with the minimum and
# maximum call dates into a compact, stable data-source description. Labels
# are validated against known values and the date range is cached per process
# because ingestion is operationally followed by an application restart.
#
# api.main attaches this description to forecast and model responses so the
# frontend can distinguish partner observations from synthetic/demo data and
# show the period represented. The code deliberately reports an unset or
# invalid label as unlabeled instead of inferring provenance from call rows.
