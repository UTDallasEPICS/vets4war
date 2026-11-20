import type { IncomingMessage } from 'node:http'
import { defineEventHandler, getRequestHeader, setResponseHeader } from 'h3'
import { apiError } from '../utils/http'
import { readBodyWithin } from '../utils/ingest/body'

// Every request body this server takes is small JSON, except a file upload. The largest,
// POST /api/planned with a full year of shifts (366 x 3 items), is about 60 KB. Better
// Auth's sign-in routes answer without a session, so without this limit anyone could
// make the server hold a body of any size in memory.
export const MAX_BODY_BYTES = 64 * 1024

// The upload route reads its body itself, up to V4W_UPLOAD_MAX_MB.
const OWN_LIMIT = new Set(['/api/admin/uploads', '/api/admin/uploads/'])
const WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function bodyIsLimited(method: string, path: string): boolean {
  if (!WITH_BODY.has(method.toUpperCase())) return false
  const pathname = path.split('?')[0] ?? path
  return !OWN_LIMIT.has(pathname)
}

const tooLarge = () =>
  apiError(
    413,
    'too_large',
    `The request is larger than the ${MAX_BODY_BYTES / 1024} KB this server accepts.`
  )

// A body over the limit is refused by its declared size, before it is read. A body that
// declares no size (Transfer-Encoding: chunked, as a proxy that streams bodies sends it)
// is read here, up to the limit, and kept where h3 and Better Auth read a body from.
export default defineEventHandler(async (event) => {
  if (!bodyIsLimited(event.method, event.path)) return
  const declared = getRequestHeader(event, 'content-length')
  if (declared !== undefined) {
    if (Number(declared) > MAX_BODY_BYTES) throw tooLarge()
    return
  }
  if (getRequestHeader(event, 'transfer-encoding') === undefined) return
  const body = await readBodyWithin(event.node.req, MAX_BODY_BYTES)
  if (body === null) {
    setResponseHeader(event, 'Connection', 'close')
    throw tooLarge()
  }
  ;(event.node.req as IncomingMessage & { rawBody?: Buffer }).rawBody = body
})
