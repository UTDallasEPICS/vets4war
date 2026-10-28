"""Synthetic workbooks matching the observed six-column partner Call Log.

No real export, database, environment file, or model is used by these tests.
"""
from datetime import datetime
from io import BytesIO
import json
from pathlib import Path

from openpyxl import Workbook
import pytest

from db.ingest import PARTNER_COLUMNS, main, parse_partner_excel


HEADERS = ["Call Date/Time", "Inqueue Time", "Routing Time", "Agent Time", "Abandon", "Abandon Time"]
ANSWERED = [datetime(2026, 9, 1, 0, 5, 30), 15, 2, 300, "N", 0]
ABANDONED = [datetime(2026, 9, 30, 23, 59, 59), 20, 0, 0, "Y", 20]


def workbook(rows, *, headers=HEADERS, sheet="Call Log"):
    wb = Workbook()
    wb.active.title = sheet
    wb.active.append(headers)
    for row in rows:
        wb.active.append(row)
    stream = BytesIO()
    wb.save(stream)
    wb.close()
    stream.seek(0)
    return stream


def test_partner_profile_normalizes_six_columns_without_an_identifier():
    content = workbook([ANSWERED, ABANDONED])
    original = content.getvalue()
    result = parse_partner_excel(content, month="2026-09")
    assert result.ok
    assert result.summary == {"total_rows": 2, "valid_rows": 2, "invalid_rows": 0, "duplicate_rows": 0}
    first, last = result.valid_records
    assert first == {"start_ts": ANSWERED[0], "abandoned": False, "in_queue_sec": 15.0,
                     "routing_sec": 2.0, "agent_sec": 300.0, "abandon_sec": 0.0}
    assert last["abandoned"] is True and last["agent_sec"] == 0 and last["abandon_sec"] == 20
    assert all(row.source_identifier is None for row in result.rows)
    assert "id" not in first
    assert not result.duplicate_detection_enabled
    assert result.report()["warnings"]
    assert content.getvalue() == original


@pytest.mark.parametrize("label,expected", [("Y", True), ("N", False), (" y ", True), (" n ", False)])
def test_partner_y_n_normalization(label, expected):
    row = ABANDONED.copy()
    row[4] = label
    result = parse_partner_excel(workbook([row]))
    assert result.ok
    assert result.valid_records[0]["abandoned"] is expected


@pytest.mark.parametrize("label", ["yes", "no", "unknown", "=TRUE()", None])
def test_unknown_or_formula_outcomes_fail_without_guessing(label):
    row = ANSWERED.copy()
    row[4] = label
    result = parse_partner_excel(workbook([row]))
    assert not result.ok
    assert result.report()["row_errors"][0]["row_number"] == 2
    assert any(issue.code == "invalid_boolean" for issue in result.rows[0].errors)


def test_original_timestamps_are_preserved_at_both_month_boundaries():
    result = parse_partner_excel(workbook([ANSWERED, ABANDONED]), month="2026-09")
    assert result.ok
    assert [r["start_ts"] for r in result.valid_records] == [ANSWERED[0], ABANDONED[0]]
    assert all(r["start_ts"].tzinfo is None for r in result.valid_records)


def test_out_of_month_rows_are_invalid_and_keep_original_excel_row_numbers():
    outside = ANSWERED.copy()
    outside[0] = datetime(2026, 10, 1, 0, 0)
    result = parse_partner_excel(workbook([ANSWERED, outside]), month="2026-09")
    assert not result.ok
    assert result.summary["valid_rows"] == 1 and result.summary["invalid_rows"] == 1
    assert result.report()["row_errors"][0]["row_number"] == 3
    assert result.report()["row_errors"][0]["errors"][0]["code"] == "outside_month"


@pytest.mark.parametrize("month", ["2026-9", "2026-13", "0000-01", "September", "", "2026-09-01"])
def test_invalid_month_is_rejected(month):
    result = parse_partner_excel(workbook([ANSWERED]), month=month)
    assert not result.ok and result.valid_records == []
    assert result.report()["file_errors"][0]["code"] == "invalid_month"


def test_historical_multi_month_file_can_be_checked_without_month_filter():
    older = ANSWERED.copy()
    older[0] = datetime(2021, 1, 1, 12)
    assert parse_partner_excel(workbook([older, ANSWERED])).ok


def test_missing_headers_and_wrong_sheet_are_rejected():
    missing = parse_partner_excel(workbook([ANSWERED[:-1]], headers=HEADERS[:-1]))
    assert not missing.ok and missing.valid_records == []
    assert any(issue.field == "abandon_sec" for issue in missing.file_errors)
    wrong_sheet = parse_partner_excel(workbook([ANSWERED], sheet="Calls"))
    assert wrong_sheet.report()["file_errors"][0]["code"] == "missing_sheet"


def test_negative_duration_and_ignored_private_columns_are_handled_safely():
    row = ANSWERED.copy()
    row[3] = -1
    result = parse_partner_excel(workbook([row + ["synthetic-private-value"]], headers=HEADERS + ["Ignored"]))
    assert not result.ok
    assert "synthetic-private-value" not in json.dumps(result.report())
    assert "Ignored" not in result.rows[0].record
    assert result.report()["row_errors"][0]["errors"][0]["field"] == "agent_sec"


def test_identical_rows_are_not_silently_deduplicated_without_call_ids():
    result = parse_partner_excel(workbook([ANSWERED, ANSWERED]))
    assert result.ok and result.summary["total_rows"] == 2
    assert result.summary["duplicate_rows"] == 0
    assert result.report()["warnings"]  # A valid workbook is not a safe-import certificate.


def test_partner_row_limit_never_returns_partially_accepted_records():
    result = parse_partner_excel(workbook([ANSWERED, ABANDONED]), max_rows=1)
    assert not result.ok and result.valid_records == []
    assert result.report()["file_errors"][0]["code"] == "too_many_rows"


def test_partner_cli_dry_run_and_month_check(tmp_path, capsys):
    file = tmp_path / "synthetic.xlsx"
    file.write_bytes(workbook([ANSWERED, ABANDONED]).getvalue())
    before = file.read_bytes()
    args = ["--file", str(file), "--profile", "partner", "--dry-run"]
    assert main(args + ["--month", "2026-09"]) == 0
    assert json.loads(capsys.readouterr().out)["summary"]["valid_rows"] == 2
    assert main(args + ["--month", "2026-10"]) == 1
    assert not json.loads(capsys.readouterr().out)["ok"]
    assert file.read_bytes() == before


def test_partner_cli_rejects_conflicting_overrides(capsys):
    with pytest.raises(SystemExit):
        main(["--file", "unused.xlsx", "--dry-run", "--profile", "partner", "--identifier-column", "fake-id"])
    capsys.readouterr()
    with pytest.raises(SystemExit):
        main(["--file", "unused.xlsx", "--dry-run", "--month", "2026-09"])


def test_draft_contract_matches_observed_headers_without_claiming_import_readiness():
    from db.pipeline import ExportContract
    example = Path(__file__).resolve().parents[1] / "config/export-contract.example.json"
    profile = ExportContract.model_validate_json(example.read_text())
    assert profile.sheet == "Call Log"
    assert profile.column_map == PARTNER_COLUMNS
    assert profile.identifier_column is None
    assert not profile.confirmed
    assert profile.timezone == "unconfirmed"
