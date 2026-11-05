"""Validate the multi-tab partner history and optionally prepare monthly files.

Never connects to a database or trains a model. Default is a read-only audit.
--output-dir creates a NEW directory only after every call row passes validation.
Generated monthly workbooks still need completeness/overlap review and explicit
import through the monthly pipeline. No source call IDs are invented.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

from openpyxl import Workbook, load_workbook

from db.ingest import CALL_RECORD_COLUMNS, validate_rows

HEADERS = ("Skill_Name", "Start_Date", "start_time", "InQueue", "Agent_Time",
           "Abandon_Time", "Routing_Time", "Abandon")


def prepare(source: Path, output_dir: Path | None = None) -> dict:
    if output_dir is not None and output_dir.exists():
        raise ValueError("Output directory already exists; choose a new directory.")
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    report = {"source_sha256": digest.hexdigest(), "sheets": [], "months": {},
              "warnings": ["No source call ID: duplicate calls cannot be identified reliably.",
                           "Date coverage and row counts do not prove completeness. Review before import."]}
    staging = None
    books = {}
    wb = None
    try:
        if output_dir is not None:
            output_dir.parent.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix=".v4w-history-", dir=output_dir.parent))
        wb = load_workbook(source, read_only=True, data_only=False)
        for sheet in wb:
            rows = sheet.iter_rows(values_only=True)
            headers = next(rows, ())
            if not set(HEADERS).issubset(v for v in headers if isinstance(v, str)):
                # Only the supplied explanatory tab is ignored automatically.
                if sheet.title == "Definitions":
                    continue
                raise ValueError("A history worksheet lacks the required eight columns; no files published.")
            named = [v for v in headers if v is not None and v != ""]
            if len(named) != len(set(named)):
                raise ValueError("A history worksheet has duplicate headers; no files published.")
            positions = [headers.index(name) for name in HEADERS]
            count = 0
            for number, values in enumerate(rows, start=2):
                if all(v is None or (isinstance(v, str) and not v.strip()) for v in values):
                    continue
                raw = [values[i] for i in positions]
                result = validate_rows(list(HEADERS), [raw], column_map=CALL_RECORD_COLUMNS,
                                       timestamp_time_column="start_time")
                if not result.ok:
                    codes = sorted({e.code for row in result.rows for e in row.errors})
                    raise ValueError(f"Invalid call data on worksheet {wb.worksheets.index(sheet) + 1}, row {number}: {', '.join(codes)}. No files published.")
                stamp = result.valid_records[0]["start_ts"]
                month = stamp.strftime("%Y-%m")
                item = report["months"].setdefault(month, {"rows": 0, "first_date": stamp.date().isoformat(),
                                                         "last_date": stamp.date().isoformat()})
                item["rows"] += 1
                item["first_date"] = min(item["first_date"], stamp.date().isoformat())
                item["last_date"] = max(item["last_date"], stamp.date().isoformat())
                count += 1
                if staging is not None:
                    if month not in books:
                        book = Workbook(write_only=True)
                        book.create_sheet("Call Records").append(HEADERS)
                        books[month] = book
                    books[month].worksheets[0].append(raw)
            report["sheets"].append({"sheet": sheet.title, "rows": count})
        if not report["months"]:
            raise ValueError("No call records found; no files published.")
        if staging is not None:
            for month, book in books.items():
                path = staging / f"calls-{month}.xlsx"
                book.save(path)
                report["months"][month]["file_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
            (staging / "manifest.json").write_text(json.dumps(report, indent=2) + "\n")
            staging.rename(output_dir)
            staging = None
        return report
    finally:
        if wb is not None:
            wb.close()
        for book in books.values():
            # Close write-only XML streams on validation failure as well.
            for sheet in book:
                if not sheet.closed:
                    sheet.close()
                if sheet._writer is not None and Path(sheet._writer.out).exists():
                    sheet._writer.cleanup()
            book.close()
        if staging is not None:
            shutil.rmtree(staging)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--output-dir", type=Path,
                        help="Optional NEW directory for monthly .xlsx files and an audit manifest.")
    args = parser.parse_args(argv)
    try:
        report = prepare(args.file, args.output_dir)
    except ValueError as error:
        parser.exit(1, str(error) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
