"""Synthetic workbooks only: no .env, network, database, or model required."""

from datetime import datetime
from io import BytesIO
import json
import os
import sys

import pytest
from openpyxl import Workbook

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from db.ingest import main, parse_excel, validate_rows  # noqa: E402


HEADERS = ["start_ts", "abandoned", "in_queue_sec", "agent_sec", "abandon_sec", "routing_sec", "Call ID"]
CALL = [datetime(2026, 9, 1, 12, 30), False, 15, 300, None, 2, "call-001"]


def workbook_bytes(rows, headers=HEADERS):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Calls"
    if headers is not None:
        sheet.append(headers)
    for row in rows:
        sheet.append(row)
    content = BytesIO()
    workbook.save(content)
    workbook.close()
    content.seek(0)
    return content


def test_valid_excel_normalizes_only_database_fields():
    result = parse_excel(workbook_bytes([CALL]), identifier_column="Call ID")
    assert result.ok
    assert result.summary == {"total_rows": 1, "valid_rows": 1, "invalid_rows": 0, "duplicate_rows": 0}
    assert result.valid_records == [{"start_ts": CALL[0], "abandoned": False,
                                     "in_queue_sec": 15.0, "agent_sec": 300.0,
                                     "abandon_sec": None, "routing_sec": 2.0}]
    assert result.rows[0].row_number == 2
    assert result.rows[0].source_identifier == "call-001"
    assert "id" not in result.valid_records[0]


def test_missing_required_column_reports_field_and_preserves_counts():
    result = parse_excel(workbook_bytes([[False]], headers=["abandoned"]))
    assert not result.ok
    assert {error.field for error in result.file_errors} == {"start_ts", "agent_sec", "in_queue_sec", "abandon_sec"}
    assert result.summary["invalid_rows"] == 1
    assert result.valid_records == []


@pytest.mark.parametrize("headers", [None, HEADERS])
def test_empty_workbook_or_header_only(headers):
    result = parse_excel(workbook_bytes([], headers=headers))
    assert not result.ok
    assert result.summary["total_rows"] == 0
    assert result.file_errors[0].code == "empty_file"


@pytest.mark.parametrize("value,code", [
    (None, "required"), (" ", "required"), ("not a date", "invalid_timestamp"),
    ("2026-02-30 12:00", "invalid_timestamp"), ("09/01/2026 12:30", "invalid_timestamp"),
    ("2026-09-01", "invalid_timestamp"), (46266, "invalid_timestamp"),
    ("2026-09-01T12:30:00Z", "invalid_timestamp"),
    ("2026-09-01T12:30:00-04:00", "invalid_timestamp"),
])
def test_invalid_or_missing_timestamps(value, code):
    call = CALL.copy()
    call[0] = value
    result = parse_excel(workbook_bytes([call]))
    assert result.summary["invalid_rows"] == 1
    assert any(error.field == "start_ts" and error.code == code for error in result.rows[0].errors)


def test_native_timezone_aware_timestamp_is_rejected():
    call = CALL.copy()
    call[0] = datetime.fromisoformat("2026-09-01T12:30:00+00:00")
    result = validate_rows(HEADERS, [call])
    assert result.rows[0].errors[0].code == "invalid_timestamp"


@pytest.mark.parametrize("field_index", [2, 3, 4, 5])
@pytest.mark.parametrize("value", [-1, "many seconds", "NaN", "Infinity", True, "=1+1"])
def test_invalid_durations(field_index, value):
    call = CALL.copy()
    call[field_index] = value
    result = parse_excel(workbook_bytes([call]))
    assert result.summary["invalid_rows"] == 1
    assert any(error.field == HEADERS[field_index] and error.code == "invalid_duration"
               for error in result.rows[0].errors)


@pytest.mark.parametrize("value", [None, "unknown", "yes", 2, -1, "=TRUE()"])
def test_malformed_abandonment(value):
    call = CALL.copy()
    call[1] = value
    result = parse_excel(workbook_bytes([call]))
    assert result.rows[0].status == "invalid"
    assert any(error.code == "invalid_boolean" for error in result.rows[0].errors)


@pytest.mark.parametrize("value,expected", [(True, True), (False, False), (1, True), (0, False), (" TRUE ", True), ("false", False), ("1", True), ("0", False)])
def test_supported_abandonment_values(value, expected):
    call = CALL.copy()
    call[1], call[4] = value, 10
    result = parse_excel(workbook_bytes([call]))
    assert result.ok
    assert result.valid_records[0]["abandoned"] is expected


@pytest.mark.parametrize("abandoned,index", [(False, 2), (False, 3), (True, 4)])
def test_durations_required_for_call_outcome(abandoned, index):
    call = CALL.copy()
    call[1], call[index] = abandoned, None
    result = parse_excel(workbook_bytes([call]))
    assert any(error.field == HEADERS[index] and error.code == "required_for_outcome"
               for error in result.rows[0].errors)


def test_abandoned_call_nullable_durations_and_zero_agent_time_are_preserved():
    abandoned = [CALL[0], True, None, None, 12, None, "abandoned-1"]
    answered = CALL.copy()
    answered[3] = 0
    result = parse_excel(workbook_bytes([abandoned, answered]))
    assert result.ok
    assert result.valid_records[0]["agent_sec"] is None
    assert result.valid_records[1]["agent_sec"] == 0


def test_duplicate_identifiers_flag_every_occurrence_including_conflicts():
    changed = CALL.copy()
    changed[3] = 900
    result = parse_excel(workbook_bytes([CALL, changed]), identifier_column="Call ID")
    assert result.summary == {"total_rows": 2, "valid_rows": 0, "invalid_rows": 0, "duplicate_rows": 2}
    assert not result.ok
    assert result.valid_records == []
    assert all(row.errors[0].code == "duplicate_identifier" for row in result.rows)


def test_duplicate_detection_is_explicit_and_does_not_assume_database_id():
    result = parse_excel(workbook_bytes([CALL, CALL]))
    assert result.summary["duplicate_rows"] == 0
    assert result.report()["duplicate_detection_enabled"] is False
    assert result.report()["warnings"]


@pytest.mark.parametrize("identifier", [None, " ", True, "=1+1", 1000000000000000])
def test_configured_identifier_must_be_reliable(identifier):
    call = CALL.copy()
    call[-1] = identifier
    result = parse_excel(workbook_bytes([call]), identifier_column="Call ID")
    assert any(error.code == "invalid_identifier" for error in result.rows[0].errors)


def test_large_text_identifiers_and_leading_zeroes_are_preserved():
    call = CALL.copy()
    call[-1] = "0001234567890123456789"
    result = parse_excel(workbook_bytes([call]), identifier_column="Call ID")
    assert result.ok
    assert result.rows[0].source_identifier == call[-1]


def test_summary_is_disjoint_and_blank_rows_are_not_silently_dropped():
    invalid = CALL.copy()
    invalid[0] = "bad date"
    # The invalid call also has a repeated identifier: it counts as invalid.
    unique = CALL.copy()
    unique[-1] = "unique-1"
    result = parse_excel(workbook_bytes([CALL, CALL, invalid, [None] * 7, unique]), identifier_column="Call ID")
    assert result.summary == {"total_rows": 5, "valid_rows": 1, "invalid_rows": 2, "duplicate_rows": 2}
    assert [row.row_number for row in result.rows] == [2, 3, 4, 5, 6]
    assert len(result.valid_records) == 1


def test_configurable_mapping_format_and_optional_routing():
    headers = ["When", "Outcome", "Queue", "Talk", "Wait", "Reference"]
    mapping = dict(zip(HEADERS[:5], headers[:5]))
    row = ["30/09/2026 13:45", "false", "10.5", "120", None, "ref-1"]
    result = parse_excel(workbook_bytes([row], headers), column_map=mapping,
                         timestamp_format="%d/%m/%Y %H:%M", identifier_column="Reference")
    assert result.ok
    assert result.valid_records[0]["start_ts"] == datetime(2026, 9, 30, 13, 45)
    assert result.valid_records[0]["in_queue_sec"] == 10.5
    assert result.valid_records[0]["routing_sec"] is None


@pytest.mark.parametrize("mapping", [{"bogus": "Date"}, {"start_ts": "abandoned"}, {"start_ts": 2}])
def test_bad_mapping_is_a_structured_file_error(mapping):
    result = parse_excel(workbook_bytes([CALL]), column_map=mapping)
    assert result.file_errors[0].code == "invalid_mapping"
    assert result.summary["invalid_rows"] == 1


def test_duplicate_headers_and_missing_identifier_column():
    result = parse_excel(workbook_bytes([CALL], ["start_ts"] * len(HEADERS)))
    assert result.file_errors[0].code == "invalid_headers"
    result = parse_excel(workbook_bytes([CALL]), identifier_column="Absent")
    assert result.file_errors[0].field == "identifier"


def test_unreadable_unsupported_and_missing_sheet(tmp_path):
    assert parse_excel(BytesIO(b"not an excel file")).file_errors[0].code == "unreadable_file"
    assert parse_excel(tmp_path / "missing.xlsx").file_errors[0].code == "unreadable_file"
    assert parse_excel(tmp_path / "input.csv").file_errors[0].code == "unsupported_file"
    assert parse_excel(workbook_bytes([CALL]), sheet="Absent").file_errors[0].code == "missing_sheet"
    assert parse_excel(workbook_bytes([CALL]), sheet="Calls").ok


def test_report_does_not_expose_cell_values():
    sensitive = "synthetic-private-value"
    call = CALL.copy()
    call[0], call[-1] = sensitive, sensitive
    result = parse_excel(workbook_bytes([call, call]), identifier_column="Call ID")
    report = json.dumps(result.report())
    assert sensitive not in report
    assert "record" not in result.report()
    assert result.report()["row_errors"][0]["row_number"] == 2


def test_cli_dry_run_json_exit_codes_and_mapping(tmp_path, capsys):
    path = tmp_path / "calls.xlsx"
    content = workbook_bytes([CALL]).getvalue()
    path.write_bytes(content)
    mapping = tmp_path / "mapping.json"
    mapping.write_text(json.dumps({"start_ts": "start_ts"}))
    assert main(["--file", str(path), "--dry-run", "--column-map", str(mapping),
                 "--identifier-column", "Call ID"]) == 0
    assert json.loads(capsys.readouterr().out)["summary"]["valid_rows"] == 1
    assert path.read_bytes() == content
    assert main(["--file", str(tmp_path / "missing.xlsx"), "--dry-run"]) == 1
    assert not json.loads(capsys.readouterr().out)["ok"]


def test_cli_requires_dry_run_and_rejects_bad_config(tmp_path, capsys):
    with pytest.raises(SystemExit) as exc:
        main(["--file", "unused.xlsx"])
    assert exc.value.code == 2
    capsys.readouterr()
    config = tmp_path / "bad.json"
    config.write_text('["synthetic-private-value"]')
    with pytest.raises(SystemExit) as exc:
        main(["--file", "unused.xlsx", "--dry-run", "--column-map", str(config)])
    assert exc.value.code == 2
    assert "synthetic-private-value" not in capsys.readouterr().err
