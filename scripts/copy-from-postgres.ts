// One-time copy of the call history from final-main's Postgres into the SQLite file.
//
//   pnpm tsx scripts/copy-from-postgres.ts            # dry run: counts and what it would do
//   pnpm tsx scripts/copy-from-postgres.ts --commit   # copy
//
// Reads V4W_DATABASE_URL (the OLD Postgres) and DATABASE_URL (the SQLite file) from the
// environment or .env. Refuses when the SQLite file is not migrated, when it already has
// calls, or when a Postgres call time has a fraction of a second. Copies every call and
// every holiday in ONE SQLite transaction, as an upload of source 'postgres-copy', and
// bumps the data revision, so the app's start-up retrain picks the data up.
//
// Never prints the connection string or a call record: counts, days and messages only.
// Call times are read as text (to_char), never through a JavaScript Date: they are
// wall-clock times with no zone and must arrive exactly as stored.
import 'dotenv/config'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sql as sqlite } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '../server/db/schema'
import { callLine, type CallValues } from '../server/utils/ingest/days'

const PAGE = 50_000
// Seven bound values per call: stay under SQLite's 32,766 variables per statement.
const INSERT_CHUNK = 4_000
const REQUIRED_TABLES = ['uploads', 'calls', 'holidays', 'data_state']

function fail(message: string): never {
  console.error(`Refused: ${message}`)
  process.exit(1)
}

function sqlitePath(url: string): string {
  const path = url.startsWith('file:') ? url.slice('file:'.length) : url
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

const n = (value: number) => value.toLocaleString('en-US')
const commit = process.argv.includes('--commit')
const pgUrl = process.env.V4W_DATABASE_URL?.trim()
if (!pgUrl)
  fail('set V4W_DATABASE_URL to the old Postgres connection string (environment or .env).')
const target = sqlitePath(process.env.DATABASE_URL?.trim() || 'file:./dev.db')

// --- the SQLite side ------------------------------------------------------------------
let file: Database.Database
try {
  file = new Database(target, { timeout: 15_000, fileMustExist: true })
} catch {
  fail('the SQLite file of DATABASE_URL does not exist. Run pnpm db:migrate first.')
}
file.pragma('foreign_keys = ON')
const db = drizzle(file, { schema })
const tables = new Set(
  (
    file.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((row) => row.name)
)
const missing = REQUIRED_TABLES.filter((table) => !tables.has(table))
if (missing.length) {
  fail(
    `the SQLite file is not migrated (no ${missing.join(', ')} table). Run pnpm db:migrate first.`
  )
}
const stored = db
  .select({ count: sqlite<number>`count(*)` })
  .from(schema.calls)
  .get()!.count
if (stored > 0) {
  fail(`the SQLite file already has ${n(stored)} calls. The copy is for an empty database only.`)
}
const revision = db.select().from(schema.dataState).get()?.callsRevision ?? 0

// --- the Postgres side ----------------------------------------------------------------
const pg = postgres(pgUrl, { max: 1, onnotice: () => {} })

async function readPostgres<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    // Driver messages can carry the host; never the URL, but print only what is safe.
    const code = (error as { code?: string }).code
    await pg.end({ timeout: 1 }).catch(() => {})
    return fail(`could not read the old Postgres database (${code ?? (error as Error).name}).`)
  }
}

const [summary] = await readPostgres(
  () => pg<
    { calls: string; days: string; first: string | null; last: string | null; fractions: string }[]
  >`
    SELECT count(*) AS calls,
           count(DISTINCT start_ts::date) AS days,
           to_char(min(start_ts), 'YYYY-MM-DD"T"HH24:MI:SS') AS first,
           to_char(max(start_ts), 'YYYY-MM-DD"T"HH24:MI:SS') AS last,
           count(*) FILTER (WHERE start_ts <> date_trunc('second', start_ts)) AS fractions
    FROM calls`
)
const holidays = await readPostgres(
  () => pg<{ holiday_date: string; holiday_name: string | null }[]>`
    SELECT holiday_date::text AS holiday_date, holiday_name FROM holidays ORDER BY holiday_date`
)
const totals = {
  calls: Number(summary!.calls),
  days: Number(summary!.days),
  fractions: Number(summary!.fractions),
}

console.log(
  `Postgres: ${n(totals.calls)} calls on ${n(totals.days)} days, first ${summary!.first ?? '-'}, ` +
    `last ${summary!.last ?? '-'}; ${holidays.length} holidays` +
    (holidays.length ? ` (${holidays[0]!.holiday_date} to ${holidays.at(-1)!.holiday_date})` : '') +
    '.'
)
console.log(`SQLite: migrated, no calls, data revision ${revision}.`)
if (totals.calls === 0) fail('the old database has no calls.')
if (totals.fractions > 0) {
  fail(
    `${n(totals.fractions)} call times have a fraction of a second; calls here are stored to the ` +
      'second, so the copy would not be faithful.'
  )
}
const unnamed = holidays.filter((h) => !h.holiday_name)
if (unnamed.length) {
  fail(
    `${unnamed.length} holiday(s) have no name (${unnamed.map((h) => h.holiday_date).join(', ')}).`
  )
}
console.log(
  `Would create upload "postgres copy" (source postgres-copy), insert ${n(totals.calls)} calls, ` +
    `insert the ${holidays.length} holidays (keeping any already present) and set the data ` +
    `revision to ${revision + 1}.`
)
if (!commit) {
  console.log('Dry run: nothing written. Run again with --commit to copy.')
  await pg.end()
  process.exit(0)
}

// --- the copy ---------------------------------------------------------------------------
type PgCall = {
  id: string
  start_ts: string
  in_queue_sec: number | null
  agent_sec: number | null
  abandon_sec: number | null
  routing_sec: number | null
  abandoned: boolean
}
const calls: CallValues[] = []
let after = '0'
for (;;) {
  // calls.id, not id: the output column `id` is text, and ORDER BY would sort that.
  const page = await readPostgres(
    () => pg<PgCall[]>`
      SELECT id::text AS id,
             to_char(start_ts, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_ts,
             in_queue_sec::float8 AS in_queue_sec, agent_sec::float8 AS agent_sec,
             abandon_sec::float8 AS abandon_sec, routing_sec::float8 AS routing_sec,
             abandoned
      FROM calls WHERE calls.id > ${after}::bigint ORDER BY calls.id LIMIT ${PAGE}`
  )
  if (page.length === 0) break
  for (const row of page) {
    calls.push({
      startTs: row.start_ts,
      inQueueSec: row.in_queue_sec,
      agentSec: row.agent_sec,
      abandonSec: row.abandon_sec,
      routingSec: row.routing_sec,
      abandoned: row.abandoned,
    })
  }
  after = page.at(-1)!.id
}
await pg.end()
if (calls.length !== totals.calls) {
  fail(
    `read ${n(calls.length)} calls but counted ${n(totals.calls)}; the old database changed during the copy.`
  )
}

const lines = calls.map((call) => callLine(call)).sort()
const days = [...new Set(calls.map((call) => call.startTs.slice(0, 10)))].sort()
const now = new Date()
const copied = db.transaction((tx) => {
  if (tx.select({ id: schema.calls.id }).from(schema.calls).limit(1).get()) {
    throw new Error('calls appeared in the SQLite file during the copy')
  }
  const upload = tx
    .insert(schema.uploads)
    .values({
      source: 'postgres-copy',
      status: 'imported',
      filename: 'postgres copy',
      fileSha256: createHash('sha256').update(lines.join('\n')).digest('hex'),
      fileBytes: 0,
      uploadedByLabel: 'cli',
      createdAt: now,
      parsedAt: now,
      importedAt: now,
      importedByLabel: 'cli',
      totalRows: calls.length,
      firstDay: days[0]!,
      lastDay: days.at(-1)!,
    })
    .returning()
    .get()
  for (let i = 0; i < calls.length; i += INSERT_CHUNK) {
    tx.insert(schema.calls)
      .values(calls.slice(i, i + INSERT_CHUNK).map((call) => ({ ...call, uploadId: upload.id })))
      .run()
  }
  if (holidays.length) {
    tx.insert(schema.holidays)
      .values(holidays.map((h) => ({ holidayDate: h.holiday_date, holidayName: h.holiday_name! })))
      .onConflictDoNothing()
      .run()
  }
  const state = tx
    .insert(schema.dataState)
    .values({ id: 1, callsRevision: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.dataState.id,
      set: { callsRevision: sqlite`${schema.dataState.callsRevision} + 1`, updatedAt: now },
    })
    .returning()
    .get()
  tx.update(schema.uploads)
    .set({
      result: {
        inserted_rows: calls.length,
        deleted_rows: 0,
        added_days: days,
        replaced_days: [],
        skipped_days: [],
        calls_revision: state.callsRevision,
      },
    })
    .where(sqlite`${schema.uploads.id} = ${upload.id}`)
    .run()
  return { upload: upload.id, revision: state.callsRevision }
})
const holidayCount = db
  .select({ count: sqlite<number>`count(*)` })
  .from(schema.holidays)
  .get()!.count
file.close()
console.log(
  `Copied ${n(calls.length)} calls on ${n(days.length)} days (${days[0]} to ${days.at(-1)}) as upload ` +
    `${copied.upload}; the holidays table has ${holidayCount} rows; data revision ${copied.revision}.`
)
console.log(
  'Next: start the app. A retrain starts by itself, because the call data is newer than the forecast.'
)
