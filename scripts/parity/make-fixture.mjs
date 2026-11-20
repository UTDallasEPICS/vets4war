// Builds tests/server/forecast/fixtures/SYNTHETIC-legacy-golden.json: a SMALL frozen slice
// of parity rung P3 that runs in CI without the legacy stack. It holds the forecast rows
// that nine golden requests of 2026-12-01..03 need (from a legacy_export.py database of
// the SYNTHETIC reference stack) and the old API's answers to them. Forecast aggregates
// only: no call record.
//
//   node scripts/parity/make-fixture.mjs --db <legacy_b.db> --golden <legacy>/golden/b \
//     [--out tests/server/forecast/fixtures/SYNTHETIC-legacy-golden.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import Database from 'better-sqlite3'

const NOTE = 'SYNTHETIC data. Frozen answers of the final-main API, for regression tests only.'
const FIRST = '2026-12-01'
const LAST = '2026-12-03'
const NAMES = [
  'forecast_three_days_defaults',
  'forecast_efficiency_050',
  'forecast_efficiency_zero',
  'forecast_target_90_in_20',
  'forecast_erlang_c',
  'forecast_patience_60',
  'staffing_erlang_c',
  'planned_defaults',
  'planned_erlang_c',
]
const DEFAULT_OUT = 'tests/server/forecast/fixtures/SYNTHETIC-legacy-golden.json'
const MAX_BYTES = 400 * 1024

const { values } = parseArgs({
  options: { db: { type: 'string' }, golden: { type: 'string' }, out: { type: 'string' } },
})
if (!values.db || !values.golden) {
  console.error(
    'usage: node scripts/parity/make-fixture.mjs --db <file> --golden <dir> [--out <file>]'
  )
  process.exit(2)
}

const goldenDir = resolve(values.golden)
const requests = JSON.parse(readFileSync(join(dirname(goldenDir), 'requests.json'), 'utf8'))
const goldens = NAMES.map((name) => {
  const request = requests.find((r) => r.name === name)
  if (!request) throw new Error(`requests.json has no ${name}`)
  const range = request.params ?? request.json
  if (range.start !== FIRST || range.end !== LAST) {
    throw new Error(`${name} asks for ${range.start}..${range.end}, not ${FIRST}..${LAST}`)
  }
  const answer = JSON.parse(readFileSync(join(goldenDir, `${name}.json`), 'utf8'))
  return { name, request, status: answer.status, body: answer.body }
})

const db = new Database(values.db, { readonly: true, fileMustExist: true })
const state = db.prepare('SELECT * FROM forecast_state WHERE id = 1').get()
if (!state) throw new Error(`${values.db} has no forecast_state row`)
const tables = {
  forecast_state: [state],
  forecast_runs: db.prepare('SELECT * FROM forecast_runs WHERE id = ?').all(state.run_id),
  model_artifacts: db
    .prepare(
      `SELECT id, run_id, created_at, model_sha256, '' AS model_text, metadata_json, train_start,
              train_end, train_rows FROM model_artifacts WHERE id = ?`
    )
    .all(state.model_id),
  data_state: db.prepare('SELECT * FROM data_state').all(),
  holidays: db.prepare('SELECT * FROM holidays ORDER BY holiday_date').all(),
  forecast_hours: db
    .prepare('SELECT * FROM forecast_hours WHERE date BETWEEN ? AND ? ORDER BY date, hour')
    .all(FIRST, LAST),
  forecast_cells: db.prepare('SELECT * FROM forecast_cells ORDER BY recency, dow, hour').all(),
}
db.close()

const fixture = {
  note: NOTE,
  made_by:
    'scripts/parity/make-fixture.mjs from a legacy_export.py database (state B) and golden/b',
  today: '2026-11-19',
  data_source_kind: 'synthetic',
  tables,
  goldens,
}
const text = `${JSON.stringify(fixture)}\n`
if (Buffer.byteLength(text) > MAX_BYTES) {
  throw new Error(`fixture is ${Buffer.byteLength(text)} bytes; the limit is ${MAX_BYTES}`)
}
const out = resolve(values.out ?? DEFAULT_OUT)
writeFileSync(out, text)
console.log(`wrote ${out} (${Buffer.byteLength(text)} bytes, ${goldens.length} goldens)`)
