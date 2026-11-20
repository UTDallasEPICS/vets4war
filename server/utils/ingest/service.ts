// Uploads of call-records workbooks: receive the bytes, read them in the background into
// `upload_rows` (staging), say what every day of the file would do to `calls`, and import
// on an admin's confirmation (the safety rules of integrate-admin's day-range pipeline).
//
// No function here returns, stores in a message, or logs a call record: reports carry
// counts, days and messages; errors are logged by type only.
import { createHash, randomUUID } from 'node:crypto'
import { rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { dataState, forecastRuns, uploadRows, uploads } from '../../db/schema'
import { addDays, dateRange, isIsoDate } from '../../../shared/utils/dates'
import type { DayPlan, ImportRequest, ImportResult, UploadReport } from '../../../shared/types/api'
import type Database from 'better-sqlite3'
import { captureForecastSnapshots } from '../accuracy/snapshot'
import type { AppDb } from '../db'
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
import { EARLIEST_CALL_DAY, MAX_PARSE_MS, RECENT_GAP_DAYS, STAGED_DAYS } from './limits'
import { parseWorkbook, type ParsedCall, type ParseResult } from './parser'
import { makeUploadFolder } from './tempfiles'

// A forecast_runs row, as the retrain runner hands one back. Defined here rather than
// imported: the read side and the runner each keep their own name for it.
type RunRow = typeof forecastRuns.$inferSelect

export type UploadRow = typeof uploads.$inferSelect

export interface IngestDeps {
  maxBytes: number
  maxRows: number
  today(): string // Eastern
  tmpDir?: string
  parseTimeoutMs?: number // default MAX_PARSE_MS
  onImported?(result: { uploadId: number; userLabel: string }): {
    run: RunRow
    queued: boolean
  } | null
}

// What the import compares against: the fingerprint each file day had in `calls` when
// the file was checked (null: no calls that day). Stored with the report, never sent.
// calls_revision: data_state.calls_revision when the plan was made, so a ready upload
// whose plan the stored calls have since outdated is planned again before it is shown.
export type StoredReport = UploadReport & {
  stored_days?: Record<string, string | null>
  calls_revision?: number
}

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
const TOOK_TOO_LONG =
  'Reading this file took too long and was stopped. Upload it again; if this happens ' +
  'again, split it into smaller files.'

// A read stopped at its time limit (MAX_PARSE_MS).
class ParseTimeout extends Error {
  constructor() {
    super('the read took too long')
    this.name = 'ParseTimeout'
  }
}

// `work`, or a ParseTimeout once `ms` have passed. A failure of `work` after that is
// left unreported (the upload has been failed already). `onTimeout` runs first.
function within<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new ParseTimeout())
    }, ms)
  })
  work.catch(() => {})
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const MAX_FILENAME = 200
const DAY_SECONDS = 86_400

const CALL_COLUMNS = 'start_ts, in_queue_sec, agent_sec, abandon_sec, routing_sec, abandoned'
const IMMEDIATE = { behavior: 'immediate' } as const
const COMBINED_SHEETS = 'more than one sheet and were combined'

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
  const { stored_days: _hidden, calls_revision: _revision, ...rest } = report
  return rest
}

// The run that read this upload's calls: the first run whose snapshot includes the
// import's revision (the script writes forecast_runs.calls_revision when it claims a
// run). Until one has, the run this import started itself, if it started one. An
// import queued behind a running retrain is read by the run that follows it, not by
// the one that was running.
function runThatReadIt(db: AppDb, row: UploadRow): number | null {
  const revision = row.status === 'imported' ? row.result?.calls_revision : undefined
  if (revision === undefined) return row.runId
  const run = db
    .select({ id: forecastRuns.id })
    .from(forecastRuns)
    .where(and(isNotNull(forecastRuns.callsRevision), gte(forecastRuns.callsRevision, revision)))
    .orderBy(asc(forecastRuns.id))
    .get()
  return run?.id ?? row.runId
}

export function withRunThatReadIt(db: AppDb, row: UploadRow): UploadRow {
  return { ...row, runId: runThatReadIt(db, row) }
}

// The API shape of an upload, without the comparison data the import keeps for itself.
export function uploadDetail(db: AppDb, row: UploadRow) {
  const shown = withRunThatReadIt(db, row)
  return toUploadDetail({ ...shown, report: publicReport(shown.report) })
}

export function getUpload(db: AppDb, uploadId: number): UploadRow {
  const row = db.select().from(uploads).where(eq(uploads.id, uploadId)).get()
  if (!row) throw apiError(404, 'not_found', `There is no upload ${uploadId}.`)
  return row
}

// Newest first, max 50, each with the run that read its calls (runThatReadIt).
export function listUploads(db: AppDb): UploadRow[] {
  return db
    .select()
    .from(uploads)
    .orderBy(desc(uploads.createdAt), desc(uploads.id))
    .limit(50)
    .all()
    .map((row) => withRunThatReadIt(db, row))
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

  // Every transaction here reads, then writes. IMMEDIATE takes the write lock first, so
  // while the retrain script holds it SQLite waits (busy timeout) instead of failing
  // at once with SQLITE_BUSY, which a deferred read-then-write transaction does.
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
  }, IMMEDIATE)
  if (received.existing) return received

  // A private folder per upload; the file name is random, never the client's.
  let folder: string | null = null
  let path: string
  try {
    folder = await makeUploadFolder(deps.tmpDir)
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
  // Set when the read passed its time limit: a stalled read that wakes up later stages
  // nothing more for the upload that has been failed meanwhile.
  let stopped = false
  try {
    const insert = sqliteOf(db).prepare(
      `INSERT INTO upload_rows (upload_id, ${CALL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    // One transaction per batch, so no write lock is held for long.
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
    const reading = parseWorkbook(path, {
      maxRows: deps.maxRows,
      onRows(sheet, rows) {
        if (stopped) throw new ParseTimeout()
        const [firstId, lastId] = stage.immediate(rows)
        batches.push({ sheet, firstId, lastId })
      },
    })
    const parse = await within(reading, deps.parseTimeoutMs ?? MAX_PARSE_MS, () => {
      stopped = true
    })
    const report: StoredReport = parse.errors.length
      ? unreadableReport(parse)
      : await buildReport(db, uploadId, { ...parse, batches }, deps.today())
    db.transaction((tx) => {
      if (!report.ok) tx.delete(uploadRows).where(eq(uploadRows.uploadId, uploadId)).run()
      tx.update(uploads)
        .set({
          status: report.ok ? 'ready' : 'invalid',
          error: report.ok ? null : invalidReason(report),
          report,
          totalRows: report.summary.total_rows,
          firstDay: report.summary.first_day,
          lastDay: report.summary.last_day,
          parsedAt: new Date(),
        })
        .where(and(eq(uploads.id, uploadId), eq(uploads.status, 'parsing')))
        .run()
    }, IMMEDIATE)
  } catch (error) {
    console.error(`[uploads] upload ${uploadId} could not be read: ${errorType(error)}`)
    const message = error instanceof ParseTimeout ? TOOK_TOO_LONG : UNREADABLE
    try {
      db.transaction((tx) => {
        tx.delete(uploadRows).where(eq(uploadRows.uploadId, uploadId)).run()
        tx.update(uploads)
          .set({ status: 'failed', error: message, parsedAt: new Date() })
          .where(and(eq(uploads.id, uploadId), eq(uploads.status, 'parsing')))
          .run()
      }, IMMEDIATE)
    } catch (inner) {
      console.error(`[uploads] upload ${uploadId} could not be marked failed: ${errorType(inner)}`)
    }
  } finally {
    await rm(path, { force: true }).catch(() => {})
    // Removes the private folder receiveUpload made; leaves any other folder alone.
    await rmdir(dirname(path)).catch(() => {})
  }
}

// Why an invalid upload cannot be imported, in one sentence for its `error`: the first
// problem of the report, which lists them all.
function invalidReason(report: StoredReport): string {
  const [first, ...more] = report.file_errors
  if (!first) return UNREADABLE
  if (!more.length) return first.message
  const count = more.length === 1 ? '1 more problem is' : `${more.length} more problems are`
  return `${first.message} ${count} listed in the report.`
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

function callsRevision(db: AppDb): number {
  return db.select().from(dataState).get()?.callsRevision ?? 0
}

function withPlan(report: StoredReport, plan: StoredPlan, revision: number): StoredReport {
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
    calls_revision: revision,
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
  const tooOld = days.filter((day) => day < EARLIEST_CALL_DAY)
  if (tooOld.length) {
    errors.push({
      code: 'day_out_of_range',
      message:
        `The file has calls dated before ${EARLIEST_CALL_DAY} (${listDays(tooOld)}). This line has ` +
        'no calls that old, so the dates were not read as they were meant. Open the file in ' +
        'Excel, check that the Start_Date column shows the real call dates, and export it again.',
    })
  }
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
  const warnings = errors.length ? [] : gapWarnings(db, days, gaps)
  if (split.length) {
    warnings.push(`${split.length} day(s) have calls on ${COMBINED_SHEETS}: ${listDays(split)}.`)
  }
  const revision = callsRevision(db)

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
  return withPlan(base, await planAgainstStoredInTurns(db, fileDays), revision)
}

// Unreported days: those the retrain would refuse once the file is in, and the other
// dates inside the file that have no call.
function gapWarnings(db: AppDb, days: string[], gaps: string[]): string[] {
  const warnings: string[] = []
  const unreported = recentDaysWithoutCalls(db, days)
  if (unreported.length) {
    warnings.push(
      `After this import, ${unreported.length} day(s) would have no calls at all: ` +
        `${listDays(unreported)}. The forecast cannot be retrained while a day in the last ` +
        `${RECENT_GAP_DAYS} days of call data has no calls. Load the calls of these days too ` +
        '(in this file or another one); until then the forecast in use stays as it is.'
    )
  }
  const otherGaps = gaps.filter((day) => !unreported.includes(day))
  if (otherGaps.length) {
    warnings.push(
      `${otherGaps.length} date(s) have no calls recorded in this workbook: ${listDays(otherGaps)}. They are left untouched.`
    )
  }
  return warnings
}

// An upload as the page should see it. A ready upload whose plan was made before the
// stored calls last changed (another import since) is planned again first, so the page
// never shows an outdated plan, such as "nothing to import" for a day that now differs.
export async function currentUpload(db: AppDb, uploadId: number): Promise<UploadRow> {
  const row = getUpload(db, uploadId)
  const report = row.report as StoredReport | null
  if (row.status !== 'ready' || !report || report.calls_revision === callsRevision(db)) return row
  const revision = callsRevision(db)
  const lines = new Map<string, string[]>()
  for await (const rows of rowsInChunks(db, 'upload_rows', 'upload_id = ?', [uploadId])) {
    for (const call of rows) {
      const day = dayOf(call.start_ts)
      const dayLines = lines.get(day)
      if (dayLines) dayLines.push(callLine(toCall(call)))
      else lines.set(day, [callLine(toCall(call))])
    }
  }
  const fileDays = await summarizeLines(lines)
  const plan = await planAgainstStoredInTurns(db, fileDays)
  const days = [...fileDays.keys()]
  const refreshed = withPlan(
    {
      ...report,
      warnings: [
        ...gapWarnings(db, days, daysWithoutCalls(days)),
        ...report.warnings.filter((w) => w.includes(COMBINED_SHEETS)),
      ],
    },
    plan,
    revision
  )
  db.update(uploads)
    .set({ report: refreshed })
    .where(and(eq(uploads.id, uploadId), eq(uploads.status, 'ready')))
    .run()
  return getUpload(db, uploadId)
}

// Days that would have no call at all once this file is in, among those the retrain
// checks: from the first call day to the last (stored or in the file), only the last
// RECENT_GAP_DAYS days before the last one (see limits.ts).
function recentDaysWithoutCalls(db: AppDb, fileDays: string[]): string[] {
  if (fileDays.length === 0) return []
  const client = sqliteOf(db)
  const span = client
    .prepare('SELECT min(start_ts) AS first, max(start_ts) AS last FROM calls')
    .get() as { first: string | null; last: string | null }
  const first = [fileDays[0]!, span.first ? dayOf(span.first) : null]
    .filter((d): d is string => d !== null)
    .sort()[0]!
  const last = [fileDays[fileDays.length - 1]!, span.last ? dayOf(span.last) : null]
    .filter((d): d is string => d !== null)
    .sort()
    .pop()!
  const windowStart = addDays(last, -(RECENT_GAP_DAYS - 1))
  const from = first > windowStart ? first : windowStart
  const present = new Set(fileDays)
  const stored = client
    .prepare('SELECT DISTINCT substr(start_ts, 1, 10) AS day FROM calls WHERE start_ts >= ?')
    .all(from) as { day: string }[]
  for (const { day } of stored) present.add(day)
  return dateRange(from, last).filter((day) => !present.has(day))
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
): { upload: UploadRow; run: RunRow | null; queued: boolean } {
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
        .set({ report: withPlan(report, plan, callsRevision(db)) })
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
    // What the served forecast said for the new days, kept before the retrain this import
    // starts learns them (server/utils/accuracy). A replaced day was in the data already.
    const now = new Date()
    captureForecastSnapshots(client, added, uploadId, Math.floor(now.getTime() / 1000))
    tx.delete(uploadRows).where(eq(uploadRows.uploadId, uploadId)).run()
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
  }, IMMEDIATE)
  if (outcome instanceof Refusal) throw apiError(409, 'conflict', outcome.message)

  let run: RunRow | null = null
  let queued = false
  if (deps.onImported) {
    // The calls are in; a retrain that cannot start must not undo or hide the import.
    try {
      const started = deps.onImported({ uploadId, userLabel: user.email })
      if (started) {
        run = started.run
        queued = started.queued
        // uploads.run_id is the run this import started. When the runner only queued
        // a re-run behind the active one, that active run never reads this file.
        if (!started.queued) {
          db.update(uploads).set({ runId: started.run.id }).where(eq(uploads.id, uploadId)).run()
        }
      }
    } catch (error) {
      console.error(
        `[uploads] upload ${uploadId}: the retrain could not be started: ${errorType(error)}`
      )
    }
  }
  return { upload: getUpload(db, uploadId), run, queued }
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
  }, IMMEDIATE)
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
  }, IMMEDIATE)
}

const ROW_COUNT = 'must be the number of rows in the file, a whole number'
export const importRequestSchema = z.object({
  total_rows: z.number({ message: ROW_COUNT }).int({ message: ROW_COUNT }).min(0, ROW_COUNT),
  replace_days: z
    .array(
      z
        .string({ message: 'must be a YYYY-MM-DD date' })
        .refine(isIsoDate, 'must be a YYYY-MM-DD date'),
      {
        message: 'must be a list of days (YYYY-MM-DD), empty when no day is replaced',
      }
    )
    .max(10_000, 'must list at most 10,000 days'),
})
