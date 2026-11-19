// Parity rung P3 in CI: nine answers the OLD final-main API gave on the SYNTHETIC
// reference stack (state B, 2026-12-01..03), replayed against the services on the same
// forecast rows, judged by the same rules as scripts/parity/compare-goldens.mjs.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { H3Error } from 'h3'
import type Database from 'better-sqlite3'
import { compareAnswer, formatDifference } from '../../../scripts/parity/compare.mjs'
import type { AppDb } from '../../../server/utils/db'
import { getForecast, getStaffing, postPlanned } from '../../../server/utils/forecast/service'
import { createTestDb } from '../../helpers/db'

type Row = Record<string, string | number | null>
interface Golden {
  name: string
  request: {
    method: 'GET' | 'POST'
    path: string
    params?: Record<string, string | number>
    json?: unknown
  }
  status: number
  body: unknown
}
interface Fixture {
  note: string
  today: string
  data_source_kind: 'synthetic'
  tables: Record<string, Row[]>
  goldens: Golden[]
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/SYNTHETIC-legacy-golden.json', import.meta.url), 'utf8')
) as Fixture

// Parents first (forecast_state names the run and the model).
const TABLE_ORDER = [
  'forecast_runs',
  'model_artifacts',
  'forecast_state',
  'data_state',
  'holidays',
  'forecast_hours',
  'forecast_cells',
]

function load(sqlite: Database.Database) {
  sqlite.transaction(() => {
    for (const table of TABLE_ORDER) {
      const rows = fixture.tables[table] ?? []
      if (!rows.length) continue
      const columns = Object.keys(rows[0]!)
      const insert = sqlite.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`
      )
      for (const row of rows) insert.run(row)
    }
  })()
}

function answer(db: AppDb, golden: Golden): { status: number; body: unknown } {
  const runtime = { dataSourceKind: fixture.data_source_kind, today: fixture.today }
  const query = Object.fromEntries(
    Object.entries(golden.request.params ?? {}).map(([k, v]) => [k, String(v)])
  )
  try {
    const body =
      golden.request.path === '/api/forecast'
        ? getForecast(db, runtime, query)
        : golden.request.path === '/api/staffing'
          ? getStaffing(db, runtime, query)
          : postPlanned(db, runtime, golden.request.json)
    // What the wire carries: JSON.
    return { status: 200, body: JSON.parse(JSON.stringify(body)) }
  } catch (error) {
    if (error instanceof H3Error) return { status: error.statusCode, body: error.data }
    throw error
  }
}

describe('frozen legacy answers (SYNTHETIC, state B)', () => {
  const { db, sqlite } = createTestDb()
  load(sqlite)

  it('is the small labelled fixture', () => {
    expect(Object.keys(fixture)[0]).toBe('note')
    expect(fixture.note).toBe(
      'SYNTHETIC data. Frozen answers of the final-main API, for regression tests only.'
    )
    expect(fixture.goldens.map((g) => g.name)).toEqual([
      'forecast_three_days_defaults',
      'forecast_efficiency_050',
      'forecast_efficiency_zero',
      'forecast_target_90_in_20',
      'forecast_erlang_c',
      'forecast_patience_60',
      'staffing_erlang_c',
      'planned_defaults',
      'planned_erlang_c',
    ])
  })

  it.each(fixture.goldens.map((g) => [g.name, g] as const))('%s', (_name, golden) => {
    const actual = answer(db, golden)
    const { differences } = compareAnswer(golden, actual, { requestPath: golden.request.path })
    expect(differences.map(formatDifference)).toEqual([])
  })

  it('notices a changed number, key or status', () => {
    const golden = fixture.goldens[0]!
    const actual = answer(db, golden) as { status: number; body: Record<string, unknown> }
    const hours = actual.body.hours as Record<string, unknown>[]
    const changed = structuredClone(actual)
    const first = (changed.body.hours as Record<string, number>[])[0]!
    first.load_erlangs = (hours[0]!.load_erlangs as number) * (1 + 1e-7)
    expect(compareAnswer(golden, changed).differences.map((d) => d.path)).toEqual([
      'hours[0].load_erlangs',
    ])
    const extra = structuredClone(actual)
    ;(extra.body.window as Record<string, unknown>).surprise = 1
    expect(compareAnswer(golden, extra).differences).toHaveLength(1)
    expect(compareAnswer(golden, { status: 400, body: {} }).differences).toHaveLength(1)
  })
})
