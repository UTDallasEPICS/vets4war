#!/usr/bin/env node
// A TEST DOUBLE for the retrain PROCESS (docs/retraining.md), not for its results: it
// takes exactly the arguments the runner passes,
//
//   -m <module> --db <abs path> --run-id <id> --mode <full|forecast-only>
//
// claims and finishes the run row the way db.retrain does, and exits with the contract's
// codes. What it writes into the forecast tables is a placeholder, labelled FAKE; nothing
// in the app may treat it as a forecast. Steered by FAKE_RETRAIN:
//
//   succeed (default)  row running -> succeeded, placeholder model/hours/cells/state, exit 0
//   reject             row rejected, nothing written, exit 3
//   refuse             row failed, message "Cannot retrain: ...", exit 2
//   crash              exit 1 without touching the row
//   hang               row running, then waits until killed
//   slow               like succeed, after FAKE_RETRAIN_MS milliseconds (default 3000)
//   workers            row running, then starts FAKE_RETRAIN_WORKERS (default 2) worker
//                      processes the way the gate's pool does at its worst: same command
//                      line, same process group, holding stdout and stderr, ignoring
//                      SIGTERM, never exiting, never dying with their parent; prints
//                      "FAKE worker pid <pid>" for each, then waits until killed
//
// FAKE_RETRAIN_NOISE=<bytes> prints that much filler output first (log tail tests).
// FAKE_RETRAIN_IGNORE_TERM=1 makes the script itself ignore SIGTERM (only SIGKILL ends it).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

if (process.env.FAKE_RETRAIN_ROLE === 'worker') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1 << 30)
} else {
  await main()
}

async function main() {
  const args = process.argv.slice(2)
  const option = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const dbPath = option('--db')
  const runId = Number(option('--run-id'))
  const mode = option('--mode') ?? 'full'
  if (
    args[0] !== '-m' ||
    !option('-m') ||
    !dbPath ||
    !Number.isInteger(runId) ||
    !['full', 'forecast-only'].includes(mode)
  ) {
    console.error(
      'usage: fake-python -m <module> --db <path> --run-id <id> --mode <full|forecast-only>'
    )
    process.exit(1)
  }

  const behaviour = process.env.FAKE_RETRAIN || 'succeed'
  if (process.env.FAKE_RETRAIN_IGNORE_TERM) process.on('SIGTERM', () => {})
  const noise = Number(process.env.FAKE_RETRAIN_NOISE || 0)
  const seconds = () => Math.floor(Date.now() / 1000)
  const db = new Database(dbPath, { timeout: 30_000 })

  if (noise > 0) {
    const line = 'FAKE retrain filler output line\n'
    process.stdout.write(line.repeat(Math.ceil(noise / line.length)))
  }
  console.log(`FAKE retrain: run ${runId}, mode ${mode}, behaviour ${behaviour}`)

  if (behaviour === 'crash') {
    console.error('Traceback (most recent call last):\nRuntimeError: FAKE crash')
    process.exit(1)
  }

  // Step 1 and 2 of section 7.2: read the data, claim the row.
  const data = db.transaction(() => {
    const revision =
      db.prepare('SELECT calls_revision AS r FROM data_state WHERE id = 1').get()?.r ?? 0
    const calls = db
      .prepare(
        'SELECT count(*) AS n, substr(min(start_ts), 1, 10) AS first, substr(max(start_ts), 1, 10) AS last FROM calls'
      )
      .get()
    return { revision, ...calls }
  })()
  db.prepare(
    `UPDATE forecast_runs SET status = 'running', started_at = COALESCE(started_at, ?), pid = ?,
     calls_revision = ?, calls_count = ?, data_start = ?, data_end = ? WHERE id = ?`
  ).run(seconds(), process.pid, data.revision, data.n, data.first, data.last, runId)

  const finishRow = (status, fields) =>
    db
      .prepare(
        `UPDATE forecast_runs SET status = ?, finished_at = ?, trained = ?, gate_passed = ?,
         forecast_written = ?, message = ?, model_id = ?, horizon_start = ?, horizon_end = ? WHERE id = ?`
      )
      .run(
        status,
        seconds(),
        fields.trained ?? null,
        fields.gatePassed ?? null,
        fields.forecastWritten ?? null,
        fields.message,
        fields.modelId ?? null,
        fields.horizonStart ?? null,
        fields.horizonEnd ?? null,
        runId
      )

  function succeed() {
    const model = `FAKE model of run ${runId}`
    const sha = createHash('sha256').update(model).digest('hex')
    const day = data.last ?? '2000-01-01'
    const modelId = db.transaction(() => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO model_artifacts (run_id, created_at, model_sha256, model_text, metadata_json,
             train_start, train_end, train_rows) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            runId,
            seconds(),
            sha,
            model,
            JSON.stringify({ config: { label: 'FAKE test double' }, model_sha256: sha }),
            `${data.first ?? day}T00:00:00`,
            `${day}T23:00:00`,
            0
          ).lastInsertRowid
      )
      db.prepare('DELETE FROM forecast_hours').run()
      const hour = db.prepare(
        'INSERT INTO forecast_hours (date, hour, predicted_calls, predicted_calls_no_holidays) VALUES (?, ?, 0, 0)'
      )
      hour.run(day, 0)
      hour.run(day, 1)
      db.prepare('DELETE FROM forecast_cells').run()
      const cell = db.prepare(
        'INSERT INTO forecast_cells (recency, dow, hour, aht_sec, real_share) VALUES (?, 1, 0, 0, 0)'
      )
      for (const recency of ['equal', 'weighted', 'recent']) cell.run(recency)
      db.prepare(
        `INSERT INTO forecast_state (id, run_id, model_id, generated_at, calls_revision, calls_count, data_start,
         data_end, horizon_start, horizon_end, patience_sec, patience_n_abandoned, patience_n_calls, quick_hangups_json)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '{}')
       ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id, model_id = excluded.model_id,
         generated_at = excluded.generated_at, calls_revision = excluded.calls_revision,
         calls_count = excluded.calls_count, data_start = excluded.data_start, data_end = excluded.data_end,
         horizon_start = excluded.horizon_start, horizon_end = excluded.horizon_end`
      ).run(runId, id, seconds(), data.revision, data.n, data.first ?? day, day, day, day)
      finishRow('succeeded', {
        trained: mode === 'full' ? 1 : 0,
        gatePassed: mode === 'full' ? 1 : null,
        forecastWritten: 1,
        message: 'FAKE retrain finished (test double, not a forecast).',
        modelId: id,
        horizonStart: day,
        horizonEnd: day,
      })
      return id
    })()
    console.log(
      `V4W_RESULT ${JSON.stringify({ run_id: runId, status: 'succeeded', model_id: modelId, model_sha256: sha })}`
    )
    process.exit(0)
  }

  switch (behaviour) {
    case 'succeed':
      succeed()
      break
    case 'slow':
      setTimeout(succeed, Number(process.env.FAKE_RETRAIN_MS || 3000))
      break
    case 'reject':
      finishRow('rejected', {
        trained: 0,
        gatePassed: 0,
        forecastWritten: 0,
        message: 'FAKE rejection: the candidate did not beat the simple baseline.',
      })
      console.log(
        `V4W_RESULT ${JSON.stringify({ run_id: runId, status: 'rejected', model_id: null, model_sha256: null })}`
      )
      process.exit(3)
      break
    case 'refuse':
      finishRow('failed', {
        message: 'Cannot retrain: FAKE refusal for tests. Load the missing days.',
      })
      process.exit(2)
      break
    case 'hang':
      setInterval(() => {}, 1 << 30)
      break
    case 'workers':
      for (let i = 0; i < Number(process.env.FAKE_RETRAIN_WORKERS || 2); i++) {
        const worker = spawn(process.execPath, process.argv.slice(1), {
          env: { ...process.env, FAKE_RETRAIN_ROLE: 'worker' },
          stdio: ['ignore', 'inherit', 'inherit'],
        })
        console.log(`FAKE worker pid ${worker.pid}`)
      }
      setInterval(() => {}, 1 << 30)
      break
    default:
      console.error(`unknown FAKE_RETRAIN ${behaviour}`)
      process.exit(1)
  }
}
