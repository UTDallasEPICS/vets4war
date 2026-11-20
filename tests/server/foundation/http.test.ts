import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { H3Error } from 'h3'
import { apiError, issuesFromZod, validationError } from '../../../server/utils/http'

describe('apiError', () => {
  it('builds the ApiErrorBody shape', () => {
    const error = apiError(400, 'end_before_start', 'end 2026-11-01 is before start 2026-11-19')
    expect(error).toBeInstanceOf(H3Error)
    expect(error.statusCode).toBe(400)
    expect(error.statusMessage).toBe('Bad Request')
    expect(error.message).toBe('end 2026-11-01 is before start 2026-11-19')
    expect(error.data).toEqual({ code: 'end_before_start' })
  })

  it('carries extra data next to the code', () => {
    const error = apiError(
      400,
      'outside_horizon',
      'The forecast covers 2026-01-01 to 2028-12-31.',
      {
        horizon: { start: '2026-01-01', end: '2028-12-31' },
      }
    )
    expect(error.data).toEqual({
      code: 'outside_horizon',
      horizon: { start: '2026-01-01', end: '2028-12-31' },
    })
  })

  it.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
    [409, 'Conflict'],
    [413, 'Payload Too Large'],
    [422, 'Unprocessable Entity'],
    [429, 'Too Many Requests'],
    [503, 'Service Unavailable'],
  ])('uses the standard reason phrase for %i', (status, phrase) => {
    expect(apiError(status, 'x', 'y').statusMessage).toBe(phrase)
  })
})

describe('validationError', () => {
  it('is a 422 that names the first issue and lists all', () => {
    const issues = [
      { path: 'efficiency', message: 'must be between 0 and 1' },
      { path: 'target_sec', message: 'must be a number' },
    ]
    const error = validationError(issues)
    expect(error.statusCode).toBe(422)
    expect(error.statusMessage).toBe('Unprocessable Entity')
    expect(error.message).toBe('efficiency: must be between 0 and 1')
    expect(error.data).toEqual({ code: 'validation', issues })
  })

  it('turns zod issues into dotted paths', () => {
    const schema = z.object({ planned: z.array(z.object({ planned: z.number().int() })) })
    const parsed = schema.safeParse({ planned: [{ planned: 1 }, { planned: 1.5 }] })
    expect(parsed.success).toBe(false)
    const issues = issuesFromZod(parsed.error!)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.path).toBe('planned.1.planned')
    expect(validationError(issues).message).toMatch(/^planned\.1\.planned: /)
  })
})

describe('readJsonBody', () => {
  // A real request through h3, so the body is parsed exactly as in a route.
  async function answer(
    body: string | undefined,
    type: string | null = 'application/json',
    read: 'body' | 'object' = 'body'
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const { createApp, eventHandler, toWebHandler } = await import('h3')
    const { readJsonBody, readJsonObject } = await import('../../../server/utils/http')
    const app = createApp()
    app.use(
      eventHandler(async (event) => ({
        body:
          read === 'body' ? ((await readJsonBody(event)) ?? 'none') : await readJsonObject(event),
      }))
    )
    const response = await toWebHandler(app)(
      new Request('http://localhost/', {
        method: 'POST',
        headers: type ? { 'content-type': type } : {},
        body,
      })
    )
    return { status: response.status, json: (await response.json()) as Record<string, unknown> }
  }

  const refusal = (message: string) => ({
    status: 422,
    json: expect.objectContaining({
      data: { code: 'validation', issues: [{ path: '', message }] },
    }),
  })

  it('refuses a body that is not JSON, a form included, before reading it as one', async () => {
    const notJson = 'The request body must be JSON, sent with Content-Type: application/json.'
    expect(await answer('mode=full', 'application/x-www-form-urlencoded')).toEqual(refusal(notJson))
    expect(await answer('{"mode":"full"}', 'text/plain')).toEqual(refusal(notJson))
    expect(await answer('{"mode":"full"}', null)).toEqual(refusal(notJson))
  })

  it('takes JSON with a charset, and no body as none', async () => {
    expect(await answer('{"a":1}', 'application/json; charset=utf-8')).toEqual({
      status: 200,
      json: { body: { a: 1 } },
    })
    expect(await answer(undefined, null)).toEqual({ status: 200, json: { body: 'none' } })
  })

  it('readJsonObject: no body is {}, anything but an object is refused', async () => {
    expect(await answer(undefined, null, 'object')).toEqual({ status: 200, json: { body: {} } })
    for (const body of ['[]', 'null', '"full"', '3']) {
      expect(await answer(body, 'application/json', 'object')).toEqual(
        refusal('The request body must be a JSON object.')
      )
    }
  })

  it('returns the parsed body', async () => {
    expect(await answer('{"name":"Vee"}')).toEqual({ status: 200, json: { body: { name: 'Vee' } } })
  })

  it('answers malformed JSON with 422 and data.code validation', async () => {
    const { status, json } = await answer('{not json')
    expect(status).toBe(422)
    expect(json.data).toEqual({
      code: 'validation',
      issues: [{ path: '', message: 'The request body must be valid JSON.' }],
    })
  })
})
