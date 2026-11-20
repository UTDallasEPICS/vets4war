// The one error shape of the API (ApiErrorBody in shared/types/api.ts):
// { statusCode, statusMessage, message, data: { code, ... } }.
import { STATUS_CODES } from 'node:http'
import { createError, getRequestHeader, readRawBody, type H3Error, type H3Event } from 'h3'
import type { z } from 'zod'

export interface Issue {
  path: string
  message: string
}

// statusMessage is the standard ASCII reason phrase ('Bad Request'); `message` is the
// sentence a person reads; data.code is what code branches on.
export function apiError(
  statusCode: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>
): H3Error {
  return createError({
    statusCode,
    statusMessage: STATUS_CODES[statusCode] ?? 'Error',
    message,
    data: { code, ...extra },
  })
}

// 422 for input that is missing, mistyped or out of range. The message names the
// first problem; data.issues lists all of them.
export function validationError(issues: Issue[]): H3Error {
  const first = issues[0]
  const message = !first
    ? 'The request is not valid.'
    : first.path
      ? `${first.path}: ${first.message}`
      : first.message
  return apiError(422, 'validation', message, { issues })
}

// A field the request does not take is named as such, not as zod's 'Unrecognized key'.
export function issuesFromZod(error: z.ZodError): Issue[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.map((part) => String(part)).join('.')
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: path ? `${path}.${key}` : key,
        message: 'is not a field of this request',
      }))
    }
    return [{ path, message: issue.message }]
  })
}

const NOT_JSON = 'The request body must be JSON, sent with Content-Type: application/json.'
const BAD_JSON = 'The request body must be valid JSON.'
const NOT_OBJECT = 'The request body must be a JSON object.'

// The JSON body of a request; undefined when there is none. A body of another type (a
// form, say, which h3 would otherwise parse too) and malformed JSON are a 422 like any
// other bad input, so the answer keeps the one error shape (h3's own 400 carries no
// data.code).
export async function readJsonBody(event: H3Event): Promise<unknown> {
  const raw = await readRawBody(event, 'utf8')
  if (raw === undefined || raw.trim() === '') return undefined
  const type = (getRequestHeader(event, 'content-type') ?? '').split(';')[0]!.trim()
  if (type.toLowerCase() !== 'application/json') {
    throw validationError([{ path: '', message: NOT_JSON }])
  }
  try {
    return JSON.parse(raw) as unknown
  } catch {
    throw validationError([{ path: '', message: BAD_JSON }])
  }
}

// A JSON object body, for routes whose input is named fields; no body at all is {} (the
// route's defaults).
export async function readJsonObject(event: H3Event): Promise<Record<string, unknown>> {
  const body = await readJsonBody(event)
  if (body === undefined) return {}
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError([{ path: '', message: NOT_OBJECT }])
  }
  return body as Record<string, unknown>
}
