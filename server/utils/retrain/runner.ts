// The one owner of retrain runs (docs/retraining.md). Every run, whatever
// started it (an import, the schedule, an admin, a server start), is a forecast_runs row
// created here and one child process of the Python script:
//
//   <python> -m <module> --db <abs path> --run-id <id> --mode <full|forecast-only>
//
// At most one runs at a time. The row is the source of truth: Python claims it and
// writes the outcome; this side only fills in what Python could not (it never started,
// it died, it was stopped).
//
// Processes: the script runs in its own process group with its gate workers. A run ends
// when the script EXITS (not when its pipes close: a leftover worker could hold them);
// whatever is left in the group is then killed. A stop (timeout, shutdown) signals the
// whole group, SIGTERM then SIGKILL. At start-up every web-app run of the script on our
// database is a leftover of an earlier server process and is killed with its workers.
// A run started from a shell (trigger 'cli') is watched until it ends: it holds a lock
// next to the database while it lives (forecast/db/store.py), whatever its command line
// or pid namespace; its row is closed only once that lock is free.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { calls, dataState, forecastRuns, forecastState } from '../../db/schema'
import type { RunMode, RunTrigger } from '../../../shared/types/api'
import type { AppDb } from '../db'
import { apiError } from '../http'

// Named RetrainRun, not RunRow: other modules under server/utils use RunRow for the same
// row, and Nitro's auto-import scan warns when two files export one name.
export type RetrainRun = typeof forecastRuns.$inferSelect

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
  }): { run: RetrainRun; queued: boolean }
  tick(): { action: 'none' | 'full' | 'forecast-only'; reason: string; runId?: number }
  recover(): { interrupted: number[]; started: number | null }
  // Closes an active row whose process is gone (a shell's run killed with -9, say).
  reconcile(): void
  shutdown(): Promise<void>
  idle(): Promise<void> // resolves when no child is running (tests)
}

// One entry of the process table.
export interface ProcessInfo {
  pid: number
  pgid: number
  args: string[]
}

export interface RetrainDeps {
  spawn?: typeof nodeSpawn
  now?: () => Date
  // Signals a process, or with a negative pid a whole process group.
  kill?: (pid: number, signal: NodeJS.Signals) => void
  // Every process on the machine (Linux /proc); empty where that cannot be read.
  processes?: () => ProcessInfo[]
  // The lock a run started from a shell holds while it lives (forecast/db/store.py),
  // and its removal once the run is closed.
  cliLock?: (runId: number) => CliLock
  removeCliLock?: (runId: number) => void
  // The environment of the script; read at each start (default: retrainEnv(process.env)).
  env?: () => NodeJS.ProcessEnv
}

// What the retrain script gets of the server's environment: what any process needs to
// run (PATH, HOME, temp folder, locale, time zone), Python's and the numeric libraries'
// own settings, and the V4W_* settings forecast/db/retrain.py reads. The server's
// secrets (BETTER_AUTH_SECRET, EMAIL_*, a database URL) never reach it: the script gets
// the database as an argument, and its output is shown to admins.
const RETRAIN_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'TZ',
  'V4W_GATE_WORKERS',
  'V4W_HORIZON_DAYS',
  'V4W_HOLIDAYS_THROUGH_YEAR',
])
const RETRAIN_ENV_PREFIXES = ['LC_', 'PYTHON', 'OMP_', 'OPENBLAS_', 'MKL_']

export function retrainEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) =>
        value !== undefined &&
        (RETRAIN_ENV_NAMES.has(name) ||
          RETRAIN_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))
    )
  )
}

// held: the shell's run is alive; free: it ended (however); missing: no lock file to
// judge by (another directory layout, or a script from before the lock).
export type CliLock = 'held' | 'free' | 'missing'

// What the admin page keeps of a run's output.
export const LOG_TAIL_BYTES = 16 * 1024
// Time a run stopped for its timeout gets between SIGTERM and SIGKILL.
export const KILL_GRACE_MS = 10_000
// The same on shutdown: the server must go away promptly.
export const SHUTDOWN_GRACE_MS = 2_000
// After the process exited, how long its output may still drain before the run is
// closed anyway (anything still holding the pipes is killed first).
export const DRAIN_MS = 1_000
// How often a run this server did not start (a shell's) is checked for its end.
export const WATCH_MS = 2_000
// A forecast older than this is refreshed by the schedule (it runs daily).
export const STALE_FORECAST_MS = 20 * 3600 * 1000

const ACTIVE = ['queued', 'running'] as const
// Outcomes that would repeat if retried on the same data: a person decides what next.
const DECIDED = ['succeeded', 'rejected', 'failed'] as const
const QUEUED_LABEL = 'queued'
// The script's exit code for a refusal it explains (forecast/db/retrain.py).
const REFUSED_EXIT = 2
// At most this much of the script's own words goes into a run's message.
const REASON_CHARS = 300

// The last line the script printed, for a message; null when it printed nothing.
export function lastLine(output: string): string | null {
  const line = output
    .split('\n')
    .map((text) => text.trim())
    .filter(Boolean)
    .at(-1)
  if (!line) return null
  return line.length > REASON_CHARS ? `${line.slice(0, REASON_CHARS - 1)}…` : line
}

// The run waiting behind the active one (data_state.rerun_*).
export interface QueuedRun {
  mode: RunMode
  trigger: 'import' | 'manual'
  requestedBy: string | null
}

// Null when nothing is queued. A flag set before the request was remembered stands for
// what it always meant: a retrain after an import, by nobody in particular.
export function queuedRunOf(row: typeof dataState.$inferSelect | undefined): QueuedRun | null {
  if (!row?.rerunRequested) return null
  if (!row.rerunMode) return { mode: 'full', trigger: 'import', requestedBy: QUEUED_LABEL }
  return {
    mode: row.rerunMode,
    trigger: row.rerunTrigger ?? 'manual',
    requestedBy: row.rerunRequestedBy,
  }
}

const NO_CALLS = 'There is no call data yet. Load a call-records file first.'
const RESTARTED = 'The server restarted during this run.'
const STOPPED = 'The server stopped during this run.'
const UNCHANGED = 'The forecast in use did not change.'
const STOPPING = 'The server is stopping. Ask again once it is back.'

function defaultKill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch (error) {
    // Already gone: nothing to stop.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function defaultProcesses(): ProcessInfo[] {
  let names: string[]
  try {
    names = readdirSync('/proc')
  } catch {
    return []
  }
  const found: ProcessInfo[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      // "pid (command) state ppid pgrp ...": the command may hold spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (fields[0] === 'Z') continue // ended, waiting to be reaped
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0')
      if (args.at(-1) === '') args.pop()
      found.push({ pid: Number(name), pgid: Number(fields[2]), args })
    } catch {
      // ended while we looked
    }
  }
  return found
}

// The lock file of shell run `runId`, as forecast/db/store.py cli_lock_path names it:
// next to the database file with symlinks resolved.
export function cliLockPath(dbPath: string, runId: number): string {
  let real = dbPath
  try {
    real = realpathSync(dbPath)
  } catch {
    // not there (yet): the name as given
  }
  return join(dirname(real), `${basename(real)}-cli-run-${runId}.lock`)
}

// Whether another process holds the lock: SQLite's own RESERVED lock on the side file,
// tried without waiting. The kernel drops it the moment its holder ends.
function defaultCliLock(lockPath: string): CliLock {
  if (!existsSync(lockPath)) return 'missing'
  let probe: Database.Database | null = null
  try {
    probe = new Database(lockPath, { fileMustExist: true, timeout: 0 })
    probe.exec('BEGIN IMMEDIATE')
    probe.exec('ROLLBACK')
    return 'free'
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'SQLITE_BUSY') return 'held'
    if (code === 'SQLITE_CANTOPEN') return 'missing'
    throw error
  } finally {
    probe?.close()
  }
}

function defaultRemoveCliLock(lockPath: string) {
  for (const path of [lockPath, `${lockPath}-journal`]) rmSync(path, { force: true })
}

function optionValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

interface Current {
  run: RetrainRun
  child: ChildProcess
  output: Buffer[]
  outputBytes: number
  spawnError: NodeJS.ErrnoException | null
  timedOut: boolean
  exit: { code: number | null; signal: NodeJS.Signals | null } | null
  timers: ReturnType<typeof setTimeout>[]
}

export function createRetrainRunner(
  db: AppDb,
  config: RetrainConfig,
  deps: RetrainDeps = {}
): RetrainRunner {
  const spawn = deps.spawn ?? nodeSpawn
  const now = deps.now ?? (() => new Date())
  const kill = deps.kill ?? defaultKill
  const processes = deps.processes ?? defaultProcesses
  const cliLock =
    deps.cliLock ?? ((runId: number) => defaultCliLock(cliLockPath(config.dbPath, runId)))
  const removeCliLock =
    deps.removeCliLock ??
    ((runId: number) => defaultRemoveCliLock(cliLockPath(config.dbPath, runId)))
  const childEnv = deps.env ?? (() => retrainEnv(process.env))

  let current: Current | null = null
  let stopping = false
  let waiters: (() => void)[] = []
  let watcher: ReturnType<typeof setInterval> | null = null

  type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0]
  // A transaction that reads, then writes. IMMEDIATE takes the write lock first, so it
  // waits out Python's write (busy timeout) instead of failing at once: a deferred one
  // holding a read lock gets SQLITE_BUSY without waiting.
  const write = <T>(fn: (tx: Tx) => T): T => db.transaction(fn, { behavior: 'immediate' })
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
      .select()
      .from(forecastRuns)
      .where(
        and(eq(forecastRuns.callsRevision, revision), inArray(forecastRuns.status, [...DECIDED]))
      )
      .orderBy(desc(forecastRuns.id))
      .get()
  const queuedRun = (tx: Tx) => queuedRunOf(tx.select().from(dataState).get())
  const setQueued = (tx: Tx, queued: QueuedRun | null) => {
    const set = {
      rerunRequested: queued !== null,
      rerunMode: queued?.mode ?? null,
      rerunTrigger: queued?.trigger ?? null,
      rerunRequestedBy: queued?.requestedBy ?? null,
    }
    tx.insert(dataState)
      .values({ id: 1, callsRevision: 0, ...set, updatedAt: now() })
      .onConflictDoUpdate({ target: dataState.id, set })
      .run()
  }
  // One run waits behind the active one, whatever is asked meanwhile. A retrain wins
  // over a refresh, and an import always queues a retrain, which reads its calls.
  // Otherwise the first request keeps the place, with who asked for it.
  const queueBehind = (
    tx: Tx,
    input: { trigger: RunTrigger; mode: RunMode; requestedBy: string | null }
  ) => {
    const asked: QueuedRun =
      input.trigger === 'import'
        ? { mode: 'full', trigger: 'import', requestedBy: input.requestedBy }
        : { mode: input.mode, trigger: 'manual', requestedBy: input.requestedBy }
    const queued = queuedRun(tx)
    if (queued && !(asked.mode === 'full' && queued.mode === 'forecast-only')) return
    setQueued(tx, asked)
  }
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

  // The retrain script working on our database. With a run id: only that run's
  // process (a run of the web app); with null: any web-app run. A shell's run is
  // never matched by command line: it is judged by its lock (closeIfGone).
  function isScript(args: string[], runId: number | null): boolean {
    const m = args.indexOf('-m')
    if (m < 0 || args[m + 1] !== config.module) return false
    if (optionValue(args, '--db') !== config.dbPath) return false
    const id = optionValue(args, '--run-id')
    return id !== undefined && (runId === null || id === String(runId))
  }

  // The processes of a run this server does not hold a handle on: its own
  // process (by pid and command line) and everything in the process group the
  // web app gave it, which is where the gate workers are.
  function processesOf(row: RetrainRun, table: ProcessInfo[]): ProcessInfo[] {
    if (!row.pid || row.trigger === 'cli') return []
    const leader = table.find((p) => p.pid === row.pid && isScript(p.args, row.id))
    return table.filter(
      (p) =>
        p === leader ||
        (p.pgid === row.pid &&
          (isScript(p.args, row.id) || p.args.some((a) => a.includes('multiprocessing'))))
    )
  }

  function settleWaiters() {
    if (current) return
    const resolved = waiters
    waiters = []
    for (const resolve of resolved) resolve()
  }

  // The whole process group: the script and its gate workers.
  function signalRun(state: Current, signal: NodeJS.Signals) {
    const pid = state.child.pid
    if (!pid) return
    try {
      kill(-pid, signal)
    } catch (error) {
      console.error(`[retrain] could not signal run ${state.run.id}: ${(error as Error).name}`)
    }
  }

  function start(run: RetrainRun) {
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
        env: { ...childEnv(), PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a stop reaches the gate workers too.
        detached: true,
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
      exit: null,
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
      // A process that never started sends no 'exit'.
      if (!child.pid) setImmediate(() => finish(state))
    })
    // The run ends when the script exits, not when its pipes close: anything it left
    // holding them (a gate worker) must not keep the run open.
    child.on('exit', (code, signal) => {
      state.exit = { code, signal }
      signalRun(state, 'SIGKILL')
      state.timers.push(setTimeout(() => finish(state), DRAIN_MS))
    })
    child.on('close', () => {
      if (state.exit) finish(state)
    })
    state.timers.push(
      setTimeout(() => {
        state.timedOut = true
        stop(state, KILL_GRACE_MS)
      }, config.timeoutMs)
    )
  }

  function stop(state: Current, graceMs: number) {
    signalRun(state, 'SIGTERM')
    state.timers.push(setTimeout(() => signalRun(state, 'SIGKILL'), graceMs))
  }

  function finish(state: Current) {
    if (current !== state) return
    for (const timer of state.timers) clearTimeout(timer)
    state.child.stdout?.destroy()
    state.child.stderr?.destroy()
    const tail = Buffer.concat(state.output).subarray(-LOG_TAIL_BYTES).toString('utf8')
    // A child that never started has no exit code of its own (Node reports -errno).
    const startError = state.spawnError && !state.child.pid ? state.spawnError : null
    const code = startError ? null : (state.exit?.code ?? null)
    try {
      record(state.run, code, state.exit?.signal ?? null, tail, startError, state.timedOut)
    } catch (error) {
      console.error(
        `[retrain] run ${state.run.id}: the outcome could not be stored: ${(error as Error).name}`
      )
    }
    current = null
    startQueued()
    settleWaiters()
  }

  // Stores exit code and log tail; fills in the outcome only when Python did not.
  function record(
    run: RetrainRun,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    tail: string,
    startError: NodeJS.ErrnoException | null, // set when the process never started
    timedOut: boolean
  ) {
    const row = write((tx) => {
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
        message = `Stopped after ${minutes} minutes (V4W_RETRAIN_TIMEOUT_MIN). ${UNCHANGED}`
      } else if (signal) {
        message = `The retrain script was stopped by ${signal} before it reported a result. ${UNCHANGED}`
      } else {
        message = `The retrain script stopped without reporting a result (exit code ${exitCode}).`
        // Exit code 2 is a refusal the script explains (a bad argument or setting, before
        // it could claim the row): its last line says why.
        const reason = exitCode === REFUSED_EXIT ? lastLine(tail) : null
        if (reason) message = `${message} It said: ${reason}`
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

  // An active row this server holds no process for: a shell's run, or a row left
  // by a run that could not be stopped cleanly. Closed once it has surely ended.
  function closeIfGone(row: RetrainRun, table: ProcessInfo[]): boolean {
    if (current?.run.id === row.id) return false
    let message: string
    let lock: CliLock | null = null
    if (row.trigger === 'cli') {
      // Its command line may spell the database another way and its pid may belong to
      // another pid namespace (another container on the same volume): only the lock
      // it holds next to the database says whether it lives.
      lock = cliLock(row.id)
      if (lock === 'held') return false
      if (lock === 'missing') {
        const since = (row.startedAt ?? row.createdAt).getTime()
        if (now().getTime() - since < config.timeoutMs) return false
        const minutes = Math.round((config.timeoutMs / 60_000) * 100) / 100
        message = `The run started from a shell has not reported a result within ${minutes} minutes (V4W_RETRAIN_TIMEOUT_MIN) and has no lock file the server can check, so it is taken as ended. ${UNCHANGED}`
      } else {
        message = `The run started from a shell (process ${row.pid ?? 'unknown'}) ended without reporting a result. ${UNCHANGED}`
      }
    } else {
      if (processesOf(row, table).some((p) => p.pid === row.pid)) return false
      message = `The retrain script is gone without reporting a result. ${UNCHANGED}`
    }
    const closed = db
      .update(forecastRuns)
      .set({ status: 'failed', finishedAt: now(), message })
      .where(and(eq(forecastRuns.id, row.id), inArray(forecastRuns.status, [...ACTIVE])))
      .run()
    if (closed.changes) console.log(`[retrain] run ${row.id} closed: it has ended`)
    if (lock === 'free') removeCliLock(row.id)
    return true
  }

  // Active rows of runs this server holds no process for, after closing those whose
  // process is gone.
  function openForeignRuns(): RetrainRun[] {
    const foreign = db
      .select()
      .from(forecastRuns)
      .where(inArray(forecastRuns.status, [...ACTIVE]))
      .all()
      .filter((row) => row.id !== current?.run.id)
    if (!foreign.length) return []
    const table = processes()
    return foreign.filter((row) => !closeIfGone(row, table))
  }

  function startQueued() {
    if (current || stopping) return
    try {
      rerunIfRequested()
    } catch (error) {
      console.error(`[retrain] the queued run could not be started: ${(error as Error).name}`)
    }
  }

  function reconcile() {
    if (openForeignRuns().length) watch()
    else startQueued()
  }

  // Checks on runs of a shell until they end, then starts what was queued behind them.
  function watch() {
    if (watcher || stopping) return
    watcher = setInterval(() => {
      if (openForeignRuns().length) return
      clearInterval(watcher!)
      watcher = null
      startQueued()
    }, WATCH_MS)
    watcher.unref?.()
  }

  function rerunIfRequested() {
    const next = write((tx) => {
      const queued = queuedRun(tx)
      if (!queued) return null
      if (activeRun(tx) || !hasCalls(tx)) return null
      setQueued(tx, null)
      return insertRun(tx, queued)
    })
    if (next) start(next)
  }

  function request(input: {
    trigger: RunTrigger
    mode?: RunMode
    requestedBy: string | null
    uploadId?: number | null
  }): { run: RetrainRun; queued: boolean } {
    // A row inserted now would never start; the next start-up begins a run anyway
    // when the data is newer than the forecast.
    if (stopping) throw apiError(409, 'conflict', STOPPING)
    reconcile()
    const outcome = write((tx) => {
      if (!hasCalls(tx)) throw apiError(409, 'conflict', NO_CALLS)
      // Python commits its outcome a moment before it exits: until this side has seen
      // the exit (and stored the exit code and output), that run still counts.
      const active =
        activeRun(tx) ??
        (current
          ? tx.select().from(forecastRuns).where(eq(forecastRuns.id, current.run.id)).get()
          : undefined)
      if (active) {
        queueBehind(tx, { ...input, mode: input.mode ?? 'full' })
        return { run: active, queued: true }
      }
      return {
        run: insertRun(tx, { ...input, mode: input.mode ?? 'full' }),
        queued: false,
      }
    })
    if (!outcome.queued) start(outcome.run)
    return outcome
  }

  function tick(): { action: 'none' | 'full' | 'forecast-only'; reason: string; runId?: number } {
    if (!config.scheduleEnabled) {
      return { action: 'none', reason: 'The schedule is off (V4W_RETRAIN_SCHEDULE).' }
    }
    if (stopping) return { action: 'none', reason: 'The server is stopping.' }
    reconcile()
    const decision = write((tx) => {
      if (current || activeRun(tx)) {
        return { action: 'none' as const, reason: 'A run is in progress.' }
      }
      if (!hasCalls(tx)) return { action: 'none' as const, reason: 'There is no call data yet.' }
      const revision = revisionOf(tx)
      const state = tx.select().from(forecastState).get()
      if (!state || state.callsRevision !== revision) {
        const decided = decidedFor(tx, revision)
        if (!decided) {
          const run = insertRun(tx, { trigger: 'schedule', mode: 'full', requestedBy: 'schedule' })
          return {
            action: 'full' as const,
            reason: `The call data (revision ${revision}) is newer than the forecast.`,
            run,
          }
        }
        // A refresh would stamp the new data revision on a forecast whose model never
        // saw that data and hide that the retrain on it did not succeed (the console
        // would stop saying the forecast is behind). An admin fixes the cause and
        // retrains, or refreshes by hand on purpose.
        const behind = state ? 'is newer than the forecast' : 'has no forecast yet'
        return {
          action: 'none' as const,
          reason: `The call data (revision ${revision}) ${behind}, and run ${decided.id} on it ended ${decided.status}; an admin decides what next.`,
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
    // This server has started nothing yet, so every web-app run of the script on our
    // database (it passes --run-id) is left over from an earlier server process, and
    // would race the new run for the forecast tables: kill it, workers included.
    // A run started from a shell is the admin's and is left alone.
    const table = processes()
    const leftovers = new Set(table.filter((p) => isScript(p.args, null)).map((p) => p.pid))
    for (const row of stuck) {
      if (row.trigger !== 'cli') for (const p of processesOf(row, table)) leftovers.add(p.pid)
    }
    for (const pid of leftovers) kill(pid, 'SIGKILL')
    if (leftovers.size) {
      console.log(`[retrain] stopped ${leftovers.size} process(es) left by the previous server`)
    }
    const shell = stuck.filter((row) => row.trigger === 'cli')
    for (const row of shell) closeIfGone(row, table)
    const ids = stuck.filter((row) => row.trigger !== 'cli').map((row) => row.id)
    const next = write((tx) => {
      if (ids.length) {
        tx.update(forecastRuns)
          .set({ status: 'interrupted', finishedAt: now(), message: RESTARTED })
          .where(and(inArray(forecastRuns.id, ids), inArray(forecastRuns.status, [...ACTIVE])))
          .run()
      }
      if (activeRun(tx)) return null // a shell's run is still going: watched below
      if (queuedRun(tx)) setQueued(tx, null)
      if (!hasCalls(tx)) return null
      const revision = revisionOf(tx)
      const state = tx.select().from(forecastState).get()
      if (state?.callsRevision === revision || decidedFor(tx, revision)) return null
      return insertRun(tx, { trigger: 'startup', mode: 'full', requestedBy: 'startup' })
    })
    if (next) start(next)
    else if (shell.length) reconcile()
    return { interrupted: ids, started: next?.id ?? null }
  }

  async function shutdown(): Promise<void> {
    stopping = true
    if (watcher) clearInterval(watcher)
    watcher = null
    const state = current
    if (!state) return
    const done = idle()
    stop(state, SHUTDOWN_GRACE_MS)
    // SIGKILL ends any process; this bound only guards against a child that never
    // reports its exit, so the server still goes away with the run recorded.
    const bound = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS + 2 * DRAIN_MS)
      timer.unref?.()
    })
    await Promise.race([done, bound])
    if (current === state) finish(state)
  }

  function idle(): Promise<void> {
    if (!current) return Promise.resolve()
    return new Promise((resolve) => waiters.push(resolve))
  }

  return { request, tick, recover, reconcile, shutdown, idle }
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
    const state = tx.select().from(dataState).get()
    return {
      runs,
      activeRunId: active?.id ?? null,
      queued: queuedRunOf(state),
      data: {
        calls_revision: state?.callsRevision ?? 0,
        calls_count: totals.count,
        first_day: totals.first,
        last_day: totals.last,
      },
    }
  })
}

export function getRun(db: AppDb, id: number): RetrainRun {
  const row = db.select().from(forecastRuns).where(eq(forecastRuns.id, id)).get()
  if (!row) throw apiError(404, 'not_found', `There is no run ${id}.`)
  return row
}
