// End-to-end check of the whole app through its production build, over HTTP only:
// SYNTHETIC call data generated on the spot, a fresh database, sign-in by a mailed code,
// upload -> per-day plan -> import -> the real retrain script -> forecast, a second week,
// a forecast-only refresh, a viewer, the pages, and a clean shutdown.
//
//   node scripts/e2e.mjs [--no-build] [--keep]        (pnpm e2e)
//
//   --no-build   use the .output/ that is already there instead of running `pnpm build`
//   --keep       keep the temp folder (database, workbooks, server log) and print its path
//
// Needs forecast/.venv (pnpm forecast:setup) and ports 3121 (the server) and 2525 (a mail
// sink that only this script talks to) free. It never reads or writes .env or dev.db:
// the server gets real environment variables and a database in a temp folder, and that
// folder is deleted at the end. Prints one PASS / FAIL line per step (SKIP for the steps
// after a failed one) and exits 0 only when every step passed; 2 when it could not start.
//
// Everything here is SYNTHETIC (forecast/tools/gen_synthetic.py): no number it prints
// says anything about the real line.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { SMTPServer } from 'smtp-server'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FORECAST_DIR = join(ROOT, 'forecast')
const PYTHON = join(FORECAST_DIR, '.venv', 'bin', 'python')
const SERVER_ENTRY = join(ROOT, '.output', 'server', 'index.mjs')

const PORT = 3121
const SMTP_PORT = 2525
const BASE = `http://localhost:${PORT}`
const ADMIN = 'admin@example.org'
const VIEWER = 'viewer@example.org'
const STRANGER = 'stranger@example.org'
const MAIL_SUBJECT = 'Vets4Warriors staffing: your sign-in code'
// Better Auth's limit for the sign-in code routes: this many requests a minute per client.
const CODE_REQUESTS_PER_MINUTE = 3

// Enough history for the retrain's accuracy check (26 weekly origins plus its training
// minimum and the recent window) with room to spare; the last week is loaded separately.
const TOTAL_DAYS = 760
const WEEK_DAYS = 7
const HOURS_PER_DAY = 24
const DEFAULT_WINDOW_DAYS = 30

const BUILD_LIMIT_MS = 10 * 60_000
const START_LIMIT_MS = 60_000
const PARSE_LIMIT_MS = 5 * 60_000
const RUN_LIMIT_MS = 20 * 60_000
const STOP_LIMIT_MS = 10_000
const MAIL_LIMIT_MS = 15_000
// Python commits a run's outcome a moment before it exits; until the server has seen
// the exit (and stored the exit code) the run still counts as active.
const EXIT_GRACE_MS = 30_000

const HISTORY_FILE = 'SYNTHETIC e2e call records - history.xlsx'
const WEEK_FILE = 'SYNTHETIC e2e call records - last week.xlsx'

// Splits the generated calls into the two workbooks, in the partner's layouts, with the
// repository's own workbook writers (forecast/tools/make_workbooks.py). Run with
// cwd = forecast/, so `tools` is that folder.
const WRITE_WORKBOOKS = `
import json, sys
from pathlib import Path
import pandas as pd
from tools.gen_synthetic import SYNTHETIC_CALLS_FILE
from tools.make_workbooks import between, multi_year_workbook, raw_workbook

folder, history_end, week_start, week_end, history_name, week_name = sys.argv[1:7]
calls = pd.read_csv(Path(folder) / SYNTHETIC_CALLS_FILE, parse_dates=["start_ts"])
history = calls[calls["start_ts"].dt.normalize() <= pd.Timestamp(history_end)].reset_index(drop=True)
week = between(calls, week_start, week_end)
multi_year_workbook(Path(folder) / history_name, history)
raw_workbook(Path(folder) / week_name, week)
print(json.dumps({"history_rows": len(history), "week_rows": len(week),
                  "first_call": calls["start_ts"].min().strftime("%Y-%m-%dT%H:%M:%S")}))
`

// ---------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`
const count = (n) => n.toLocaleString('en-US')

class StepFailure extends Error {}

function expect(condition, message) {
  if (!condition) throw new StepFailure(message)
}

function equal(actual, expected, what) {
  expect(
    actual === expected,
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  )
}

// 'YYYY-MM-DD' arithmetic in UTC (no local time involved).
function addDays(iso, n) {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString().slice(0, 10)
}

// Today on the line's clock: the upload check refuses days that have not finished there.
function easternToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

function tail(text, lines = 25) {
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

// Runs a command to its end; resolves with its exit code and everything it printed.
function run(command, args, { cwd = ROOT, env = process.env, limitMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const timer = limitMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
          reject(
            new StepFailure(`${command} ${args[0] ?? ''} did not finish in ${seconds(limitMs)}`)
          )
        }, limitMs)
      : null
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(new StepFailure(`${command} could not be started: ${error.message}`))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

async function runOrFail(what, command, args, options) {
  const { code, output } = await run(command, args, options)
  expect(code === 0, `${what} failed (exit ${code}):\n${tail(output)}`)
  return output
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// Processes whose command line mentions `needle` (pid and command), this one excluded.
function processesMentioning(needle) {
  return execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(needle) && Number(line.split(/\s+/)[0]) !== process.pid)
}

// ---------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------

// One request. A write carries the Origin a browser would send (the server compares it
// with BETTER_AUTH_URL); `origin` overrides it for the cross-site check.
async function call(method, path, { cookie, json, form, origin, redirect = 'follow' } = {}) {
  const headers = { accept: 'application/json' }
  if (cookie) headers.cookie = cookie
  if (method !== 'GET') headers.origin = origin ?? BASE
  const init = { method, headers, redirect }
  if (json !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(json)
  } else if (form !== undefined) {
    init.body = form
  }
  const response = await fetch(new URL(path, BASE), init)
  const text = await response.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    // not JSON (a page): the text itself
  }
  return { status: response.status, body, text, headers: response.headers }
}

const describeAnswer = (answer) =>
  `HTTP ${answer.status} ${typeof answer.body === 'string' ? answer.body.slice(0, 200) : JSON.stringify(answer.body).slice(0, 400)}`

function expectStatus(answer, status, what) {
  expect(
    answer.status === status,
    `${what}: expected HTTP ${status}, got ${describeAnswer(answer)}`
  )
  return answer.body
}

function expectError(answer, status, code, what) {
  expectStatus(answer, status, what)
  equal(answer.body?.data?.code, code, `${what}: error code`)
}

// server/utils/security-headers.ts, on every kind of answer; and nothing that names the
// server's software. Nitro's error answers set a stricter Referrer-Policy of their own.
const SECURITY_HEADERS = {
  'strict-transport-security': ['max-age=31536000'],
  'x-content-type-options': ['nosniff'],
  'x-frame-options': ['DENY'],
  'referrer-policy': ['same-origin', 'no-referrer'],
}
function expectSecurityHeaders(answer, what) {
  for (const [name, values] of Object.entries(SECURITY_HEADERS)) {
    const value = answer.headers.get(name)
    expect(
      values.includes(value),
      `${what}: ${name}: expected ${values.join(' or ')}, got ${value}`
    )
  }
  equal(answer.headers.get('x-powered-by'), null, `${what}: x-powered-by`)
}

// ---------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { build: true, keep: false }
  for (const arg of argv) {
    if (arg === '--no-build') options.build = false
    else if (arg === '--keep') options.keep = true
    else {
      console.error(`unknown argument ${arg}\nusage: node scripts/e2e.mjs [--no-build] [--keep]`)
      process.exit(2)
    }
  }
  return options
}

// What must be there before anything is created: said at once, not after a build.
async function missing() {
  if (!existsSync(PYTHON)) return `${PYTHON} is missing: run pnpm forecast:setup first`
  if (!options.build && !existsSync(SERVER_ENTRY)) {
    return `${SERVER_ENTRY} is missing: run pnpm build first, or leave out --no-build`
  }
  for (const port of [PORT, SMTP_PORT]) {
    if (await portInUse(port)) return `port ${port} is already in use`
  }
  return null
}

const options = parseArgs(process.argv.slice(2))
const problem = await missing()
if (problem) {
  console.error(`e2e cannot start: ${problem}`)
  process.exit(2)
}
const started = Date.now()
const work = mkdtempSync(join(tmpdir(), 'v4w-e2e-'))
const dataDir = join(work, 'data')
const dbPath = join(work, 'app.db')
const serverLogPath = join(work, 'server.log')

const mails = [] // { to: string[], data: string }
let sink = null
let server = null // { child, exited: Promise<{ code, signal }>, log: () => string }
const state = {} // what later steps need from earlier ones

const end = addDays(easternToday(), -2)
const start = addDays(end, -(TOTAL_DAYS - 1))
const historyEnd = addDays(end, -WEEK_DAYS)
const weekStart = addDays(historyEnd, 1)

function startSink() {
  return new Promise((resolve, reject) => {
    const smtp = new SMTPServer({
      // A local stand-in for a mail provider: no TLS, any login is accepted.
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      authOptional: true,
      onAuth: (auth, session, done) => done(null, { user: auth.username || 'anyone' }),
      onData(stream, session, done) {
        let data = ''
        stream.on('data', (chunk) => (data += chunk))
        stream.on('end', () => {
          mails.push({ to: session.envelope.rcptTo.map((r) => r.address), data })
          done()
        })
      },
    })
    smtp.on('error', reject)
    smtp.listen(SMTP_PORT, '127.0.0.1', () => resolve(smtp))
  })
}

async function mailFor(address, after) {
  const deadline = Date.now() + MAIL_LIMIT_MS
  for (;;) {
    const mail = mails.slice(after).find((m) => m.to.includes(address))
    if (mail) return mail
    expect(Date.now() < deadline, `no mail for ${address} arrived in ${seconds(MAIL_LIMIT_MS)}`)
    await sleep(100)
  }
}

const answeredCodeRequests = [] // when each request for a code was answered 200
async function requestCode(email) {
  const answer = await call('POST', '/api/auth/email-otp/send-verification-otp', {
    json: { email, type: 'sign-in' },
  })
  if (answer.status === 200) answeredCodeRequests.push(Date.now())
  return answer
}
const useCode = (email, otp) =>
  call('POST', '/api/auth/sign-in/email-otp', { json: { email, otp } })

function sessionCookie(answer) {
  return answer.headers
    .getSetCookie()
    .map((header) => header.split(';')[0])
    .join('; ')
}

// Asks for a code, reads it from the mail, signs in; returns the Cookie header value.
async function signIn(email) {
  const before = mails.length
  expectStatus(await requestCode(email), 200, `asking for a code for ${email}`)
  const mail = await mailFor(email, before)
  const otp = /code is (\d{6})/.exec(mail.data)?.[1]
  expect(otp, `the mail to ${email} holds no six-digit code`)
  const answer = await useCode(email, otp)
  expectStatus(answer, 200, `signing in as ${email}`)
  const cookie = sessionCookie(answer)
  expect(
    cookie.includes('better-auth.session_token='),
    `signing in as ${email} set no session cookie`
  )
  return { cookie, mail, otp }
}

async function uploadWorkbook(cookie, name) {
  const form = new FormData()
  form.append('file', new Blob([readFileSync(join(dataDir, name))]), name)
  const answer = await call('POST', '/api/admin/uploads', { cookie, form })
  const { upload } = expectStatus(answer, 202, `uploading ${name}`)
  const deadline = Date.now() + PARSE_LIMIT_MS
  for (;;) {
    const detail = expectStatus(
      await call('GET', `/api/admin/uploads/${upload.id}`, { cookie }),
      200,
      `reading upload ${upload.id}`
    ).upload
    if (detail.status !== 'parsing') return detail
    expect(Date.now() < deadline, `${name} was still being read after ${seconds(PARSE_LIMIT_MS)}`)
    await sleep(250)
  }
}

// Follows a run to its end, then until the server has seen its process exit.
async function followRun(cookie, id) {
  const deadline = Date.now() + RUN_LIMIT_MS
  let finishedAt = null
  for (;;) {
    const { run } = expectStatus(
      await call('GET', `/api/admin/runs/${id}`, { cookie }),
      200,
      `reading run ${id}`
    )
    if (run.status !== 'queued' && run.status !== 'running') {
      finishedAt ??= Date.now()
      if (run.exit_code !== null || Date.now() - finishedAt > EXIT_GRACE_MS) return run
    }
    expect(
      Date.now() < deadline,
      `run ${id} was still ${run.status} after ${seconds(RUN_LIMIT_MS)}`
    )
    await sleep(500)
  }
}

// A retrain succeeds only when the new model beats the simple baseline in the script's
// accuracy check. On SYNTHETIC data of this size it did so by a clear margin on every
// date tried while this script was written, but it is a statistical outcome: say so when
// a run ends `rejected`, because then the app did what it should and the draw was unlucky.
const UNLUCKY_DRAW =
  "\nThe SYNTHETIC calls generated for today's dates gave a model that did not beat the " +
  'baseline. The app handled that as designed; this script cannot go on without a model. ' +
  'It is rare: run it again on another day before looking for a defect.'

function expectSucceeded(run, what) {
  expect(
    run.status === 'succeeded',
    `${what}: run ${run.id} ended ${run.status} (${run.message})` +
      (run.status === 'rejected' ? UNLUCKY_DRAW : `\n${tail(run.log_tail ?? '', 15)}`)
  )
  equal(run.exit_code, 0, `${what}: exit code of run ${run.id}`)
}

const steps = [
  [
    'SYNTHETIC call data and two workbooks',
    async () => {
      mkdirSync(dataDir, { recursive: true })
      await runOrFail(
        'generating the SYNTHETIC calls',
        PYTHON,
        ['tools/gen_synthetic.py', dataDir, '--start', start, '--end', end],
        { cwd: FORECAST_DIR }
      )
      const output = await runOrFail(
        'writing the workbooks',
        PYTHON,
        ['-c', WRITE_WORKBOOKS, dataDir, historyEnd, weekStart, end, HISTORY_FILE, WEEK_FILE],
        { cwd: FORECAST_DIR }
      )
      Object.assign(state, JSON.parse(output.trim().split('\n').at(-1)))
      expect(state.history_rows > 0 && state.week_rows > 0, 'a workbook came out empty')
      return (
        `${TOTAL_DAYS} days, ${start} to ${end}: ${count(state.history_rows)} calls in the ` +
        `history workbook, ${count(state.week_rows)} in the last week's`
      )
    },
  ],
  [
    'fresh database (pnpm db:migrate)',
    async () => {
      await runOrFail('pnpm db:migrate', 'pnpm', ['db:migrate'], {
        env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      })
      const db = new Database(dbPath, { readonly: true, fileMustExist: true })
      try {
        const tables = db
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
          .get()
        equal(db.prepare('SELECT count(*) AS n FROM calls').get().n, 0, 'calls in a new database')
        return `${tables.n} tables, no calls`
      } finally {
        db.close()
      }
    },
  ],
  [
    'mail sink',
    async () => {
      sink = await startSink()
      return `listening on 127.0.0.1:${SMTP_PORT}`
    },
  ],
  [
    options.build ? 'production build and server start' : 'server start (build skipped)',
    async () => {
      if (options.build) {
        await runOrFail('pnpm build', 'pnpm', ['build'], { limitMs: BUILD_LIMIT_MS })
      }
      expect(existsSync(SERVER_ENTRY), `the build left no ${SERVER_ENTRY}`)

      // Only what the server needs: nothing of the caller's shell changes the run.
      // NODE_ENV is left out on purpose: a production build must not depend on it (the
      // sign-in rate limit is checked below).
      const env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // the server's own temp files (uploads being read) stay inside the temp folder too
        TMPDIR: join(work, 'tmp'),
        PORT: String(PORT),
        DATABASE_URL: `file:${dbPath}`,
        BETTER_AUTH_URL: BASE,
        BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
        EMAIL_TRANSPORT: 'smtp',
        EMAIL_HOST: '127.0.0.1',
        EMAIL_PORT: String(SMTP_PORT),
        EMAIL_SECURE: 'false',
        EMAIL_USER: 'e2e',
        EMAIL_PASS: 'e2e',
        EMAIL_FROM: 'Vets4Warriors staffing <no-reply@example.org>',
        V4W_ADMIN_EMAILS: ADMIN,
        V4W_DATA_SOURCE: 'synthetic',
        V4W_RETRAIN_SCHEDULE: 'off',
      }
      mkdirSync(env.TMPDIR, { recursive: true })
      const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let log = ''
      const keepOutput = (chunk) => {
        log += chunk
        appendFileSync(serverLogPath, chunk)
      }
      child.stdout.on('data', keepOutput)
      child.stderr.on('data', keepOutput)
      const exited = new Promise((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal }))
      )
      server = { child, exited, log: () => log, running: true }
      exited.then(() => (server.running = false))

      const waited = Date.now()
      for (;;) {
        expect(server.running, `the server stopped while starting:\n${tail(log)}`)
        const health = await call('GET', '/api/health').catch(() => null)
        if (health?.status === 200) break
        expect(
          Date.now() - waited < START_LIMIT_MS,
          `/api/health did not answer in ${seconds(START_LIMIT_MS)}:\n${tail(log)}`
        )
        await sleep(200)
      }
      return `${BASE} answered /api/health after ${seconds(Date.now() - waited)}`
    },
  ],
  [
    'sign-in with a mailed code',
    async () => {
      // An address nobody added: the same answer as for a real one, but no mail and no account.
      expectStatus(await requestCode(STRANGER), 200, 'asking for a code for an unknown address')

      const before = mails.length
      expectStatus(await requestCode(ADMIN), 200, `asking for a code for ${ADMIN}`)
      const mail = await mailFor(ADMIN, before)
      expect(mail.data.includes(`Subject: ${MAIL_SUBJECT}`), 'the mail has another subject line')
      const otp = /code is (\d{6})/.exec(mail.data)?.[1]
      expect(otp, 'the mail holds no six-digit code')
      // The stranger was asked for first, so a mail to them would be here by now.
      expect(
        mails.every((m) => !m.to.includes(STRANGER)),
        `a mail was sent to ${STRANGER}, who has no account`
      )
      equal(mails.length, 1, 'mails received so far')

      const wrong = String((Number(otp) + 1) % 1_000_000).padStart(6, '0')
      const refused = await useCode(ADMIN, wrong)
      expect(
        refused.status >= 400 && refused.status < 500,
        `a wrong code: ${describeAnswer(refused)}`
      )
      expect(!sessionCookie(refused).includes('session_token'), 'a wrong code set a session cookie')

      const accepted = await useCode(ADMIN, otp)
      expectStatus(accepted, 200, 'signing in with the mailed code')
      state.admin = sessionCookie(accepted)
      expect(state.admin.includes('better-auth.session_token='), 'no session cookie was set')

      const { users } = expectStatus(
        await call('GET', '/api/admin/users', { cookie: state.admin }),
        200,
        'listing people'
      )
      equal(users.map((u) => `${u.email}:${u.role}`).join(','), `${ADMIN}:admin`, 'people')
      return `${ADMIN} signed in; ${STRANGER} got no mail and no account; a wrong code was refused`
    },
  ],
  [
    'empty state',
    async () => {
      const cookie = state.admin
      const status = expectStatus(await call('GET', '/api/status', { cookie }), 200, '/api/status')
      equal(status.forecast, null, '/api/status forecast')
      equal(status.model, null, '/api/status model')
      equal(status.viewer.role, 'admin', '/api/status viewer role')
      expectError(
        await call('GET', '/api/forecast', { cookie }),
        503,
        'no_forecast',
        '/api/forecast'
      )
      expectError(await call('GET', '/api/model', { cookie }), 404, 'not_found', '/api/model')
      expectError(
        await call('POST', '/api/admin/runs', { cookie, json: {} }),
        409,
        'conflict',
        'a retrain without calls'
      )
      return 'no forecast (503), no model (404), a retrain without calls is refused (409)'
    },
  ],
  [
    'history upload, import and the first retrain',
    async () => {
      const cookie = state.admin
      const t0 = Date.now()
      const upload = await uploadWorkbook(cookie, HISTORY_FILE)
      const readIn = Date.now() - t0
      equal(
        upload.status,
        'ready',
        `upload status (${upload.error ?? JSON.stringify(upload.report?.file_errors)})`
      )
      const { summary } = upload.report
      const historyDays = TOTAL_DAYS - WEEK_DAYS
      equal(summary.total_rows, state.history_rows, 'calls read from the history workbook')
      equal(summary.days, historyDays, 'days in the history workbook')
      equal(summary.new_days, historyDays, 'new days')
      equal(summary.identical_days + summary.conflict_days, 0, 'days already stored')
      equal(summary.first_day, start, 'first day')
      equal(summary.last_day, historyEnd, 'last day')
      equal(upload.report.days.length, historyDays, 'days in the plan')
      expect(
        upload.report.days.every((d) => d.status === 'new'),
        'a day of the plan is not new'
      )

      const importPath = `/api/admin/uploads/${upload.id}/import`
      expectError(
        await call('POST', importPath, {
          cookie,
          json: { total_rows: summary.total_rows + 1, replace_days: [] },
        }),
        409,
        'conflict',
        'an import with the wrong row count'
      )
      const imported = expectStatus(
        await call('POST', importPath, {
          cookie,
          json: { total_rows: summary.total_rows, replace_days: [] },
        }),
        200,
        'the import'
      )
      equal(imported.upload.status, 'imported', 'upload status after the import')
      equal(imported.upload.result.inserted_rows, state.history_rows, 'inserted calls')
      equal(imported.queued, false, 'import answer: queued')
      expect(imported.run, 'the import started no retrain')

      const t1 = Date.now()
      const run = await followRun(cookie, imported.run.id)
      expectSucceeded(run, 'first retrain')
      equal(run.trained, true, 'run trained a model')
      equal(run.gate_passed, true, 'run passed the accuracy check')

      const status = expectStatus(await call('GET', '/api/status', { cookie }), 200, '/api/status')
      equal(status.forecast?.stale, false, '/api/status forecast.stale')
      equal(status.forecast?.data_end, historyEnd, '/api/status forecast.data_end')
      const model = expectStatus(await call('GET', '/api/model', { cookie }), 200, '/api/model')
      equal(model.train_end.slice(0, 10), historyEnd, '/api/model train_end day')
      equal(model.data_source.kind, 'synthetic', '/api/model data_source.kind')

      const forecast = expectStatus(
        await call('GET', '/api/forecast', { cookie }),
        200,
        '/api/forecast'
      )
      equal(
        forecast.hours.length,
        DEFAULT_WINDOW_DAYS * HOURS_PER_DAY,
        'hours of the default window'
      )
      equal(forecast.days.length, DEFAULT_WINDOW_DAYS, 'days of the default window')
      expect(
        forecast.hours.every((h) => h.predicted_calls > 0),
        'an hour has no predicted calls'
      )
      equal(forecast.data_source.kind, 'synthetic', '/api/forecast data_source.kind')
      equal(forecast.data_source.end, historyEnd, '/api/forecast data_source.end')

      Object.assign(state, { model1: model.model_sha256, run1: run.id })
      return (
        `${count(summary.total_rows)} calls on ${historyDays} new days read in ${seconds(readIn)}; ` +
        `run ${run.id} succeeded in ${seconds(Date.now() - t1)}; ${forecast.hours.length} forecast hours`
      )
    },
  ],
  [
    'one more week: upload, import, retrain',
    async () => {
      const cookie = state.admin
      const upload = await uploadWorkbook(cookie, WEEK_FILE)
      equal(
        upload.status,
        'ready',
        `upload status (${upload.error ?? JSON.stringify(upload.report?.file_errors)})`
      )
      const { summary } = upload.report
      equal(summary.total_rows, state.week_rows, 'calls read from the week workbook')
      equal(summary.new_days, WEEK_DAYS, 'new days')
      equal(summary.days, WEEK_DAYS, 'days in the week workbook')
      equal(summary.first_day, weekStart, 'first day')
      equal(summary.last_day, end, 'last day')

      const imported = expectStatus(
        await call('POST', `/api/admin/uploads/${upload.id}/import`, {
          cookie,
          json: { total_rows: summary.total_rows, replace_days: [] },
        }),
        200,
        'the import'
      )
      equal(imported.queued, false, 'import answer: queued')
      const run = await followRun(cookie, imported.run.id)
      expectSucceeded(run, 'second retrain')

      const model = expectStatus(await call('GET', '/api/model', { cookie }), 200, '/api/model')
      equal(model.train_end.slice(0, 10), end, '/api/model train_end day')
      expect(
        model.model_sha256 !== state.model1,
        'the model did not change after a week of new calls'
      )
      const forecast = expectStatus(
        await call('GET', '/api/forecast', { cookie }),
        200,
        '/api/forecast'
      )
      equal(forecast.data_source.end, end, '/api/forecast data_source.end')

      // The same file once more: every day is already stored, so there is nothing to import.
      const again = await uploadWorkbook(cookie, WEEK_FILE)
      equal(again.status, 'ready', 'status of the same file uploaded again')
      equal(again.report.nothing_to_import, true, 'nothing_to_import')
      equal(again.report.summary.identical_days, WEEK_DAYS, 'identical days')
      expectError(
        await call('POST', `/api/admin/uploads/${again.id}/import`, {
          cookie,
          json: { total_rows: again.report.summary.total_rows, replace_days: [] },
        }),
        409,
        'conflict',
        'importing a file with nothing new'
      )

      Object.assign(state, { model2: model.model_sha256, modelId2: run.model_id, run2: run.id })
      return `${WEEK_DAYS} new days, run ${run.id} succeeded, the model is trained through ${end}; the same file again has nothing to import`
    },
  ],
  [
    'forecast-only refresh',
    async () => {
      const cookie = state.admin
      const before = expectStatus(await call('GET', '/api/status', { cookie }), 200, '/api/status')
      const requested = expectStatus(
        await call('POST', '/api/admin/runs', { cookie, json: { mode: 'forecast-only' } }),
        202,
        'asking for a forecast-only run'
      )
      equal(requested.queued, false, 'run answer: queued')
      equal(requested.run.mode, 'forecast-only', 'run mode')
      const run = await followRun(cookie, requested.run.id)
      expectSucceeded(run, 'forecast-only run')
      equal(run.trained, false, 'forecast-only run trained a model')

      const after = expectStatus(await call('GET', '/api/status', { cookie }), 200, '/api/status')
      expect(
        Date.parse(after.forecast.generated_at) > Date.parse(before.forecast.generated_at),
        `generated_at did not move (${before.forecast.generated_at} -> ${after.forecast.generated_at})`
      )
      equal(after.forecast.run_id, run.id, 'forecast.run_id')
      equal(after.model.id, before.model.id, 'model id')
      equal(after.model.model_sha256, state.model2, 'model fingerprint')
      return `run ${run.id} succeeded: generated_at moved, model ${after.model.id} unchanged`
    },
  ],
  [
    'a viewer: forecast yes, admin routes no',
    async () => {
      const added = expectStatus(
        await call('POST', '/api/admin/users', {
          cookie: state.admin,
          json: { email: VIEWER, role: 'viewer' },
        }),
        201,
        'adding a viewer'
      )
      equal(added.user.role, 'viewer', 'role of the new person')
      const { cookie } = await signIn(VIEWER)
      const status = expectStatus(await call('GET', '/api/status', { cookie }), 200, '/api/status')
      equal(status.viewer.role, 'viewer', '/api/status viewer role')
      expectStatus(await call('GET', '/api/forecast', { cookie }), 200, '/api/forecast as a viewer')
      expectError(
        await call('GET', '/api/admin/runs', { cookie }),
        403,
        'forbidden',
        '/api/admin/runs'
      )
      expectError(
        await call('GET', '/api/admin/users', { cookie }),
        403,
        'forbidden',
        '/api/admin/users'
      )
      expectError(
        await call('POST', '/api/admin/runs', { cookie, json: {} }),
        403,
        'forbidden',
        'a retrain asked for by a viewer'
      )
      state.viewer = cookie
      return `${VIEWER} signed in with a mailed code: /api/forecast 200, /api/admin/* 403`
    },
  ],
  [
    'pages and the origin check',
    async () => {
      for (const path of ['/', '/admin']) {
        const page = await call('GET', path, { cookie: state.admin })
        expectStatus(page, 200, `GET ${path} as the admin`)
        expect(
          (page.headers.get('content-type') ?? '').includes('text/html') &&
            page.text.includes('<title>'),
          `GET ${path} did not answer an HTML page`
        )
        expectSecurityHeaders(page, `GET ${path}`)
        const signedOut = await call('GET', path, { redirect: 'manual' })
        expect(
          [301, 302, 303, 307, 308].includes(signedOut.status) &&
            new URL(signedOut.headers.get('location') ?? '', BASE).pathname === '/auth',
          `GET ${path} without a session should lead to /auth, got HTTP ${signedOut.status} ` +
            `location ${signedOut.headers.get('location')}`
        )
      }
      const refused = await call('GET', '/api/status')
      expectStatus(refused, 401, '/api/status without a session')
      expectSecurityHeaders(refused, '/api/status without a session')
      const asset = await call('GET', '/favicon.ico')
      expectStatus(asset, 200, '/favicon.ico')
      expectSecurityHeaders(asset, '/favicon.ico')

      const runsBefore = expectStatus(
        await call('GET', '/api/admin/runs', { cookie: state.admin }),
        200,
        '/api/admin/runs'
      ).runs.length
      expectError(
        await call('POST', '/api/admin/runs', {
          cookie: state.admin,
          json: {},
          origin: 'http://evil.example',
        }),
        403,
        'forbidden',
        'a write from another origin'
      )
      const runsAfter = expectStatus(
        await call('GET', '/api/admin/runs', { cookie: state.admin }),
        200,
        '/api/admin/runs'
      ).runs.length
      equal(runsAfter, runsBefore, 'runs after the refused cross-origin write')
      return '/ and /admin are HTML for the admin and lead to /auth without a session; a cross-origin write is 403'
    },
  ],
  [
    'no call record in the output',
    async () => {
      // The first call of the data, as it is stored and as a log line might print it.
      const stamps = [state.first_call, state.first_call.replace('T', ' ')]
      const log = server.log()
      for (const stamp of stamps) {
        expect(!log.includes(stamp), `the server's output holds a call's start time (${stamp})`)
      }
      for (const id of [state.run1, state.run2]) {
        const { run } = expectStatus(
          await call('GET', `/api/admin/runs/${id}`, { cookie: state.admin }),
          200,
          `reading run ${id}`
        )
        expect(run.log_tail, `run ${id} kept no output`)
        for (const stamp of stamps) {
          expect(!run.log_tail.includes(stamp), `the output of run ${id} holds a call's start time`)
        }
      }
      return `${count(log.length)} bytes of server output and the output of 2 retrains hold no call start time`
    },
  ],
  [
    'sign-in rate limit',
    async () => {
      // Guessing a code needs many requests, so asking for codes is limited (3 a minute
      // for one client). Last on purpose: it uses up the allowance. Up to here this run
      // asked three times at most.
      const answers = []
      for (let i = 0; i < CODE_REQUESTS_PER_MINUTE + 1; i++) {
        answers.push((await requestCode(STRANGER)).status)
      }
      expect(
        answers.every((status) => status === 200 || status === 429),
        `asking for codes answered ${answers.join(', ')}`
      )
      expect(
        answers.includes(429),
        `${answers.length} requests for a sign-in code within a minute were all answered ` +
          `(${answers.join(', ')}): the rate limit is off`
      )
      const lastMinute = answeredCodeRequests.filter((at) => Date.now() - at < 60_000).length
      return `a request for a sign-in code is refused (429) after ${lastMinute} were answered within a minute`
    },
  ],
]

async function stopServer() {
  expect(server.running, `the server had already stopped by itself:\n${tail(server.log())}`)
  const t0 = Date.now()
  server.child.kill('SIGTERM')
  const outcome = await Promise.race([server.exited, sleep(STOP_LIMIT_MS).then(() => null)])
  if (outcome === null) {
    server.child.kill('SIGKILL')
    await server.exited
    throw new StepFailure(`the server did not exit within ${seconds(STOP_LIMIT_MS)} of SIGTERM`)
  }
  await sleep(300)
  const left = processesMentioning(dbPath)
  expect(left.length === 0, `processes are still working on the database:\n${left.join('\n')}`)
  return `the server exited ${seconds(Date.now() - t0)} after SIGTERM; no process is left on the database`
}

let failed = false
let number = 0
const report = (verdict, name, detail) =>
  console.log(`${verdict} ${String(number).padStart(2)}. ${name}${detail ? `: ${detail}` : ''}`)

async function step(name, body, { always = false } = {}) {
  number++
  if (failed && !always) return report('SKIP', name, 'an earlier step failed')
  try {
    report('PASS', name, await body())
  } catch (error) {
    failed = true
    const reason = error instanceof StepFailure ? error.message : (error?.stack ?? String(error))
    report('FAIL', name, reason)
  }
}

// Whatever happens, nothing of this run stays behind: no server on the port, no folder.
function cleanUp() {
  if (server?.running) server.child.kill('SIGKILL')
  if (options.keep) {
    console.log(`kept: ${work} (app.db, server.log, data/)`)
  } else {
    rmSync(work, { recursive: true, force: true })
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\ne2e stopped by ${signal}`)
    cleanUp()
    process.exit(130)
  })
}

console.log(`e2e: SYNTHETIC data, production build on ${BASE}, temp folder ${work}`)
try {
  for (const [name, body] of steps) await step(name, body)
  // Also after a failed step, when there is a server to stop.
  await step('shutdown on SIGTERM', stopServer, { always: server !== null })
} finally {
  cleanUp()
  if (sink) await new Promise((resolve) => sink.close(resolve))
}
console.log(
  `${failed ? 'e2e FAILED' : 'e2e passed'}: ${number} steps in ${seconds(Date.now() - started)}`
)
process.exit(failed ? 1 : 0)
