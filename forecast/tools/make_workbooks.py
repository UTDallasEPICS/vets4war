#!/usr/bin/env python3
"""Split the SYNTHETIC calls and write partner-layout .xlsx workbooks. NOT real data.

    cd forecast && .venv/bin/python tools/make_workbooks.py SYNTHETIC_DIR [--history-end 2026-11-08]
        [--skip-history-workbook]

Reads SYNTHETIC_DIR/SYNTHETIC_calls_all.csv.gz (tools/gen_synthetic.py) and
writes, into the same folder:

    SYNTHETIC_calls_history.csv.gz   every call up to --history-end (calls columns)
    SYNTHETIC_calls_week1.csv.gz     Nov 9 to Nov 15 2026
    SYNTHETIC_calls_week2.csv.gz     Nov 16 to Nov 17 2026

    workbooks/SYNTHETIC V4W Call Records - CY 21 - CY 26.xlsx
        multi-year layout: a Definitions sheet, then one sheet per calendar
        year, all history up to --history-end
    workbooks/SYNTHETIC V4W Call Records - Nov 9th 2026 thru Nov 15th 2026.xlsx
        raw export layout: the calls on the only sheet
    workbooks/SYNTHETIC Nov 16 2026 to Nov 17 2026 - Actual Data for Validity Testing.xlsx
        validity-testing layout: summary sheets first, the calls on a later
        sheet with an extra Hour column
    workbooks/negative/...      files an importer must refuse or flag (see NEGATIVE below)

Column layout and cell types follow the repository's own tests
(forecast/tests/test_client_files.py): Start_Date is a date cell, start_time
a time cell, the four durations whole seconds, Abandon "Y" / "N".

For tests, parity runs and demos only; needs openpyxl (requirements.txt).
"""

from __future__ import annotations

import argparse
import sys
from datetime import time
from pathlib import Path

import pandas as pd
from openpyxl import Workbook

HEADER = ["Skill_Name", "Start_Date", "start_time", "InQueue", "Agent_Time",
          "Abandon_Time", "Routing_Time", "Abandon"]
SKILL = "Vets4Warriors_Call"
WEEK1 = ("2026-11-09", "2026-11-15")
WEEK2 = ("2026-11-16", "2026-11-17")


def _rows(calls: pd.DataFrame, extra_hour: bool = False):
    for row in calls.itertuples(index=False):
        stamp = row.start_ts
        cells = [SKILL, stamp.normalize().to_pydatetime(), time(stamp.hour, stamp.minute, stamp.second),
                 int(row.in_queue_sec), int(row.agent_sec), int(row.abandon_sec), int(row.routing_sec),
                 "Y" if row.abandoned else "N"]
        yield cells + ([f"{stamp.hour:02d}"] if extra_hour else [])


def _fill(sheet, calls: pd.DataFrame, extra_hour: bool = False) -> None:
    sheet.append(HEADER + (["Hour"] if extra_hour else []))
    for cells in _rows(calls, extra_hour):
        sheet.append(cells)


def between(calls: pd.DataFrame, first: str, last: str) -> pd.DataFrame:
    day = calls["start_ts"].dt.normalize()
    return calls[(day >= pd.Timestamp(first)) & (day <= pd.Timestamp(last))].reset_index(drop=True)


def raw_workbook(path: Path, calls: pd.DataFrame) -> None:
    book = Workbook(write_only=True)
    _fill(book.create_sheet("Call Records"), calls)
    book.save(path)


def validity_workbook(path: Path, calls: pd.DataFrame) -> None:
    book = Workbook(write_only=True)
    summary = book.create_sheet("Offered vs Abandoned")
    summary.append(["Calls Offered", len(calls)])
    summary.append(["Calls Abandoned", int(calls["abandoned"].sum())])
    book.create_sheet("Staff By Shift").append([None, None, "12AM- 8AM", "8AM - 4 PM", "4PM - 12 AM"])
    _fill(book.create_sheet("Call Records - Nov 16 to Nov 17"), calls, extra_hour=True)
    book.create_sheet("Pivot Table").append(["Count of Skill_Name", "Column Labels"])
    book.save(path)


def multi_year_workbook(path: Path, calls: pd.DataFrame) -> None:
    book = Workbook(write_only=True)
    definitions = book.create_sheet("Definitions")
    definitions.append(["InQueue", "seconds waiting, routing included"])
    definitions.append(["Agent_Time", "seconds of talk time"])
    for year, group in calls.groupby(calls["start_ts"].dt.year):
        _fill(book.create_sheet(f"CY {year}"), group)
    book.save(path)


def negative_workbooks(folder: Path, history: pd.DataFrame, week1: pd.DataFrame) -> None:
    """Files that must not import cleanly:
    partial_last_day     week 1 cut off at 14:00 on its last day (not whole days)
    different_day        Nov 5 to Nov 8 again, but Nov 6 has 25 calls fewer than history
    already_loaded       Nov 5 to Nov 8 exactly as in history (nothing new)
    bad_abandon_flag     one row with Abandon = "Maybe"
    missing_column       no Routing_Time column
    no_call_sheet        a workbook with no call-records sheet at all
    """
    folder.mkdir(parents=True, exist_ok=True)
    cut = week1[week1["start_ts"] < pd.Timestamp("2026-11-15 14:00")]
    raw_workbook(folder / "SYNTHETIC partial_last_day.xlsx", cut)

    tail = between(history, "2026-11-05", "2026-11-08")
    raw_workbook(folder / "SYNTHETIC already_loaded.xlsx", tail)
    nov6 = tail.index[tail["start_ts"].dt.normalize() == pd.Timestamp("2026-11-06")]
    raw_workbook(folder / "SYNTHETIC different_day.xlsx", tail.drop(index=nov6[::max(1, len(nov6) // 25)][:25]))

    book = Workbook()
    sheet = book.active
    sheet.append(HEADER)
    for i, cells in enumerate(_rows(week1.head(40))):
        if i == 7:
            cells[-1] = "Maybe"
        sheet.append(cells)
    book.save(folder / "SYNTHETIC bad_abandon_flag.xlsx")

    book = Workbook()
    sheet = book.active
    keep = [i for i, name in enumerate(HEADER) if name != "Routing_Time"]
    sheet.append([HEADER[i] for i in keep])
    for cells in _rows(week1.head(40)):
        sheet.append([cells[i] for i in keep])
    book.save(folder / "SYNTHETIC missing_column.xlsx")

    book = Workbook()
    book.active.append(["SATURDAY 8/1", "SUNDAY 8/2"])
    book.save(folder / "SYNTHETIC no_call_sheet.xlsx")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write SYNTHETIC partner-layout workbooks (not real data).")
    parser.add_argument("synthetic_dir", type=Path)
    parser.add_argument("--history-end", default="2026-11-08")
    parser.add_argument("--skip-history-workbook", action="store_true",
                        help="skip the big multi-year workbook (takes a few minutes)")
    args = parser.parse_args(argv)

    folder = args.synthetic_dir
    calls = pd.read_csv(folder / "SYNTHETIC_calls_all.csv.gz", parse_dates=["start_ts"])
    history = calls[calls["start_ts"].dt.normalize() <= pd.Timestamp(args.history_end)].reset_index(drop=True)
    week1, week2 = between(calls, *WEEK1), between(calls, *WEEK2)
    for name, frame in (("history", history), ("week1", week1), ("week2", week2)):
        frame.to_csv(folder / f"SYNTHETIC_calls_{name}.csv.gz", index=False)
        print(f"{name:8s} {len(frame):>8,} calls  {frame['start_ts'].min()} to {frame['start_ts'].max()}")

    books = folder / "workbooks"
    books.mkdir(parents=True, exist_ok=True)
    raw_workbook(books / "SYNTHETIC V4W Call Records - Nov 9th 2026 thru Nov 15th 2026.xlsx", week1)
    validity_workbook(books / "SYNTHETIC Nov 16 2026 to Nov 17 2026 - Actual Data for Validity Testing.xlsx", week2)
    negative_workbooks(books / "negative", history, week1)
    if not args.skip_history_workbook:
        multi_year_workbook(books / "SYNTHETIC V4W Call Records - CY 21 - CY 26.xlsx", history)
    for path in sorted(books.rglob("*.xlsx")):
        print(f"{path.stat().st_size / 1e6:8.2f} MB  {path.relative_to(folder)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
