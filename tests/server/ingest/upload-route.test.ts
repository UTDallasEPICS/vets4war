// POST /api/admin/uploads over real HTTP: a body sent without Content-Length (chunked,
// as a proxy that streams request bodies forwards it) is read and accepted, and a body
// that passes the limit is refused with 413 as soon as it does (review W3-9).
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, eventHandler, toNodeListener } from 'h3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // Never the developer's database from .env.
  process.env.DATABASE_URL = 'file::memory:'
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

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

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

// Sends the body in pieces without Content-Length (Node then uses chunked encoding).
function postChunked(body: Buffer, type: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/admin/uploads',
        headers: { 'content-type': type },
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode!, text }))
      }
    )
    req.on('error', reject)
    for (let i = 0; i < body.length; i += 4096) req.write(body.subarray(i, i + 4096))
    req.end()
  })
}

describe('POST /api/admin/uploads without Content-Length', () => {
  it('accepts a chunked body and starts reading the file', async () => {
    const file = await withTempDir(async (dir) =>
      readFile(await writeWorkbook(join(dir, 'book.xlsx'), rawLayout(wholeDay('2026-11-05'))))
    )
    const { body, type } = multipart(file)
    const answer = await postChunked(body, type)
    expect(answer.status, answer.text).toBe(202)
    expect(JSON.parse(answer.text).upload.status).toBe('parsing')
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
