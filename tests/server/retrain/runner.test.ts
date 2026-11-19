// The retrain runner with an injected spawn (no real process) and fake timers: the exact
// command, single flight, the queued re-run, every way a run can end, the timeout,
// shutdown, start-up recovery, runs of a shell and every branch of the scheduled tick.
// process.test.ts runs the same paths with real process trees.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../../helpers/db'
import * as schema from '../../../server/db/schema'
import type { AppDb } from '../../../server/utils/db'
import {
  DRAIN_MS,
  KILL_GRACE_MS,
  LOG_TAIL_BYTES,
  SHUTDOWN_GRACE_MS,
  WATCH_MS,
  createRetrainRunner,
  getRun,
  runsOverview,
  type RetrainConfig,
  type ProcessInfo,
  type RetrainDeps,
  type RetrainRun,
} from '../../../server/utils/retrain/runner'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  constructor(public pid: number | undefined) {
    super()
  }
  // The process exits and its pipes close (no leftover holds them).
  exit(code: number | null, signal: string | null = null) {
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

const CONFIG: RetrainConfig = {
  pythonPath: '/opt/forecast/.venv/bin/python',
  module: 'db.retrain',
  forecastDir: '/opt/forecast',
  dbPath: '/data/v4w.db',
  timeoutMs: 60_000,
  scheduleEnabled: true,
}
const NOW = new Date('2026-11-19T12:00:00Z')

let db: AppDb
let children: FakeChild[]
let spawned: { command: string; args: string[]; options: Record<string, unknown> }[]
let nextPid: number | undefined
let killed: [number, string][]
let table: ProcessInfo[]

function runner(config: Partial<RetrainConfig> = {}, deps: RetrainDeps = {}) {
  const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    spawned.push({ command, args, options })
    const child = new FakeChild(nextPid)
    if (nextPid !== undefined) nextPid++
    children.push(child)
    return child
  }) as unknown as typeof spawn
  return createRetrainRunner(
    db,
    { ...CONFIG, ...config },
    {
      spawn: fakeSpawn,
      now: () => NOW,
      kill: (pid, signal) => {
        killed.push([pid, signal])
      },
      processes: () => table,
      ...deps,
    }
  )
}

function seedCalls(revision = 1) {
  const upload = db
    .insert(schema.uploads)
    .values({
      source: 'upload',
      status: 'imported',
      filename: 'SYNTHETIC.xlsx',
      fileSha256: 'x',
      fileBytes: 1,
      uploadedByLabel: 'admin@example.org',
      createdAt: NOW,
    })
    .returning()
    .get()
  db.insert(schema.calls)
    .values({ startTs: '2026-11-05T08:00:00', abandoned: false, uploadId: upload.id })
    .run()
  setRevision(revision)
}

function setRevision(revision: number, rerun = false) {
  db.insert(schema.dataState)
    .values({ id: 1, callsRevision: revision, rerunRequested: rerun, updatedAt: NOW })
    .onConflictDoUpdate({
      target: schema.dataState.id,
      set: { callsRevision: revision, rerunRequested: rerun },
    })
    .run()
}

function setForecast(revision: number, generatedAt: Date) {
  db.insert(schema.forecastState)
    .values({
      id: 1,
      runId: 1,
      modelId: 1,
      generatedAt,
      callsRevision: revision,
      callsCount: 1,
      dataStart: '2026-11-05',
      dataEnd: '2026-11-05',
      horizonStart: '2026-11-05',
      horizonEnd: '2029-01-01',
      patienceSec: 250,
      patienceNAbandoned: 1,
      patienceNCalls: 1,
      quickHangups: {
        threshold_sec: 10,
        window_days: 90,
        first_day: '2026-11-05',
        last_day: '2026-11-05',
        n_calls: 1,
        n_abandoned: 0,
        n_quick: 0,
        quick_share_of_abandoned: null,
        quick_share_of_calls: 0,
      },
    })
    .run()
}

function addRun(values: Partial<typeof schema.forecastRuns.$inferInsert>): RetrainRun {
  return db
    .insert(schema.forecastRuns)
    .values({ trigger: 'manual', mode: 'full', status: 'succeeded', createdAt: NOW, ...values })
    .returning()
    .get()
}

// What db.retrain does to its row (section 7.2), done by hand.
function pythonWrites(id: number, status: RetrainRun['status'], fields: Partial<RetrainRun> = {}) {
  db.update(schema.forecastRuns)
    .set({ status, finishedAt: NOW, callsRevision: 1, message: `python says ${status}`, ...fields })
    .where(eq(schema.forecastRuns.id, id))
    .run()
}

const runs = () => db.select().from(schema.forecastRuns).orderBy(schema.forecastRuns.id).all()
const rerunFlag = () => db.select().from(schema.dataState).get()?.rerunRequested ?? false

beforeEach(() => {
  db = createTestDb().db
  children = []
  spawned = []
  nextPid = 5000
  killed = []
  table = []
})

// The script as the runner starts it, for the process table.
const script = (runId: number | null, db = '/data/v4w.db') => [
  '/opt/forecast/.venv/bin/python',
  '-m',
  'db.retrain',
  '--db',
  db,
  ...(runId === null ? [] : ['--run-id', String(runId)]),
  '--mode',
  'full',
]

afterEach(() => {
  vi.useRealTimers()
})

describe('request', () => {
  it('refuses when there are no calls', () => {
    expect(() => runner().request({ trigger: 'manual', requestedBy: 'a@example.org' })).toThrow(
      'There is no call data yet. Load a call-records file first.'
    )
    expect(runs()).toEqual([])
  })

  it('inserts a queued row and spawns exactly the contract command', () => {
    seedCalls()
    const { run, queued } = runner().request({
      trigger: 'import',
      mode: 'forecast-only',
      requestedBy: 'admin@example.org',
      uploadId: 7,
    })
    expect(queued).toBe(false)
    expect(run).toMatchObject({
      trigger: 'import',
      mode: 'forecast-only',
      status: 'queued',
      requestedByLabel: 'admin@example.org',
      uploadId: 7,
    })
    expect(spawned).toHaveLength(1)
    const [{ command, args, options }] = spawned as [(typeof spawned)[number]]
    expect(command).toBe('/opt/forecast/.venv/bin/python')
    expect(args).toEqual([
      '-m',
      'db.retrain',
      '--db',
      '/data/v4w.db',
      '--run-id',
      String(run.id),
      '--mode',
      'forecast-only',
    ])
    expect(options.cwd).toBe('/opt/forecast')
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    // Its own process group, so a stop reaches the gate workers.
    expect(options.detached).toBe(true)
    expect((options.env as Record<string, string>).PYTHONUNBUFFERED).toBe('1')
    expect((options.env as Record<string, string>).PATH).toBe(process.env.PATH)
    expect(getRun(db, run.id).pid).toBe(5000)
  })

  it('runs one at a time: later requests queue exactly one more full run', async () => {
    seedCalls()
    const r = runner()
    const first = r.request({ trigger: 'manual', requestedBy: 'a@example.org' })
    for (let i = 0; i < 3; i++) {
      const again = r.request({
        trigger: 'import',
        mode: 'forecast-only',
        requestedBy: 'b@example.org',
      })
      expect(again).toEqual({ run: expect.objectContaining({ id: first.run.id }), queued: true })
    }
    expect(spawned).toHaveLength(1)
    expect(rerunFlag()).toBe(true)

    pythonWrites(first.run.id, 'succeeded')
    children[0]!.exit(0)
    expect(spawned).toHaveLength(2)
    expect(rerunFlag()).toBe(false)
    const rerun = runs()[1]!
    expect(rerun).toMatchObject({
      trigger: 'import',
      mode: 'full',
      status: 'queued',
      requestedByLabel: 'queued',
    })

    pythonWrites(rerun.id, 'succeeded')
    children[1]!.exit(0)
    await r.idle()
    expect(spawned).toHaveLength(2)
    expect(runs()).toHaveLength(2)
  })
})

describe('a run that has reported but not yet exited', () => {
  it('still counts as active: a request queues behind it, its exit code and output are kept', () => {
    seedCalls()
    const r = runner()
    const { run } = r.request({ trigger: 'manual', requestedBy: 'a@example.org' })
    children[0]!.stdout.write('V4W_RESULT {}\n')
    pythonWrites(run.id, 'succeeded') // committed; the process is still exiting
    const again = r.request({ trigger: 'manual', requestedBy: 'b@example.org' })
    expect(again).toEqual({
      run: expect.objectContaining({ id: run.id, status: 'succeeded' }),
      queued: true,
    })
    expect(r.tick()).toMatchObject({ action: 'none', reason: 'A run is in progress.' })
    expect(spawned).toHaveLength(1)

    children[0]!.exit(0)
    expect(getRun(db, run.id)).toMatchObject({ exitCode: 0, logTail: 'V4W_RESULT {}\n' })
    expect(spawned).toHaveLength(2) // the queued one
  })
})

describe('how a run ends', () => {
  it.each([
    ['succeeded', 0],
    ['rejected', 3],
    ['failed', 2],
  ] as const)('keeps the row Python wrote (%s, exit %i)', async (status, code) => {
    seedCalls()
    const r = runner()
    const { run } = r.request({ trigger: 'manual', requestedBy: 'a@example.org' })
    children[0]!.stdout.write('gate table\n')
    children[0]!.stderr.write('a warning\n')
    pythonWrites(run.id, status)
    children[0]!.exit(code)
    await r.idle()
    expect(getRun(db, run.id)).toMatchObject({
      status,
      exitCode: code,
      message: `python says ${status}`,
      logTail: 'gate table\na warning\n',
    })
  })

  it('fails a run whose process died without reporting', () => {
    seedCalls()
    const r = runner()
    const { run } = r.request({ trigger: 'manual', requestedBy: 'a@example.org' })
    db.update(schema.forecastRuns)
      .set({ status: 'running' })
      .where(eq(schema.forecastRuns.id, run.id))
      .run()
    children[0]!.exit(1)
    expect(getRun(db, run.id)).toMatchObject({
      status: 'failed',
      exitCode: 1,
      finishedAt: NOW,
      message: 'The retrain script stopped without reporting a result (exit code 1).',
    })
  })

  it('names the signal that killed the process', () => {
    seedCalls()
    const { run } = runner().request({ trigger: 'manual', requestedBy: 'a@example.org' })
    children[0]!.exit(null, 'SIGKILL')
    expect(getRun(db, run.id)).toMatchObject({
      status: 'failed',
      exitCode: null,
      message:
        'The retrain script was stopped by SIGKILL before it reported a result. The forecast in use did not change.',
    })
    // Whatever the script left in its process group is killed with it.
    expect(killed).toEqual([[-5000, 'SIGKILL']])
  })

  it('fails a run whose interpreter could not be started', () => {
    seedCalls()
    nextPid = undefined
    const { run } = runner().request({ trigger: 'manual', requestedBy: 'a@example.org' })
    const error = Object.assign(new Error('spawn /opt/forecast/.venv/bin/python ENOENT'), {
      code: 'ENOENT',
    })
    children[0]!.emit('error', error)
    children[0]!.exit(-2)
    expect(getRun(db, run.id)).toMatchObject({
      status: 'failed',
      exitCode: null,
      pid: null,
      message: 'The retrain script could not be started (ENOENT).',
    })
  })

  it('keeps only the last 16 KB of output', () => {
    seedCalls()
    const { run } = runner().request({ trigger: 'manual', requestedBy: 'a@example.org' })
    for (let i = 0; i < 40; i++) children[0]!.stdout.write('x'.repeat(1023) + '\n')
    children[0]!.stdout.write('the last line\n')
    pythonWrites(run.id, 'succeeded')
    children[0]!.exit(0)
    const tail = getRun(db, run.id).logTail!
    expect(Buffer.byteLength(tail)).toBe(LOG_TAIL_BYTES)
    expect(tail.endsWith('the last line\n')).toBe(true)
  })

  it('stops a run after the timeout: SIGTERM, then SIGKILL, to the whole group', () => {
    vi.useFakeTimers()
    seedCalls()
    const { run } = runner().request({ trigger: 'manual', requestedBy: 'a@example.org' })
    vi.advanceTimersByTime(CONFIG.timeoutMs - 1)
    expect(killed).toEqual([])
    vi.advanceTimersByTime(1)
    expect(killed).toEqual([[-5000, 'SIGTERM']])
    vi.advanceTimersByTime(KILL_GRACE_MS)
    expect(killed).toEqual([
      [-5000, 'SIGTERM'],
      [-5000, 'SIGKILL'],
    ])
    children[0]!.exit(null, 'SIGKILL')
    expect(getRun(db, run.id)).toMatchObject({
      status: 'failed',
      message:
        'Stopped after 1 minutes (V4W_RETRAIN_TIMEOUT_MIN). The forecast in use did not change.',
    })
  })

  it('a run that ends before the timeout is not signalled later', () => {
    vi.useFakeTimers()
    seedCalls()
    const { run } = runner().request({ trigger: 'manual', requestedBy: 'a@example.org' })
    pythonWrites(run.id, 'succeeded')
    children[0]!.exit(0)
    killed = []
    vi.advanceTimersByTime(CONFIG.timeoutMs + KILL_GRACE_MS)
    expect(killed).toEqual([])
  })

  it('ends the run when the script exits, even while something still holds its pipes', async () => {
    vi.useFakeTimers()
    seedCalls()
    const r = runner()
    const { run } = r.request({ trigger: 'manual', requestedBy: 'a@example.org' })
    children[0]!.stdout.write('gate table\n')
    children[0]!.emit('exit', null, 'SIGKILL') // no 'close': a worker holds the pipes
    expect(killed).toEqual([[-5000, 'SIGKILL']])
    expect(getRun(db, run.id).status).toBe('queued')
    vi.advanceTimersByTime(DRAIN_MS)
    expect(getRun(db, run.id)).toMatchObject({ status: 'failed', logTail: 'gate table\n' })
    await r.idle()
    // The next request starts a fresh run.
    expect(r.request({ trigger: 'manual', requestedBy: 'a@example.org' }).queued).toBe(false)
    expect(spawned).toHaveLength(2)
  })
})

describe('shutdown', () => {
  it('stops the child, marks the run interrupted and starts nothing more', async () => {
    seedCalls()
    const r = runner()
    const { run } = r.request({ trigger: 'manual', requestedBy: 'a@example.org' })
    r.request({ trigger: 'import', requestedBy: 'b@example.org' }) // sets the re-run flag
    const done = r.shutdown()
    expect(killed).toEqual([[-5000, 'SIGTERM']])
    children[0]!.exit(null, 'SIGTERM')
    await done
    expect(getRun(db, run.id)).toMatchObject({
      status: 'interrupted',
      message: 'The server stopped during this run.',
    })
    expect(spawned).toHaveLength(1)
    expect(r.tick().action).toBe('none')
    expect(() => r.request({ trigger: 'manual', requestedBy: 'a@example.org' })).toThrow(
      'The server is stopping. Ask again once it is back.'
    )
    expect(runs()).toHaveLength(1)
  })

  it('a run that does not stop is killed after a short grace and recorded anyway', async () => {
    vi.useFakeTimers()
    seedCalls()
    const r = runner()
    const { run } = r.request({ trigger: 'manual', requestedBy: 'a@example.org' })
    const done = r.shutdown()
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS)
    expect(killed).toEqual([
      [-5000, 'SIGTERM'],
      [-5000, 'SIGKILL'],
    ])
    // Not even an exit event: the run is still closed and the server can go.
    vi.advanceTimersByTime(2 * DRAIN_MS)
    await done
    expect(getRun(db, run.id)).toMatchObject({
      status: 'interrupted',
      message: 'The server stopped during this run.',
    })
  })

  it('resolves at once when nothing runs', async () => {
    await expect(runner().shutdown()).resolves.toBeUndefined()
  })
})

describe('recover (start-up)', () => {
  it('interrupts what was left running, kills its process tree only, clears the flag, starts a run', () => {
    seedCalls(3)
    setRevision(3, true)
    const orphan = addRun({ status: 'running', pid: 4242 })
    const reused = addRun({ status: 'running', pid: 4343 })
    const queued = addRun({ status: 'queued' })
    table = [
      // the left-over script and its gate workers (same command line, same group)
      { pid: 4242, pgid: 4242, args: script(orphan.id) },
      { pid: 4250, pgid: 4242, args: script(orphan.id) },
      { pid: 4251, pgid: 4242, args: script(orphan.id) },
      // a worker whose parent already died: found by its command line alone
      { pid: 4300, pgid: 4299, args: script(99) },
      // a pid reused by something else, in a group of that number
      { pid: 4343, pgid: 4343, args: ['/usr/bin/vim', 'notes.txt'] },
      { pid: 4344, pgid: 4343, args: ['/bin/sh'] },
      // another app's retrain on another database, and an admin's run from a shell
      { pid: 4400, pgid: 4400, args: script(1, '/other/app.db') },
      { pid: 4500, pgid: 4500, args: script(null) },
    ]

    const result = runner().recover()
    expect(result.interrupted).toEqual([orphan.id, reused.id, queued.id])
    expect(killed.sort()).toEqual([
      [4242, 'SIGKILL'],
      [4250, 'SIGKILL'],
      [4251, 'SIGKILL'],
      [4300, 'SIGKILL'],
    ])
    for (const id of result.interrupted) {
      expect(getRun(db, id)).toMatchObject({
        status: 'interrupted',
        message: 'The server restarted during this run.',
      })
    }
    expect(rerunFlag()).toBe(false)
    expect(result.started).not.toBeNull()
    expect(getRun(db, result.started!)).toMatchObject({
      trigger: 'startup',
      mode: 'full',
      requestedByLabel: 'startup',
    })
    expect(spawned).toHaveLength(1)
  })

  it('starts nothing when a run already finished on this revision', () => {
    seedCalls(2)
    addRun({ status: 'failed', callsRevision: 2 })
    expect(runner().recover()).toEqual({ interrupted: [], started: null })
  })

  it('starts nothing when the forecast is already on this revision', () => {
    seedCalls(2)
    setForecast(2, NOW)
    expect(runner().recover().started).toBeNull()
  })

  it('starts nothing without calls', () => {
    expect(runner().recover()).toEqual({ interrupted: [], started: null })
    expect(spawned).toEqual([])
  })

  it('an interrupted run does not count as finished', () => {
    seedCalls(2)
    addRun({ status: 'interrupted', callsRevision: 2 })
    expect(runner().recover().started).not.toBeNull()
  })
})

describe('runs started from a shell', () => {
  it('a request while one runs is queued, and starts once that run ends', () => {
    vi.useFakeTimers()
    seedCalls()
    const shell = addRun({ trigger: 'cli', status: 'running', pid: 4500, requestedByLabel: 'cli' })
    table = [{ pid: 4500, pgid: 4500, args: script(null) }]
    const r = runner()
    expect(r.request({ trigger: 'manual', requestedBy: 'a@example.org' })).toEqual({
      run: expect.objectContaining({ id: shell.id }),
      queued: true,
    })
    vi.advanceTimersByTime(WATCH_MS)
    expect(spawned).toEqual([])

    pythonWrites(shell.id, 'succeeded') // the shell's run reports and exits
    table = []
    vi.advanceTimersByTime(WATCH_MS)
    expect(spawned).toHaveLength(1)
    expect(runs().at(-1)).toMatchObject({ trigger: 'import', requestedByLabel: 'queued' })
    expect(getRun(db, shell.id).status).toBe('succeeded')
  })

  it('a run whose process is gone without a word is closed, and does not block', () => {
    seedCalls()
    const shell = addRun({ trigger: 'cli', status: 'running', pid: 4500 })
    table = [{ pid: 4500, pgid: 4500, args: ['/usr/bin/vim'] }] // the pid was reused
    const r = runner()
    const { run, queued } = r.request({ trigger: 'manual', requestedBy: 'a@example.org' })
    expect(queued).toBe(false)
    expect(run.id).not.toBe(shell.id)
    expect(getRun(db, shell.id)).toMatchObject({
      status: 'failed',
      finishedAt: NOW,
      message:
        'The run started from a shell (process 4500) ended without reporting a result. The forecast in use did not change.',
    })
    expect(killed).toEqual([]) // never signalled: it is not ours
  })

  it('start-up leaves a live one alone and starts nothing beside it', () => {
    seedCalls(2)
    setRevision(2, true)
    const shell = addRun({ trigger: 'cli', status: 'running', pid: 4500 })
    table = [{ pid: 4500, pgid: 4500, args: script(null) }]
    expect(runner().recover()).toEqual({ interrupted: [], started: null })
    expect(killed).toEqual([])
    expect(getRun(db, shell.id).status).toBe('running')
    expect(rerunFlag()).toBe(true) // still owed once it ends
  })
})

describe('tick', () => {
  const OLD = new Date(NOW.getTime() - 21 * 3600 * 1000)
  const FRESH = new Date(NOW.getTime() - 19 * 3600 * 1000)

  it.each([
    {
      name: 'schedule off',
      config: { scheduleEnabled: false },
      setup: () => seedCalls(),
      action: 'none',
      reason: 'The schedule is off (V4W_RETRAIN_SCHEDULE).',
    },
    {
      name: 'a run is active',
      setup: () => {
        seedCalls()
        addRun({ trigger: 'cli', status: 'running', pid: 4500 })
        table = [{ pid: 4500, pgid: 4500, args: script(null) }]
      },
      action: 'none',
      reason: 'A run is in progress.',
    },
    { name: 'no calls', setup: () => {}, action: 'none', reason: 'There is no call data yet.' },
    {
      name: 'no forecast and nothing ran on this revision',
      setup: () => seedCalls(1),
      action: 'full',
      reason: 'The call data (revision 1) is newer than the forecast.',
    },
    {
      name: 'data newer than the forecast, nothing finished on it',
      setup: () => {
        seedCalls(2)
        setForecast(1, FRESH)
        addRun({ status: 'interrupted', callsRevision: 2 })
      },
      action: 'full',
      reason: 'The call data (revision 2) is newer than the forecast.',
    },
    {
      // A refresh would mark the forecast current although no model saw the new data.
      name: 'data newer, a run on it failed, forecast old',
      setup: () => {
        seedCalls(2)
        setForecast(1, OLD)
        addRun({ status: 'failed', callsRevision: 2 })
      },
      action: 'none',
      reason:
        'The call data (revision 2) is newer than the forecast, and run 1 on it ended failed; an admin decides what next.',
    },
    {
      name: 'data newer, a run on it was rejected, forecast fresh',
      setup: () => {
        seedCalls(2)
        setForecast(1, FRESH)
        addRun({ status: 'rejected', callsRevision: 2 })
      },
      action: 'none',
      reason:
        'The call data (revision 2) is newer than the forecast, and run 1 on it ended rejected; an admin decides what next.',
    },
    {
      name: 'no forecast, a run on this revision failed',
      setup: () => {
        seedCalls(1)
        addRun({ status: 'failed', callsRevision: 1 })
      },
      action: 'none',
      reason:
        'The call data (revision 1) has no forecast yet, and run 1 on it ended failed; an admin decides what next.',
    },
    {
      name: 'forecast current and fresh',
      setup: () => {
        seedCalls(4)
        setForecast(4, FRESH)
      },
      action: 'none',
      reason: 'The forecast is up to date.',
    },
    {
      name: 'forecast current but older than 20 hours',
      setup: () => {
        seedCalls(4)
        setForecast(4, OLD)
      },
      action: 'forecast-only',
      reason: 'The forecast is more than 20 hours old.',
    },
  ] as const)('$name -> $action', ({ config, setup, action, reason }) => {
    setup()
    const before = runs().length
    const result = runner(config ?? {}).tick()
    expect(result.action).toBe(action)
    expect(result.reason).toBe(reason)
    if (action === 'none') {
      expect(result.runId).toBeUndefined()
      expect(runs()).toHaveLength(before)
      expect(spawned).toEqual([])
    } else {
      expect(getRun(db, result.runId!)).toMatchObject({
        trigger: 'schedule',
        mode: action,
        requestedByLabel: 'schedule',
      })
      expect(spawned).toHaveLength(1)
    }
  })
})

describe('runsOverview', () => {
  it('lists runs newest first, the active one and the data line', () => {
    expect(runsOverview(db)).toEqual({
      runs: [],
      activeRunId: null,
      data: { calls_revision: 0, calls_count: 0, first_day: null, last_day: null },
    })
    seedCalls(5)
    const old = addRun({ status: 'succeeded', createdAt: new Date(NOW.getTime() - 1000) })
    const active = addRun({ status: 'running' })
    const overview = runsOverview(db)
    expect(overview.runs.map((r) => r.id)).toEqual([active.id, old.id])
    expect(overview.activeRunId).toBe(active.id)
    expect(overview.data).toEqual({
      calls_revision: 5,
      calls_count: 1,
      first_day: '2026-11-05',
      last_day: '2026-11-05',
    })
  })
})
