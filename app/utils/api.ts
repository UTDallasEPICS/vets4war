import type { ApiErrorBody } from '#shared/types/api'

// An error answer of our API, as page code sees it: the HTTP status, data.code to
// branch on, the sentence to show, and the rest of data (issues, horizon, ...).
export class ApiClientError extends Error {
  status: number
  code: string
  data: Record<string, unknown>

  constructor(status: number, code: string, message: string, data: Record<string, unknown>) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
    this.data = data
  }
}

// $fetch for our API. A 401 means the session ended: go to the sign-in page.
export async function apiFetch<T>(url: string, options?: Parameters<typeof $fetch>[1]): Promise<T> {
  // A plain string URL: $fetch's typed-route inference over every server route is too
  // deep for the type checker and adds nothing for a wrapper.
  const request = $fetch as unknown as (
    url: string,
    options?: Parameters<typeof $fetch>[1]
  ) => Promise<T>
  try {
    return await request(url, options)
  } catch (error) {
    const failure = error as {
      status?: number
      statusCode?: number
      data?: unknown
      message?: string
    }
    const status = failure.status ?? failure.statusCode ?? 0
    if (status === 401) {
      await navigateTo('/auth', { external: true })
    }
    const body = (failure.data ?? null) as Partial<ApiErrorBody> | null
    const data: Record<string, unknown> =
      body && typeof body === 'object' && body.data && typeof body.data === 'object'
        ? body.data
        : {}
    const code = typeof data.code === 'string' ? data.code : 'error'
    const message = body?.message || failure.message || 'The request failed.'
    throw new ApiClientError(status, code, message, data)
  }
}
