"""Client call-record workbooks -> parsed calls -> hourly frame.

Workbooks are built here with openpyxl in a temp folder. No client data and
no database.
"""

from datetime import datetime, time
from io import BytesIO

import pandas as pd
import pytest
from openpyxl import Workbook

from db.client_files import hourly_from_calls, read_call_records, read_call_sheets
from db.load_week import CallRecordsError

HEADER = ["Skill_Name", "Start_Date", "start_time", "InQueue", "Agent_Time",
          "Abandon_Time", "Routing_Time", "Abandon"]
SKILL = "Vets4Warriors_Call"
# (date, clock, in_queue, agent, abandon, routing, flag)
SEP_1 = [
    (datetime(2026, 9, 1), time(0, 0, 32), 18, 1290, 0, 17, "N"),
    (datetime(2026, 9, 1), time(0, 59, 59), 45, 0, 45, 20, "Y"),
    (datetime(2026, 9, 1), time(13, 5, 0), 31, 600, 0, 30, "N"),
]
SEP_2 = [
    (datetime(2026, 9, 2), time(13, 5, 0), 5, 60, 0, 5, "N"),
]


def _fill(sheet, rows, extra_column: bool = False) -> None:
    sheet.append(HEADER + (["Hour"] if extra_column else []))
    for row in rows:
        sheet.append([SKILL, *row] + ([f"{row[1].hour:02d}"] if extra_column else []))


def _raw_workbook(path, rows):
    """The layout of 'V4W Call Records - ... .xlsx': calls on the only sheet."""
    book = Workbook()
    _fill(book.active, rows)
    book.save(path)
    return path


def _validity_workbook(path, rows):
    """The layout of '... Actual Data for Validity Testing.xlsx': summary
    sheets first, the calls on a later sheet with one extra column."""
    book = Workbook()
    summary = book.active
    summary.title = "Offered vs Abandoned"
    summary.append(["Calls Offered", len(rows)])
    book.create_sheet("Staff By Shift").append([None, None, "12AM- 8AM", "8AM - 4 PM", "4PM - 12 AM"])
    _fill(book.create_sheet("Call Records - Sep 1 to Sep 2"), rows, extra_column=True)
    book.create_sheet("Pivot Table").append(["Count of Skill_Name", "Column Labels"])
    book.save(path)
    return path


# ---- read_call_records ---------------------------------------------------------

def test_raw_layout_reads_every_call(tmp_path):
    calls = read_call_records(_raw_workbook(tmp_path / "raw.xlsx", SEP_1 + SEP_2))

    assert len(calls) == 4
    assert calls["start_ts"].iloc[0] == pd.Timestamp("2026-09-01 00:00:32")
    assert calls["abandoned"].tolist() == [False, True, False, False]


def test_validity_layout_gives_the_same_calls_as_the_raw_layout(tmp_path):
    raw = read_call_records(_raw_workbook(tmp_path / "raw.xlsx", SEP_1 + SEP_2))
    validity = read_call_records(_validity_workbook(tmp_path / "validity.xlsx", SEP_1 + SEP_2))

    pd.testing.assert_frame_equal(validity, raw)


def test_calls_spread_over_several_sheets_are_joined_in_time_order(tmp_path):
    book = Workbook()
    book.active.title = "Definitions"
    book.active.append(["InQueue", "seconds waiting"])
    _fill(book.create_sheet("CY 2026 b"), SEP_2)
    _fill(book.create_sheet("CY 2026 a"), SEP_1)
    book.save(tmp_path / "years.xlsx")

    calls = read_call_records(tmp_path / "years.xlsx")

    assert len(calls) == 4
    assert calls["start_ts"].is_monotonic_increasing


def test_blank_rows_after_the_last_call_are_ignored(tmp_path):
    book = Workbook()
    _fill(book.active, SEP_1)
    book.active.append([None] * len(HEADER))
    book.active.append([None] * len(HEADER))
    book.save(tmp_path / "blank_tail.xlsx")

    assert len(read_call_records(tmp_path / "blank_tail.xlsx")) == 3


def test_a_call_row_with_no_start_time_raises(tmp_path):
    broken = [(datetime(2026, 9, 1), None, 18, 100, 0, 17, "N")]
    book = Workbook()
    _fill(book.active, SEP_1)
    book.active.append([SKILL, *broken[0]])
    book.save(tmp_path / "broken.xlsx")

    with pytest.raises(ValueError, match="start_time"):
        read_call_records(tmp_path / "broken.xlsx")


def test_a_workbook_without_call_records_raises(tmp_path):
    book = Workbook()
    book.active.append(["SATURDAY 8/1", "SUNDAY 8/2"])
    book.save(tmp_path / "staffing.xlsx")

    with pytest.raises(ValueError, match="no call-records sheet"):
        read_call_records(tmp_path / "staffing.xlsx")


# ---- hourly_from_calls ------------------------------------------------------------

def test_hourly_counts_match_the_calls(tmp_path):
    calls = read_call_records(_raw_workbook(tmp_path / "raw.xlsx", SEP_1 + SEP_2))

    hourly = hourly_from_calls(calls).set_index("hour_start")

    midnight = hourly.loc[pd.Timestamp("2026-09-01 00:00")]
    assert (midnight["offered"], midnight["answered"], midnight["abandoned"]) == (2, 1, 1)
    assert midnight["answered_30s"] == 1
    assert midnight["talk_sec"] == 1290.0
    assert hourly["offered"].sum() == len(calls)


def test_answered_after_the_service_level_wait_is_not_counted_as_in_time(tmp_path):
    calls = read_call_records(_raw_workbook(tmp_path / "raw.xlsx", SEP_1))

    hourly = hourly_from_calls(calls).set_index("hour_start")

    # 13:05 call waited 31 s: answered, but not within 30 s.
    afternoon = hourly.loc[pd.Timestamp("2026-09-01 13:00")]
    assert (afternoon["answered"], afternoon["answered_30s"]) == (1, 0)


def test_hours_with_no_calls_have_no_row(tmp_path):
    calls = read_call_records(_raw_workbook(tmp_path / "raw.xlsx", SEP_1))

    assert len(hourly_from_calls(calls)) == 2


def test_header_names_with_stray_spaces_are_still_read(tmp_path):
    book = Workbook()
    book.active.append([name + " " for name in HEADER])
    for row in SEP_1:
        book.active.append([SKILL, *row])
    book.save(tmp_path / "spaces.xlsx")

    assert len(read_call_records(tmp_path / "spaces.xlsx")) == 3


# ---- an uploaded workbook (bytes in memory, not a path) --------------------------

def test_an_uploaded_workbook_reads_the_same_as_the_file_on_disk(tmp_path):
    path = _validity_workbook(tmp_path / "validity.xlsx", SEP_1 + SEP_2)
    uploaded = BytesIO(path.read_bytes())
    pd.testing.assert_frame_equal(read_call_records(uploaded), read_call_records(path))


def test_an_uploaded_workbook_can_be_read_again_from_wherever_it_was_left(tmp_path):
    uploaded = BytesIO(_raw_workbook(tmp_path / "raw.xlsx", SEP_1).read_bytes())
    uploaded.read()
    assert len(read_call_records(uploaded)) == 3
    assert len(read_call_records(uploaded)) == 3


def test_an_uploaded_workbook_without_call_records_says_so(tmp_path):
    book = Workbook()
    book.active.append(["Calls Offered", 3])
    book.save(tmp_path / "summary.xlsx")
    with pytest.raises(ValueError, match="uploaded workbook: no call-records sheet"):
        read_call_records(BytesIO((tmp_path / "summary.xlsx").read_bytes()))


# ---- read_call_sheets -----------------------------------------------------------

def test_calls_are_also_available_sheet_by_sheet(tmp_path):
    book = Workbook()
    book.active.title = "CY 2026 a"
    _fill(book.active, SEP_1)
    _fill(book.create_sheet("CY 2026 b"), SEP_2)
    book.create_sheet("Notes").append(["not calls"])
    book.save(tmp_path / "two.xlsx")

    sheets = read_call_sheets(tmp_path / "two.xlsx")

    assert list(sheets) == ["CY 2026 a", "CY 2026 b"]
    assert [len(calls) for calls in sheets.values()] == [3, 1]
    assert len(read_call_records(tmp_path / "two.xlsx")) == 4


def test_problems_in_the_file_are_reported_as_call_record_errors(tmp_path):
    """One error type for 'this is not a usable call-records file', so a
    caller can show its message and treat anything else as a plain failure.
    It is still a ValueError for callers that catch that."""
    book = Workbook()
    book.active.append(["Calls Offered", 3])
    book.save(tmp_path / "summary.xlsx")
    with pytest.raises(CallRecordsError):
        read_call_records(tmp_path / "summary.xlsx")
    broken = [(datetime(2026, 9, 1), time(0, 5, 0), "not a number", 60, 0, 5, "N")]
    with pytest.raises(CallRecordsError, match="InQueue"):
        read_call_records(_raw_workbook(tmp_path / "broken.xlsx", broken))
    assert issubclass(CallRecordsError, ValueError)
