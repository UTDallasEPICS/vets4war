// Uploads end to end at the service level, on an in-memory database: receive, read,
// the per-day plan, import, refusals and housekeeping. Workbooks are SYNTHETIC and
// written at test time with the exceljs writer.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { count, eq } from 'drizzle-orm'
import { createTestDb, createTestUser } from '../../helpers/db'
import * as schema from '../../../server/db/schema'
import type { AppDb } from '../../../server/utils/db'
import {
  discardUpload,
  getUpload,
  importUpload,
  listUploads,
  receiveUpload,
  recoverUploads,
  uploadDetail,
  type IngestDeps,
  type RunRow,
} from '../../../server/utils/ingest/service'
import {
  HEADER,
  call,
  rawLayout,
  wholeDay,
  writeWorkbook,
  type SheetSpec,
} from './fixtures/workbooks'

const TODAY = '2026-11-19'
// A value no message or report may ever show.
const SECRET_SECONDS = 4321.987

let db: AppDb
let admin: { id: string; email: string }
let folder: string
let imported: { uploadId: number; userLabel: string }[]

function deps(overrides: Partial<IngestDeps> = {}): IngestDeps {
  return {
    maxBytes: 40 * 1024 * 1024,
    maxRows: 10_000,
    today: () => TODAY,
    tmpDir: folder,
    onImported(result) {
      imported.push(result)
      const run = db
        .insert(schema.forecastRuns)
        .values({
          trigger: 'import',
          mode: 'full',
          status: 'queued',
          requestedByLabel: result.userLabel,
          uploadId: result.uploadId,
          createdAt: new Date(),
        })
        .returning()
        .get() as RunRow
      return { run, queued: false }
    },
    ...overrides,
  }
}

async function bytesOf(sheets: SheetSpec[]): Promise<Buffer> {
  const path = await writeWorkbook(join(folder, `book-${Math.random()}.xlsx`), sheets)
  const data = await readFile(path)
  await rm(path)
  return data
}

async function upload(sheets: SheetSpec[], options: Partial<IngestDeps> = {}) {
  const received = await receiveUpload(db, deps(options), {
    filename: 'SYNTHETIC calls.xlsx',
    data: await bytesOf(sheets),
    user: admin,
  })
  await received.parsing
  return getUpload(db, received.upload.id)
}

const callCount = () => db.select({ n: count() }).from(schema.calls).get()!.n
const stagedCount = (uploadId?: number) =>
  db
    .select({ n: count() })
    .from(schema.uploadRows)
    .where(uploadId ? eq(schema.uploadRows.uploadId, uploadId) : undefined)
    .get()!.n
const revision = () => db.select().from(schema.dataState).get()?.callsRevision ?? 0

const NOV_5 = wholeDay('2026-11-05')
const NOV_6 = wholeDay('2026-11-06')
const NOV_7 = wholeDay('2026-11-07')

beforeEach(async () => {
  db = createTestDb().db
  admin = createTestUser(db, { email: 'admin@example.org', role: 'admin' })
  folder = await mkdtemp(join(tmpdir(), 'v4w-service-test-'))
  imported = []
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

describe('receive and read', () => {
  it('reads a file into the stage and plans every day as new', async () => {
    const row = await upload(rawLayout([...NOV_5, ...NOV_6]))
    expect(row.status).toBe('ready')
    expect(row.uploadedByLabel).toBe('admin@example.org')
    expect(row.totalRows).toBe(48)
    expect([row.firstDay, row.lastDay]).toEqual(['2026-11-05', '2026-11-06'])
    expect(stagedCount(row.id)).toBe(48)
    const detail = uploadDetail(row)
    expect(detail.report).toEqual({
      ok: true,
      nothing_to_import: false,
      summary: {
        total_rows: 48,
        first_day: '2026-11-05',
        last_day: '2026-11-06',
        days: 2,
        new_days: 2,
        identical_days: 0,
        conflict_days: 0,
      },
      days: [
        { day: '2026-11-05', rows: 24, existing_rows: 0, status: 'new' },
        { day: '2026-11-06', rows: 24, existing_rows: 0, status: 'new' },
      ],
      days_without_calls: [],
      file_errors: [],
      warnings: [],
    })
    expect(Object.keys(detail.report!)).not.toContain('stored_days')
    // The temp file and its private folder are gone once the file is read.
    expect(await readdir(folder)).toEqual([])
  })

  it('marks a file with a bad row invalid and keeps none of its rows', async () => {
    const row = await upload(
      rawLayout([...NOV_5, call('2026-11-05', '12:00:00', 1, 2, 0, 1, 'Maybe')])
    )
    expect(row.status).toBe('invalid')
    expect(stagedCount(row.id)).toBe(0)
    expect(row.report!.ok).toBe(false)
    expect(row.report!.file_errors.map((e) => e.code)).toEqual(['bad_rows'])
  })

  it('marks a workbook without call records invalid with no_call_sheet', async () => {
    const row = await upload([{ name: 'Staffing', rows: [['SATURDAY 8/1']] }])
    expect(row.status).toBe('invalid')
    expect(row.report!.file_errors.map((e) => e.code)).toEqual(['no_call_sheet'])
  })

  it('refuses days that are not finished yet', async () => {
    const row = await upload(rawLayout([...wholeDay('2026-11-18'), ...wholeDay(TODAY)]))
    expect(row.status).toBe('invalid')
    expect(row.report!.file_errors).toEqual([
      {
        code: 'day_not_finished',
        message:
          'Only finished days can be imported; the file includes 2026-11-19. Export up to 2026-11-18.',
      },
    ])
    expect(stagedCount(row.id)).toBe(0)
  })

  it('refuses a file cut off part-way through its last day', async () => {
    const cut = NOV_6.filter((r) => (r[2] as Date).getUTCHours() < 14)
    const row = await upload(rawLayout([...NOV_5, ...cut]))
    expect(row.report!.file_errors).toEqual([
      {
        code: 'partial_day',
        message: 'The file starts or stops part-way through a day (2026-11-06). Export whole days.',
      },
    ])
  })

  it('refuses the same calls on two sheets, and combines a day split over two sheets', async () => {
    const copied = await upload([
      { name: 'A', rows: [HEADER, ...NOV_5] },
      { name: 'B', rows: [HEADER, ...NOV_5.slice(0, 3)] },
    ])
    expect(copied.report!.file_errors.map((e) => e.code)).toEqual(['day_on_two_sheets'])
    expect(copied.report!.file_errors[0]!.message).toBe(
      'The same calls for 2026-11-05 appear on more than one sheet. Remove the copy so each call is in the file once.'
    )

    const split = await upload([
      { name: 'CY 2026 a', rows: [HEADER, ...NOV_5, ...NOV_6.slice(0, 20)] },
      { name: 'CY 2026 b', rows: [HEADER, ...NOV_6.slice(20)] },
    ])
    expect(split.status).toBe('ready')
    expect(split.report!.warnings).toEqual([
      '1 day(s) have calls on more than one sheet and were combined: 2026-11-06.',
    ])
  })

  it('warns about dates without calls inside the file range', async () => {
    const row = await upload(rawLayout([...NOV_5, ...NOV_7]))
    expect(row.status).toBe('ready')
    expect(row.report!.days_without_calls).toEqual(['2026-11-06'])
    expect(row.report!.warnings).toEqual([
      '1 date(s) have no calls recorded in this workbook: 2026-11-06. They are left untouched.',
    ])
  })

  it('stops at the row limit with too_many_rows', async () => {
    const row = await upload(rawLayout([...NOV_5, ...NOV_6]), { maxRows: 30 })
    expect(row.status).toBe('invalid')
    expect(row.report!.file_errors.map((e) => e.code)).toEqual(['too_many_rows'])
    expect(stagedCount()).toBe(0)
  })

  it('returns the upload that already holds the same bytes', async () => {
    const data = await bytesOf(rawLayout(NOV_5))
    const first = await receiveUpload(db, deps(), { filename: 'a.xlsx', data, user: admin })
    await first.parsing
    const again = await receiveUpload(db, deps(), { filename: 'b.xlsx', data, user: admin })
    expect(again.existing).toBe(true)
    expect(again.upload.id).toBe(first.upload.id)
    expect(again.parsing).toBeUndefined()
  })

  it('answers busy while another file is being read', async () => {
    const first = await receiveUpload(db, deps(), {
      filename: 'a.xlsx',
      data: await bytesOf(rawLayout(NOV_5)),
      user: admin,
    })
    const second = receiveUpload(db, deps(), {
      filename: 'b.xlsx',
      data: await bytesOf(rawLayout(NOV_6)),
      user: admin,
    })
    await expect(second).rejects.toMatchObject({
      statusCode: 429,
      data: { code: 'busy' },
      message: 'Another file is being read right now. Try again in a few seconds.',
    })
    await first.parsing
    expect(getUpload(db, first.upload.id).status).toBe('ready')
  })

  it('refuses a file over the size limit and a file that is not a zip', async () => {
    const data = await bytesOf(rawLayout(NOV_5))
    await expect(
      receiveUpload(db, deps({ maxBytes: 100 }), { filename: 'a.xlsx', data, user: admin })
    ).rejects.toMatchObject({ statusCode: 413, data: { code: 'too_large' } })
    await expect(
      receiveUpload(db, deps(), { filename: 'a.csv', data: Buffer.from('a,b\n1,2\n'), user: admin })
    ).rejects.toMatchObject({ statusCode: 400, data: { code: 'not_a_workbook' } })
    expect(listUploads(db)).toEqual([])
  })

  it('discards ready uploads older than a week when a new one arrives', async () => {
    const old = await upload(rawLayout(NOV_5))
    db.update(schema.uploads)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(schema.uploads.id, old.id))
      .run()
    await upload(rawLayout(NOV_6))
    expect(getUpload(db, old.id).status).toBe('discarded')
    expect(stagedCount(old.id)).toBe(0)
  })
})

describe('import', () => {
  it('imports new days, bumps the revision and starts the retrain', async () => {
    const row = await upload(rawLayout([...NOV_5, ...NOV_6]))
    const { upload: done, run } = importUpload(
      db,
      deps(),
      row.id,
      { total_rows: 48, replace_days: [] },
      admin
    )
    expect(done.status).toBe('imported')
    expect(done.importedByLabel).toBe('admin@example.org')
    expect(done.result).toEqual({
      inserted_rows: 48,
      deleted_rows: 0,
      added_days: ['2026-11-05', '2026-11-06'],
      replaced_days: [],
      skipped_days: [],
      calls_revision: 1,
    })
    expect(callCount()).toBe(48)
    expect(stagedCount()).toBe(0)
    expect(revision()).toBe(1)
    const stored = db.select().from(schema.calls).all()
    expect(new Set(stored.map((c) => c.uploadId))).toEqual(new Set([row.id]))
    expect(imported).toEqual([{ uploadId: row.id, userLabel: 'admin@example.org' }])
    expect(run?.id).toBeGreaterThan(0)
    expect(done.runId).toBe(run!.id)
  })

  it('imports without starting a retrain when none is wired', async () => {
    const row = await upload(rawLayout(NOV_5))
    const { run } = importUpload(
      db,
      deps({ onImported: undefined }),
      row.id,
      { total_rows: 24, replace_days: [] },
      admin
    )
    expect(run).toBeNull()
    expect(getUpload(db, row.id).runId).toBeNull()
  })

  it('finds nothing to import in the same file again', async () => {
    const first = await upload(rawLayout(NOV_5))
    importUpload(db, deps(), first.id, { total_rows: 24, replace_days: [] }, admin)
    const again = await upload(rawLayout([...NOV_5].reverse()))
    expect(again.status).toBe('ready')
    expect(again.report!.nothing_to_import).toBe(true)
    expect(again.report!.days).toEqual([
      { day: '2026-11-05', rows: 24, existing_rows: 24, status: 'identical' },
    ])
    expect(() =>
      importUpload(db, deps(), again.id, { total_rows: 24, replace_days: [] }, admin)
    ).toThrow('Every day in this file is already loaded. Nothing to import.')
    expect(revision()).toBe(1)
  })

  it('replaces a changed day only when it is named, and keeps what it removed', async () => {
    const first = await upload(rawLayout([...NOV_5, ...NOV_6]))
    importUpload(db, deps(), first.id, { total_rows: 48, replace_days: [] }, admin)

    const changed = NOV_6.slice(0, -5).concat([NOV_6.at(-1)!])
    const second = await upload(rawLayout([...NOV_5, ...changed, ...NOV_7]))
    expect(second.report!.days.map((d) => [d.day, d.status, d.rows, d.existing_rows])).toEqual([
      ['2026-11-05', 'identical', 24, 24],
      ['2026-11-06', 'conflict', 20, 24],
      ['2026-11-07', 'new', 24, 0],
    ])
    const body = { total_rows: 68, replace_days: [] as string[] }
    expect(() => importUpload(db, deps(), second.id, body, admin)).toThrow(
      'These days already hold different calls: 2026-11-06. Not confirmed: 2026-11-06. ' +
        'Nothing was changed. Confirm replacing exactly the days that differ.'
    )
    expect(() =>
      importUpload(
        db,
        deps(),
        second.id,
        { ...body, replace_days: ['2026-11-06', '2026-11-07'] },
        admin
      )
    ).toThrow(/Not different: 2026-11-07\./)
    expect(callCount()).toBe(48)

    const { upload: done } = importUpload(
      db,
      deps(),
      second.id,
      { total_rows: 68, replace_days: ['2026-11-06'] },
      admin
    )
    expect(done.result).toEqual({
      inserted_rows: 44,
      deleted_rows: 24,
      added_days: ['2026-11-07'],
      replaced_days: ['2026-11-06'],
      skipped_days: ['2026-11-05'],
      calls_revision: 2,
    })
    expect(callCount()).toBe(24 + 20 + 24)
    const kept = db.select().from(schema.replacedCalls).all()
    expect(kept).toHaveLength(24)
    expect(new Set(kept.map((c) => [c.replacedByUploadId, c.originalUploadId].join()))).toEqual(
      new Set([`${second.id},${first.id}`])
    )
    expect(kept.every((c) => c.startTs.startsWith('2026-11-06'))).toBe(true)
  })

  it("refuses a row count that is not the file's", async () => {
    const row = await upload(rawLayout(NOV_5))
    expect(() =>
      importUpload(db, deps(), row.id, { total_rows: 25, replace_days: [] }, admin)
    ).toThrow("The row count you typed (25) is not the file's (24).")
    expect(getUpload(db, row.id).status).toBe('ready')
  })

  it('refuses when the stored calls changed since the check, and stores the new plan', async () => {
    const a = await upload(rawLayout([...NOV_5, ...NOV_6]))
    const b = await upload(rawLayout(NOV_6))
    importUpload(db, deps(), b.id, { total_rows: 24, replace_days: [] }, admin)

    expect(() =>
      importUpload(db, deps(), a.id, { total_rows: 48, replace_days: [] }, admin)
    ).toThrow('The stored calls changed since this file was checked. Review the new plan.')
    const refreshed = getUpload(db, a.id)
    expect(refreshed.status).toBe('ready')
    expect(refreshed.report!.days.map((d) => d.status)).toEqual(['new', 'identical'])
    expect(refreshed.report!.summary).toMatchObject({ new_days: 1, identical_days: 1 })

    const { upload: done } = importUpload(
      db,
      deps(),
      a.id,
      { total_rows: 48, replace_days: [] },
      admin
    )
    expect(done.result!.added_days).toEqual(['2026-11-05'])
    expect(done.result!.skipped_days).toEqual(['2026-11-06'])
  })

  it('refuses an upload that is not ready, and an unknown one', async () => {
    const bad = await upload(
      rawLayout([...NOV_5, call('2026-11-05', '12:00:00', -1, 2, 0, 1, 'N')])
    )
    expect(() =>
      importUpload(db, deps(), bad.id, { total_rows: 0, replace_days: [] }, admin)
    ).toThrow('This upload is invalid. Only a checked file that is ready can be imported.')
    expect(() =>
      importUpload(db, deps(), 999, { total_rows: 0, replace_days: [] }, admin)
    ).toThrowError(expect.objectContaining({ statusCode: 404 }))
  })

  it('keeps the import when the retrain cannot start', async () => {
    const row = await upload(rawLayout(NOV_5))
    const failing = deps({
      onImported() {
        throw new Error('no runner')
      },
    })
    const { upload: done, run } = importUpload(
      db,
      failing,
      row.id,
      { total_rows: 24, replace_days: [] },
      admin
    )
    expect(done.status).toBe('imported')
    expect(run).toBeNull()
    expect(callCount()).toBe(24)
  })
})

describe('housekeeping', () => {
  it('discards a ready upload and its staged rows, and refuses to discard an imported one', async () => {
    const row = await upload(rawLayout(NOV_5))
    expect(discardUpload(db, row.id).status).toBe('discarded')
    expect(stagedCount(row.id)).toBe(0)

    const other = await upload(rawLayout(NOV_6))
    importUpload(db, deps(), other.id, { total_rows: 24, replace_days: [] }, admin)
    expect(() => discardUpload(db, other.id)).toThrow(
      'This upload is imported. Only an upload that is ready, invalid or failed can be discarded.'
    )
  })

  it('recoverUploads fails what a stopped process was reading', async () => {
    const row = db
      .insert(schema.uploads)
      .values({
        source: 'upload',
        status: 'parsing',
        filename: 'x.xlsx',
        fileSha256: 'x',
        fileBytes: 1,
        uploadedByLabel: 'admin@example.org',
        createdAt: new Date(),
      })
      .returning()
      .get()
    db.insert(schema.uploadRows)
      .values({
        uploadId: row.id,
        startTs: '2026-11-05T00:00:00',
        inQueueSec: 1,
        agentSec: 1,
        abandonSec: 0,
        routingSec: 1,
        abandoned: false,
      })
      .run()
    expect(recoverUploads(db)).toBe(1)
    expect(getUpload(db, row.id)).toMatchObject({
      status: 'failed',
      error: 'The server restarted while this file was being read. Upload it again.',
    })
    expect(stagedCount(row.id)).toBe(0)
    expect(recoverUploads(db)).toBe(0)
  })

  it('never shows a staged value in a report, a list or a refusal', async () => {
    const secret = [
      ...NOV_5.slice(0, -1),
      call('2026-11-05', '23:50:05', SECRET_SECONDS, SECRET_SECONDS, 0, SECRET_SECONDS, 'N'),
    ]
    const row = await upload(rawLayout(secret))
    const refusals: string[] = []
    for (const body of [
      { total_rows: 1, replace_days: [] },
      { total_rows: 24, replace_days: ['2026-11-05'] },
    ]) {
      try {
        importUpload(db, deps(), row.id, body, admin)
      } catch (error) {
        refusals.push(JSON.stringify(error), (error as Error).message)
      }
    }
    const bad = await upload(
      rawLayout([
        ...NOV_6,
        [...call('2026-11-06', '12:00:00', 1, 1, 0, 1, 'N').slice(0, 7), `X${SECRET_SECONDS}`],
      ])
    )
    const text = JSON.stringify([
      uploadDetail(getUpload(db, row.id)),
      uploadDetail(bad),
      listUploads(db),
      refusals,
    ])
    expect(refusals.length).toBe(4)
    expect(text).not.toContain('4321')
    expect(text).not.toContain('23:50:05')
  })
})
