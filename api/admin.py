"""Admin API: everything under /api/admin.

    GET  /api/admin/config                 what the admin page needs to start the
                                           Auth0 sign-in: {domain, clientId, audience}.
                                           The only route here that needs no token.
    GET  /api/admin/me                     {sub, permissions} of the signed-in admin
    POST /api/admin/validate               multipart file; the validation report and
                                           the per-day plan (db.pipeline.inspect).
                                           Reads the database, stores nothing.
    POST /api/admin/uploads                multipart file; validates and stages a
                                           batch (db.pipeline.preview)
    POST /api/admin/uploads/{id}/import    {expected_rows, replace_days?}; imports a
                                           staged batch into calls (db.pipeline.commit_import)
    GET  /api/admin/uploads                the last 100 batches (db.pipeline.history)

A file may cover any range of whole days; there is no month to pick. Each
day in it is new, already loaded, or different from what is loaded, and a
different day is only replaced when the import request names exactly those
days in `replace_days`.

Who may call what is decided by the permissions inside an Auth0 access token
(api/auth.py), never by the shared-password session: api/site_auth.py lets
/api/admin/* through its gate for exactly that reason. `read:admin` reads;
`read:admin` + `import:calls` stages and imports.

Importing writes to the shared `calls` table, so it also needs the server
setting V4W_ADMIN_IMPORTS=1. Without it the import route answers 503 and
everything else still works: a deployment can show and validate without
being able to write.

api/main.py includes `router` and owns the two app-wide pieces that go with
it: the oversized-upload check and the PipelineError handler.
"""

from __future__ import annotations

import logging
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import date

import psycopg
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from api.auth import require_permissions
from api.auth0_config import auth0_config
from db import pipeline

log = logging.getLogger("v4w.api.admin")

# Room for the multipart boundaries around the workbook.
UPLOAD_ENVELOPE_BYTES = 64 * 1024
UPLOAD_PATHS = ("/api/admin/validate", "/api/admin/uploads")
TOO_LARGE = pipeline.TOO_LARGE
IMPORTS_SETTING = "V4W_ADMIN_IMPORTS"
IMPORTS_OFF = "Imports are switched off on this server. Validation and upload history still work."
# One request never needs to replace more than a year of days.
MAX_REPLACE_DAYS = 366
# Reading a workbook takes real CPU and memory. Only this many are read at
# once; a further request is told to come back, not queued.
PARSE_SLOTS = threading.BoundedSemaphore(2)
BUSY_RETRY_SEC = 5
BUSY = "Other files are being checked right now. Try again in a few seconds."

router = APIRouter(prefix="/api/admin", tags=["admin"])

require_admin = require_permissions("read:admin")
require_import = require_permissions("read:admin", "import:calls")


class ImportRequest(BaseModel):
    # The row count the admin confirms from the source export; must match the batch.
    expected_rows: int = Field(ge=1, le=pipeline.MAX_ROWS)
    # Exactly the days whose stored calls differ from the file and should be
    # replaced by it. Empty when the file only adds days.
    replace_days: list[date] = Field(default_factory=list, max_length=MAX_REPLACE_DAYS)


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


@contextmanager
def _parse_slot():
    if not PARSE_SLOTS.acquire(blocking=False):
        raise HTTPException(429, BUSY, headers={"Retry-After": str(BUSY_RETRY_SEC)})
    try:
        yield
    finally:
        PARSE_SLOTS.release()


def imports_enabled() -> bool:
    return os.environ.get(IMPORTS_SETTING) == "1"


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
def validate(file: UploadFile = File(...)):
    """Check a workbook and say what importing it would do, day by day.
    Nothing is stored, and call records are never sent back to the browser."""
    content = _read_upload(file)
    with _parse_slot(), _pipeline_connection() as conn:
        # On a self-committing connection read-only only applies inside a
        # transaction block, so the whole check runs in one.
        conn.read_only = True
        with conn.transaction():
            return pipeline.inspect(conn, content)


@router.post("/uploads", status_code=201)
def upload(file: UploadFile = File(...), user: dict = Depends(require_import)):
    content = _read_upload(file)
    with _parse_slot(), _pipeline_connection() as conn:
        return pipeline.preview(conn, content, user["sub"])


@router.post("/uploads/{batch_id}/import")
def import_batch(batch_id: uuid.UUID, body: ImportRequest, user: dict = Depends(require_import)):
    if not imports_enabled():
        raise HTTPException(503, IMPORTS_OFF)
    with _pipeline_connection() as conn:
        return pipeline.commit_import(conn, batch_id, expected_rows=body.expected_rows,
                                      replace_days=body.replace_days, actor=user["sub"])


@router.get("/uploads", dependencies=[Depends(require_admin)])
def history():
    with _pipeline_connection() as conn:
        return pipeline.history(conn)
