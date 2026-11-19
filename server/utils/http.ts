// The one error shape of the API (ApiErrorBody in shared/types/api.ts):
// { statusCode, statusMessage, message, data: { code, ... } }.
import { STATUS_CODES } from 'node:http'
import { createError, readBody, type H3Error, type H3Event } from 'h3'
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

export function issuesFromZod(error: z.ZodError): Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join('.'),
    message: issue.message,
  }))
}

// The JSON body of a request. Malformed JSON is a 422 like any other bad input, so the
// answer keeps the one error shape (h3's own 400 carries no data.code).
export async function readJsonBody(event: H3Event): Promise<unknown> {
  try {
    return await readBody(event)
  } catch {
    throw validationError([{ path: '', message: 'The request body must be valid JSON.' }])
  }
}
