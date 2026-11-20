import 'dotenv/config'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { parseAdminEmails } from '../db/admins'

// Environment variables the server reads (.env.example lists them). Validated once, on
// import, so a missing or malformed value stops the start with a message that names
// the variable, instead of failing later inside the database, auth or mail code.
//
// This lives in a module that db.ts and auth.ts import, rather than a Nitro plugin,
// because db.ts opens the database at module load, before any plugin runs.
//
// `nuxt dev` loads .env; a production build does not (`node --env-file=.env ...` or
// real environment variables).

export interface Env {
  DATABASE_URL: string
  BETTER_AUTH_SECRET: string
  BETTER_AUTH_URL: string
  EMAIL_TRANSPORT: 'smtp' | 'console'
  EMAIL_HOST: string
  EMAIL_USER: string
  EMAIL_PASS: string
  EMAIL_FROM: string
  EMAIL_PORT: number
  EMAIL_SECURE: boolean
  V4W_ADMIN_EMAILS: string[]
  V4W_DATA_SOURCE: 'partner' | 'synthetic' | 'unlabeled'
  V4W_FORECAST_DIR: string
  V4W_PYTHON: string
  V4W_RETRAIN_MODULE: string
  V4W_RETRAIN_ON_IMPORT: boolean
  V4W_RETRAIN_SCHEDULE: 'on' | 'off'
  V4W_RETRAIN_TIMEOUT_MIN: number
  V4W_UPLOAD_MAX_MB: number
  V4W_UPLOAD_MAX_ROWS: number
}

type Source = Record<string, string | undefined>

// The placeholder .env.example ships: anyone can read it, so nothing may be signed with it.
export const EXAMPLE_AUTH_SECRET = 'replace-this-with-the-output-of-openssl-rand-hex-32'
// Better Auth's own minimum; `openssl rand -hex 32` gives 64 characters.
const MIN_AUTH_SECRET_LENGTH = 32

export function parseEnv(
  source: Source,
  options: { dev: boolean; cwd: string; warn?: (message: string) => void }
): Env {
  const issues: string[] = []
  const warnings: string[] = []
  const fail = (name: string, message: string) => issues.push(`  - ${name}: ${message}`)

  // An empty value counts as not set.
  const read = (name: string): string | undefined => {
    const value = source[name]?.trim()
    return value ? value : undefined
  }
  const required = (name: string): string => {
    const value = read(name)
    if (value === undefined) fail(name, 'is required')
    return value ?? ''
  }
  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = read(name)
    if (value === undefined) return fallback
    if ((allowed as readonly string[]).includes(value)) return value as T
    fail(name, `must be one of ${allowed.join(', ')}, got "${value}"`)
    return fallback
  }
  const bool = (name: string, fallback: boolean): boolean => {
    const value = read(name)?.toLowerCase()
    if (value === undefined) return fallback
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
    fail(name, `must be true, false, 1 or 0, got "${value}"`)
    return fallback
  }
  const number = (
    name: string,
    fallback: number,
    check: { integer?: boolean; min: number; max?: number }
  ): number => {
    const value = read(name)
    if (value === undefined) return fallback
    const n = Number(value)
    const ok =
      Number.isFinite(n) &&
      (!check.integer || Number.isInteger(n)) &&
      n >= check.min &&
      (check.max === undefined || n <= check.max)
    if (ok) return n
    const kind = check.integer ? 'an integer' : 'a number'
    const range = check.max === undefined ? `>= ${check.min}` : `${check.min}..${check.max}`
    fail(name, `must be ${kind} ${range}, got "${value}"`)
    return fallback
  }

  const DATABASE_URL = read('DATABASE_URL') ?? 'file:./dev.db'
  const BETTER_AUTH_SECRET = required('BETTER_AUTH_SECRET')
  // A short secret only warns: refusing it would stop a server that runs today.
  if (!options.dev && BETTER_AUTH_SECRET === EXAMPLE_AUTH_SECRET) {
    fail('BETTER_AUTH_SECRET', 'is the example value from .env.example; set your own')
  } else if (!options.dev && BETTER_AUTH_SECRET.length < MIN_AUTH_SECRET_LENGTH) {
    warnings.push(
      `BETTER_AUTH_SECRET is ${BETTER_AUTH_SECRET.length} characters long; use at least ` +
        `${MIN_AUTH_SECRET_LENGTH} (openssl rand -hex 32). Changing it signs everyone out.`
    )
  }
  const BETTER_AUTH_URL = required('BETTER_AUTH_URL')
  if (BETTER_AUTH_URL && !z.url().safeParse(BETTER_AUTH_URL).success) {
    fail('BETTER_AUTH_URL', `must be a URL, got "${BETTER_AUTH_URL}"`)
  }

  const EMAIL_TRANSPORT = oneOf('EMAIL_TRANSPORT', ['smtp', 'console'] as const, 'smtp')
  if (EMAIL_TRANSPORT === 'console' && !options.dev) {
    fail('EMAIL_TRANSPORT', 'EMAIL_TRANSPORT=console is for `nuxt dev` only')
  }
  // SMTP settings matter only when mail is really sent.
  const mail = (name: string) => (EMAIL_TRANSPORT === 'smtp' ? required(name) : (read(name) ?? ''))
  const EMAIL_HOST = mail('EMAIL_HOST')
  const EMAIL_USER = mail('EMAIL_USER')
  const EMAIL_PASS = mail('EMAIL_PASS')
  const EMAIL_FROM = mail('EMAIL_FROM')
  const EMAIL_PORT = number('EMAIL_PORT', 587, { integer: true, min: 1, max: 65535 })
  const EMAIL_SECURE = bool('EMAIL_SECURE', false)

  let V4W_ADMIN_EMAILS: string[] = []
  try {
    V4W_ADMIN_EMAILS = parseAdminEmails(source.V4W_ADMIN_EMAILS)
  } catch (error) {
    fail('V4W_ADMIN_EMAILS', (error as Error).message)
  }

  // Same rule as final-main: only an explicit label counts; anything else is "not set".
  const kind = read('V4W_DATA_SOURCE')?.toLowerCase()
  const V4W_DATA_SOURCE = kind === 'partner' || kind === 'synthetic' ? kind : 'unlabeled'

  const forecastDir = read('V4W_FORECAST_DIR')
  const V4W_FORECAST_DIR = forecastDir
    ? isAbsolute(forecastDir)
      ? forecastDir
      : resolve(options.cwd, forecastDir)
    : join(options.cwd, 'forecast')
  const venvPython = join(V4W_FORECAST_DIR, '.venv', 'bin', 'python')
  // A path is made absolute because the script runs with cwd = V4W_FORECAST_DIR; a bare
  // command name ('python3') is left to PATH.
  const python = read('V4W_PYTHON')
  const V4W_PYTHON = python
    ? python.includes('/') && !isAbsolute(python)
      ? resolve(options.cwd, python)
      : python
    : existsSync(venvPython)
      ? venvPython
      : 'python3'

  const result: Env = {
    DATABASE_URL,
    BETTER_AUTH_SECRET,
    BETTER_AUTH_URL,
    EMAIL_TRANSPORT,
    EMAIL_HOST,
    EMAIL_USER,
    EMAIL_PASS,
    EMAIL_FROM,
    EMAIL_PORT,
    EMAIL_SECURE,
    V4W_ADMIN_EMAILS,
    V4W_DATA_SOURCE,
    V4W_FORECAST_DIR,
    V4W_PYTHON,
    V4W_RETRAIN_MODULE: read('V4W_RETRAIN_MODULE') ?? 'db.retrain',
    V4W_RETRAIN_ON_IMPORT: bool('V4W_RETRAIN_ON_IMPORT', true),
    V4W_RETRAIN_SCHEDULE: oneOf('V4W_RETRAIN_SCHEDULE', ['on', 'off'] as const, 'on'),
    V4W_RETRAIN_TIMEOUT_MIN: number('V4W_RETRAIN_TIMEOUT_MIN', 60, { min: 1 }),
    V4W_UPLOAD_MAX_MB: number('V4W_UPLOAD_MAX_MB', 40, { min: 1 }),
    V4W_UPLOAD_MAX_ROWS: number('V4W_UPLOAD_MAX_ROWS', 750000, { integer: true, min: 1 }),
  }

  if (issues.length) {
    throw new Error(
      `Invalid environment configuration:\n${issues.join('\n')}\n\n` +
        `Copy .env.example to .env and set the required values before starting the app.`
    )
  }
  const warn = options.warn ?? ((message: string) => console.warn(`[env] ${message}`))
  for (const message of warnings) warn(message)
  return result
}

// Vitest runs without a real environment and never sends mail or serves requests, so
// the values it does not set get harmless stand-ins instead of failing the import (the
// template skips validation there for the same reason).
const VITEST_DEFAULTS: Source = {
  DATABASE_URL: ':memory:',
  BETTER_AUTH_SECRET: 'vitest-only-secret-never-used-to-sign-anything',
  BETTER_AUTH_URL: 'http://localhost:3000',
  EMAIL_TRANSPORT: 'console',
}

// Vitest sets VITEST and NODE_ENV=test. A built server reads NODE_ENV as "production"
// whatever its environment says (Nitro writes the value of `process.env.NODE_ENV` into the
// build), so a stray VITEST in a deployment cannot switch it to the stand-ins above, the
// console transport (sign-in codes in the log) or the relaxed checks of `nuxt dev`.
export function isVitestRun(vitest: string | undefined, nodeEnv: string | undefined): boolean {
  return Boolean(vitest) && nodeEnv === 'test'
}

export const env: Env = isVitestRun(process.env.VITEST, process.env.NODE_ENV)
  ? parseEnv({ ...VITEST_DEFAULTS, ...process.env }, { dev: true, cwd: process.cwd() })
  : parseEnv(process.env, { dev: import.meta.dev === true, cwd: process.cwd() })
