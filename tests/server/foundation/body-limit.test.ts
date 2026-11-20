// The request-body limit of server/middleware/00.body-limit.ts over real HTTP: a body
// over 64 KB is refused with the API's error shape on Better Auth's public routes and on
// the JSON routes, whether it declares its size or is sent chunked; a body within the
// limit still reaches the route, read the way h3 and Better Auth read it; the upload
// route keeps its own, larger limit.
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, eventHandler, readBody, toNodeListener, toWebRequest } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import bodyLimit, { MAX_BODY_BYTES, bodyIsLimited } from '../../../server/middleware/00.body-limit'
import { readBodyWithin } from '../../../server/utils/ingest/body'
import { MAX_PLANNED_ITEMS } from '../../../server/utils/forecast/params'

let server: Server
let port = 0

beforeAll(async () => {
  const app = createApp()
  app.use(bodyLimit)
  // As server/api/auth/[...all].ts hands the request to Better Auth.
  app.use(
    '/api/auth',
    eventHandler(async (event) => ({ bytes: (await toWebRequest(event).text()).length }))
  )
  app.use(
    '/api/admin/uploads',
    eventHandler(async (event) => {
      if (event.path !== '/') return { bytes: JSON.stringify(await readBody(event)).length }
      return { bytes: (await readBodyWithin(event.node.req, 10 * 1024 * 1024))!.length }
    })
  )
  app.use(
    '/api/planned',
    eventHandler(async (event) => ({ bytes: JSON.stringify(await readBody(event)).length }))
  )
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

// A JSON body of exactly `size` bytes.
function jsonOf(size: number): Buffer {
  const text = JSON.stringify({ email: 'a@example.org', type: 'sign-in', pad: '' })
  return Buffer.from(text.replace('"pad":""', `"pad":"${'x'.repeat(size - text.length)}"`))
}

// Without `chunked`, the body declares its length; with it, it is sent in pieces without
// Content-Length (Node then uses chunked encoding).
function post(
  path: string,
  body: Buffer,
  options: { chunked?: boolean } = {}
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const headers: Record<string, string | number> = { 'content-type': 'application/json' }
  if (!options.chunked) headers['content-length'] = body.length
  return new Promise((resolve) => {
    let answered = false
    const req = request(
      { host: '127.0.0.1', port, method: 'POST', path, headers, agent: false },
      (res) => {
        answered = true
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(text) }))
      }
    )
    req.on('error', () => {
      if (!answered) resolve({ status: 0, json: null })
    })
    for (let i = 0; i < body.length; i += 4096) req.write(body.subarray(i, i + 4096))
    req.end()
  })
}

const OVER = MAX_BODY_BYTES + 1024

describe('request body limit', () => {
  it.each(['/api/auth/sign-in/email-otp', '/api/planned', '/api/admin/uploads/1/import'])(
    'refuses a declared body over 64 KB on %s with 413 and data.code too_large',
    async (path) => {
      const answer = await post(path, jsonOf(OVER))
      expect(answer.status).toBe(413)
      expect(answer.json).toMatchObject({
        statusCode: 413,
        statusMessage: 'Payload Too Large',
        data: { code: 'too_large' },
      })
    }
  )

  it('refuses a chunked body as soon as it passes 64 KB', async () => {
    const answer = await post('/api/auth/email-otp/send-verification-otp', jsonOf(OVER), {
      chunked: true,
    })
    expect(answer.status).toBe(413)
    expect(answer.json).toMatchObject({ data: { code: 'too_large' } })
  })

  it('lets a body within the limit through, declared or chunked, for h3 and Better Auth', async () => {
    const body = jsonOf(MAX_BODY_BYTES)
    for (const chunked of [false, true]) {
      for (const path of ['/api/auth/sign-in/email-otp', '/api/planned']) {
        expect(await post(path, body, { chunked })).toEqual({
          status: 200,
          json: { bytes: MAX_BODY_BYTES },
        })
      }
    }
  })

  it('leaves the upload route to its own limit', async () => {
    const file = Buffer.alloc(1024 * 1024, 0x61)
    for (const chunked of [false, true]) {
      expect(await post('/api/admin/uploads', file, { chunked })).toEqual({
        status: 200,
        json: { bytes: file.length },
      })
    }
  })

  it('applies to the methods that carry a body only', () => {
    expect(bodyIsLimited('GET', '/api/auth/get-session')).toBe(false)
    expect(bodyIsLimited('HEAD', '/api/forecast')).toBe(false)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(bodyIsLimited(method, '/api/admin/users/x')).toBe(true)
    }
    expect(bodyIsLimited('POST', '/api/admin/uploads?x=1')).toBe(false)
  })

  it('fits the largest roster POST /api/planned accepts', () => {
    const planned = Array.from({ length: MAX_PLANNED_ITEMS }, () => ({
      date: '2026-11-20',
      shift: 'Evening',
      planned: 1000,
    }))
    const body = JSON.stringify({
      start: '2026-01-01',
      end: '2026-12-31',
      efficiency: 0.85,
      target_pct: 80,
      target_sec: 120,
      queue_model: 'erlang_a',
      patience_sec: 250,
      recency: 'weighted',
      include_holidays: true,
      planned,
    })
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES)
  })
})
