// POST /api/admin/uploads over real HTTP (review W3-9): a body sent without
// Content-Length (chunked, as a proxy that streams request bodies forwards it) is read
// and accepted; a chunked body that passes the limit is refused with 413 as soon as it
// does; a declared length over the limit is refused before reading; a body longer than
// the length it declares is read only as far as declared. Nothing is stored and no temp
// folder is left by a refused body.
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, eventHandler, toNodeListener } from 'h3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // Never the developer's database from .env; a small limit, so passing it is cheap.
  process.env.DATABASE_URL = 'file::memory:'
  process.env.V4W_UPLOAD_MAX_MB = '1'
})

const { db } = await import('../../../server/utils/db')
const { default: handler } = await import('../../../server/api/admin/uploads/index.post')
const schema = await import('../../../server/db/schema')
const { readBodyWithin } = await import('../../../server/utils/ingest/body')
const { rawLayout, wholeDay, withTempDir, writeWorkbook } = await import('./fixtures/workbooks')

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))
let server: Server
let port = 0

beforeAll(async () => {
  migrate(db, { migrationsFolder: MIGRATIONS })
  const admin = db
    .insert(schema.user)
    .values({ email: 'admin@example.org', name: 'admin', role: 'admin' })
    .returning()
    .get()
  const app = createApp()
  app.use(
    eventHandler((event) => {
      event.context.user = { ...admin, role: 'admin' } as never
    })
  )
  app.use('/api/admin/uploads', handler)
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await settled()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function multipart(file: Buffer) {
  const boundary = 'v4wtestboundary'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="SYNTHETIC calls.xlsx"\r\n` +
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    body: Buffer.concat([head, file, tail]),
    type: `multipart/form-data; boundary=${boundary}`,
  }
}

async function workbook(day: string): Promise<Buffer> {
  return withTempDir(async (dir) =>
    readFile(await writeWorkbook(join(dir, 'book.xlsx'), rawLayout(wholeDay(day))))
  )
}

// Sends the body in pieces: without Content-Length (Node then uses chunked encoding),
// or with the Content-Length given, true or not. Status 0: the connection was dropped.
function post(
  body: Buffer,
  type: string,
  length?: number
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string | number> = { 'content-type': type }
  if (length !== undefined) headers['content-length'] = length
  return new Promise((resolve) => {
    let answered = false
    const req = request(
      // A connection of its own: a lying request must not leave a reused socket behind.
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/admin/uploads',
        headers,
        agent: false,
      },
      (res) => {
        answered = true
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode!, text }))
        // A connection dropped after the answer ends the body without 'end'.
        res.on('close', () => resolve({ status: res.statusCode!, text }))
      }
    )
    // The server may answer and close before the whole body is sent.
    req.on('error', () => {
      if (!answered) resolve({ status: 0, text: '' })
    })
    for (let i = 0; i < body.length; i += 4096) req.write(body.subarray(i, i + 4096))
    req.end()
  })
}

const uploadCount = () => db.select().from(schema.uploads).all().length
// The folder goes in parseUpload's `finally`, just after the upload's status is set:
// wait a moment for it rather than read the directory once.
const ourTempFolders = async () => {
  let left: string[] = []
  for (let i = 0; i < 100; i++) {
    left = (await readdir(tmpdir())).filter((name) => name.startsWith(`v4w-upload-${process.pid}-`))
    if (left.length === 0) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return left
}

// Waits until no upload is being read (the background part of an accepted upload).
async function settled() {
  for (let i = 0; i < 400; i++) {
    if (
      !db
        .select()
        .from(schema.uploads)
        .all()
        .some((u) => u.status === 'parsing')
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('POST /api/admin/uploads', () => {
  it('accepts a chunked body without Content-Length and reads the file', async () => {
    const { body, type } = multipart(await workbook('2026-11-05'))
    const answer = await post(body, type)
    expect(answer.status, answer.text).toBe(202)
    const id = JSON.parse(answer.text).upload.id as number
    await settled()
    expect(
      db
        .select()
        .from(schema.uploads)
        .all()
        .find((u) => u.id === id)?.status
    ).toBe('ready')
    expect(await ourTempFolders()).toEqual([])
  })

  it('refuses a chunked body as soon as it passes the limit, storing nothing', async () => {
    await settled()
    const before = uploadCount()
    const big = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(3 * 1024 * 1024),
    ])
    const { body, type } = multipart(big)
    const answer = await post(body, type)
    expect(answer.status).toBe(413)
    expect(JSON.parse(answer.text).data.code).toBe('too_large')
    expect(uploadCount()).toBe(before)
    expect(await ourTempFolders()).toEqual([])
  })

  it('refuses a declared length over the limit before reading', async () => {
    const { body, type } = multipart(Buffer.alloc(16))
    const answer = await post(body, type, 5 * 1024 * 1024)
    expect(answer.status).toBe(413)
  })

  it('reads a body only as far as its Content-Length: a longer body is cut and refused', async () => {
    await settled()
    const before = uploadCount()
    const { body, type } = multipart(await workbook('2026-11-06'))
    const answer = await post(body, type, 200)
    expect(answer.status === 0 || answer.status >= 400).toBe(true)
    await settled()
    expect(uploadCount()).toBe(before)
    expect(await ourTempFolders()).toEqual([])
  })
})

describe('readBodyWithin', () => {
  it('returns the body up to the limit and null past it', async () => {
    const chunks = [Buffer.alloc(10, 1), Buffer.alloc(10, 2)]
    expect((await readBodyWithin(chunks, 20))!.length).toBe(20)
    expect(await readBodyWithin(chunks, 19)).toBeNull()
  })

  it('stops reading as soon as the limit is passed', async () => {
    let pulled = 0
    async function* endless() {
      for (;;) {
        pulled++
        yield Buffer.alloc(1024)
      }
    }
    expect(await readBodyWithin(endless(), 4096)).toBeNull()
    expect(pulled).toBe(5)
  })
})
