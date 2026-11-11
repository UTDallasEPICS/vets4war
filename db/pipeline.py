"""Day-range staging, imports and history for client call-record workbooks.

The unit of an upload is a whole calendar day, not a month. A workbook may
hold one week, six weeks or several years; the client's three layouts are
all read by db.client_files. For every day in the file the import decides,
by comparing with what `calls` holds for that day (db.day_ledger):

    new        no call that day in the database   -> inserted
    identical  exactly these calls already there  -> skipped
    conflict   different calls already there      -> nothing happens unless the
               admin names exactly those days in `replace_days`; then that
               day's rows are deleted and the file's rows inserted

The comparison is always against the live `calls` table, so history loaded
before this ledger existed (db.load_week and earlier loaders) takes part like
any other rows: it neither blocks an import nor gets duplicated.

    inspect(conn, content)                    the validation report; writes nothing
    preview(conn, content, uploader)          validate and stage a batch
    commit_import(conn, batch_id, ...)        import a staged batch
    import_calls(conn, calls, uploader, ...)  import without staging (command line,
                                              files too big for the web upload)
    history(conn)                             the last 100 batches

Refused outright, with a reason in the report: a file that cannot be read as
call records, a day that is today or later (Eastern time), a first or last
day that is cut short, the same day on two sheets, and more rows than
MAX_ROWS for a staged upload.

Every import is one transaction under an advisory lock and a table lock: it
re-reads the database, re-plans, and either does everything or nothing. No
migration or import runs on import/server startup, and this module never
retrains a model.

Command line (from the repo root):

    python -m db.pipeline migrate [--dry-run]
    python -m db.pipeline purge-expired
    python -m db.pipeline import FILE [--replace-days YYYY-MM-DD ...] [--commit]
"""
from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import logging
import os
from pathlib import Path
import re
import sys
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from zipfile import BadZipFile, ZipFile

from openpyxl.utils.exceptions import InvalidFileException
import pandas as pd
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from db.client_files import hourly_from_calls, read_call_sheets
from db.dataset import partial_edge_days
from db.day_ledger import CALL_COLUMNS, CONFLICT, IDENTICAL, NEW, call_lines, describe_plan, plan_days, summarize_days
from db.load_week import CallRecordsError

log = logging.getLogger("v4w.pipeline")

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ("001_ingestion.sql", "002_day_ranges.sql")
LOCK_ID = 74803219
# The web upload. Real weekly exports are about 0.1 MB and six weeks about
# 0.4 MB; the multi-year workbook goes through the command line instead.
MAX_BYTES = 4 * 1024 * 1024
# Unpacked size and sheet count bound what one upload can cost to read: a
# small archive can otherwise unpack to, or point many sheets at, far more.
MAX_UNPACKED = 32 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 2000
MAX_SHEETS = 16
MAX_ROWS = 100_000
WORKBOOK_RELATIONSHIPS = "xl/_rels/workbook.xml.rels"
RELATIONSHIP = re.compile(rb"<Relationship\b[^>]*>")
WORKSHEET_TYPE = re.compile(rb'Type="[^"]*/worksheet"')
TARGET = re.compile(rb'Target="([^"]*)"')
EASTERN = ZoneInfo("America/New_York")
# Stored in pipeline_batches.contract_hash: which reader produced the staged
# rows. A batch staged by another reader has to be validated again.
PARSER_VERSION = "client-call-records-v1"
SOURCE_NAMESPACE = "client-export"
ONE_DAY = timedelta(days=1)
MAX_DAYS_IN_MESSAGE = 10
# Key under which read_calls notes, on the frame it returns, the days whose
# calls were spread over more than one sheet (combined, and reported).
SPLIT_DAYS = "days_split_across_sheets"
TOO_LARGE = "Upload a nonempty Excel file no larger than 4 MB."
NOT_A_WORKBOOK = "Upload a valid .xlsx workbook."
UNREADABLE = "This file could not be read as call records. Check it is the call-records export and try again."


class PipelineError(Exception):
    """`status` is the HTTP status the admin API answers with; `code` names
    the reason in a validation report."""

    def __init__(self, message, status=409, code="unreadable"):
        self.status = status
        self.code = code
        super().__init__(message)


def connect():
    """A connection to the application database. autocommit, so each
    `with conn.transaction()` block in this module really commits when it
    ends (on a default connection it would only be a savepoint inside a
    transaction that commits whenever the caller closes the connection).
    No prepared statements, so a transaction-mode pooler also works."""
    dsn = os.getenv("V4W_DATABASE_URL")
    if not dsn:
        raise PipelineError("The application database is not configured.", 503)
    return psycopg.connect(dsn, row_factory=dict_row, autocommit=True, prepare_threshold=None)


def _require_autocommit(conn) -> None:
    if not conn.autocommit:
        raise RuntimeError("imports need an autocommit connection (db.pipeline.connect()): otherwise the import "
                           "would be reported as done before it is committed")


def lock_import(conn):
    with conn.cursor(row_factory=dict_row) as cursor:
        locked = cursor.execute("SELECT pg_try_advisory_xact_lock(%s) AS locked", (LOCK_ID,)).fetchone()["locked"]
    if not locked:
        raise PipelineError("Another import is running. Try again when it finishes.")


def _worksheet_targets(archive: ZipFile) -> list[bytes]:
    """The worksheet part each sheet of the workbook points at."""
    try:
        relationships = archive.read(WORKBOOK_RELATIONSHIPS)
    except KeyError:
        raise PipelineError(NOT_A_WORKBOOK, 400) from None
    targets = []
    for tag in RELATIONSHIP.findall(relationships):
        target = TARGET.search(tag)
        if WORKSHEET_TYPE.search(tag) and target:
            targets.append(target.group(1))
    return targets


def check_archive(content):
    """Refuse oversized, non-ZIP or oddly built uploads before any worksheet
    is parsed, so a small file cannot be made expensive to read."""
    if not content or len(content) > MAX_BYTES:
        raise PipelineError(TOO_LARGE, 413)
    try:
        with ZipFile(BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ARCHIVE_ENTRIES or sum(entry.file_size for entry in entries) > MAX_UNPACKED:
                raise PipelineError("The expanded workbook is too large.", 413)
            targets = _worksheet_targets(archive)
    except BadZipFile:
        raise PipelineError(NOT_A_WORKBOOK, 400) from None
    if len(targets) > MAX_SHEETS:
        raise PipelineError(f"The workbook has too many sheets ({len(targets)}); the limit is {MAX_SHEETS}.", 400)
    if len(set(targets)) != len(targets):
        raise PipelineError("Two or more sheets of this workbook share one worksheet. Export the file again.", 400)


# =============================================================================
# Reading and checking a file (no database)
# =============================================================================

def _today() -> date:
    return datetime.now(EASTERN).date()


def _issue(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def _listed(days) -> str:
    """Days as text for a message, capped so a multi-year file stays readable."""
    names = [day.isoformat() if isinstance(day, date) else str(day) for day in sorted(days)]
    more = len(names) - MAX_DAYS_IN_MESSAGE
    return ", ".join(names[:MAX_DAYS_IN_MESSAGE]) + (f" and {more} more" if more > 0 else "")


def _days_on_two_sheets(sheets: dict[str, pd.DataFrame]) -> tuple[set[date], set[date]]:
    """(copied, split): days on which some call appears on two sheets, and
    days whose calls are merely spread over sheets. A repeated call would be
    stored twice, so it is refused; a split is how the client's multi-year
    workbook ends each year (the last calls of Dec 31 sit on the next sheet)."""
    seen: dict[date, set[str]] = {}
    copied, split = set(), set()
    for calls in sheets.values():
        for day, lines in call_lines(calls).groupby(calls["start_ts"].dt.date):
            if day in seen:
                (copied if seen[day] & set(lines) else split).add(day)
            seen = {**seen, day: seen.get(day, set()) | set(lines)}
    return copied, split - copied


def read_calls(source) -> pd.DataFrame:
    """Every call in a client workbook (bytes, a path or an open file), sorted
    by start_ts. Raises PipelineError when it cannot be read as call records
    or carries the same call on two sheets."""
    try:
        sheets = read_call_sheets(BytesIO(source) if isinstance(source, bytes) else source)
    except CallRecordsError as error:
        # These messages name columns and Excel row numbers, never cell values.
        raise PipelineError(f"This file could not be read as call records: {error}.", 400) from None
    except Exception:
        # Anything else (a damaged archive, malformed sheet XML, a pandas
        # conversion error) may quote cell contents: log it, show nothing of it.
        log.exception("call-records workbook could not be read")
        raise PipelineError(UNREADABLE, 400) from None
    copied, split = _days_on_two_sheets(sheets)
    if copied:
        raise PipelineError(f"The same calls for {_listed(copied)} appear on more than one sheet. "
                            "Remove the copy so each call is in the file once.", 400, "day_on_two_sheets")
    calls = pd.concat(list(sheets.values()), ignore_index=True).sort_values("start_ts", kind="stable").reset_index(drop=True)
    calls.attrs[SPLIT_DAYS] = sorted(split)
    return calls


def _file_errors(calls: pd.DataFrame, today: date, max_rows: int | None) -> list[dict]:
    """Reasons this file may not be imported at all, whatever the database holds."""
    errors = []
    if max_rows is not None and len(calls) > max_rows:
        errors.append(_issue("too_many_rows", f"The file has {len(calls):,} calls; the upload limit is {max_rows:,}. "
                                              "Split it, or load it from the command line."))
    unfinished = sorted({day for day in calls["start_ts"].dt.date if day >= today})
    if unfinished:
        errors.append(_issue("day_not_finished", f"Only finished days can be imported; the file includes {_listed(unfinished)}. "
                                                 f"Export up to {(today - ONE_DAY).isoformat()}."))
    cut_short = partial_edge_days(hourly_from_calls(calls))
    if cut_short:
        errors.append(_issue("partial_day", f"The file starts or stops part-way through a day ({_listed(cut_short)}). "
                                            "Export whole days."))
    return errors


def _days_without_calls(calls: pd.DataFrame) -> list[str]:
    days = set(calls["start_ts"].dt.date)
    first, last = min(days), max(days)
    return [(first + ONE_DAY * offset).isoformat() for offset in range((last - first).days + 1)
            if first + ONE_DAY * offset not in days]


def _warnings(gaps: list[str], split_days: list[date]) -> list[str]:
    """Things worth a look that do not stop an import."""
    warnings = []
    if gaps:
        warnings.append(f"{len(gaps)} day(s) inside the file's range have no calls: {_listed(gaps)}. "
                        "Check the export is complete.")
    if split_days:
        warnings.append(f"{len(split_days)} day(s) have calls on more than one sheet and were combined: {_listed(split_days)}.")
    return warnings


def _unreadable_report(error: PipelineError) -> dict:
    return {"ok": False, "nothing_to_import": False, "summary": {"total_rows": 0}, "days": [],
            "days_without_calls": [], "file_errors": [_issue(error.code, str(error))], "warnings": []}


# =============================================================================
# Comparing with the database
# =============================================================================

def _stored_calls(conn, days) -> pd.DataFrame:
    """The `calls` rows on exactly these days. Only the file's own days are
    read: a file with one call in 1990 and one yesterday reads two days, not
    the whole table."""
    with conn.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(
            """SELECT c.start_ts,c.in_queue_sec,c.agent_sec,c.abandon_sec,c.routing_sec,c.abandoned
               FROM unnest(%s::date[]) AS wanted(day)
               JOIN calls c ON c.start_ts >= wanted.day AND c.start_ts < wanted.day + 1""",
            (sorted(days),)).fetchall()
    return pd.DataFrame(rows, columns=list(CALL_COLUMNS))


def _count(plan: dict[date, str], status: str) -> int:
    return sum(1 for value in plan.values() if value == status)


def _report(conn, calls: pd.DataFrame, today: date, max_rows: int | None) -> dict:
    """The validation report for parsed calls: what the file covers, what is
    wrong with it, and what each of its days would do to the database."""
    file_days = summarize_days(calls)
    first_day, last_day = min(file_days), max(file_days)
    current_days = summarize_days(_stored_calls(conn, file_days))
    plan = plan_days(file_days, current_days)
    errors = _file_errors(calls, today, max_rows)
    gaps = _days_without_calls(calls)
    return {
        "ok": not errors,
        "nothing_to_import": not errors and _count(plan, IDENTICAL) == len(plan),
        "summary": {"total_rows": len(calls), "first_day": first_day.isoformat(), "last_day": last_day.isoformat(),
                    "days": len(plan), "new_days": _count(plan, NEW), "identical_days": _count(plan, IDENTICAL),
                    "conflict_days": _count(plan, CONFLICT)},
        "days": describe_plan(file_days, current_days),
        "days_without_calls": gaps,
        "file_errors": errors,
        "warnings": _warnings(gaps, calls.attrs.get(SPLIT_DAYS, [])),
    }


def inspect(conn, content: bytes, *, today: date | None = None) -> dict:
    """Validate an uploaded workbook and say what importing it would do.
    Reads the database; writes nothing."""
    check_archive(content)
    try:
        calls = read_calls(content)
    except PipelineError as error:
        if error.status != 400:
            raise
        return _unreadable_report(error)
    return _report(conn, calls, today or _today(), MAX_ROWS)


# =============================================================================
# Staging
# =============================================================================

def _records(calls: pd.DataFrame) -> list[dict]:
    """Parsed calls as JSON rows. Only the six `calls` values: no workbook,
    no caller-identifying column is ever stored."""
    rows = calls[list(CALL_COLUMNS)].to_dict("records")
    return [{**row, "start_ts": row["start_ts"].isoformat(), "abandoned": bool(row["abandoned"])} for row in rows]


def _calls_from_records(records: list[dict]) -> pd.DataFrame:
    frame = pd.DataFrame(records, columns=list(CALL_COLUMNS))
    return frame.assign(start_ts=pd.to_datetime(frame["start_ts"], format="ISO8601"))


def _insert_batch(conn, batch_id, uploader, file_hash, report, *, status, records=None, imported_by=None):
    summary = report["summary"]
    conn.execute(
        """INSERT INTO pipeline_batches(id,uploader,month,first_day,last_day,file_hash,contract_hash,source_namespace,
                                        status,summary,records,imported_at,imported_by)
           VALUES (%s,%s,NULL,%s,%s,%s,%s,%s,%s,%s,%s,CASE WHEN %s THEN now() END,%s)""",
        (batch_id, uploader, summary.get("first_day"), summary.get("last_day"), file_hash, PARSER_VERSION,
         SOURCE_NAMESPACE, status, Jsonb(report), Jsonb(records) if records is not None else None,
         status == "imported", imported_by))


def preview(conn, content: bytes, uploader: str, *, today: date | None = None) -> dict:
    """Validate an uploaded workbook and stage it for seven days. Nothing is
    written to `calls`. Returns {id, status, validation}."""
    check_archive(content)
    try:
        calls = read_calls(content)
    except PipelineError as error:
        if error.status != 400:
            raise
        calls, report = None, _unreadable_report(error)
    else:
        report = _report(conn, calls, today or _today(), MAX_ROWS)
    batch_id = uuid.uuid4()
    status = "validated" if report["ok"] else "invalid"
    with conn.transaction():
        # Staged rows are only good for seven days; clear the stale ones as we go.
        conn.execute("UPDATE pipeline_batches SET records=NULL,status='expired' WHERE status='validated' AND expires_at<now()")
        _insert_batch(conn, batch_id, uploader, hashlib.sha256(content).hexdigest(), report, status=status,
                      records=_records(calls) if report["ok"] else None)
    return {"id": str(batch_id), "status": status, "validation": report}


# =============================================================================
# Importing
# =============================================================================

def _require_generated_ids(conn) -> None:
    """Internal row IDs come from the database, not an Excel column."""
    with conn.cursor(row_factory=dict_row) as cursor:
        generated = cursor.execute("""SELECT column_default, is_identity FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='calls' AND column_name='id'""").fetchone()
    if not generated or not (generated["column_default"] or generated["is_identity"] == "YES"):
        raise PipelineError("calls.id must have a verified database-generated default before imports can run.")


def _delete_days(conn, days: list[date]) -> tuple[list[dict], set]:
    """Remove every `calls` row on these days, and the ledger links to them.
    Returns (the rows removed, batches that lost links)."""
    if not days:
        return [], set()
    with conn.cursor(row_factory=dict_row) as cursor:
        links = cursor.execute("""DELETE FROM pipeline_call_links l USING calls c, unnest(%s::date[]) AS gone(day)
            WHERE l.call_id=c.id AND c.start_ts >= gone.day AND c.start_ts < gone.day + 1
            RETURNING l.batch_id""", (days,)).fetchall()
        removed = cursor.execute("""DELETE FROM calls c USING unnest(%s::date[]) AS gone(day)
            WHERE c.start_ts >= gone.day AND c.start_ts < gone.day + 1
            RETURNING c.start_ts,c.in_queue_sec,c.agent_sec,c.abandon_sec,c.routing_sec,c.abandoned""", (days,)).fetchall()
    return removed, {link["batch_id"] for link in links}


def _insert_calls(conn, batch_id, calls: pd.DataFrame) -> int:
    """Insert these calls and link each to the batch, in one statement.
    Returns rows inserted."""
    if calls.empty:
        return 0
    columns = [calls["start_ts"].dt.to_pydatetime().tolist(), calls["abandoned"].astype(bool).tolist()]
    columns += [[None if pd.isna(value) else float(value) for value in calls[name]]
                for name in ("in_queue_sec", "agent_sec", "abandon_sec", "routing_sec")]
    linked = conn.execute("""WITH inserted AS (
            INSERT INTO calls(start_ts,abandoned,in_queue_sec,agent_sec,abandon_sec,routing_sec)
            SELECT * FROM unnest(%s::timestamp[],%s::boolean[],%s::float8[],%s::float8[],%s::float8[],%s::float8[])
            RETURNING id)
        INSERT INTO pipeline_call_links(call_id,batch_id) SELECT id, %s FROM inserted""", (*columns, batch_id)).rowcount
    if linked != len(calls):
        raise PipelineError("The database did not store every call. No records were changed.")
    return linked


def _apply(conn, batch_id, calls: pd.DataFrame, replace_days) -> dict:
    """Bring `calls` into the database. The caller holds the transaction and
    the import lock. Re-plans against the database as it is NOW, so a plan
    shown earlier cannot be applied to data that has since changed."""
    _require_generated_ids(conn)
    # Writers outside this ledger must also be kept out while days are compared.
    conn.execute("LOCK TABLE calls IN SHARE ROW EXCLUSIVE MODE")
    file_days = summarize_days(calls)
    plan = plan_days(file_days, summarize_days(_stored_calls(conn, file_days)))
    conflicts = sorted(day for day, status in plan.items() if status == CONFLICT)
    if set(replace_days) != set(conflicts):
        if not conflicts:
            raise PipelineError("None of these days needs replacing any more. Validate the file again.")
        raise PipelineError(f"These days already hold different calls: {_listed(conflicts)}. "
                            "Nothing was changed. Confirm replacing exactly these days, or remove them from the file.")
    added = sorted(day for day, status in plan.items() if status == NEW)
    if not added and not conflicts:
        raise PipelineError("Every day in this file is already loaded with the same calls. Nothing to import.")
    removed, touched = _delete_days(conn, conflicts)
    if removed:
        # What a replacement deleted stays with the batch that replaced it, so
        # a wrong replacement can be put back without a database restore.
        conn.execute("UPDATE pipeline_batches SET replaced_records=%s WHERE id=%s", (Jsonb(_records(pd.DataFrame(removed))), batch_id))
    wanted = set(added) | set(conflicts)
    inserted = _insert_calls(conn, batch_id, calls[calls["start_ts"].dt.date.isin(wanted)])
    conn.execute("""UPDATE pipeline_batches b SET status='superseded'
        WHERE b.id = ANY(%s) AND b.id <> %s AND b.status='imported'
          AND NOT EXISTS (SELECT 1 FROM pipeline_call_links l WHERE l.batch_id=b.id)""", (list(touched), batch_id))
    conn.execute("UPDATE pipeline_state SET revision=revision+1")
    return {"inserted_rows": inserted, "deleted_rows": len(removed),
            "added_days": [day.isoformat() for day in added],
            "replaced_days": [day.isoformat() for day in conflicts],
            "skipped_days": [day.isoformat() for day in sorted(plan) if plan[day] == IDENTICAL]}


def commit_import(conn, batch_id, *, expected_rows: int, replace_days=(), actor: str | None = None) -> dict:
    """Import a staged batch. `expected_rows` is the row count the admin
    confirms from the source export. `replace_days` must name exactly the
    days that conflict at this moment; any other set is refused."""
    _require_autocommit(conn)
    with conn.transaction():
        lock_import(conn)
        with conn.cursor(row_factory=dict_row) as cursor:
            batch = cursor.execute("SELECT *, expires_at > now() AS fresh FROM pipeline_batches WHERE id=%s FOR UPDATE",
                                   (batch_id,)).fetchone()
        if not batch:
            raise PipelineError("Upload not found.", 404)
        if batch["status"] != "validated" or not batch["fresh"] or not batch["records"]:
            raise PipelineError("This upload is invalid, expired, or already imported. Upload a fresh valid file.")
        if batch["contract_hash"] != PARSER_VERSION:
            raise PipelineError("This upload was staged by an older version. Validate the file again.")
        if len(batch["records"]) != expected_rows:
            raise PipelineError("The confirmed source row count does not match the upload.")
        result = _apply(conn, batch_id, _calls_from_records(batch["records"]), replace_days)
        conn.execute("""UPDATE pipeline_batches SET status='imported',imported_at=now(),imported_by=%s,records=NULL,
                               summary=summary || %s WHERE id=%s""",
                     (actor or batch["uploader"], Jsonb({"result": result}), batch_id))
    return {"id": str(batch_id), "status": "imported", **result}


def import_calls(conn, calls: pd.DataFrame, uploader: str, *, replace_days=(), commit: bool = False,
                 today: date | None = None) -> dict:
    """Import parsed calls (read_calls) without staging: for the command line
    and for files too big for the web upload, so no row limit applies. A dry
    run unless `commit`. Returns {committed, validation[, id, result]}."""
    report = _report(conn, calls, today or _today(), max_rows=None)
    if not commit:
        return {"committed": False, "validation": report}
    if not report["ok"]:
        raise PipelineError(" ".join(error["message"] for error in report["file_errors"]), 400)
    _require_autocommit(conn)
    batch_id = uuid.uuid4()
    with conn.transaction():
        lock_import(conn)
        file_hash = hashlib.sha256(pd.util.hash_pandas_object(calls, index=False).values.tobytes()).hexdigest()
        _insert_batch(conn, batch_id, uploader, file_hash, report, status="imported", imported_by=uploader)
        result = _apply(conn, batch_id, calls, replace_days)
        conn.execute("UPDATE pipeline_batches SET summary=summary || %s WHERE id=%s",
                     (Jsonb({"result": result}), batch_id))
    return {"committed": True, "id": str(batch_id), "validation": report, "result": result}


# =============================================================================
# History and housekeeping
# =============================================================================

def history(conn):
    with conn.cursor(row_factory=dict_row) as cursor:
        return cursor.execute("""SELECT id,created_at,uploader,month,first_day,last_day,status,summary,imported_at,
                                        imported_by,replaced_batch_id
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


def migrate(conn, *, dry_run: bool = False):
    """Apply the ledger migrations in order. Every statement is safe to run
    again. With dry_run the whole thing is rolled back: it proves the
    migrations run against this database without changing it."""
    with conn.transaction():
        # The former prototype used a different primary key. Never silently
        # rewrite an already-applied ledger or discard its provenance.
        legacy = conn.execute("""SELECT 1 FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='pipeline_call_links'
            AND column_name='source_id'""").fetchone()
        if legacy:
            raise PipelineError("An older source-ID ledger exists. Review a schema/data migration before applying this version.", 503)
        for name in MIGRATIONS:
            conn.execute((ROOT / "db/migrations" / name).read_text())
        if dry_run:
            raise psycopg.Rollback()


# =============================================================================
# Command line
# =============================================================================

def _print_report(report: dict) -> None:
    summary = report["summary"]
    print(f"{summary['total_rows']:,} calls, {summary['first_day']} to {summary['last_day']}: "
          f"{summary['new_days']} new day(s), {summary['identical_days']} already loaded, "
          f"{summary['conflict_days']} different from what is loaded")
    for row in report["days"]:
        if row["status"] != IDENTICAL:
            print(f"  {row['day']}  {row['status']:<9} file {row['rows']:>6,} rows, database {row['existing_rows']:>6,}")
    for line in [error["message"] for error in report["file_errors"]] + report["warnings"]:
        print(f"  ! {line}")


def _import_file(conn, args) -> int:
    calls = read_calls(args.file)
    replace_days = [date.fromisoformat(day) for day in args.replace_days]
    outcome = import_calls(conn, calls, f"cli:{os.getenv('USER', 'unknown')}", replace_days=replace_days, commit=args.commit)
    _print_report(outcome["validation"])
    if not outcome["committed"]:
        print("dry run: nothing written. Re-run with --commit to import.")
        return 0
    result = outcome["result"]
    print(f"imported: {result['inserted_rows']:,} rows inserted, {result['deleted_rows']:,} deleted, "
          f"{len(result['skipped_days'])} day(s) skipped. batch {outcome['id']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Call-record ingestion ledger.")
    commands = parser.add_subparsers(dest="command", required=True)
    migrate_command = commands.add_parser("migrate", help="apply the ledger migrations")
    migrate_command.add_argument("--dry-run", action="store_true", help="run them, then roll back")
    commands.add_parser("purge-expired", help="clear staged rows older than seven days")
    import_command = commands.add_parser("import", help="import a client workbook without the web upload")
    import_command.add_argument("file", type=Path)
    import_command.add_argument("--replace-days", nargs="*", default=[], metavar="YYYY-MM-DD",
                                help="exactly the days whose stored calls should be replaced")
    import_command.add_argument("--commit", action="store_true", help="write; without it this is a dry run")
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv()
    try:
        with connect() as conn:
            if args.command == "migrate":
                migrate(conn, dry_run=args.dry_run)
                print("Ingestion migrations ran; rolled back (dry run)." if args.dry_run else "Ingestion migrations applied.")
            elif args.command == "purge-expired":
                print(f"Expired staged batches cleared: {purge_expired(conn)}")
            elif args.commit:
                return _import_file(conn, args)
            else:
                # A dry run cannot write: read-only applies inside a transaction block.
                conn.read_only = True
                with conn.transaction():
                    return _import_file(conn, args)
    except (PipelineError, OSError, ValueError, psycopg.Error) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
