// The one error shape of the API (PLAN.md section 8.1, ApiErrorBody):
// { statusCode, statusMessage, message, data: { code, ... } }.
import { STATUS_CODES } from 'node:http'
import { createError, type H3Error } from 'h3'
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
