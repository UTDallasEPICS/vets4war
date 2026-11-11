"""Actual partner layout using small generated workbooks, never partner data."""
from datetime import datetime, time, timezone
from io import BytesIO
import json
from pathlib import Path

from openpyxl import Workbook
import pytest

from db.ingest import parse_excel
from db.pipeline import ExportContract


HEADERS = ["Skill_Name", "Start_Date", "start_time", "InQueue", "Agent_Time",
           "Abandon_Time", "Routing_Time", "Abandon"]
ROW = ["Vets4Warriors_Call", datetime(2026, 9, 1), time(14, 5, 30), 30, 240, 0, 5, "N"]


def contract():
    return ExportContract.model_validate_json(
        (Path(__file__).resolve().parents[1] / "config/export-contract.example.json").read_text())


def workbook(rows=None, *, second=False):
    wb = Workbook()
    wb.active.title = "Definitions"
    wb.active.append(["Field", "Description"])
    ws = wb.create_sheet("Partner's changing tab name")
    ws.append(HEADERS + [None, "Extra"])
    for row in rows if rows is not None else [ROW]:
        ws.append(row)
    if second:
        ws = wb.create_sheet("Another period")
        ws.append(HEADERS)
        ws.append(ROW)
    out = BytesIO()
    wb.save(out)
    wb.close()
    return out.getvalue()


def parse(content, **overrides):
    return parse_excel(BytesIO(content), **{**contract().parser_options(), **overrides})


def test_auto_detect_split_timestamp_blank_padding_and_duration_semantics():
    result = parse(workbook([[None] * 8, ROW, [None] * 8]))
    assert result.ok and result.summary["total_rows"] == 1
    assert result.rows[0].row_number == 3
    record = result.valid_records[0]
    assert record["start_ts"] == datetime(2026, 9, 1, 14, 5, 30)
    assert record["in_queue_sec"] == 30  # routing is already included
    assert record["routing_sec"] == 5
    assert record["agent_sec"] == 240 and not record["abandoned"]
    assert "Skill_Name" not in record


def test_multiple_call_tabs_require_explicit_selection():
    content = workbook(second=True)
    result = parse(content)
    assert not result.ok and result.file_errors[0].code == "ambiguous_sheets"
    assert parse(content, sheet="Another period").ok


@pytest.mark.parametrize("clock", [None, "bad", 0.5, "=NOW()", time(12, tzinfo=timezone.utc)])
def test_bad_or_missing_time_never_silently_becomes_midnight(clock):
    row = ROW.copy()
    # Excel cannot store timezone-aware cells; test that value at row level.
    if isinstance(clock, time) and clock.tzinfo:
        from db.ingest import CALL_RECORD_COLUMNS, validate_rows
        row[2] = clock
        result = validate_rows(HEADERS, [row], column_map=CALL_RECORD_COLUMNS,
                               timestamp_time_column="start_time")
    else:
        row[2] = clock
        result = parse(workbook([row]))
    assert not result.ok
    assert result.rows[0].errors[0].code == "invalid_timestamp"


def test_text_clock_and_midnight_are_supported():
    for clock in ["14:05:30", time(0, 0)]:
        row = ROW.copy()
        row[2] = clock
        assert parse(workbook([row])).ok


def test_skipped_blanks_do_not_hide_bad_row_numbers_or_row_limit():
    bad = ROW.copy()
    bad[4] = -1
    result = parse(workbook([ROW, [None] * 8, bad]))
    assert result.report()["row_errors"][0]["row_number"] == 4
    assert not parse(workbook([ROW, [None] * 8, ROW]), max_rows=2).ok


@pytest.mark.usefixtures("signed_in_admin")
def test_http_validation_uses_same_contract_without_database(monkeypatch):
    from fastapi.testclient import TestClient
    from api.main import app
    monkeypatch.setenv("V4W_EXPORT_CONTRACT", str(
        Path(__file__).resolve().parents[1] / "config/export-contract.example.json"))
    response = TestClient(app).post("/api/admin/validate", data={"month": "2026-09"},
                                   files={"file": ("calls.xlsx", workbook())})
    assert response.status_code == 200 and response.json()["ok"]
    assert "records" not in response.json()


@pytest.mark.usefixtures("signed_in_admin")
def test_cross_month_http_format_check_passes_without_enabling_monthly_import(monkeypatch):
    from fastapi.testclient import TestClient
    from api.main import app
    from db import pipeline
    monkeypatch.setenv("V4W_EXPORT_CONTRACT", str(
        Path(__file__).resolve().parents[1] / "config/export-contract.example.json"))
    def no_database():
        raise AssertionError("Format validation must not connect to the database")
    monkeypatch.setattr(pipeline, "connect", no_database)
    october = ROW.copy()
    october[1] = datetime(2026, 10, 28)
    november = ROW.copy()
    november[1] = datetime(2026, 11, 3)
    content = workbook([october, november])
    client = TestClient(app)
    response = client.post("/api/admin/validate", files={"file": ("calls.xlsx", content)})
    report = response.json()
    assert response.status_code == 200 and report["ok"]
    assert report["validation_scope"] == "format_only"
    assert report["months_found"] == {"2026-10": 1, "2026-11": 1}
    assert "records" not in report and "id" not in report
    # The explicit month mode retains its strict checks.
    report = client.post("/api/admin/validate", data={"month": "2026-10"},
                         files={"file": ("calls.xlsx", content)}).json()
    assert not report["ok"] and report["validation_scope"] == "single_month"
    assert report["row_errors"][0]["errors"][0]["code"] == "outside_month"


@pytest.mark.usefixtures("signed_in_admin")
def test_format_check_caps_errors_but_keeps_total_counts(monkeypatch):
    from fastapi.testclient import TestClient
    from api.main import app
    monkeypatch.setenv("V4W_EXPORT_CONTRACT", str(
        Path(__file__).resolve().parents[1] / "config/export-contract.example.json"))
    row = ROW.copy()
    row[2] = None
    report = TestClient(app).post("/api/admin/validate",
        files={"file": ("bad.xlsx", workbook([row] * 205))}).json()
    assert report["summary"]["invalid_rows"] == 205
    assert len(report["row_errors"]) == 200 and report["row_errors_truncated"]


def test_call_records_cli_is_read_only(tmp_path, capsys):
    from db.ingest import main
    path = tmp_path / "calls.xlsx"
    path.write_bytes(workbook())
    assert main(["--file", str(path), "--profile", "call-records", "--month", "2026-09", "--dry-run"]) == 0
    assert json.loads(capsys.readouterr().out)["summary"]["valid_rows"] == 1


def test_history_preparation_splits_tabs_by_month_and_preserves_calls(tmp_path):
    from db.prepare_history import prepare
    source = tmp_path / "history.xlsx"
    source.write_bytes(workbook(second=True))
    before = source.read_bytes()
    audit = prepare(source)
    assert audit["months"]["2026-09"]["rows"] == 2
    assert len(audit["sheets"]) == 2
    output = tmp_path / "monthly"
    report = prepare(source, output)
    assert parse((output / "calls-2026-09.xlsx").read_bytes()).summary["valid_rows"] == 2
    assert json.loads((output / "manifest.json").read_text()) == report
    assert source.read_bytes() == before
    with pytest.raises(ValueError, match="already exists"):
        prepare(source, output)


def test_history_failure_publishes_no_partial_months(tmp_path):
    from db.prepare_history import prepare
    source = tmp_path / "bad.xlsx"
    bad = ROW.copy()
    bad[2] = None
    source.write_bytes(workbook([ROW, bad]))
    output = tmp_path / "monthly"
    with pytest.raises(ValueError, match="row 3"):
        prepare(source, output)
    assert not output.exists()
    assert not list(tmp_path.glob(".v4w-history-*"))
