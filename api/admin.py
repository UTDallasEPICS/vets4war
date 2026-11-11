"""Admin API: everything under /api/admin.

    GET  /api/admin/config                 what the admin page needs to start the
                                           Auth0 sign-in: {domain, clientId, audience}.
                                           The only route here that needs no token.
    GET  /api/admin/me                     {sub, permissions} of the signed-in admin
    POST /api/admin/validate               multipart file + optional month=YYYY-MM;
                                           validation report only, nothing stored
    POST /api/admin/uploads                multipart file + month=YYYY-MM; validates
                                           and stages a batch (db.pipeline.preview)
    POST /api/admin/uploads/{id}/import    {expected_rows, replace_batch_id?}; imports a
                                           staged batch into calls (db.pipeline.commit_import)
    GET  /api/admin/uploads                the last 100 batches (db.pipeline.history)

Who may call what is decided by the permissions inside an Auth0 access token
(api/auth.py), never by the shared-password session: api/site_auth.py lets
/api/admin/* through its gate for exactly that reason. `read:admin` reads;
`read:admin` + `import:calls` stages and imports.

api/main.py includes `router` and owns the two app-wide pieces that go with
it: the oversized-upload check and the PipelineError handler.
"""

from __future__ import annotations

import logging
import os
import uuid
from io import BytesIO

import psycopg
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from api.auth import require_permissions
from api.auth0_config import auth0_config
from db import pipeline
from db.ingest import parse_partner_excel

log = logging.getLogger("v4w.api.admin")

# Room for the multipart boundaries and the month field around the workbook.
UPLOAD_ENVELOPE_BYTES = 64 * 1024
UPLOAD_PATHS = ("/api/admin/validate", "/api/admin/uploads")
TOO_LARGE = "Upload a nonempty Excel file no larger than 25 MB."
MAX_ROW_ERRORS_SHOWN = 200
VALIDATION_ONLY = ("Validation only: no records were staged or imported. "
                   "Import requires a complete export for one completed reporting month.")

router = APIRouter(prefix="/api/admin", tags=["admin"])

require_admin = require_permissions("read:admin")
require_import = require_permissions("read:admin", "import:calls")


class ImportRequest(BaseModel):
    # The row count the admin confirms from the source export; must match the batch.
    expected_rows: int = Field(ge=1, le=pipeline.MAX_ROWS)
    # Required only to replace a month that is already imported.
    replace_batch_id: uuid.UUID | None = None


def _read_upload(file: UploadFile) -> bytes:
    content = file.file.read(pipeline.MAX_BYTES + 1)
    if not content or len(content) > pipeline.MAX_BYTES:
        raise HTTPException(413, TOO_LARGE)
    return content


def _pipeline_connection():
    try:
        return pipeline.connect()
    except psycopg.OperationalError as exc:
        log.exception("pipeline database connection failed")
        raise HTTPException(503, "The application database is unavailable. Try again later.") from exc


def _months_found(rows) -> dict[str, int]:
    """Calls per calendar month in a parsed workbook, oldest month first."""
    months: dict[str, int] = {}
    for row in rows:
        stamp = row.record.get("start_ts")
        if stamp is not None:
            key = stamp.strftime("%Y-%m")
            months = {**months, key: months.get(key, 0) + 1}
    return dict(sorted(months.items()))


@router.get("/config")
def config():
    """Public on purpose: the page needs these before anyone can sign in, and
    none of them is a secret."""
    settings = auth0_config(os.environ)
    if settings is None:
        raise HTTPException(503, "Admin sign-in is not configured on this server.")
    return {"domain": settings.domain, "clientId": settings.client_id, "audience": settings.audience}


@router.get("/me")
def me(claims: dict = Depends(require_admin)):
    return {"sub": claims["sub"], "permissions": claims["permissions"]}


@router.post("/validate", dependencies=[Depends(require_admin)])
def validate(file: UploadFile = File(...), month: str | None = Form(None)):
    """Check the configured export layout (default: partner Call Log). Nothing is
    stored, and normalized call records are never sent back to the browser."""
    # Omit month for format-only testing, including cross-month weekly exports.
    # Explicit month checks remain available; staging/import always require one.
    month_value = pipeline.month_start(month) if month is not None else None
    content = _read_upload(file)
    pipeline.check_archive(content)
    # Match staging's explicit sheet/mapping without opening a DB connection.
    # An invalid configured contract fails closed; never guess another sheet.
    options = pipeline.contract().parser_options() if os.environ.get("V4W_EXPORT_CONTRACT") else {}
    result = parse_partner_excel(BytesIO(content), month=month_value.strftime("%Y-%m") if month_value else None,
                                 max_rows=pipeline.MAX_ROWS, **options)
    report = result.report()
    return {
        **report,
        "months_found": _months_found(result.rows),
        "validation_scope": "single_month" if month_value else "format_only",
        "warnings": [*report["warnings"], VALIDATION_ONLY],
        "row_errors_truncated": len(report["row_errors"]) > MAX_ROW_ERRORS_SHOWN,
        "row_errors": report["row_errors"][:MAX_ROW_ERRORS_SHOWN],
    }


@router.post("/uploads", status_code=201)
def upload(file: UploadFile = File(...), month: str = Form(...), user: dict = Depends(require_import)):
    month_value = pipeline.month_start(month)
    content = _read_upload(file)
    profile = pipeline.contract()
    with _pipeline_connection() as conn:
        return pipeline.preview(conn, content, month_value, user["sub"], profile)


@router.post("/uploads/{batch_id}/import")
def import_batch(batch_id: uuid.UUID, body: ImportRequest, user: dict = Depends(require_import)):
    profile = pipeline.contract()
    with _pipeline_connection() as conn:
        return pipeline.commit_import(conn, batch_id, profile, expected_rows=body.expected_rows,
                                      replace_batch_id=body.replace_batch_id, actor=user["sub"])


@router.get("/uploads", dependencies=[Depends(require_admin)])
def history():
    with _pipeline_connection() as conn:
        return pipeline.history(conn)
