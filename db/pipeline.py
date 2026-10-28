"""Ingestion-only monthly staging, imports and history.

No authentication, frontend, reporting, monitoring, training, or activation is
owned by this module. No migration or import runs on import/server startup.
The import draft still requires verified source IDs; the supplied six-column
export needs a separately implemented month-based identity/correction policy.
"""
from __future__ import annotations

import argparse
import calendar
import hashlib
from io import BytesIO
import os
from pathlib import Path
import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfo
from zipfile import BadZipFile, ZipFile

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from db.ingest import parse_excel

ROOT = Path(__file__).resolve().parent.parent
LOCK_ID = 74803219
MAX_BYTES = 25 * 1024 * 1024
MAX_UNPACKED = 100 * 1024 * 1024
MAX_ROWS = 100_000


class PipelineError(Exception):
    def __init__(self, message, status=409):
        self.status = status
        super().__init__(message)


class ExportContract(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmed: bool = False
    confirmed_by: str = ""
    source_namespace: str = Field(min_length=1, max_length=100)
    identifier_column: str = Field(min_length=1)
    sheet: str | None = None
    column_map: dict[str, str] = Field(default_factory=dict)
    timestamp_format: str | None = None
    timezone: Literal["America/New_York"] = "America/New_York"
    duration_unit: Literal["seconds"] = "seconds"
    one_row_per_inbound_call: Literal[True] = True
    correction_policy: Literal["replace_managed_month"] = "replace_managed_month"

    @property
    def fingerprint(self):
        return hashlib.sha256(self.model_dump_json().encode()).hexdigest()


def contract():
    path = os.getenv("V4W_EXPORT_CONTRACT")
    if not path:
        raise PipelineError("Configure the export contract using the historical Excel format first.", 503)
    try:
        return ExportContract.model_validate_json(Path(path).read_text())
    except Exception:
        raise PipelineError("The export contract is unreadable or invalid. Check the setup documentation.", 503) from None


def connect():
    dsn = os.getenv("V4W_DATABASE_URL")
    if not dsn:
        raise PipelineError("The application database is not configured.", 503)
    return psycopg.connect(dsn, row_factory=dict_row)


def month_start(value):
    try:
        parsed = date.fromisoformat(value + "-01")
        if parsed.strftime("%Y-%m") != value:
            raise ValueError
        if parsed >= datetime.now(ZoneInfo("America/New_York")).date().replace(day=1):
            raise ValueError
        return parsed
    except (ValueError, TypeError):
        raise PipelineError("Select a completed reporting month using YYYY-MM.", 400) from None


def next_month(month):
    return date(month.year + (month.month == 12), month.month % 12 + 1, 1)


def lock_import(conn):
    locked = conn.execute("SELECT pg_try_advisory_xact_lock(%s) AS locked", (LOCK_ID,)).fetchone()["locked"]
    if not locked:
        raise PipelineError("Another import is running. Try again when it finishes.")


def preview(conn, content, month, uploader, profile):
    if not content or len(content) > MAX_BYTES:
        raise PipelineError("Upload a nonempty Excel file no larger than 25 MB.", 413)
    try:
        with ZipFile(BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > 2000 or sum(entry.file_size for entry in entries) > MAX_UNPACKED:
                raise PipelineError("The expanded workbook is too large.", 413)
    except BadZipFile:
        raise PipelineError("Upload a valid .xlsx workbook.", 400) from None
    result = parse_excel(BytesIO(content), sheet=profile.sheet, column_map=profile.column_map,
                         timestamp_format=profile.timestamp_format, identifier_column=profile.identifier_column,
                         max_rows=MAX_ROWS)
    report = result.report()
    report["month"] = month.strftime("%Y-%m")
    report["contract_confirmed"] = profile.confirmed and bool(profile.confirmed_by.strip())
    outside = [r.row_number for r in result.rows if r.record.get("start_ts") and
               not month <= r.record["start_ts"].date() < next_month(month)]
    if outside:
        report["ok"] = False
        report["file_errors"].append({"field": "start_ts", "code": "outside_month",
                                      "message": "All calls must belong to the selected reporting month."})
    dates = {r.record["start_ts"].day for r in result.rows if r.record.get("start_ts") and
             r.record["start_ts"].date().replace(day=1) == month}
    report["days_without_calls"] = [day for day in range(1, calendar.monthrange(month.year, month.month)[1] + 1)
                                    if day not in dates]
    report["warnings"].append("Date coverage cannot prove completeness. Confirm the full-month export and source row count before import.")
    # Error reports remain bounded; the full counts still describe the workbook.
    report["row_errors_truncated"] = len(report["row_errors"]) > 200
    report["row_errors"] = report["row_errors"][:200]
    records = [{**row.record, "start_ts": row.record["start_ts"].isoformat(),
                "source_id": row.source_identifier} for row in result.rows] if report["ok"] else None
    fingerprint = hashlib.sha256(content).hexdigest()
    batch_id = uuid.uuid4()
    with conn.transaction():
        # Never store original workbooks or ignored caller-identifying columns.
        row = conn.execute("""
            INSERT INTO pipeline_batches(id,uploader,month,file_hash,contract_hash,source_namespace,status,summary,records)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (file_hash,contract_hash,month) DO UPDATE
                SET records=excluded.records,status=excluded.status,summary=excluded.summary,
                    uploader=excluded.uploader,created_at=now(),expires_at=excluded.expires_at
                WHERE pipeline_batches.status='expired' OR
                    (pipeline_batches.status='validated' AND pipeline_batches.expires_at<now())
            RETURNING id,status,summary
        """, (batch_id, uploader, month, fingerprint, profile.fingerprint, profile.source_namespace,
              "validated" if report["ok"] else "invalid", Jsonb(report), Jsonb(records) if records else None)).fetchone()
        if row is None:
            row = conn.execute("SELECT id,status,summary FROM pipeline_batches WHERE file_hash=%s AND contract_hash=%s AND month=%s",
                               (fingerprint, profile.fingerprint, month)).fetchone()
    return {"id": str(row["id"]), "status": row["status"], "validation": row["summary"]}


def commit_import(conn, batch_id, profile, *, expected_rows, replace_batch_id=None, actor=None):
    if not profile.confirmed or not profile.confirmed_by.strip():
        raise PipelineError("Confirm the historical export format and stable call identifier before enabling imports.")
    with conn.transaction():
        lock_import(conn)
        batch = conn.execute("SELECT *, expires_at > now() AS fresh FROM pipeline_batches WHERE id=%s FOR UPDATE",
                             (batch_id,)).fetchone()
        if not batch:
            raise PipelineError("Upload not found.", 404)
        if batch["status"] != "validated" or not batch["fresh"] or not batch["records"]:
            raise PipelineError("This upload is invalid, expired, or already imported. Upload a fresh valid file.")
        if batch["contract_hash"] != profile.fingerprint:
            raise PipelineError("The export contract changed. Validate the file again.")
        if len(batch["records"]) != expected_rows:
            raise PipelineError("The confirmed source row count does not match the upload.")
        # Never invent IDs or reuse sponsor IDs as database primary keys.
        generated = conn.execute("""SELECT column_default, is_identity FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='calls' AND column_name='id'""").fetchone()
        if not generated or not (generated["column_default"] or generated["is_identity"] == "YES"):
            raise PipelineError("calls.id must have a verified database-generated default before imports can run.")
        # Legacy writers must also be excluded while checking monthly overlap.
        conn.execute("LOCK TABLE calls IN SHARE ROW EXCLUSIVE MODE")
        month = batch["month"]
        prior = conn.execute("SELECT id FROM pipeline_batches WHERE month=%s AND status='imported' FOR UPDATE",
                             (month,)).fetchone()
        if prior and str(prior["id"]) != str(replace_batch_id):
            raise PipelineError("This month is already imported. Select its current batch explicitly to replace it.")
        if not prior and replace_batch_id:
            raise PipelineError("The selected replacement batch is no longer current.")
        unmanaged = conn.execute("""SELECT count(*) AS n FROM calls c LEFT JOIN pipeline_call_links l ON l.call_id=c.id
            WHERE c.start_ts >= %s AND c.start_ts < %s AND (l.batch_id IS NULL OR l.batch_id IS DISTINCT FROM %s::uuid)
        """, (month, next_month(month), prior["id"] if prior else None)).fetchone()["n"]
        if unmanaged:
            raise PipelineError("This month overlaps existing unmanaged records. Reconcile the historical import before continuing.")
        if prior:
            old_ids = conn.execute("DELETE FROM pipeline_call_links WHERE batch_id=%s RETURNING call_id",
                                   (prior["id"],)).fetchall()
            conn.execute("DELETE FROM calls WHERE id=ANY(%s)", ([r["call_id"] for r in old_ids],))
            conn.execute("UPDATE pipeline_batches SET status='superseded' WHERE id=%s", (prior["id"],))
        records = batch["records"]
        existing = conn.execute("SELECT 1 FROM pipeline_call_links WHERE source_namespace=%s AND source_id=ANY(%s) LIMIT 1",
                                (profile.source_namespace, [r["source_id"] for r in records])).fetchone()
        if existing:
            raise PipelineError("A source call identifier is already imported in another month. No records were changed.")
        # Psycopg batches executemany through its pipeline to avoid a network
        # round trip per row when the database is remote.
        with conn.cursor() as cursor:
            cursor.executemany("""INSERT INTO calls(start_ts,abandoned,in_queue_sec,agent_sec,abandon_sec,routing_sec)
                VALUES (%s,%s,%s,%s,%s,%s) RETURNING id""",
                [tuple(r[k] for k in ("start_ts", "abandoned", "in_queue_sec", "agent_sec", "abandon_sec", "routing_sec"))
                 for r in records], returning=True)
            call_ids = []
            while True:
                call_ids.append(cursor.fetchone()["id"])
                if not cursor.nextset():
                    break
            cursor.executemany("INSERT INTO pipeline_call_links VALUES (%s,%s,%s,%s)",
                               [(profile.source_namespace, r["source_id"], call_id, batch_id)
                                for r, call_id in zip(records, call_ids, strict=True)])
        conn.execute("UPDATE pipeline_batches SET status='imported',imported_at=now(),imported_by=%s,records=NULL,replaced_batch_id=%s WHERE id=%s",
                     (actor or batch["uploader"], prior["id"] if prior else None, batch_id))
        conn.execute("UPDATE pipeline_state SET revision=revision+1")
    return {"id": str(batch_id), "status": "imported"}


def history(conn):
    return conn.execute("""SELECT id,created_at,uploader,month,status,summary,imported_at,imported_by,replaced_batch_id
        FROM pipeline_batches ORDER BY created_at DESC LIMIT 100""").fetchall()


def purge_expired(conn):
    """Remove stale staged values explicitly; retain the batch audit record."""
    with conn.transaction():
        lock_import(conn)
        result = conn.execute("UPDATE pipeline_batches SET records=NULL,status='expired' WHERE status='validated' AND expires_at<now()")
    return result.rowcount


def revision(conn):
    # Available to future consumers; this module does not refresh model caches.
    with conn.cursor(row_factory=dict_row) as cursor:
        return cursor.execute("SELECT revision FROM pipeline_state WHERE singleton").fetchone()["revision"]


def migrate(conn):
    with conn.transaction():
        conn.execute((ROOT / "db/migrations/001_ingestion.sql").read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["migrate", "purge-expired"])
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv()
    with connect() as conn:
        if args.command == "migrate":
            migrate(conn)
            print("Ingestion migration applied.")
        else:
            print(f"Expired staged batches cleared: {purge_expired(conn)}")


if __name__ == "__main__":
    main()
