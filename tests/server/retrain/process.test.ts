// The runner with REAL child processes: fixtures/fake-python.mjs plays the process
// contract of the retrain script against a migrated SQLite file on disk. Its `workers`
// mode builds the process tree the real gate can leave at its worst (workers that hold
// the pipes, ignore SIGTERM and outlive their parent), so the kill, timeout, shutdown
// and start-up tests below prove the runner itself leaves nothing behind.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../../server/db/schema'
import type { AppDb } from '../../../server/utils/db'
import {
  LOG_TAIL_BYTES,
  SHUTDOWN_GRACE_MS,
  createRetrainRunner,
  getRun,
  type RetrainConfig,
  type RetrainRunner,
} from '../../../server/utils/retrain/runner'

const FAKE = fileURLToPath(new URL('./fixtures/fake-python.mjs', import.meta.url))
const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))
// Real processes on a shared, busy machine: generous, but far below the test timeout.
const SLOW = 30_000

let folder: string
let sqlite: Database.Database
let db: AppDb
let config: RetrainConfig

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'v4w-retrain-test-'))
  const path = join(folder, 'v4w.db')
  sqlite = new Database(path, { timeout: 15_000 })
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS })
  const upload = db
    .insert(schema.uploads)
    .values({
      source: 'upload',
      status: 'imported',
      filename: 'SYNTHETIC.xlsx',
      fileSha256: 'x',
      fileBytes: 1,
      uploadedByLabel: 'admin@example.org',
      createdAt: new Date(),
    })
    .returning()
    .get()
  db.insert(schema.calls)
    .values([
      { startTs: '2026-11-05T08:00:00', abandoned: false, uploadId: upload.id },
      { startTs: '2026-11-06T09:00:00', abandoned: true, uploadId: upload.id },
    ])
    .run()
  db.insert(schema.dataState).values({ id: 1, callsRevision: 1, updatedAt: new Date() }).run()
  config = {
    pythonPath: FAKE,
    module: 'db.retrain',
    forecastDir: folder,
    dbPath: path,
    timeoutMs: 60_000,
    scheduleEnabled: true,
  }
})

let leftovers: number[] = []

afterEach(async () => {
  // Never leave a process of a failed test behind on a shared machine.
  for (const pid of leftovers) if (alive(pid)) process.kill(pid, 'SIGKILL')
  leftovers = []
  delete process.env.FAKE_RETRAIN
  delete process.env.FAKE_RETRAIN_NOISE
  delete process.env.FAKE_RETRAIN_IGNORE_TERM
  sqlite.close()
  await rm(folder, { recursive: true, force: true })
})

// Linux has /proc; elsewhere (macOS) the same facts come from ps.
const HAS_PROC = existsSync('/proc/self/stat')

// Every process as { pid, pgid, state } from ps, for systems without /proc.
function psTable(): { pid: number; pgid: number; state: string }[] {
  const out = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).stdout ?? ''
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && /^\d+$/.test(f[0]!))
    .map(([pid, pgid, state]) => ({ pid: Number(pid), pgid: Number(pgid), state: state! }))
}

// Running, not a zombie waiting to be reaped.
function alive(pid: number): boolean {
  if (!HAS_PROC) {
    const entry = psTable().find((p) => p.pid === pid)
    return entry !== undefined && !entry.state.startsWith('Z')
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat[stat.lastIndexOf(')') + 2] !== 'Z'
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = SLOW / 2): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

// The other members of process group `pgid` (the gate workers of a run).
function workersOf(pgid: number): number[] {
  if (!HAS_PROC) {
    return psTable()
      .filter((p) => p.pid !== pgid && p.pgid === pgid && !p.state.startsWith('Z'))
      .map((p) => p.pid)
  }
  const members: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === pgid) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (fields[0] !== 'Z' && Number(fields[2]) === pgid) members.push(Number(name))
    } catch {
      // ended while we looked
    }
  }
  return members
}

// Starts a run in `workers` mode and waits until its workers exist.
async function runWithWorkers(runner: RetrainRunner, count = 2) {
  process.env.FAKE_RETRAIN = 'workers'
  const { run } = runner.request({ trigger: 'manual', requestedBy: 'admin@example.org' })
  const pid = getRun(db, run.id).pid!
  expect(await until(() => workersOf(pid).length >= count)).toBe(true)
  const tree = [pid, ...workersOf(pid)]
  leftovers.push(...tree)
  return { run, pid, tree }
}

async function runWith(behaviour: string, overrides: Partial<RetrainConfig> = {}) {
  process.env.FAKE_RETRAIN = behaviour
  const runner = createRetrainRunner(db, { ...config, ...overrides })
  const { run } = runner.request({ trigger: 'manual', requestedBy: 'admin@example.org' })
  await runner.idle()
  return getRun(db, run.id)
}

describe('real child processes', () => {
  it(
    'succeed: Python claims the row, writes the forecast tables and reports',
    async () => {
      const run = await runWith('succeed')
      expect(run).toMatchObject({
        status: 'succeeded',
        exitCode: 0,
        callsRevision: 1,
        callsCount: 2,
        dataStart: '2026-11-05',
        dataEnd: '2026-11-06',
        forecastWritten: true,
        trained: true,
      })
      expect(run.pid).toBeGreaterThan(0)
      expect(run.startedAt).not.toBeNull()
      expect(run.logTail).toMatch(/V4W_RESULT \{"run_id":\d+,"status":"succeeded"/)
      expect(db.select().from(schema.forecastState).get()?.runId).toBe(run.id)
    },
    SLOW
  )

  it(
    'reject: the row says rejected, exit 3',
    async () => {
      expect(await runWith('reject')).toMatchObject({
        status: 'rejected',
        exitCode: 3,
        forecastWritten: false,
      })
    },
    SLOW
  )

  it(
    'refuse: the row says failed with the reason, exit 2',
    async () => {
      const run = await runWith('refuse')
      expect(run).toMatchObject({ status: 'failed', exitCode: 2 })
      expect(run.message).toMatch(/^Cannot retrain: /)
    },
    SLOW
  )

  it(
    'crash: the process never reported, so the runner fails the row',
    async () => {
      const run = await runWith('crash')
      expect(run).toMatchObject({
        status: 'failed',
        exitCode: 1,
        message: 'The retrain script stopped without reporting a result (exit code 1).',
      })
      expect(run.logTail).toContain('RuntimeError: FAKE crash')
    },
    SLOW
  )

  it(
    'hang: the timeout stops the process and fails the row',
    async () => {
      const started = Date.now()
      const run = await runWith('hang', { timeoutMs: 1500 })
      expect(run).toMatchObject({
        status: 'failed',
        exitCode: null,
        message:
          'Stopped after 0.03 minutes (V4W_RETRAIN_TIMEOUT_MIN). The forecast in use did not change.',
      })
      expect(Date.now() - started).toBeLessThan(SLOW)
      expect(() => process.kill(run.pid!, 0)).toThrow()
    },
    SLOW
  )

  it(
    'stores the end of the output, capped at 16 KB',
    async () => {
      process.env.FAKE_RETRAIN_NOISE = String(64 * 1024)
      const run = await runWith('succeed')
      expect(Buffer.byteLength(run.logTail!)).toBe(LOG_TAIL_BYTES)
      expect(run.logTail).toMatch(/V4W_RESULT .*\n$/)
    },
    SLOW
  )

  it(
    'an interpreter that does not exist fails the run with the reason',
    async () => {
      const run = await runWith('succeed', { pythonPath: join(folder, 'no-such-python') })
      expect(run).toMatchObject({
        status: 'failed',
        exitCode: null,
        message: 'The retrain script could not be started (ENOENT).',
      })
    },
    SLOW
  )
})

describe('a run whose workers outlive the script and hold its pipes', () => {
  it.each(['SIGKILL', 'SIGTERM'] as const)(
    '%s of the script: the run fails within seconds, nothing is left, the next request starts',
    async (signal) => {
      const runner = createRetrainRunner(db, config)
      const { run, pid, tree } = await runWithWorkers(runner)
      const started = Date.now()
      process.kill(pid, signal)
      await runner.idle()
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(getRun(db, run.id)).toMatchObject({
        status: 'failed',
        exitCode: null,
        message: `The retrain script was stopped by ${signal} before it reported a result. The forecast in use did not change.`,
      })
      expect(getRun(db, run.id).logTail).toMatch(/FAKE worker pid \d+/)
      expect(await until(() => tree.every((p) => !alive(p)), 5_000)).toBe(true)

      process.env.FAKE_RETRAIN = 'succeed'
      const next = runner.request({ trigger: 'manual', requestedBy: 'admin@example.org' })
      expect(next.queued).toBe(false)
      await runner.idle()
      expect(getRun(db, next.run.id).status).toBe('succeeded')
    },
    SLOW
  )

  it(
    'the timeout stops the whole tree and fails the run',
    async () => {
      const runner = createRetrainRunner(db, { ...config, timeoutMs: 1500 })
      const { run, tree } = await runWithWorkers(runner)
      await runner.idle()
      expect(getRun(db, run.id)).toMatchObject({
        status: 'failed',
        message:
          'Stopped after 0.03 minutes (V4W_RETRAIN_TIMEOUT_MIN). The forecast in use did not change.',
      })
      expect(await until(() => tree.every((p) => !alive(p)), 5_000)).toBe(true)
    },
    SLOW
  )

  it.each([
    ['a script that stops on SIGTERM', false],
    ['a script that ignores SIGTERM', true],
  ])(
    'shutdown with %s: prompt, interrupted, nothing left',
    async (_name, stubborn) => {
      if (stubborn) process.env.FAKE_RETRAIN_IGNORE_TERM = '1'
      const runner = createRetrainRunner(db, config)
      const { run, tree } = await runWithWorkers(runner)
      const started = Date.now()
      await runner.shutdown()
      expect(Date.now() - started).toBeLessThan(SHUTDOWN_GRACE_MS + 3_000)
      expect(getRun(db, run.id)).toMatchObject({
        status: 'interrupted',
        message: 'The server stopped during this run.',
      })
      expect(await until(() => tree.every((p) => !alive(p)), 5_000)).toBe(true)
    },
    SLOW
  )

  // The runner finds a dead server's processes through /proc (Linux, as in the image);
  // without /proc it sees none, so these two can only run on Linux.
  it.skipIf(!HAS_PROC).each([
    ['the script still running', false],
    ['only its workers left', true],
  ])(
    'start-up after a server died with %s: the tree is killed, a start-up run follows',
    async (_name, scriptDied) => {
      // What a server killed with -9 leaves: a run row and a process tree nobody watches.
      const row = db
        .insert(schema.forecastRuns)
        .values({ trigger: 'import', mode: 'full', status: 'queued', createdAt: new Date() })
        .returning()
        .get()
      const left = spawn(
        FAKE,
        ['-m', 'db.retrain', '--db', config.dbPath, '--run-id', String(row.id), '--mode', 'full'],
        {
          cwd: folder,
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, FAKE_RETRAIN: 'workers' },
        }
      )
      const pid = left.pid!
      leftovers.push(pid)
      expect(await until(() => workersOf(pid).length >= 2)).toBe(true)
      const tree = [pid, ...workersOf(pid)]
      leftovers.push(...tree)
      expect(getRun(db, row.id)).toMatchObject({ status: 'running', pid })
      if (scriptDied) {
        process.kill(pid, 'SIGKILL')
        expect(await until(() => !alive(pid))).toBe(true)
      }

      process.env.FAKE_RETRAIN = 'succeed'
      const runner = createRetrainRunner(db, config)
      const { interrupted, started } = runner.recover()
      expect(interrupted).toEqual([row.id])
      expect(getRun(db, row.id)).toMatchObject({
        status: 'interrupted',
        message: 'The server restarted during this run.',
      })
      expect(await until(() => tree.every((p) => !alive(p)), 5_000)).toBe(true)
      expect(started).not.toBeNull()
      await runner.idle()
      expect(getRun(db, started!)).toMatchObject({ trigger: 'startup', status: 'succeeded' })
    },
    SLOW
  )
})

describe('while Python holds the write lock', () => {
  it(
    'a request waits for it instead of failing at once',
    async () => {
      // Another process holds BEGIN IMMEDIATE for a while, as db.retrain does while it
      // claims its row, adds holidays or swaps in the forecast.
      const holder = spawn(
        process.execPath,
        [
          '-e',
          `const db = new (require('better-sqlite3'))(process.argv[1]);
           db.exec('BEGIN IMMEDIATE'); console.log('locked');
           setTimeout(() => { db.exec('COMMIT'); process.exit(0) }, 1500)`,
          config.dbPath,
        ],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] }
      )
      leftovers.push(holder.pid!)
      await new Promise((resolve) => holder.stdout!.once('data', resolve))
      process.env.FAKE_RETRAIN = 'succeed'
      const runner = createRetrainRunner(db, config)
      const started = Date.now()
      const { run, queued } = runner.request({
        trigger: 'manual',
        requestedBy: 'admin@example.org',
      })
      expect(queued).toBe(false)
      expect(Date.now() - started).toBeGreaterThan(500)
      await runner.idle()
      expect(getRun(db, run.id).status).toBe('succeeded')
    },
    SLOW
  )
})

// A retrain started from a shell is judged by the lock it
// holds next to the database, so the server never closes one that is alive, however
// its command line spells the database and whatever pid namespace it runs in, and
// still closes one that died. These use the REAL script (forecast/.venv) on SYNTHETIC
// calls; without that interpreter they are skipped.
const FORECAST = fileURLToPath(new URL('../../../forecast', import.meta.url))
const PYTHON = join(FORECAST, '.venv/bin/python')
const REAL = existsSync(PYTHON)
const BUSY = [
  '--gate-origins',
  '4',
  '--workers',
  '2',
  '--today',
  '2026-10-20',
  '--horizon-days',
  '30',
]
const unshareWorks =
  spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'true'], { stdio: 'ignore' }).status ===
  0

describe.skipIf(!REAL)('runs started from a shell, real script', () => {
  let real: string // a migrated database with 250 days of SYNTHETIC calls (enough for 26 origins)

  beforeEach(() => {
    real = join(folder, 'real.db')
    const made = spawnSync(
      PYTHON,
      [
        '-c',
        'import sys; sys.path.insert(0, "tests"); from pathlib import Path; ' +
          'from conftest import apply_migrations, insert_calls, synthetic_calls; ' +
          'insert_calls(apply_migrations(Path(sys.argv[1])), synthetic_calls("2026-02-10", 250))',
        real,
      ],
      { cwd: FORECAST, encoding: 'utf8' }
    )
    expect(made.status, made.stderr).toBe(0)
  }, SLOW)

  function shellRun(command: string[]) {
    const child = spawn(command[0]!, command.slice(1), {
      cwd: FORECAST,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (chunk) => (stderr += chunk))
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code))
    )
    return { child, exited, stderr: () => stderr }
  }

  // Polls the server's view of the shell run, as the runs page does, until the run exits.
  async function watchUntilExit(
    runner: RetrainRunner,
    readDb: Database.Database,
    run: ReturnType<typeof shellRun>
  ) {
    const seen = new Set<string>()
    let done = false
    void run.exited.then(() => (done = true))
    while (!done) {
      runner.reconcile()
      const row = readDb.prepare("SELECT status FROM forecast_runs WHERE trigger = 'cli'").get() as
        { status: string } | undefined
      if (row) seen.add(row.status)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return { code: await run.exited, seen }
  }

  const spellings: [string, (path: string) => string[]][] = [
    [
      'through a symlink',
      (path) => {
        mkdirSync(join(folder, 'other'))
        symlinkSync(path, join(folder, 'other', 'link.db'))
        return ['-m', 'db.retrain', '--db', join(folder, 'other', 'link.db')]
      },
    ],
    [
      'as an unnormalised path',
      (path) => {
        mkdirSync(join(folder, 'sub'))
        return ['-m', 'db.retrain', '--db', `${folder}/sub/../${basename(path)}`]
      },
    ],
    ['as --db=<path>', (path) => ['-m', 'db.retrain', `--db=${path}`]],
    ['through the db.train alias', (path) => ['-m', 'db.train', '--db', path]],
  ]
  const command = (spell: (path: string) => string[]) => (path: string) => [
    PYTHON,
    ...spell(path),
    ...BUSY,
  ]

  it.each(spellings)(
    'the database spelled %s: never closed while alive, and it records its own result',
    async (_name, spell) => {
      const readDb = new Database(real, { timeout: 15_000 })
      const runner = createRetrainRunner(drizzle(readDb, { schema }), {
        ...config,
        pythonPath: PYTHON,
        forecastDir: FORECAST,
        dbPath: real,
      })
      try {
        const run = shellRun(command(spell)(real))
        leftovers.push(run.child.pid!)
        const { code, seen } = await watchUntilExit(runner, readDb, run)
        expect(code, run.stderr()).toBe(0)
        expect([...seen].filter((s) => s !== 'running' && s !== 'succeeded')).toEqual([])
        const row = readDb
          .prepare("SELECT status, message FROM forecast_runs WHERE trigger = 'cli'")
          .get()
        expect(row).toMatchObject({ status: 'succeeded' })
      } finally {
        await runner.shutdown() // stops its watcher before the connection goes
        readDb.close()
      }
    },
    SLOW * 4
  )

  it(
    'the documented command (make retrain DB=<path>, from forecast/): never closed while alive',
    async () => {
      const readDb = new Database(real, { timeout: 15_000 })
      const runner = createRetrainRunner(drizzle(readDb, { schema }), {
        ...config,
        pythonPath: PYTHON,
        forecastDir: FORECAST,
        dbPath: real,
      })
      try {
        const run = shellRun(['make', 'retrain', `DB=${real}`])
        leftovers.push(run.child.pid!)
        const { code, seen } = await watchUntilExit(runner, readDb, run)
        expect(code, run.stderr()).toBe(0)
        expect([...seen].filter((s) => s !== 'running' && s !== 'succeeded')).toEqual([])
        expect(
          readDb.prepare("SELECT status FROM forecast_runs WHERE trigger = 'cli'").get()
        ).toEqual({
          status: 'succeeded',
        })
      } finally {
        await runner.shutdown()
        readDb.close()
      }
    },
    SLOW * 6
  )

  it.skipIf(!unshareWorks)(
    'started in another pid namespace (as from another container on the volume): never closed while alive',
    async () => {
      const readDb = new Database(real, { timeout: 15_000 })
      const runner = createRetrainRunner(drizzle(readDb, { schema }), {
        ...config,
        pythonPath: PYTHON,
        forecastDir: FORECAST,
        dbPath: real,
      })
      try {
        const run = shellRun([
          'unshare',
          '--pid',
          '--fork',
          '--mount-proc',
          PYTHON,
          '-m',
          'db.retrain',
          '--db',
          real,
          ...BUSY,
        ])
        leftovers.push(run.child.pid!)
        const { code, seen } = await watchUntilExit(runner, readDb, run)
        expect(code, run.stderr()).toBe(0)
        const row = readDb
          .prepare("SELECT status, pid FROM forecast_runs WHERE trigger = 'cli'")
          .get() as { status: string; pid: number }
        expect(row.status).toBe('succeeded')
        expect(row.pid).toBe(1) // the pid it recorded means nothing on this side
        expect([...seen].filter((s) => s !== 'running' && s !== 'succeeded')).toEqual([])
      } finally {
        await runner.shutdown() // stops its watcher before the connection goes
        readDb.close()
      }
    },
    SLOW * 4
  )

  it(
    'one killed with -9 is closed within seconds and its lock file removed',
    async () => {
      const readDb = new Database(real, { timeout: 15_000 })
      const runner = createRetrainRunner(drizzle(readDb, { schema }), {
        ...config,
        pythonPath: PYTHON,
        forecastDir: FORECAST,
        dbPath: real,
      })
      try {
        const run = shellRun([PYTHON, '-m', 'db.retrain', '--db', real, ...BUSY])
        leftovers.push(run.child.pid!)
        const running = () =>
          readDb
            .prepare("SELECT 1 FROM forecast_runs WHERE trigger = 'cli' AND status = 'running'")
            .get() !== undefined
        expect(await until(running)).toBe(true)
        runner.reconcile()
        const status = () =>
          (
            readDb.prepare("SELECT status FROM forecast_runs WHERE trigger = 'cli'").get() as {
              status: string
            }
          ).status
        expect(status()).toBe('running')
        run.child.kill('SIGKILL')
        await run.exited
        const killedAt = Date.now()
        expect(await until(() => (runner.reconcile(), status() === 'failed'), 5_000)).toBe(true)
        expect(Date.now() - killedAt).toBeLessThan(3_000)
        expect(existsSync(`${real}-cli-run-1.lock`)).toBe(false) // removed with the row
      } finally {
        await runner.shutdown() // stops its watcher before the connection goes
        readDb.close()
      }
    },
    SLOW * 4
  )
})
