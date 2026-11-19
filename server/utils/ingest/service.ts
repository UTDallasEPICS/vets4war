// Uploads of call-records workbooks: receive the bytes, read them in the background into
// `upload_rows` (staging), say what every day of the file would do to `calls`, and import
// on an admin's confirmation (the safety rules of integrate-admin's day-range pipeline).
//
// No function here returns, stores in a message, or logs a call record: reports carry
// counts, days and messages; errors are logged by type only.
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { dataState, uploadRows, uploads } from '../../db/schema'
import { addDays, isIsoDate } from '../../../shared/utils/dates'
import type { DayPlan, ImportRequest, ImportResult, UploadReport } from '../../../shared/types/api'
import type Database from 'better-sqlite3'
import type { AppDb } from '../db'
import type { RunRow } from '../retrain/runner'
import { apiError } from '../http'
import { toUploadDetail } from '../mappers'
import {
  callLine,
  dayOf,
  daysWithoutCalls,
  fingerprint,
  listDays,
  nextDay,
  partialEdgeDays,
  planDays,
  summarizeDays,
  type CallValues,
  type DaySummary,
} from './days'
import { NOT_A_WORKBOOK } from './archive'
import { STAGED_DAYS } from './limits'
import { parseWorkbook, type ParsedCall, type ParseResult } from './parser'

export type UploadRow = typeof uploads.$inferSelect

export interface IngestDeps {
  maxBytes: number
  maxRows: number
  today(): string // Eastern
  tmpDir?: string
  onImported?(result: { uploadId: number; userLabel: string }): {
    run: RunRow
    queued: boolean
  } | null
}

// What the import compares against: the fingerprint each file day had in `calls` when
// the file was checked (null: no calls that day). Stored with the report, never sent.
export type StoredReport = UploadReport & { stored_days?: Record<string, string | null> }

export interface StagedBatch {
  sheet: string
  firstId: number
  lastId: number
}
export type StagedParse = ParseResult & { batches: StagedBatch[] }

export const UNREADABLE =
  'This file could not be read as call records. Check it is the call-records export and try again.'
const BUSY = 'Another file is being read right now. Try again in a few seconds.'
const SERVER_RESTARTED = 'The server restarted while this file was being read. Upload it again.'
export const UPLOAD_FOLDER_PREFIX = 'v4w-upload-'
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const MAX_FILENAME = 200
const DAY_SECONDS = 86_400

const CALL_COLUMNS = 'start_ts, in_queue_sec, agent_sec, abandon_sec, routing_sec, abandoned'

interface RawCall {
  id?: number
  start_ts: string
  in_queue_sec: number | null
  agent_sec: number | null
  abandon_sec: number | null
  routing_sec: number | null
  abandoned: number
}

// The better-sqlite3 handle behind the Drizzle database (drizzle() always sets it; the
// AppDb type leaves it out). Bulk staging and day-range copies use prepared statements
// with bound parameters on it.
export function sqliteOf(db: AppDb): Database.Database {
  return (db as AppDb & { $client: Database.Database }).$client
}

function toCall(row: RawCall): CallValues {
  return {
    startTs: row.start_ts,
    inQueueSec: row.in_queue_sec,
    agentSec: row.agent_sec,
    abandonSec: row.abandon_sec,
    routingSec: row.routing_sec,
    abandoned: row.abandoned === 1,
  }
}

function errorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? `${error.name} (${code})` : error.name
}

// The client's file name, for display only: no folders, no control characters.
function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = [...base]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, MAX_FILENAME)
  return cleaned || 'upload.xlsx'
}

export function publicReport(report: StoredReport | null): UploadReport | null {
  if (!report) return null
  const { stored_days: _hidden, ...rest } = report
  return rest
}

// The API shape of an upload, without the comparison data the import keeps for itself.
export function uploadDetail(row: UploadRow) {
  return toUploadDetail({ ...row, report: publicReport(row.report) })
}

export function getUpload(db: AppDb, uploadId: number): UploadRow {
  const row = db.select().from(uploads).where(eq(uploads.id, uploadId)).get()
  if (!row) throw apiError(404, 'not_found', `There is no upload ${uploadId}.`)
  return row
}

export function listUploads(db: AppDb): UploadRow[] {
  return db
    .select()
    .from(uploads)
    .orderBy(desc(uploads.createdAt), desc(uploads.id))
    .limit(50)
    .all()
}

// ---------------------------------------------------------------------------
// Receiving and reading

export async function receiveUpload(
  db: AppDb,
  deps: IngestDeps,
  input: { filename: string; data: Buffer; user: { id: string; email: string } }
): Promise<{ upload: UploadRow; existing: boolean; parsing?: Promise<void> }> {
  if (input.data.length > deps.maxBytes) {
    const limit = Math.floor(deps.maxBytes / (1024 * 1024))
    throw apiError(
      413,
      'too_large',
      `The file is larger than the upload limit of ${limit} MB. Split it into smaller files (one year per file works).`
    )
  }
  if (input.data.length < ZIP_MAGIC.length || !input.data.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw apiError(400, 'not_a_workbook', NOT_A_WORKBOOK)
  }
  const sha = createHash('sha256').update(input.data).digest('hex')
  const now = new Date()

  const received = db.transaction((tx) => {
    const same = tx
      .select()
      .from(uploads)
      .where(and(eq(uploads.fileSha256, sha), inArray(uploads.status, ['parsing', 'ready'])))
      .orderBy(desc(uploads.id))
      .get()
    if (same) return { upload: same, existing: true }
    const reading = tx
      .select({ id: uploads.id })
      .from(uploads)
      .where(eq(uploads.status, 'parsing'))
      .get()
    if (reading) throw apiError(429, 'busy', BUSY)

    // Staged rows are only good for a week; clear the stale ones as uploads arrive.
    const stale = tx
      .select({ id: uploads.id })
      .from(uploads)
      .where(
        and(
          eq(uploads.status, 'ready'),
          lt(uploads.createdAt, new Date(now.getTime() - STAGED_DAYS * DAY_SECONDS * 1000))
        )
      )
      .all()
      .map((row) => row.id)
    if (stale.length) {
      tx.delete(uploadRows).where(inArray(uploadRows.uploadId, stale)).run()
      tx.update(uploads).set({ status: 'discarded' }).where(inArray(uploads.id, stale)).run()
    }

    const upload = tx
      .insert(uploads)
      .values({
        source: 'upload',
        status: 'parsing',
        filename: cleanFilename(input.filename),
        fileSha256: sha,
        fileBytes: input.data.length,
        uploadedBy: input.user.id,
        uploadedByLabel: input.user.email,
        createdAt: now,
      })
      .returning()
      .get()
    return { upload, existing: false }
  })
  if (received.existing) return received

  // A private folder per upload; the file name is random, never the client's.
  let folder: string | null = null
  let path: string
  try {
    folder = await mkdtemp(join(deps.tmpDir ?? tmpdir(), UPLOAD_FOLDER_PREFIX))
    path = join(folder, `${randomUUID()}.xlsx`)
    await writeFile(path, input.data, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    console.error(`[uploads] upload ${received.upload.id} could not be stored: ${errorType(error)}`)
    if (folder) await rm(folder, { recursive: true, force: true })
    const failed = db
      .update(uploads)
      .set({ status: 'failed', error: UNREADABLE, parsedAt: new Date() })
      .where(eq(uploads.id, received.upload.id))
      .returning()
      .get()
    return { upload: failed, existing: false }
  }
  const parsing = parseUpload(db, deps, received.upload.id, path)
  return { upload: received.upload, existing: false, parsing }
}

// The background part. Never throws; the temp file (and its private folder, once empty)
// is deleted whatever happens.
export async function parseUpload(
  db: AppDb,
  deps: IngestDeps,
  uploadId: number,
  path: string
): Promise<void> {
  const batches: StagedBatch[] = []
  try {
    const insert = sqliteOf(db).prepare(
      `INSERT INTO upload_rows (upload_id, ${CALL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    // One transaction per batch, so no write lock is held for long (PLAN.md 6).
    const stage = sqliteOf(db).transaction((rows: ParsedCall[]): [number, number] => {
      let first = 0
      let last = 0
      for (const row of rows) {
        const id = Number(
          insert.run(
            uploadId,
            row.startTs,
            row.inQueueSec,
            row.agentSec,
            row.abandonSec,
            row.routingSec,
            row.abandoned ? 1 : 0
          ).lastInsertRowid
        )
        if (!first) first = id
        last = id
      }
      return [first, last]
    })
    const parse = await parseWorkbook(path, {
      maxRows: deps.maxRows,
      onRows(sheet, rows) {
        const [firstId, lastId] = stage(rows)
        batches.push({ sheet, firstId, lastId })
      },
    })
    const report: StoredReport = parse.errors.length
      ? unreadableReport(parse)
      : await buildReport(db, uploadId, { ...parse, batches }, deps.today())
    db.transaction((tx) => {
      if (!report.ok) tx.delete(uploadRows).where(eq(uploadRows.uploadId, uploadId)).run()
      tx.update(uploads)
        .set({
          status: report.ok ? 'ready' : 'invalid',
          report,
          totalRows: report.summary.total_rows,
          firstDay: report.summary.first_day,
          lastDay: report.summary.last_day,
          parsedAt: new Date(),
        })
        .where(and(eq(uploads.id, uploadId), eq(uploads.status, 'parsing')))
        .run()
    })
  } catch (error) {
    console.error(`[uploads] upload ${uploadId} could not be read: ${errorType(error)}`)
    try {
      db.transaction((tx) => {
        tx.delete(uploadRows).where(eq(uploadRows.uploadId, uploadId)).run()
        tx.update(uploads)
          .set({ status: 'failed', error: UNREADABLE, parsedAt: new Date() })
          .where(and(eq(uploads.id, uploadId), eq(uploads.status, 'parsing')))
          .run()
      })
    } catch (inner) {
      console.error(`[uploads] upload ${uploadId} could not be marked failed: ${errorType(inner)}`)
    }
  } finally {
    await rm(path, { force: true }).catch(() => {})
    // Removes the private folder receiveUpload made; leaves any other folder alone.
    await rmdir(dirname(path)).catch(() => {})
  }
}

function unreadableReport(parse: ParseResult): StoredReport {
  return {
    ok: false,
    nothing_to_import: false,
    summary: {
      total_rows: 0,
      first_day: null,
      last_day: null,
      days: 0,
      new_days: 0,
      identical_days: 0,
      conflict_days: 0,
    },
    days: [],
    days_without_calls: [],
    file_errors: parse.errors,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// The report

interface StoredPlan {
  days: DayPlan[]
  storedDays: Record<string, string | null>
}

// The file's days against the live `calls` table, reading only the file's date range.
function planAgainstStored(db: AppDb, fileDays: Map<string, DaySummary>): StoredPlan {
  const days = [...fileDays.keys()]
  if (days.length === 0) return { days: [], storedDays: {} }
  const first = days[0]!
  const last = days[days.length - 1]!
  const rows = sqliteOf(db)
    .prepare(`SELECT ${CALL_COLUMNS} FROM calls WHERE start_ts >= ? AND start_ts < ?`)
    .iterate(first, nextDay(last)) as IterableIterator<RawCall>
  const stored = summarizeDays(
    (function* () {
      for (const row of rows) if (fileDays.has(dayOf(row.start_ts))) yield toCall(row)
    })()
  )
  const storedDays: Record<string, string | null> = {}
  for (const day of days) storedDays[day] = stored.get(day)?.fingerprint ?? null
  return { days: planDays(fileDays, stored), storedDays }
}

// Reads that run while other requests are served go a chunk at a time, in (start_ts, id)
// order, and give the event loop a turn between chunks: on the multi-year workbook a
// single pass held it for most of a second. (better-sqlite3 cannot keep a statement open
// across a yield: the connection is shared with every request.)
const READ_CHUNK = 20_000
const DAYS_PER_TURN = 200
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

async function* rowsInChunks(
  db: AppDb,
  table: 'upload_rows' | 'calls',
  where: string,
  params: unknown[]
): AsyncGenerator<(RawCall & { id: number })[]> {
  const statement = sqliteOf(db).prepare(
    `SELECT id, ${CALL_COLUMNS} FROM ${table} WHERE ${where} AND (start_ts, id) > (?, ?) ` +
      `ORDER BY start_ts, id LIMIT ${READ_CHUNK}`
  )
  let after: [string, number] = ['', 0]
  for (;;) {
    const rows = statement.all(...params, ...after) as (RawCall & { id: number })[]
    if (rows.length === 0) return
    yield rows
    const last = rows[rows.length - 1]!
    after = [last.start_ts, last.id]
    await nextTurn()
  }
}

async function summarizeLines(lines: Map<string, string[]>): Promise<Map<string, DaySummary>> {
  const summaries = new Map<string, DaySummary>()
  let done = 0
  for (const day of [...lines.keys()].sort()) {
    const dayLines = lines.get(day)!
    summaries.set(day, { rows: dayLines.length, fingerprint: fingerprint(dayLines) })
    if (++done % DAYS_PER_TURN === 0) await nextTurn()
  }
  return summaries
}

async function planAgainstStoredInTurns(
  db: AppDb,
  fileDays: Map<string, DaySummary>
): Promise<StoredPlan> {
  const days = [...fileDays.keys()]
  if (days.length === 0) return { days: [], storedDays: {} }
  const lines = new Map<string, string[]>()
  const range = [days[0]!, nextDay(days[days.length - 1]!)]
  for await (const rows of rowsInChunks(db, 'calls', 'start_ts >= ? AND start_ts < ?', range)) {
    for (const row of rows) {
      const day = dayOf(row.start_ts)
      if (!fileDays.has(day)) continue
      const dayLines = lines.get(day)
      if (dayLines) dayLines.push(callLine(toCall(row)))
      else lines.set(day, [callLine(toCall(row))])
    }
  }
  const stored = await summarizeLines(lines)
  const storedDays: Record<string, string | null> = {}
  for (const day of days) storedDays[day] = stored.get(day)?.fingerprint ?? null
  return { days: planDays(fileDays, stored), storedDays }
}

function withPlan(report: StoredReport, plan: StoredPlan): StoredReport {
  const count = (status: DayPlan['status']) => plan.days.filter((d) => d.status === status).length
  return {
    ...report,
    nothing_to_import:
      report.ok && plan.days.length > 0 && plan.days.every((d) => d.status === 'identical'),
    summary: {
      ...report.summary,
      days: plan.days.length,
      new_days: count('new'),
      identical_days: count('identical'),
      conflict_days: count('conflict'),
    },
    days: plan.days,
    stored_days: plan.storedDays,
  }
}

function stagedRows(db: AppDb, uploadId: number) {
  return sqliteOf(db)
    .prepare(
      `SELECT id, ${CALL_COLUMNS} FROM upload_rows WHERE upload_id = ? ORDER BY start_ts, id`
    )
    .iterate(uploadId) as IterableIterator<RawCall & { id: number }>
}

function sheetOf(batches: StagedBatch[], id: number): number {
  let lo = 0
  let hi = batches.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const batch = batches[mid]!
    if (id < batch.firstId) hi = mid - 1
    else if (id > batch.lastId) lo = mid + 1
    else return mid
  }
  return -1
}

export async function buildReport(
  db: AppDb,
  uploadId: number,
  parse: StagedParse,
  today: string
): Promise<StoredReport> {
  // One pass over the staged calls: lines per day (for the fingerprint), the hours with
  // calls (for cut-short days) and the sheet each line came from (for copied sheets).
  const lines = new Map<string, string[]>()
  const sheets = new Map<string, string[]>()
  const hours = new Map<string, Set<number>>()
  let total = 0
  for await (const rows of rowsInChunks(db, 'upload_rows', 'upload_id = ?', [uploadId])) {
    for (const row of rows) {
      total++
      const day = dayOf(row.start_ts)
      const line = callLine(toCall(row))
      const sheet = parse.batches[sheetOf(parse.batches, row.id)]?.sheet ?? ''
      if (!lines.has(day)) {
        lines.set(day, [])
        sheets.set(day, [])
        hours.set(day, new Set())
      }
      lines.get(day)!.push(line)
      sheets.get(day)!.push(sheet)
      hours.get(day)!.add(Number(row.start_ts.slice(11, 13)))
    }
  }
  const fileDays = await summarizeLines(lines)
  const copied: string[] = []
  const split: string[] = []
  for (const [day, dayLines] of lines) {
    const daySheets = sheets.get(day)!
    if (new Set(daySheets).size < 2) continue
    // A day on two sheets is how the multi-year export ends a year; the same call on two
    // sheets is a copied sheet or row and would be stored twice.
    const firstSheetOf = new Map<string, string>()
    let isCopy = false
    dayLines.forEach((line, i) => {
      const seen = firstSheetOf.get(line)
      if (seen === undefined) firstSheetOf.set(line, daySheets[i]!)
      else if (seen !== daySheets[i]) isCopy = true
    })
    ;(isCopy ? copied : split).push(day)
  }

  const days = [...fileDays.keys()]
  const errors = [...parse.errors]
  const unfinished = days.filter((day) => day >= today)
  if (unfinished.length) {
    errors.push({
      code: 'day_not_finished',
      message:
        `Only finished days can be imported; the file includes ${listDays(unfinished)}. ` +
        `Export up to ${addDays(today, -1)}.`,
    })
  }
  const cutShort = partialEdgeDays(hours)
  if (cutShort.length) {
    errors.push({
      code: 'partial_day',
      message: `The file starts or stops part-way through a day (${listDays(cutShort)}). Export whole days.`,
    })
  }
  if (copied.length) {
    errors.push({
      code: 'day_on_two_sheets',
      message:
        `The same calls for ${listDays(copied)} appear on more than one sheet. ` +
        'Remove the copy so each call is in the file once.',
    })
  }
  const gaps = daysWithoutCalls(days)
  const warnings: string[] = []
  if (gaps.length) {
    warnings.push(
      `${gaps.length} date(s) have no calls recorded in this workbook: ${listDays(gaps)}. They are left untouched.`
    )
  }
  if (split.length) {
    warnings.push(
      `${split.length} day(s) have calls on more than one sheet and were combined: ${listDays(split)}.`
    )
  }

  const base: StoredReport = {
    ok: errors.length === 0,
    nothing_to_import: false,
    summary: {
      total_rows: total,
      first_day: days[0] ?? null,
      last_day: days[days.length - 1] ?? null,
      days: 0,
      new_days: 0,
      identical_days: 0,
      conflict_days: 0,
    },
    days: [],
    days_without_calls: gaps,
    file_errors: errors,
    warnings,
  }
  return withPlan(base, await planAgainstStoredInTurns(db, fileDays))
}

// ---------------------------------------------------------------------------
// Import

class Refusal {
  constructor(readonly message: string) {}
}

function sameSnapshot(
  a: Record<string, string | null> | undefined,
  b: Record<string, string | null>
): boolean {
  if (!a) return false
  const keys = Object.keys(b)
  return keys.length === Object.keys(a).length && keys.every((day) => a[day] === b[day])
}

function describeReplaceMismatch(conflicts: string[], requested: Set<string>): string {
  if (conflicts.length === 0) {
    return 'No day in this file differs from the stored calls any more, so there is nothing to replace. Review the plan and import again.'
  }
  const missing = conflicts.filter((day) => !requested.has(day))
  const extra = [...requested].filter((day) => !conflicts.includes(day))
  const parts = [`These days already hold different calls: ${listDays(conflicts)}.`]
  if (missing.length) parts.push(`Not confirmed: ${listDays(missing)}.`)
  if (extra.length) parts.push(`Not different: ${listDays(extra)}.`)
  parts.push('Nothing was changed. Confirm replacing exactly the days that differ.')
  return parts.join(' ')
}

export function importUpload(
  db: AppDb,
  deps: IngestDeps,
  uploadId: number,
  body: ImportRequest,
  user: { email: string }
): { upload: UploadRow; run: RunRow | null } {
  const replace = new Set(body.replace_days)
  // Everything below runs in one transaction. A refusal that also stores a refreshed
  // report must commit that report, so refusals are returned, then thrown after it.
  const outcome = db.transaction((tx): Refusal | ImportResult => {
    const upload = tx.select().from(uploads).where(eq(uploads.id, uploadId)).get()
    if (!upload) throw apiError(404, 'not_found', `There is no upload ${uploadId}.`)
    if (upload.status !== 'ready') {
      return new Refusal(
        `This upload is ${upload.status}. Only a checked file that is ready can be imported.`
      )
    }
    if (body.total_rows !== upload.totalRows) {
      return new Refusal(
        `The row count you typed (${body.total_rows.toLocaleString('en-US')}) is not the file's ` +
          `(${(upload.totalRows ?? 0).toLocaleString('en-US')}).`
      )
    }
    // The transaction is the connection's, so reads through `db` below see it too.
    const fileDays = summarizeDays(
      (function* () {
        for (const row of stagedRows(db, uploadId)) yield toCall(row)
      })()
    )
    const plan = planAgainstStored(db, fileDays)
    const report = upload.report as StoredReport
    if (!sameSnapshot(report.stored_days, plan.storedDays)) {
      tx.update(uploads)
        .set({ report: withPlan(report, plan) })
        .where(eq(uploads.id, uploadId))
        .run()
      return new Refusal(
        'The stored calls changed since this file was checked. Review the new plan.'
      )
    }
    const conflicts = plan.days.filter((d) => d.status === 'conflict').map((d) => d.day)
    const added = plan.days.filter((d) => d.status === 'new').map((d) => d.day)
    const skipped = plan.days.filter((d) => d.status === 'identical').map((d) => d.day)
    if (replace.size !== conflicts.length || conflicts.some((day) => !replace.has(day))) {
      return new Refusal(describeReplaceMismatch(conflicts, replace))
    }
    if (added.length === 0 && conflicts.length === 0) {
      return new Refusal('Every day in this file is already loaded. Nothing to import.')
    }

    const client = sqliteOf(db)
    const keep = client.prepare(
      `INSERT INTO replaced_calls (replaced_by_upload_id, original_upload_id, ${CALL_COLUMNS})
       SELECT ?, upload_id, ${CALL_COLUMNS} FROM calls WHERE start_ts >= ? AND start_ts < ?`
    )
    const remove = client.prepare('DELETE FROM calls WHERE start_ts >= ? AND start_ts < ?')
    const insert = client.prepare(
      `INSERT INTO calls (${CALL_COLUMNS}, upload_id)
       SELECT ${CALL_COLUMNS}, upload_id FROM upload_rows
       WHERE upload_id = ? AND start_ts >= ? AND start_ts < ? ORDER BY start_ts, id`
    )
    // What a replacement deletes is kept, so a wrong replacement can be put back.
    let deleted = 0
    for (const day of conflicts) {
      keep.run(uploadId, day, nextDay(day))
      deleted += remove.run(day, nextDay(day)).changes
    }
    let inserted = 0
    for (const day of [...added, ...conflicts].sort()) {
      inserted += insert.run(uploadId, day, nextDay(day)).changes
    }
    tx.delete(uploadRows).where(eq(uploadRows.uploadId, uploadId)).run()
    const now = new Date()
    const state = tx
      .insert(dataState)
      .values({ id: 1, callsRevision: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: dataState.id,
        set: { callsRevision: sql`${dataState.callsRevision} + 1`, updatedAt: now },
      })
      .returning()
      .get()
    const result: ImportResult = {
      inserted_rows: inserted,
      deleted_rows: deleted,
      added_days: added,
      replaced_days: conflicts,
      skipped_days: skipped,
      calls_revision: state.callsRevision,
    }
    tx.update(uploads)
      .set({ status: 'imported', importedAt: now, importedByLabel: user.email, result })
      .where(eq(uploads.id, uploadId))
      .run()
    return result
  })
  if (outcome instanceof Refusal) throw apiError(409, 'conflict', outcome.message)

  let run: RunRow | null = null
  if (deps.onImported) {
    // The calls are in; a retrain that cannot start must not undo or hide the import.
    try {
      const started = deps.onImported({ uploadId, userLabel: user.email })
      if (started) {
        run = started.run
        db.update(uploads).set({ runId: started.run.id }).where(eq(uploads.id, uploadId)).run()
      }
    } catch (error) {
      console.error(
        `[uploads] upload ${uploadId}: the retrain could not be started: ${errorType(error)}`
      )
    }
  }
  return { upload: getUpload(db, uploadId), run }
}

// ---------------------------------------------------------------------------
// Housekeeping

export function discardUpload(db: AppDb, uploadId: number): UploadRow {
  return db.transaction((tx) => {
    const upload = tx.select().from(uploads).where(eq(uploads.id, uploadId)).get()
    if (!upload) throw apiError(404, 'not_found', `There is no upload ${uploadId}.`)
    if (!['ready', 'invalid', 'failed'].includes(upload.status)) {
      throw apiError(
        409,
        'conflict',
        `This upload is ${upload.status}. Only an upload that is ready, invalid or failed can be discarded.`
      )
    }
    tx.delete(uploadRows).where(eq(uploadRows.uploadId, uploadId)).run()
    return tx
      .update(uploads)
      .set({ status: 'discarded' })
      .where(eq(uploads.id, uploadId))
      .returning()
      .get()
  })
}

// Start-up: nothing is reading or importing in a process that just started.
export function recoverUploads(db: AppDb): number {
  return db.transaction((tx) => {
    const stuck = tx
      .select({ id: uploads.id })
      .from(uploads)
      .where(inArray(uploads.status, ['parsing', 'importing']))
      .all()
      .map((row) => row.id)
    if (stuck.length === 0) return 0
    tx.delete(uploadRows).where(inArray(uploadRows.uploadId, stuck)).run()
    tx.update(uploads)
      .set({ status: 'failed', error: SERVER_RESTARTED })
      .where(inArray(uploads.id, stuck))
      .run()
    return stuck.length
  })
}

export const importRequestSchema = z.object({
  total_rows: z.number().int().min(0),
  replace_days: z
    .array(z.string().refine((day) => isIsoDate(day), 'must be a YYYY-MM-DD date'))
    .max(10_000),
})
