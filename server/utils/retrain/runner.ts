// The one owner of retrain runs (PLAN.md sections 7 and 8.3). Every run, whatever
// started it (an import, the schedule, an admin, a server start), is a forecast_runs row
// created here and one child process of the Python script:
//
//   <python> -m <module> --db <abs path> --run-id <id> --mode <full|forecast-only>
//
// At most one runs at a time. The row is the source of truth: Python claims it and
// writes the outcome; this side only fills in what Python could not (it never started,
// it died, it was stopped).
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { calls, dataState, forecastRuns, forecastState } from '../../db/schema'
import type { RunMode, RunTrigger } from '../../../shared/types/api'
import type { AppDb } from '../db'
import { apiError } from '../http'

export type RunRow = typeof forecastRuns.$inferSelect

export interface RetrainConfig {
  pythonPath: string
  module: string
  forecastDir: string
  dbPath: string // absolute
  timeoutMs: number
  scheduleEnabled: boolean
}

export interface RetrainRunner {
  request(input: {
    trigger: RunTrigger
    mode?: RunMode
    requestedBy: string | null
    uploadId?: number | null
  }): { run: RunRow; queued: boolean }
  tick(): { action: 'none' | 'full' | 'forecast-only'; reason: string; runId?: number }
  recover(): { interrupted: number[]; started: number | null }
  shutdown(): Promise<void>
  idle(): Promise<void> // resolves when no child is running (tests)
}

export interface RetrainDeps {
  spawn?: typeof nodeSpawn
  now?: () => Date
  isAlive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  // The command line of a process (/proc/<pid>/cmdline), or null when unknown.
  commandLine?: (pid: number) => string | null
}

// What the admin page keeps of a run's output.
export const LOG_TAIL_BYTES = 16 * 1024
// Time a stopped child gets between SIGTERM and SIGKILL.
export const KILL_GRACE_MS = 10_000
// A forecast older than this is refreshed by the schedule (it runs daily).
export const STALE_FORECAST_MS = 20 * 3600 * 1000

const ACTIVE = ['queued', 'running'] as const
// Outcomes that would repeat if retried on the same data: a person decides what next.
const DECIDED = ['succeeded', 'rejected', 'failed'] as const
const QUEUED_LABEL = 'queued'

const NO_CALLS = 'There is no call data yet. Load a call-records file first.'
const RESTARTED = 'The server restarted during this run.'
const STOPPED = 'The server stopped during this run.'

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function defaultCommandLine(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
  } catch {
    return null
  }
}

interface Current {
  run: RunRow
  child: ChildProcess
  output: Buffer[]
  outputBytes: number
  spawnError: NodeJS.ErrnoException | null
  timedOut: boolean
  timers: ReturnType<typeof setTimeout>[]
}

export function createRetrainRunner(
  db: AppDb,
  config: RetrainConfig,
  deps: RetrainDeps = {}
): RetrainRunner {
  const spawn = deps.spawn ?? nodeSpawn
  const now = deps.now ?? (() => new Date())
  const isAlive = deps.isAlive ?? defaultIsAlive
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const commandLine = deps.commandLine ?? defaultCommandLine

  let current: Current | null = null
  let stopping = false
  let waiters: (() => void)[] = []

  type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0]
  const activeRun = (tx: Tx) =>
    tx
      .select()
      .from(forecastRuns)
      .where(inArray(forecastRuns.status, [...ACTIVE]))
      .orderBy(desc(forecastRuns.id))
      .get()
  const hasCalls = (tx: Tx) => tx.select({ id: calls.id }).from(calls).limit(1).get() !== undefined
  const revisionOf = (tx: Tx) => tx.select().from(dataState).get()?.callsRevision ?? 0
  const decidedFor = (tx: Tx, revision: number) =>
    tx
      .select({ id: forecastRuns.id })
      .from(forecastRuns)
      .where(
        and(eq(forecastRuns.callsRevision, revision), inArray(forecastRuns.status, [...DECIDED]))
      )
      .get() !== undefined
  const setRerun = (tx: Tx, value: boolean) =>
    tx
      .insert(dataState)
      .values({ id: 1, callsRevision: 0, rerunRequested: value, updatedAt: now() })
      .onConflictDoUpdate({ target: dataState.id, set: { rerunRequested: value } })
      .run()
  const insertRun = (
    tx: Tx,
    input: {
      trigger: RunTrigger
      mode: RunMode
      requestedBy: string | null
      uploadId?: number | null
    }
  ) =>
    tx
      .insert(forecastRuns)
      .values({
        trigger: input.trigger,
        mode: input.mode,
        status: 'queued',
        requestedByLabel: input.requestedBy,
        uploadId: input.uploadId ?? null,
        createdAt: now(),
      })
      .returning()
      .get()

  function settleWaiters() {
    if (current) return
    const resolved = waiters
    waiters = []
    for (const resolve of resolved) resolve()
  }

  function start(run: RunRow) {
    const args = [
      '-m',
      config.module,
      '--db',
      config.dbPath,
      '--run-id',
      String(run.id),
      '--mode',
      run.mode,
    ]
    let child: ChildProcess
    try {
      child = spawn(config.pythonPath, args, {
        cwd: config.forecastDir,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      // Node reports most spawn failures through 'error'; a synchronous throw (a bad
      // argument) is the same outcome.
      record(run, null, null, '', error as NodeJS.ErrnoException, false)
      return
    }
    const state: Current = {
      run,
      child,
      output: [],
      outputBytes: 0,
      spawnError: null,
      timedOut: false,
      timers: [],
    }
    current = state
    console.log(`[retrain] run ${run.id} started (${run.mode}, ${run.trigger})`)
    if (child.pid) {
      db.update(forecastRuns)
        .set({ pid: child.pid })
        .where(and(eq(forecastRuns.id, run.id), inArray(forecastRuns.status, [...ACTIVE])))
        .run()
    }
    const keep = (chunk: Buffer) => {
      state.output.push(chunk)
      state.outputBytes += chunk.length
      while (
        state.output.length > 1 &&
        state.outputBytes - state.output[0]!.length >= LOG_TAIL_BYTES
      ) {
        state.outputBytes -= state.output.shift()!.length
      }
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (error) => {
      state.spawnError = error as NodeJS.ErrnoException
    })
    child.on('close', (code, signal) => finish(state, code, signal))
    state.timers.push(
      setTimeout(() => {
        state.timedOut = true
        stop(state)
      }, config.timeoutMs)
    )
  }

  function stop(state: Current) {
    state.child.kill('SIGTERM')
    state.timers.push(setTimeout(() => state.child.kill('SIGKILL'), KILL_GRACE_MS))
  }

  function finish(state: Current, code: number | null, signal: NodeJS.Signals | null) {
    if (current !== state) return
    for (const timer of state.timers) clearTimeout(timer)
    const tail = Buffer.concat(state.output).subarray(-LOG_TAIL_BYTES).toString('utf8')
    // A child that never started has no exit code of its own (Node reports -errno).
    const startError = state.spawnError && !state.child.pid ? state.spawnError : null
    try {
      record(state.run, startError ? null : code, signal, tail, startError, state.timedOut)
    } catch (error) {
      console.error(
        `[retrain] run ${state.run.id}: the outcome could not be stored: ${(error as Error).name}`
      )
    }
    current = null
    if (!stopping) {
      try {
        rerunIfRequested()
      } catch (error) {
        console.error(`[retrain] the queued run could not be started: ${(error as Error).name}`)
      }
    }
    settleWaiters()
  }

  // Stores exit code and log tail; fills in the outcome only when Python did not.
  function record(
    run: RunRow,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    tail: string,
    startError: NodeJS.ErrnoException | null, // set when the process never started
    timedOut: boolean
  ) {
    const row = db.transaction((tx) => {
      tx.update(forecastRuns)
        .set({ exitCode, logTail: tail })
        .where(eq(forecastRuns.id, run.id))
        .run()
      const stored = tx.select().from(forecastRuns).where(eq(forecastRuns.id, run.id)).get()!
      if (!(ACTIVE as readonly string[]).includes(stored.status)) return stored
      let message: string
      if (startError) {
        message = `The retrain script could not be started (${startError.code ?? startError.name}).`
      } else if (stopping) {
        message = STOPPED
      } else if (timedOut) {
        const minutes = Math.round((config.timeoutMs / 60_000) * 100) / 100
        message = `Stopped after ${minutes} minutes (V4W_RETRAIN_TIMEOUT_MIN).`
      } else {
        const how = signal ? `signal ${signal}` : `exit code ${exitCode}`
        message = `The retrain script stopped without reporting a result (${how}).`
      }
      return tx
        .update(forecastRuns)
        .set({ status: stopping ? 'interrupted' : 'failed', finishedAt: now(), message })
        .where(eq(forecastRuns.id, run.id))
        .returning()
        .get()
    })
    console.log(
      `[retrain] run ${run.id} ended: ${row.status} (exit ${exitCode ?? signal ?? 'none'})`
    )
  }

  function rerunIfRequested() {
    const next = db.transaction((tx) => {
      if (!tx.select().from(dataState).get()?.rerunRequested) return null
      setRerun(tx, false)
      if (activeRun(tx) || !hasCalls(tx)) return null
      return insertRun(tx, { trigger: 'import', mode: 'full', requestedBy: QUEUED_LABEL })
    })
    if (next) start(next)
  }

  function request(input: {
    trigger: RunTrigger
    mode?: RunMode
    requestedBy: string | null
    uploadId?: number | null
  }): { run: RunRow; queued: boolean } {
    const outcome = db.transaction((tx) => {
      if (!hasCalls(tx)) throw apiError(409, 'conflict', NO_CALLS)
      const active = activeRun(tx)
      if (active) {
        setRerun(tx, true)
        return { run: active, queued: true }
      }
      return {
        run: insertRun(tx, { ...input, mode: input.mode ?? 'full' }),
        queued: false,
      }
    })
    if (!outcome.queued && !stopping) start(outcome.run)
    return outcome
  }

  function tick(): { action: 'none' | 'full' | 'forecast-only'; reason: string; runId?: number } {
    if (!config.scheduleEnabled) {
      return { action: 'none', reason: 'The schedule is off (V4W_RETRAIN_SCHEDULE).' }
    }
    if (stopping) return { action: 'none', reason: 'The server is stopping.' }
    const decision = db.transaction((tx) => {
      if (activeRun(tx)) return { action: 'none' as const, reason: 'A run is in progress.' }
      if (!hasCalls(tx)) return { action: 'none' as const, reason: 'There is no call data yet.' }
      const revision = revisionOf(tx)
      const state = tx.select().from(forecastState).get()
      if (!state || state.callsRevision !== revision) {
        if (!decidedFor(tx, revision)) {
          const run = insertRun(tx, { trigger: 'schedule', mode: 'full', requestedBy: 'schedule' })
          return {
            action: 'full' as const,
            reason: `The call data (revision ${revision}) is newer than the forecast.`,
            run,
          }
        }
      }
      if (!state) {
        return {
          action: 'none' as const,
          reason:
            'A retrain on the current call data already ended without a forecast; an admin decides what next.',
        }
      }
      if (now().getTime() - state.generatedAt.getTime() > STALE_FORECAST_MS) {
        const run = insertRun(tx, {
          trigger: 'schedule',
          mode: 'forecast-only',
          requestedBy: 'schedule',
        })
        return {
          action: 'forecast-only' as const,
          reason: 'The forecast is more than 20 hours old.',
          run,
        }
      }
      return { action: 'none' as const, reason: 'The forecast is up to date.' }
    })
    if ('run' in decision && decision.run) {
      start(decision.run)
      return { action: decision.action, reason: decision.reason, runId: decision.run.id }
    }
    return { action: decision.action, reason: decision.reason }
  }

  function recover(): { interrupted: number[]; started: number | null } {
    const stuck = db
      .select()
      .from(forecastRuns)
      .where(inArray(forecastRuns.status, [...ACTIVE]))
      .orderBy(forecastRuns.id)
      .all()
    // A retrain the previous server process left running would race the new one for
    // the forecast tables: stop it, but only if that pid is still our script.
    const orphans = stuck.flatMap((row) =>
      row.pid && isAlive(row.pid) && (commandLine(row.pid) ?? '').includes(config.module)
        ? [row.pid]
        : []
    )
    for (const pid of orphans) kill(pid, 'SIGTERM')
    if (orphans.length) {
      const late = setTimeout(() => {
        for (const pid of orphans) {
          if (isAlive(pid) && (commandLine(pid) ?? '').includes(config.module)) kill(pid, 'SIGKILL')
        }
      }, KILL_GRACE_MS)
      late.unref?.()
    }
    const ids = stuck.map((row) => row.id)
    const next = db.transaction((tx) => {
      if (ids.length) {
        tx.update(forecastRuns)
          .set({ status: 'interrupted', finishedAt: now(), message: RESTARTED })
          .where(and(inArray(forecastRuns.id, ids), inArray(forecastRuns.status, [...ACTIVE])))
          .run()
      }
      if (tx.select().from(dataState).get()?.rerunRequested) setRerun(tx, false)
      if (!hasCalls(tx)) return null
      const revision = revisionOf(tx)
      const state = tx.select().from(forecastState).get()
      if (state?.callsRevision === revision || decidedFor(tx, revision)) return null
      return insertRun(tx, { trigger: 'startup', mode: 'full', requestedBy: 'startup' })
    })
    if (next) start(next)
    return { interrupted: ids, started: next?.id ?? null }
  }

  async function shutdown(): Promise<void> {
    stopping = true
    const state = current
    if (!state) return
    const done = idle()
    state.child.kill('SIGTERM')
    state.timers.push(setTimeout(() => state.child.kill('SIGKILL'), KILL_GRACE_MS))
    await done
  }

  function idle(): Promise<void> {
    if (!current) return Promise.resolve()
    return new Promise((resolve) => waiters.push(resolve))
  }

  return { request, tick, recover, shutdown, idle }
}

// The latest runs and what the data looks like, for GET /api/admin/runs.
export function runsOverview(db: AppDb) {
  return db.transaction((tx) => {
    const runs = tx
      .select()
      .from(forecastRuns)
      .orderBy(desc(forecastRuns.createdAt), desc(forecastRuns.id))
      .limit(30)
      .all()
    const active = tx
      .select({ id: forecastRuns.id })
      .from(forecastRuns)
      .where(inArray(forecastRuns.status, [...ACTIVE]))
      .orderBy(desc(forecastRuns.id))
      .get()
    const totals = tx
      .select({
        count: sql<number>`count(*)`,
        first: sql<string | null>`substr(min(${calls.startTs}), 1, 10)`,
        last: sql<string | null>`substr(max(${calls.startTs}), 1, 10)`,
      })
      .from(calls)
      .get()!
    return {
      runs,
      activeRunId: active?.id ?? null,
      data: {
        calls_revision: tx.select().from(dataState).get()?.callsRevision ?? 0,
        calls_count: totals.count,
        first_day: totals.first,
        last_day: totals.last,
      },
    }
  })
}

export function getRun(db: AppDb, id: number): RunRow {
  const row = db.select().from(forecastRuns).where(eq(forecastRuns.id, id)).get()
  if (!row) throw apiError(404, 'not_found', `There is no run ${id}.`)
  return row
}
