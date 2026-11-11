"""Synthetic workbooks in the client's call-record layout, shared by the
ledger tests (test_pipeline.py, test_admin_api.py). No client data.

A generated day has three calls: one just after midnight, one at noon, one
just before midnight, so the day counts as whole (not cut short).
"""
from datetime import date, datetime, time
from io import BytesIO
import re
from zipfile import ZIP_DEFLATED, ZipFile

from openpyxl import Workbook

HEADER = ["Skill_Name", "Start_Date", "start_time", "InQueue", "Agent_Time", "Abandon_Time", "Routing_Time", "Abandon"]
SKILL = "Vets4Warriors_Call"
ROWS_PER_DAY = 3
SEP_1, SEP_2, SEP_3, SEP_4 = (date(2026, 9, day) for day in (1, 2, 3, 4))


def day_rows(day: date, agent: int = 300) -> list[tuple]:
    """One whole day of calls: (date, clock, in_queue, agent, abandon, routing, flag)."""
    stamp = datetime.combine(day, time())
    return [
        (stamp, time(0, 10), 10, agent, 0, 2, "N"),
        (stamp, time(12, 0), 20, 0, 20, 2, "Y"),
        (stamp, time(23, 50), 5, agent, 0, 2, "N"),
    ]


def _fill(sheet, rows) -> None:
    sheet.append(HEADER)
    for row in rows:
        sheet.append([SKILL, *row])


def workbook(days=(SEP_1,), *, agent: int = 300, description: str = "", rows=None, second_sheet=None) -> bytes:
    """A client call-records workbook as bytes. `rows` overrides the
    generated days; `second_sheet` adds a second call sheet with those rows."""
    book = Workbook()
    book.properties.description = description
    book.active.title = "Call Records"
    _fill(book.active, rows if rows is not None else [row for day in days for row in day_rows(day, agent)])
    if second_sheet is not None:
        _fill(book.create_sheet("More Call Records"), second_sheet)
    stream = BytesIO()
    book.save(stream)
    book.close()
    return stream.getvalue()


def shared_worksheet_workbook(days=(SEP_1,)) -> bytes:
    """A workbook with two sheet names that both point at ONE worksheet part.
    A real export never looks like this; it is how a small file can be made
    to cost many times its size to read."""
    original = workbook(days, second_sheet=day_rows(SEP_4))
    rebuilt = BytesIO()
    with ZipFile(BytesIO(original)) as source, ZipFile(rebuilt, "w", ZIP_DEFLATED) as target:
        for entry in source.infolist():
            data = source.read(entry.filename)
            if entry.filename == "xl/_rels/workbook.xml.rels":
                data = re.sub(rb"worksheets/sheet2\.xml", b"worksheets/sheet1.xml", data)
            target.writestr(entry, data)
    return rebuilt.getvalue()
