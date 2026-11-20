// GET /api/admin/accuracy at the service level, on an in-memory database. The served
// forecast is the test helper's: 10 calls an hour and 12 at noon (242 a day), from a
// model trained on calls through 2026-11-15. Calls are SYNTHETIC, written straight
// into `calls`.
import { beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../../server/db/schema'
import type { AppDb } from '../../../server/utils/db'
import { captureForecastSnapshots } from '../../../server/utils/accuracy/snapshot'
import { parseAccuracyQuery, readAccuracy } from '../../../server/utils/accuracy/report'
import { sqliteOf } from '../../../server/utils/ingest/service'
import { createTestDb } from '../../helpers/db'
import { caught, seedForecast } from '../forecast/helpers'

const SERVED_PER_DAY = 23 * 10 + 12

let db: AppDb
let uploadId: number

function addUpload(): number {
  return db
    .insert(schema.uploads)
    .values({
      source: 'upload',
      status: 'imported',
      filename: 'SYNTHETIC calls.xlsx',
      fileSha256: '00',
      fileBytes: 1,
      uploadedByLabel: 'cli',
      createdAt: new Date('2026-11-19T00:00:00Z'),
    })
    .returning({ id: schema.uploads.id })
    .get().id
}

// `perHour` calls in every hour of the day, or the given count per hour.
function addCalls(date: string, perHour: number | Record<number, number>) {
  const counts =
    typeof perHour === 'number'
      ? Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, perHour]))
      : perHour
  const rows = Object.entries(counts).flatMap(([hour, n]) =>
    Array.from({ length: n }, (_, i) => ({
      startTs: `${date}T${hour.padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
      inQueueSec: 10,
      agentSec: 300,
      abandonSec: 0,
      routingSec: 9,
      abandoned: false,
      uploadId,
    }))
  )
  db.insert(schema.calls).values(rows).run()
}

// Another model artifact, trained through `trainEnd`; returns its id.
function addModel(trainEnd: string): number {
  return db
    .insert(schema.modelArtifacts)
    .values({
      runId: 1,
      createdAt: new Date('2026-11-15T00:00:00Z'),
      modelSha256: 'cd'.repeat(32),
      modelText: 'tree',
      metadata: {} as never,
      trainStart: '2021-01-01T00:00:00',
      trainEnd,
      trainRows: 1,
    })
    .returning({ id: schema.modelArtifacts.id })
    .get().id
}

// A forecast kept at import for every hour of `date` (12 calls an hour), made by `modelId`.
function keepForecast(date: string, modelId: number) {
  db.insert(schema.forecastSnapshots)
    .values(
      Array.from({ length: 24 }, (_, hour) => ({
        date,
        hour,
        predictedCalls: 12,
        modelId,
        runId: 1,
        uploadId,
        capturedAt: new Date('2026-11-16T00:00:00Z'),
      }))
    )
    .run()
}

const report = (query: Record<string, unknown> = {}) => readAccuracy(db, parseAccuracyQuery(query))

beforeEach(() => {
  db = createTestDb().db
  uploadId = addUpload()
})

describe('accuracy report', () => {
  it('scores the days after the model was trained, and lists the ones it saw', () => {
    seedForecast(db)
    addCalls('2026-11-15', 10)
    addCalls('2026-11-16', 11) // 264: 22 over the forecast
    addCalls('2026-11-17', 9) // 216: 26 under

    const answer = report({ start: '2026-11-15', end: '2026-11-17' })

    expect(answer.status).toBe('success')
    expect(answer.period).toEqual({ start: '2026-11-15', end: '2026-11-17' })
    expect(answer.model).toEqual({ id: 1, train_end: '2026-11-15T23:00:00' })
    expect(answer.calls_range).toEqual({ first_day: '2026-11-15', last_day: '2026-11-17' })
    expect(answer.days.map((d) => [d.date, d.source, d.held_out, d.actual_calls])).toEqual([
      ['2026-11-15', 'replay', false, 240],
      ['2026-11-16', 'replay', true, 264],
      ['2026-11-17', 'replay', true, 216],
    ])
    expect(answer.days[1]).toMatchObject({ predicted_calls: SERVED_PER_DAY, error_calls: -22 })
    expect(answer.metrics).toMatchObject({
      days: 2,
      hours: 48,
      actual_calls: 480,
      predicted_calls: 2 * SERVED_PER_DAY,
      daily_total_mae: 24,
      signed_bias: (2 * SERVED_PER_DAY - 480) / 48,
    })
    expect(answer.warnings).toEqual([
      '1 day is in the training data of the model in use (calls through 2026-11-15) and no ' +
        'forecast was kept from before their calls were imported. They are shown but left ' +
        'out of the numbers.',
      '2 days are compared with the forecast in use now. The model had not seen them, but ' +
        'this may not be the forecast that was served before the calls came in.',
    ])
  })

  it('prefers the forecast kept at import, which counts even after a retrain learned the day', () => {
    seedForecast(db)
    addCalls('2026-11-15', 10)
    // Served before the day's calls came: a model trained through the day before.
    keepForecast('2026-11-15', addModel('2026-11-14T23:00:00'))

    const answer = report({ start: '2026-11-15', end: '2026-11-15' })

    expect(answer.status).toBe('success')
    expect(answer.days).toEqual([
      expect.objectContaining({
        source: 'snapshot',
        held_out: true,
        predicted_calls: 288,
        error_calls: 48,
      }),
    ])
    expect(answer.warnings).toEqual([])
  })

  it('does not count a kept forecast whose model had been trained on the day (a gap filled later)', () => {
    seedForecast(db) // model 1, trained through 2026-11-15
    addCalls('2026-11-10', 10)
    addCalls('2026-11-15', 10)
    // An import that filled older gaps kept what model 1 said about days it had seen.
    keepForecast('2026-11-10', 1)
    keepForecast('2026-11-15', 1)

    const answer = report({ start: '2026-11-10', end: '2026-11-15' })

    expect(answer.status).toBe('not_held_out')
    expect(answer.metrics).toBeNull()
    expect(answer.days.map((d) => [d.date, d.source, d.held_out])).toEqual([
      ['2026-11-10', 'snapshot', false],
      ['2026-11-15', 'snapshot', false],
    ])
    expect(answer.warnings).toEqual([
      '2 days are compared with the forecast kept when their calls were imported, but the ' +
        'model that made that forecast had already been trained on them. They are shown but ' +
        'left out of the numbers.',
    ])
  })

  it('does not count a kept forecast whose model is no longer known', () => {
    seedForecast(db)
    addCalls('2026-11-16', 10)
    keepForecast('2026-11-16', 99)
    const [day] = report({ start: '2026-11-16', end: '2026-11-16' }).days
    expect(day).toMatchObject({ source: 'snapshot', held_out: false })
  })

  it('counts calls per hour and takes an hour without calls on a loaded day as zero', () => {
    seedForecast(db)
    addCalls('2026-11-16', { 0: 3, 12: 5, 23: 1 })
    const [day] = report({ start: '2026-11-16', end: '2026-11-16' }).days
    expect(day!.actual_calls).toBe(9)
    // |10-3| + |12-5| + |10-1| + 21 hours * 10
    expect(day!.hourly_mae).toBeCloseTo((7 + 7 + 9 + 210) / 24)
  })

  it('never takes a day without calls for a zero', () => {
    seedForecast(db)
    addCalls('2026-11-16', 10)
    const answer = report({ start: '2026-11-16', end: '2026-11-18' })
    expect(answer.days.map((d) => d.date)).toEqual(['2026-11-16'])
    expect(answer.metrics!.days).toBe(1)
  })

  it('defaults to the two weeks ending on the newest call day', () => {
    seedForecast(db)
    addCalls('2026-11-20', 10)
    expect(report().period).toEqual({ start: '2026-11-07', end: '2026-11-20' })
    expect(report({ start: '2026-11-16' }).period).toEqual({
      start: '2026-11-16',
      end: '2026-11-29',
    })
    expect(report({ end: '2026-11-16' }).period).toEqual({
      start: '2026-11-03',
      end: '2026-11-16',
    })
  })

  it('says not_held_out when every day was in the training data', () => {
    seedForecast(db)
    addCalls('2026-11-14', 10)
    const answer = report({ start: '2026-11-14', end: '2026-11-14' })
    expect(answer.status).toBe('not_held_out')
    expect(answer.metrics).toBeNull()
    expect(answer.days).toHaveLength(1)
  })

  it('says which days with calls have no forecast', () => {
    seedForecast(db, { horizonStart: '2026-11-10' })
    addCalls('2026-11-09', 10)
    addCalls('2026-11-16', 10)
    const answer = report({ start: '2026-11-09', end: '2026-11-16' })
    expect(answer.days.map((d) => d.date)).toEqual(['2026-11-16'])
    expect(answer.warnings).toContain('1 day with calls has no forecast to compare with.')
  })

  it('says no_data without calls, and no_forecast before the first forecast', () => {
    expect(report()).toEqual({
      status: 'no_data',
      period: null,
      calls_range: null,
      model: null,
      days: [],
      metrics: null,
      warnings: [],
    })
    addCalls('2026-11-16', 10)
    const answer = report()
    expect(answer.status).toBe('no_forecast')
    expect(answer.model).toBeNull()
    expect(answer.warnings).toEqual(['1 day with calls has no forecast to compare with.'])
  })

  it('refuses dates that are not dates, an end before the start and a range too long', () => {
    expect(caught(() => report({ start: '2026-02-30', end: 'soon' }))).toMatchObject({
      statusCode: 422,
      data: { code: 'validation', issues: [{ path: 'start' }, { path: 'end' }] },
    })
    expect(caught(() => report({ start: '2026-11-17', end: '2026-11-16' }))).toMatchObject({
      statusCode: 400,
      data: { code: 'end_before_start' },
    })
    expect(caught(() => report({ start: '2025-01-01', end: '2026-11-16' }))).toMatchObject({
      statusCode: 400,
      data: { code: 'range_too_long' },
    })
  })
})

describe('forecast snapshots', () => {
  it('keeps the served hours of the given days, once, with the model and run that made them', () => {
    const { run, model } = seedForecast(db)
    const client = sqliteOf(db)
    expect(captureForecastSnapshots(client, ['2026-11-16', '2026-11-17'], uploadId, 1000)).toBe(48)
    db.update(schema.forecastHours).set({ predictedCalls: 99 }).run()
    // A second capture of a day keeps the first copy.
    expect(captureForecastSnapshots(client, ['2026-11-16'], uploadId, 2000)).toBe(0)
    const kept = db.select().from(schema.forecastSnapshots).all()
    expect(kept).toHaveLength(48)
    expect(kept.find((r) => r.date === '2026-11-16' && r.hour === 12)).toMatchObject({
      predictedCalls: 12,
      modelId: model.id,
      runId: run.id,
      uploadId,
      capturedAt: new Date(1_000_000),
    })
  })

  it('keeps nothing before the first forecast', () => {
    expect(captureForecastSnapshots(sqliteOf(db), ['2026-11-16'], uploadId, 1000)).toBe(0)
  })
})
