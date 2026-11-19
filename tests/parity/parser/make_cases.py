"""Parity rung P4: SYNTHETIC call-records workbooks for the TypeScript reader.

Writes one workbook per case with openpyxl (and, through excel_like.py, by hand
in the markup Excel and other export tools write) into the folder given as the only
argument, reads each with the proven Python parser
(db.client_files.read_call_records) and prints one JSON document:

    {"<file name>": {"calls": [[start_ts, in_queue, agent, abandon, routing, abandoned], ...]}
                    | {"error": true}}

start_ts is ISO text to the second. Every value here is made up; no real call
data is read or written.

Run from the repository root:
    forecast/.venv/bin/python tests/parity/parser/make_cases.py <folder>
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime, time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "forecast"))
# Run with -I, which leaves the script's own folder off sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from openpyxl import Workbook  # noqa: E402

from db.client_files import read_call_records  # noqa: E402
from excel_like import CASES as EXCEL_LIKE_CASES  # noqa: E402

HEADER = ["Skill_Name", "Start_Date", "start_time", "InQueue", "Agent_Time",
          "Abandon_Time", "Routing_Time", "Abandon"]
SKILL = "Vets4Warriors_Call"
TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%S"
# (date, clock, in_queue, agent, abandon, routing, flag)
SEP_1 = [
    (datetime(2026, 9, 1), time(0, 0, 32), 18, 1290, 0, 17, "N"),
    (datetime(2026, 9, 1), time(0, 59, 59), 45, 0, 45, 20, "Y"),
    (datetime(2026, 9, 1), time(13, 5, 0), 31, 600, 0, 30, "N"),
]
SEP_2 = [
    (datetime(2026, 9, 2), time(13, 5, 0), 5, 60, 0, 5, "N"),
    (datetime(2026, 9, 2), time(23, 59, 59), 5, 60, 0, 5, "N"),
]
BLANK = [None] * len(HEADER)


def _fill(sheet, rows, extra_column: bool = False) -> None:
    sheet.append(HEADER + (["Hour"] if extra_column else []))
    for row in rows:
        if row is None:
            sheet.append(BLANK)
            continue
        hour = [f"{row[1].hour:02d}" if isinstance(row[1], time) else None] if extra_column else []
        sheet.append([SKILL, *row] + hour)


def raw(path: Path, rows) -> None:
    """The raw export: calls on the only sheet."""
    book = Workbook()
    book.active.title = "Call Records"
    _fill(book.active, rows)
    book.save(path)


def validity(path: Path, rows) -> None:
    """Summary sheets first, the calls on a later sheet with an extra Hour column."""
    book = Workbook()
    book.active.title = "Offered vs Abandoned"
    book.active.append(["Calls Offered", len(rows)])
    book.create_sheet("Staff By Shift").append([None, None, "12AM- 8AM", "8AM - 4 PM", "4PM - 12 AM"])
    _fill(book.create_sheet("Call Records - Sep 1 to Sep 2"), rows, extra_column=True)
    book.create_sheet("Pivot Table").append(["Count of Skill_Name", "Column Labels"])
    book.save(path)


def multi_year(path: Path) -> None:
    """A Definitions sheet, then one sheet per year; the last calls of Dec 31 sit
    on the next year's sheet, as in the partner's multi-year export."""
    book = Workbook()
    book.active.title = "Definitions"
    book.active.append(["InQueue", "seconds waiting in the queue"])
    _fill(book.create_sheet("CY 2025"), [
        (datetime(2025, 12, 30), time(0, 1, 2), 3, 400, 0, 3, "N"),
        (datetime(2025, 12, 31), time(0, 10, 0), 4, 410, 0, 4, "N"),
        (datetime(2025, 12, 31), time(22, 59, 0), 5, 0, 5, 4, "Y"),
    ])
    _fill(book.create_sheet("CY 2026"), [
        (datetime(2025, 12, 31), time(23, 30, 0), 6, 420, 0, 6, "N"),
        (datetime(2026, 1, 1), time(0, 0, 1), 7, 430, 0, 7, "N"),
        (datetime(2026, 1, 1), time(23, 0, 0), 8, 440, 0, 8, "N"),
    ])
    book.save(path)


CASES = {
    "raw.xlsx": lambda p: raw(p, SEP_1 + SEP_2),
    "validity.xlsx": lambda p: validity(p, SEP_1 + SEP_2),
    "multi_year.xlsx": multi_year,
    "start_date_as_date.xlsx": lambda p: raw(p, [(date(2026, 9, 1), time(8, 0, 0), 1, 2, 0, 1, "N")]),
    "start_date_as_datetime_with_time.xlsx": lambda p: raw(p, [(datetime(2026, 9, 1, 17, 45, 0), time(8, 0, 0), 1, 2, 0, 1, "N")]),
    "start_time_as_text.xlsx": lambda p: raw(p, [
        (datetime(2026, 9, 1), "13:05:00", 1, 2, 0, 1, "N"),
        (datetime(2026, 9, 1), "8:05:09", 1, 2, 0, 1, "N"),
    ]),
    "durations_int_float_text.xlsx": lambda p: raw(p, [
        (datetime(2026, 9, 1), time(8, 0, 0), 12, 300.5, 0, 7, "N"),
        (datetime(2026, 9, 1), time(9, 0, 0), "12.5", "300", "0", "7.25", "N"),
    ]),
    "abandon_lower_and_padded.xlsx": lambda p: raw(p, [
        (datetime(2026, 9, 1), time(8, 0, 0), 40, 0, 40, 3, "y"),
        (datetime(2026, 9, 1), time(9, 0, 0), 4, 100, 0, 3, " N "),
    ]),
    "blank_rows.xlsx": lambda p: raw(p, [SEP_1[0], None, SEP_1[1], None, SEP_1[2], None, None]),
    "empty_start_time.xlsx": lambda p: raw(p, SEP_1 + [(datetime(2026, 9, 1), None, 18, 100, 0, 17, "N")]),
    "abandon_maybe.xlsx": lambda p: raw(p, SEP_1 + [(datetime(2026, 9, 1), time(14, 0, 0), 1, 2, 0, 1, "Maybe")]),
    "negative_duration.xlsx": lambda p: raw(p, SEP_1 + [(datetime(2026, 9, 1), time(14, 0, 0), 1, -2, 0, 1, "N")]),
}


def missing_column(path: Path) -> None:
    book = Workbook()
    book.active.append([name for name in HEADER if name != "Routing_Time"])
    for row in SEP_1:
        book.active.append([SKILL, *row[:5], row[6]])
    book.save(path)


def no_call_sheet(path: Path) -> None:
    book = Workbook()
    book.active.append(["SATURDAY 8/1", "SUNDAY 8/2"])
    book.save(path)


CASES["missing_column.xlsx"] = missing_column
CASES["no_call_sheet.xlsx"] = no_call_sheet
# Workbooks shaped the way Excel and other export tools write them (excel_like.py).
CASES.update(EXCEL_LIKE_CASES)


def _read(path: Path) -> dict:
    try:
        calls = read_call_records(path)
    except ValueError:
        return {"error": True}
    return {"calls": [
        [row.start_ts.strftime(TIMESTAMP_FORMAT), float(row.in_queue_sec), float(row.agent_sec),
         float(row.abandon_sec), float(row.routing_sec), bool(row.abandoned)]
        for row in calls.itertuples(index=False)
    ]}


def main() -> int:
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    results = {}
    for name, write in CASES.items():
        write(folder / name)
        results[name] = _read(folder / name)
    print(json.dumps(results))
    return 0


if __name__ == "__main__":
    sys.exit(main())
