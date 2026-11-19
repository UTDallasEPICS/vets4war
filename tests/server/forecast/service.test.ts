import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../../../server/db/schema'
import {
  getForecast,
  getModel,
  getStaffing,
  getStatus,
  postPlanned,
} from '../../../server/utils/forecast/service'
import { createTestDb } from '../../helpers/db'
import { AHT, METADATA, PATIENCE, QUICK, REAL_SHARE, RUNTIME, caught, rejected, seedForecast } from './helpers'

// The key sets final-main's tests/test_api.py pinned.
const HOUR_KEYS = [
  'date',
  'hour',
  'predicted_calls',
  'aht_sec',
  'load_erlangs',
  'agents_required',
  'staff_to_schedule',
  'effective_agents',
  'service_level_delivered',
  'over_cap',
  'implausible',
  'reason',
  'expected_talk_sec',
  'expected_talk',
  'abandon_share',
  'predicted_real_calls',
]
const DAY_KEYS = [
  'date',
  'is_weekend',
  'holiday',
  'predicted_calls',
  'shifts',
  'expected_talk_sec',
  'expected_talk',
]
const WINDOW_KEYS = [
  'start',
  'end',
  'expected_calls',
  'expected_talk_sec',
  'expected_talk',
  'mean_aht_sec',
  'expected_abandoned_calls',
  'abandon_share',
  'expected_abandoned_one_fewer',
  'recency',
  'recency_effect_pct',
  'caveat',
]
const SOURCE_KEYS = ['kind', 'label', 'start', 'end']
const SHIFT_KEYS = [
  'predicted_calls',
  'agents_required',
  'staff_needed',
  'capped',
  'service_level_delivered',
  'abandon_share',
]
const PLANNED_KEYS = [
  'date',
  'shift',
  'planned',
  'recommended',
  'delta',
  'verdict',
  'effective_agents',
  'cap',
  'service_level_at_planned',
  'abandon_share_at_planned',
]
const sorted = (keys: string[]) => [...keys].sort()
const THREE_DAYS = { start: '2026-12-01', end: '2026-12-03' }
const VIEWER = { email: 'v@example.org', name: 'v', role: 'viewer' as const }

function seeded() {
  const { db } = createTestDb()
  seedForecast(db)
  return db
}

describe('forecast service without a forecast', () => {
  it('answers 503 no_forecast on the three forecast routes', async () => {
    const { db } = createTestDb()
    for (const call of [
      () => getForecast(db, RUNTIME, THREE_DAYS),
      () => getStaffing(db, RUNTIME, THREE_DAYS),
      () => postPlanned(db, RUNTIME, { ...THREE_DAYS, planned: [] }),
    ]) {
      const error = await rejected(call)
      expect(error.statusCode).toBe(503)
      expect(error.data.code).toBe('no_forecast')
      expect(error.message).toBe(
        'No forecast yet. An admin needs to load call data and run a retrain.'
      )
    }
  })

  it('still validates before it looks for a forecast', async () => {
    const { db } = createTestDb()
    expect((await rejected(() => getForecast(db, RUNTIME, { efficiency: '2' }))).statusCode).toBe(422)
    expect(
      (await rejected(() => getForecast(db, RUNTIME, { start: '2026-12-03', end: '2026-12-01' }))).statusCode
    ).toBe(400)
  })

  it('answers /api/model with 404 not_found', async () => {
    const { db } = createTestDb()
    const error = caught(() => getModel(db, RUNTIME))
    expect(error.statusCode).toBe(404)
    expect(error.data.code).toBe('not_found')
    expect(error.message).toBe('No model yet. An admin needs to load call data and run a retrain.')
  })

  it('reports status with nothing served', async () => {
    const { db } = createTestDb()
    expect(getStatus(db, RUNTIME, VIEWER)).toEqual({
      viewer: VIEWER,
      data_source: { kind: 'synthetic', label: 'Synthetic data' },
      forecast: null,
      model: null,
      run: null,
    })
  })
})

describe('forecast service on a stored forecast', () => {
  // Review finding W2-2: the Erlang chain runs on the server's one thread; a long range
  // must give the event loop back between days instead of holding it to the end.
  it('lets other work run while a long range is computed', async () => {
    const db = seeded()
    const order: string[] = []
    setImmediate(() => order.push('other work'))
    await getForecast(db, RUNTIME, { start: '2026-11-01', end: '2026-12-31' })
    order.push('forecast done')
    expect(order).toEqual(['other work', 'forecast done'])
  })

  it('refuses dates outside the horizon with the horizon in data', async () => {
    const db = seeded()
    const error = await rejected(() => getForecast(db, RUNTIME, { start: '2026-12-30', end: '2027-01-02' }))
    expect(error.statusCode).toBe(400)
    expect(error.data).toEqual({
      code: 'outside_horizon',
      horizon: { start: '2026-11-01', end: '2026-12-31' },
    })
    expect(error.message).toBe('The forecast covers 2026-11-01 to 2026-12-31.')
    expect((await rejected(() => getStaffing(db, RUNTIME, { start: '2026-10-31', end: '2026-11-01' }))).data.code).toBe(
      'outside_horizon'
    )
  })

  it('answers 500 when a stored day is not whole', async () => {
    const db = seeded()
    db.delete(schema.forecastHours)
      .where(eq(schema.forecastHours.date, '2026-12-02'))
      .run()
    const error = await rejected(() => getForecast(db, RUNTIME, THREE_DAYS))
    expect(error.statusCode).toBe(500)
    expect(error.data.code).toBe('internal')
    expect(error.message).toBe('The stored forecast is incomplete; run a retrain.')
  })

  it('answers 500 when cells are missing', async () => {
    const { db } = createTestDb()
    seedForecast(db, { skipCells: true })
    expect((await rejected(() => getForecast(db, RUNTIME, THREE_DAYS))).statusCode).toBe(500)
  })

  it('gives 72 hours and 3 days with exactly the documented keys', async () => {
    const body = await getForecast(seeded(), RUNTIME, { ...THREE_DAYS, efficiency: '0.65' })
    expect(Object.keys(body)).toEqual([
      'params',
      'data_source',
      'holiday_coverage',
      'hours',
      'days',
      'window',
      'quick_hangups',
    ])
    expect(body.hours).toHaveLength(72)
    expect(body.days.map((d) => d.date)).toEqual(['2026-12-01', '2026-12-02', '2026-12-03'])
    for (const h of body.hours) expect(sorted(Object.keys(h))).toEqual(sorted(HOUR_KEYS))
    for (const d of body.days) {
      expect(sorted(Object.keys(d))).toEqual(sorted(DAY_KEYS))
      expect(Object.keys(d.shifts)).toEqual(['Overnight', 'Day', 'Evening'])
      for (const s of Object.values(d.shifts)) expect(sorted(Object.keys(s!))).toEqual(sorted(SHIFT_KEYS))
    }
    expect(sorted(Object.keys(body.window))).toEqual(sorted(WINDOW_KEYS))
    expect(sorted(Object.keys(body.data_source))).toEqual(sorted(SOURCE_KEYS))
    expect(body.data_source).toEqual({
      kind: 'synthetic',
      label: 'Synthetic data',
      start: '2021-01-01',
      end: '2026-11-15',
    })
    expect(body.quick_hangups).toEqual(QUICK)
    expect(body.holiday_coverage).toEqual({
      last_known_holiday: '2027-12-25',
      covered: true,
      message: null,
    })
  })

  it('keeps the hand-traceable chain of every hour', async () => {
    const body = await getForecast(seeded(), RUNTIME, { ...THREE_DAYS, efficiency: '0.65' })
    for (const h of body.hours) {
      expect(h.aht_sec).toBe(AHT.weighted)
      expect(h.predicted_real_calls).toBeCloseTo(h.predicted_calls * REAL_SHARE, 12)
      expect(h.load_erlangs).toBeCloseTo((h.predicted_calls * h.aht_sec) / 3600, 9)
      expect(h.staff_to_schedule).toBe(Math.ceil(h.agents_required / 0.65))
      expect(h.effective_agents).toBe(Math.floor((h.staff_to_schedule as number) * 0.65))
      expect(h.expected_talk_sec).toBeCloseTo(h.load_erlangs * 3600, 6)
    }
    const window = body.window
    expect(window.expected_calls).toBeCloseTo(3 * (23 * 10 + 12), 9)
    expect(window.mean_aht_sec).toBeCloseTo(AHT.weighted, 9)
    expect(window.recency_effect_pct).toBeCloseTo((AHT.weighted / AHT.equal - 1) * 100, 9)
  })

  it('echoes the parameters it used, with the estimated patience by default', async () => {
    const db = seeded()
    expect((await getForecast(db, RUNTIME, THREE_DAYS)).params).toEqual({
      ...THREE_DAYS,
      efficiency: 0.65625,
      target_pct: 0.8,
      target_sec: 30,
      queue_model: 'erlang_a',
      patience_sec: PATIENCE.sec,
      patience_source: {
        kind: 'estimated',
        n_abandoned: PATIENCE.nAbandoned,
        n_calls: PATIENCE.nCalls,
      },
      recency: 'weighted',
      include_holidays: true,
    })
    const override = (await getForecast(db, RUNTIME, { ...THREE_DAYS, patience_sec: '60' })).params
    expect([override.patience_sec, override.patience_source]).toEqual([60, { kind: 'override' }])
    const c = await getForecast(db, RUNTIME, { ...THREE_DAYS, queue_model: 'erlang_c', patience_sec: '60' })
    expect([c.params.patience_sec, c.params.patience_source]).toEqual([null, null])
    expect(c.hours.every((h) => h.abandon_share === null)).toBe(true)
    expect(c.window.expected_abandoned_one_fewer).toBeNull()
  })

  it('reads the no-holidays column when include_holidays=false', async () => {
    const db = seeded()
    const withH = await getForecast(db, RUNTIME, THREE_DAYS)
    const without = await getForecast(db, RUNTIME, { ...THREE_DAYS, include_holidays: 'false' })
    expect(withH.hours[12]!.predicted_calls).toBe(12)
    expect(without.hours[12]!.predicted_calls).toBe(10)
    expect(without.params.include_holidays).toBe(false)
  })

  it('reads a different cell table for each recency', async () => {
    const db = seeded()
    for (const recency of ['equal', 'weighted', 'recent'] as const) {
      const body = await getForecast(db, RUNTIME, { ...THREE_DAYS, recency })
      expect(body.hours[0]!.aht_sec).toBe(AHT[recency])
      expect(body.window.recency).toBe(recency)
    }
    expect((await getForecast(db, RUNTIME, { ...THREE_DAYS, recency: 'equal' })).window.recency_effect_pct).toBe(0)
  })

  it('names the holiday of a date and reports a calendar that ends too early', async () => {
    const db = seeded()
    const body = await getForecast(db, RUNTIME, { start: '2026-12-24', end: '2026-12-26' })
    expect(body.days.map((d) => d.holiday)).toEqual([null, 'Christmas Day', null])
    const { db: short } = createTestDb()
    seedForecast(short, { holidays: [['2026-11-26', 'Thanksgiving']] })
    const coverage = (await getForecast(short, RUNTIME, THREE_DAYS)).holiday_coverage
    expect(coverage.covered).toBe(false)
    expect(coverage.message).toContain('Holiday calendar ends 2026-11-26.')
  })

  it('serves the same days on /api/staffing', async () => {
    const db = seeded()
    const forecast = await getForecast(db, RUNTIME, THREE_DAYS)
    const staffing = await getStaffing(db, RUNTIME, THREE_DAYS)
    expect(Object.keys(staffing)).toEqual(['params', 'data_source', 'holiday_coverage', 'days'])
    expect(staffing.days).toEqual(
      forecast.days.map((d) => ({ date: d.date, predicted_calls: d.predicted_calls, shifts: d.shifts }))
    )
  })

  it('judges a roster on /api/planned', async () => {
    const db = seeded()
    const forecast = await getForecast(db, RUNTIME, THREE_DAYS)
    const rec = forecast.days[0]!.shifts.Day!.staff_needed as number
    const body = await postPlanned(db, RUNTIME, {
      ...THREE_DAYS,
      planned: [
        { date: '2026-12-01', shift: 'Day', planned: rec },
        { date: '2026-12-01', shift: 'Day', planned: 8 },
      ],
    })
    expect(Object.keys(body)).toEqual(['params', 'data_source', 'shifts'])
    expect(body.shifts.map((s) => sorted(Object.keys(s)))).toEqual([
      sorted(PLANNED_KEYS),
      sorted(PLANNED_KEYS),
    ])
    expect(body.shifts[0]).toMatchObject({ recommended: rec, delta: 0, verdict: 'on target' })
    expect(body.shifts[1]!.verdict).toBe('exceeds capacity')
  })

  it('checks efficiency 0 after the forecast and before the items', async () => {
    const { db } = createTestDb()
    expect(
      (await rejected(() => postPlanned(db, RUNTIME, { ...THREE_DAYS, efficiency: 0, planned: [] }))).statusCode
    ).toBe(503)
    const error = await rejected(() => postPlanned(seeded(), RUNTIME, {
        ...THREE_DAYS,
        efficiency: 0,
        planned: [{ date: '2026-12-09', shift: 'Day', planned: 4 }],
      })
    )
    expect(error.data.code).toBe('efficiency_zero')
  })

  it('serves the model metadata with the data badge', async () => {
    const body = getModel(seeded(), RUNTIME)
    expect(body).toEqual({
      ...METADATA,
      data_source: {
        kind: 'synthetic',
        label: 'Synthetic data',
        start: '2021-01-01',
        end: '2026-11-15',
      },
    })
  })

  it('reports status, and stale once the calls changed', async () => {
    const db = seeded()
    const status = getStatus(db, { ...RUNTIME, dataSourceKind: 'unlabeled' }, VIEWER)
    expect(status.data_source).toEqual({
      kind: 'unlabeled',
      label: 'Data source not set (V4W_DATA_SOURCE)',
    })
    expect(status.forecast).toEqual({
      run_id: 1,
      generated_at: '2026-11-19T00:40:14.000Z',
      horizon_start: '2026-11-01',
      horizon_end: '2026-12-31',
      data_start: '2021-01-01',
      data_end: '2026-11-15',
      calls_count: 1000,
      stale: false,
    })
    expect(status.model).toEqual({
      id: 1,
      created_at: '2026-11-19T00:40:14.000Z',
      train_start: METADATA.train_start,
      train_end: METADATA.train_end,
      train_rows: METADATA.train_rows,
      model_sha256: METADATA.model_sha256,
      label: 'test model',
    })
    expect(status.run).toMatchObject({ id: 1, status: 'succeeded', trigger: 'cli' })

    db.update(schema.dataState).set({ callsRevision: 2 }).where(eq(schema.dataState.id, 1)).run()
    expect(getStatus(db, RUNTIME, VIEWER).forecast?.stale).toBe(true)
    db.delete(schema.dataState).run()
    expect(getStatus(db, RUNTIME, VIEWER).forecast?.stale).toBe(true) // no row = revision 0
  })

  it('prefers the active run over a newer finished one', async () => {
    const db = seeded()
    const now = new Date('2026-11-19T10:00:00Z')
    const queued = db
      .insert(schema.forecastRuns)
      .values({ trigger: 'manual', mode: 'full', status: 'queued', createdAt: now })
      .returning()
      .get()
    db.insert(schema.forecastRuns)
      .values({
        trigger: 'schedule',
        mode: 'full',
        status: 'failed',
        createdAt: new Date('2026-11-19T11:00:00Z'),
      })
      .run()
    expect(getStatus(db, RUNTIME, VIEWER).run?.id).toBe(queued.id)
    db.update(schema.forecastRuns)
      .set({ status: 'succeeded' })
      .where(eq(schema.forecastRuns.id, queued.id))
      .run()
    expect(getStatus(db, RUNTIME, VIEWER).run?.status).toBe('failed')
  })
})
