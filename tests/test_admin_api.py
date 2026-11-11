"""HTTP tests for the admin Excel upload routes.

Synthetic workbooks only. Database tests use an isolated schema from
V4W_TEST_DATABASE_URL or optional pgserver, never V4W_DATABASE_URL.
"""
from datetime import datetime
from io import BytesIO
import os
from pathlib import Path
import tempfile
import uuid

from fastapi.testclient import TestClient
from openpyxl import Workbook
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
import pytest

from api.main import app
from api.auth import verify_token
from db import pipeline
from db.ingest import PARTNER_COLUMNS

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
SEPTEMBER = [datetime(2026, 9, 1, 12), 10, 2, 300, "N", 0]

client = TestClient(app)


def workbook(rows=(SEPTEMBER,), *, sheet="Call Log"):
    wb = Workbook()
    wb.active.title = sheet
    wb.active.append(["Call Date/Time", "Inqueue Time", "Routing Time", "Agent Time", "Abandon", "Abandon Time"])
    for row in rows:
        wb.active.append(list(row))
    stream = BytesIO()
    wb.save(stream)
    wb.close()
    return stream.getvalue()


def post_file(path, content, month="2026-09"):
    return client.post(path, data={"month": month}, files={"file": ("calls.xlsx", content, XLSX)})


@pytest.fixture(autouse=True)
def no_dev_admin(monkeypatch):
    monkeypatch.delenv("V4W_INSECURE_DEV_ADMIN", raising=False)
    monkeypatch.delenv("V4W_EXPORT_CONTRACT", raising=False)


# --- validation only: no database, no sign-in --------------------------------

def test_validate_returns_report_without_records():
    response = post_file("/api/admin/validate", workbook())
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["summary"]["valid_rows"] == 1
    assert "records" not in body and "300" not in response.text


def test_validate_flags_calls_outside_the_selected_month():
    response = post_file("/api/admin/validate", workbook([[datetime(2026, 8, 31, 23), 10, 2, 300, "N", 0]]))
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["row_errors"][0]["errors"][0]["code"] == "outside_month"


@pytest.mark.parametrize("month", ["2026-9", "not-a-month", "9999-12"])
def test_validate_rejects_bad_or_incomplete_months(month):
    response = post_file("/api/admin/validate", workbook(), month=month)
    assert response.status_code == 400
    assert "completed reporting month" in response.json()["detail"]


def test_validate_rejects_non_workbook_and_empty_files():
    assert post_file("/api/admin/validate", b"not a workbook").status_code == 400
    assert post_file("/api/admin/validate", b"").status_code == 413


def test_oversized_upload_is_rejected(monkeypatch):
    monkeypatch.setattr(pipeline, "MAX_BYTES", 100)
    response = post_file("/api/admin/validate", workbook())
    assert response.status_code == 413


def test_oversized_declared_length_is_refused_before_parsing():
    response = client.post("/api/admin/uploads", content=b"x",
                           headers={"content-length": str(pipeline.MAX_BYTES * 2),
                                    "content-type": "multipart/form-data; boundary=x"})
    assert response.status_code == 413


# --- sign-in gate -------------------------------------------------------------

def test_admin_routes_refuse_requests_without_an_admin():
    assert post_file("/api/admin/uploads", workbook()).status_code == 401
    assert client.get("/api/admin/uploads").status_code == 401
    response = client.post(f"/api/admin/uploads/{uuid.uuid4()}/import", json={"expected_rows": 1})
    assert response.status_code == 401


# --- staging, import and history against an isolated schema ------------------

@pytest.fixture(scope="module")
def test_dsn():
    configured = os.getenv("V4W_TEST_DATABASE_URL")
    if configured:
        yield configured
        return
    pgserver = pytest.importorskip("pgserver", reason="Set V4W_TEST_DATABASE_URL or install pgserver for isolated DB tests")
    server = pgserver.get_server(Path(tempfile.mkdtemp(prefix="v4wpg-", dir="/tmp")), cleanup_mode="delete")
    try:
        yield server.get_uri()
    finally:
        server.cleanup()


@pytest.fixture
def authorized_actor():
    # Domain tests bypass only signature retrieval; real JWT route tests live in test_auth.py.
    app.dependency_overrides[verify_token] = lambda: {
        "sub": "auth0|test-admin", "permissions": ["read:admin", "import:calls"]}
    try:
        yield
    finally:
        app.dependency_overrides.pop(verify_token, None)


@pytest.fixture
def admin_db(test_dsn, monkeypatch, authorized_actor):
    schema = "admin_api_test_" + uuid.uuid4().hex
    with psycopg.connect(test_dsn, autocommit=True, row_factory=dict_row) as conn:
        conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        conn.execute(sql.SQL("SET search_path TO {}").format(sql.Identifier(schema)))
        conn.execute("""CREATE TABLE calls(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            start_ts timestamp NOT NULL, abandoned boolean NOT NULL,in_queue_sec double precision,
            agent_sec double precision,abandon_sec double precision,routing_sec double precision)""")
        pipeline.migrate(conn)
        profile = pipeline.ExportContract(confirmed=True, confirmed_by="Synthetic test fixture",
                                          source_namespace="test-inbound", sheet="Call Log",
                                          column_map=PARTNER_COLUMNS)
        monkeypatch.setattr(pipeline, "contract", lambda: profile)
        monkeypatch.setattr(pipeline, "connect", lambda: psycopg.connect(
            test_dsn, row_factory=dict_row, options=f"-c search_path={schema}"))
        try:
            yield conn
        finally:
            conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def stage(content=None):
    response = post_file("/api/admin/uploads", content or workbook())
    assert response.status_code == 201, response.text
    return response.json()


def test_upload_import_and_history(admin_db):
    batch = stage()
    assert batch["status"] == "validated" and batch["validation"]["ok"]
    assert admin_db.execute("SELECT count(*) AS n FROM calls").fetchone()["n"] == 0

    response = client.post(f"/api/admin/uploads/{batch['id']}/import", json={"expected_rows": 1})
    assert response.status_code == 200, response.text
    assert response.json() == {"id": batch["id"], "status": "imported"}
    assert admin_db.execute("SELECT count(*) AS n FROM calls").fetchone()["n"] == 1

    history = client.get("/api/admin/uploads").json()
    assert history[0]["id"] == batch["id"]
    assert history[0]["status"] == "imported"
    assert history[0]["uploader"] == history[0]["imported_by"] == "auth0|test-admin"


def test_invalid_workbook_is_staged_as_invalid_and_cannot_import(admin_db):
    batch = stage(workbook([[datetime(2026, 8, 1, 12), 10, 2, 300, "N", 0]]))
    assert batch["status"] == "invalid"
    response = client.post(f"/api/admin/uploads/{batch['id']}/import", json={"expected_rows": 1})
    assert response.status_code == 409


def test_wrong_row_count_is_a_conflict(admin_db):
    batch = stage()
    response = client.post(f"/api/admin/uploads/{batch['id']}/import", json={"expected_rows": 2})
    assert response.status_code == 409
    assert "row count" in response.json()["detail"]


def test_repeat_month_needs_explicit_replacement(admin_db):
    first = stage()
    client.post(f"/api/admin/uploads/{first['id']}/import", json={"expected_rows": 1})
    corrected = stage(workbook([[datetime(2026, 9, 1, 12), 10, 2, 450, "N", 0]]))

    blocked = client.post(f"/api/admin/uploads/{corrected['id']}/import", json={"expected_rows": 1})
    assert blocked.status_code == 409 and "already imported" in blocked.json()["detail"]

    replaced = client.post(f"/api/admin/uploads/{corrected['id']}/import",
                           json={"expected_rows": 1, "replace_batch_id": first["id"]})
    assert replaced.status_code == 200
    assert admin_db.execute("SELECT agent_sec FROM calls").fetchone()["agent_sec"] == 450


def test_unknown_batch_is_not_found(admin_db):
    response = client.post(f"/api/admin/uploads/{uuid.uuid4()}/import", json={"expected_rows": 1})
    assert response.status_code == 404


def test_missing_database_configuration_is_a_service_error(monkeypatch, authorized_actor):
    monkeypatch.delenv("V4W_DATABASE_URL", raising=False)
    assert client.get("/api/admin/uploads").status_code == 503


def test_configured_worksheet_validation_is_explicit_and_database_free(tmp_path, monkeypatch):
    import json
    contract = tmp_path / "synthetic-contract.json"
    contract.write_text(json.dumps({
        "source_namespace": "synthetic", "sheet": "Synthetic Export", "column_map": PARTNER_COLUMNS,
        "confirmed": False,
    }))
    monkeypatch.setenv("V4W_EXPORT_CONTRACT", str(contract))
    def no_database():
        pytest.fail("Validation must not connect to a database")
    monkeypatch.setattr(pipeline, "connect", no_database)
    wrong = post_file("/api/admin/validate", workbook())
    assert wrong.status_code == 200
    assert wrong.json()["file_errors"][0]["code"] == "missing_sheet"
    response = post_file("/api/admin/validate", workbook(sheet="Synthetic Export"))
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "records" not in response.json()
    outside = post_file("/api/admin/validate", workbook(
        [[datetime(2026, 8, 1), 10, 2, 300, "N", 0]], sheet="Synthetic Export"))
    assert outside.json()["ok"] is False
    assert outside.json()["row_errors"][0]["errors"][0]["code"] == "outside_month"


def test_invalid_configured_contract_does_not_fall_back_to_default(monkeypatch, tmp_path):
    monkeypatch.setenv("V4W_EXPORT_CONTRACT", str(tmp_path / "missing-contract.json"))
    response = post_file("/api/admin/validate", workbook())
    assert response.status_code == 503


def test_configured_validation_and_staging_use_the_same_worksheet(admin_db, monkeypatch):
    profile = pipeline.contract().model_copy(update={"sheet": "Synthetic Export", "confirmed": False})
    monkeypatch.setattr(pipeline, "contract", lambda: profile)
    monkeypatch.setenv("V4W_EXPORT_CONTRACT", "synthetic-test-contract")
    content = workbook(sheet="Synthetic Export")
    validation = post_file("/api/admin/validate", content)
    staged = stage(content)
    assert validation.json()["ok"] is True
    assert staged["validation"]["ok"] is True
    assert staged["validation"]["summary"] == validation.json()["summary"]
    assert staged["validation"]["contract_confirmed"] is False
    response = client.post(f"/api/admin/uploads/{staged['id']}/import", json={"expected_rows": 1})
    assert response.status_code == 409
    assert admin_db.execute("SELECT count(*) AS n FROM calls").fetchone()["n"] == 0
