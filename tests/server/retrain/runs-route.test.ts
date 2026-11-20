// POST /api/admin/runs refuses what it cannot read with the API's 422 shape and a
// sentence an admin can act on: a form, broken JSON, a body that is not an object, a
// mode it does not know and a field it does not take. Only refusals are sent here: none
// of them reaches the runner, so no process is started.
import { createApp, eventHandler, toWebHandler } from 'h3'
import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // Never the developer's database from .env.
  process.env.DATABASE_URL = 'file::memory:'
})

const { default: handler } = await import('../../../server/api/admin/runs/index.post')

async function post(body: string, type = 'application/json') {
  const app = createApp()
  app.use(
    eventHandler((event) => {
      event.context.user = { id: 'a', email: 'admin@example.org', role: 'admin' } as never
    })
  )
  app.use(handler)
  const response = await toWebHandler(app)(
    new Request('http://localhost/api/admin/runs', {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    })
  )
  // A bare h3 app leaves `message` out of its error answer; Nitro's sends the first
  // issue in it, as validationError builds it.
  const json = (await response.json()) as {
    data: { code: string; issues: { path: string; message: string }[] }
  }
  const [first] = json.data.issues
  const message = first!.path ? `${first!.path}: ${first!.message}` : first!.message
  return { status: response.status, message, code: json.data.code }
}

describe('POST /api/admin/runs refuses', () => {
  it.each([
    [
      'a form',
      'mode=full',
      'application/x-www-form-urlencoded',
      'The request body must be JSON, sent with Content-Type: application/json.',
    ],
    ['broken JSON', '{"mode": ', 'application/json', 'The request body must be valid JSON.'],
    [
      'JSON that is not an object',
      'null',
      'application/json',
      'The request body must be a JSON object.',
    ],
    [
      'an unknown mode',
      '{"mode":"quick"}',
      'application/json',
      'mode: must be "full" or "forecast-only"',
    ],
    [
      'a field it does not take',
      '{"x":1}',
      'application/json',
      'x: is not a field of this request',
    ],
  ])('%s, in words', async (_what, body, type, message) => {
    expect(await post(body, type)).toEqual({ status: 422, message, code: 'validation' })
  })
})
