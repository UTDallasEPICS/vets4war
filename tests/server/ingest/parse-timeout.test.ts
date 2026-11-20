// A read of an upload that stalls is stopped at its time limit: the upload is failed with
// a message that says so, nothing it staged is kept, nothing more is staged if the read
// wakes up later, and the next upload is read instead of being refused as busy. The
// workbook reader is replaced by one that stalls until the test lets it go on.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { count } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../../../server/db/schema'
import type { AppDb } from '../../../server/utils/db'
import type { ParseOptions, ParseResult } from '../../../server/utils/ingest/parser'
import { getUpload, receiveUpload, type IngestDeps } from '../../../server/utils/ingest/service'
import { createTestDb, createTestUser } from '../../helpers/db'

const reader = vi.hoisted(() => ({
  release: [] as (() => void)[],
  lateErrors: [] as unknown[],
}))

vi.mock('../../../server/utils/ingest/parser', async (original) => {
  const ROW = {
    startTs: '2026-11-05T08:00:00',
    inQueueSec: 1,
    agentSec: 1,
    abandonSec: 0,
    routingSec: 1,
    abandoned: false,
  }
  return {
    ...(await original<object>()),
    // Stages one batch, then stalls; once let go, tries to stage another.
    async parseWorkbook(_path: string, options: ParseOptions): Promise<ParseResult> {
      await options.onRows('Calls', [ROW])
      await new Promise<void>((resolve) => reader.release.push(resolve))
      try {
        await options.onRows('Calls', [ROW])
      } catch (error) {
        reader.lateErrors.push(error)
        throw error
      }
      return { sheets: [{ name: 'Calls', rows: 2 }], totalRows: 2, errors: [] }
    },
  }
})

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)])

let db: AppDb
let folder: string
let admin: { id: string; email: string }

const deps = (): IngestDeps => ({
  maxBytes: 1024 * 1024,
  maxRows: 10,
  today: () => '2026-11-19',
  tmpDir: folder,
  parseTimeoutMs: 50,
})
const staged = () => db.select({ n: count() }).from(schema.uploadRows).get()!.n
const upload = (data: Buffer) =>
  receiveUpload(db, deps(), { filename: 'SYNTHETIC calls.xlsx', data, user: admin })

beforeEach(async () => {
  db = createTestDb().db
  admin = createTestUser(db, { email: 'admin@example.org', role: 'admin' })
  folder = await mkdtemp(join(tmpdir(), 'v4w-parse-timeout-test-'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  for (const release of reader.release.splice(0)) release()
  reader.lateErrors = []
  vi.restoreAllMocks()
  await rm(folder, { recursive: true, force: true })
})

describe('a read that stalls', () => {
  it('is stopped at its time limit and the upload failed, keeping nothing it staged', async () => {
    const received = await upload(ZIP)
    expect(received.upload.status).toBe('parsing')
    expect(staged()).toBe(1)

    await received.parsing

    expect(getUpload(db, received.upload.id)).toMatchObject({
      status: 'failed',
      error:
        'Reading this file took too long and was stopped. Upload it again; if this happens ' +
        'again, split it into smaller files.',
    })
    expect(staged()).toBe(0)
    expect(console.error).toHaveBeenCalledWith(
      `[uploads] upload ${received.upload.id} could not be read: ParseTimeout`
    )

    // The stalled read wakes up: it may not stage anything more.
    reader.release.shift()!()
    await vi.waitFor(() => expect(reader.lateErrors).toHaveLength(1))
    expect(staged()).toBe(0)
  })

  it('does not keep the next upload waiting', async () => {
    const first = await upload(ZIP)
    await first.parsing
    const second = await upload(Buffer.concat([ZIP, Buffer.from('another file')]))
    expect(second.existing).toBe(false)
    expect(second.upload.status).toBe('parsing')
    await second.parsing
  })
})
