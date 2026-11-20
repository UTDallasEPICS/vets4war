// @vitest-environment nuxt
//
// apiFetch turns an ApiErrorBody answer into ApiClientError. The endpoints are
// registered in the test environment; no server runs. The error endpoint answers with
// the body Nitro's error handler sends for apiError() (h3 alone leaves out `message`).

import { describe, it, expect } from 'vitest'
import { defineEventHandler, setResponseStatus } from 'h3'
import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { ApiClientError, apiFetch } from '../../app/utils/api'

registerEndpoint(
  '/api/test-ok',
  defineEventHandler(() => ({ value: 42 }))
)
registerEndpoint(
  '/api/test-conflict',
  defineEventHandler((event) => {
    setResponseStatus(event, 409, 'Conflict')
    return {
      statusCode: 409,
      statusMessage: 'Conflict',
      message: 'A run is already going.',
      data: { code: 'conflict', run_id: 7 },
    }
  })
)

describe('apiFetch', () => {
  it('returns the body of a success', async () => {
    expect(await apiFetch<{ value: number }>('/api/test-ok')).toEqual({ value: 42 })
  })

  it('throws ApiClientError with status, code, message and data', async () => {
    const error = await apiFetch('/api/test-conflict', { method: 'POST' }).catch((e) => e)
    expect(error).toBeInstanceOf(ApiClientError)
    expect(error).toMatchObject({
      status: 409,
      code: 'conflict',
      message: 'A run is already going.',
      data: { code: 'conflict', run_id: 7 },
    })
  })
})
