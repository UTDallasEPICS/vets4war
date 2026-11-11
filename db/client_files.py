"""Read a client call-records workbook into parsed calls, without the database.

The client sends call records in two workbook layouts:

  * raw export        one sheet, one row per call
                      ("V4W Call Records - Sept 1st 2026 thru Oct 13th 2026.xlsx")
  * validity testing  summary sheets first, the calls on a later sheet with
                      an extra `Hour` column
                      ("Oct 21 2026 to Oct 27 2026 - Actual Data for Validity Testing 2.xlsx")
  * multi-year        one sheet per calendar year
                      ("V4W Call Records - CY 21 - CY 26 - no PHI.xlsx")

In every layout a call sheet is recognised by its header row: it carries all
of db.load_week.REQUIRED_COLUMNS. Every such sheet is read; other sheets are
ignored.

    read_call_records(path)   -> calls, same frame as db.load_week.parse_call_records
    hourly_from_calls(calls)  -> hourly frame, same columns as db.features.HOURLY_SQL

Nothing here writes anywhere. Row parsing and validation are
db.load_week.parse_call_records, imported, never reimplemented.
"""

from __future__ import annotations

from pathlib import Path

import openpyxl
import pandas as pd

from db.features import SERVICE_LEVEL_SEC
from db.load_week import REQUIRED_COLUMNS, parse_call_records

HOURLY_COLUMNS = ("hour_start", "offered", "answered", "abandoned", "answered_30s", "talk_sec")


def call_sheets(path: Path) -> list[str]:
    """Names of the sheets whose first row has every call-record column."""
    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        names = []
        for sheet in book.worksheets:
            header = next(sheet.iter_rows(min_row=1, max_row=1, values_only=True), ())
            if set(REQUIRED_COLUMNS) <= {str(cell).strip() for cell in header if cell is not None}:
                names.append(sheet.title)
        return names
    finally:
        book.close()


def _read_sheet(path: Path, sheet: str) -> pd.DataFrame:
    """One call sheet, without the fully blank rows Excel leaves after the
    last call. A row with SOME call fields filled is kept, so the parser
    rejects it instead of it being dropped silently."""
    raw = pd.read_excel(path, sheet_name=sheet).rename(columns=lambda name: str(name).strip())
    blank = raw[list(REQUIRED_COLUMNS)].isna().all(axis=1)
    return raw[~blank].reset_index(drop=True)


def read_call_records(path: Path | str) -> pd.DataFrame:
    """Every call in the workbook, in `calls` column order, sorted by start_ts.
    Raises ValueError when the workbook has no call sheet or a call row is
    malformed."""
    path = Path(path)
    sheets = call_sheets(path)
    if not sheets:
        raise ValueError(f"{path.name}: no call-records sheet (no header row with {list(REQUIRED_COLUMNS)})")
    parsed = [parse_call_records(_read_sheet(path, sheet)) for sheet in sheets]
    return pd.concat(parsed, ignore_index=True).sort_values("start_ts", kind="stable").reset_index(drop=True)


def hourly_from_calls(calls: pd.DataFrame) -> pd.DataFrame:
    """One row per hour that has at least one call, with the same columns
    and meaning as db.features.HOURLY_SQL."""
    answered = ~calls["abandoned"]
    per_call = pd.DataFrame({
        "hour_start": calls["start_ts"].dt.floor("h"),
        "offered": 1,
        "answered": answered.astype("int64"),
        "abandoned": calls["abandoned"].astype("int64"),
        "answered_30s": (answered & (calls["in_queue_sec"] <= SERVICE_LEVEL_SEC)).astype("int64"),
        "talk_sec": calls["agent_sec"].astype("float64"),
    })
    hourly = per_call.groupby("hour_start", as_index=False).sum()
    return hourly[list(HOURLY_COLUMNS)]
