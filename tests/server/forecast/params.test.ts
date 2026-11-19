import { describe, expect, it } from 'vitest'
import { parseForecastQuery, parsePlannedBody } from '../../../server/utils/forecast/params'
import { caught } from './helpers'

const TODAY = '2026-11-19'
const RANGE = { start: '2026-12-01', end: '2026-12-03' }
const ITEM = { date: '2026-12-01', shift: 'Day', planned: 4 }

function issuePaths(fn: () => unknown): string[] {
  const error = caught(fn)
  expect(error.statusCode).toBe(422)
  expect(error.data.code).toBe('validation')
  return (error.data.issues as { path: string }[]).map((i) => i.path)
}

describe('parseForecastQuery', () => {
  it('defaults to today and the next 29 days with final-main controls', () => {
    expect(parseForecastQuery({}, TODAY)).toEqual({
      start: '2026-11-19',
      end: '2026-12-18',
      efficiency: 0.65625,
      targetPct: 0.8,
      targetSec: 30,
      queueModel: 'erlang_a',
      patienceSec: null,
      recency: 'weighted',
      includeHolidays: true,
    })
  })

  it('reads every control from strings', () => {
    const input = parseForecastQuery(
      {
        ...RANGE,
        efficiency: '0.5',
        target_pct: '0.9',
        target_sec: '20',
        queue_model: 'erlang_c',
        patience_sec: '60',
        recency: 'recent',
        include_holidays: 'false',
      },
      TODAY
    )
    expect(input).toEqual({
      ...RANGE,
      efficiency: 0.5,
      targetPct: 0.9,
      targetSec: 20,
      queueModel: 'erlang_c',
      patienceSec: 60,
      recency: 'recent',
      includeHolidays: false,
    })
  })

  it('accepts the edges of every range', () => {
    expect(parseForecastQuery({ ...RANGE, efficiency: '0' }, TODAY).efficiency).toBe(0)
    expect(parseForecastQuery({ ...RANGE, efficiency: '1' }, TODAY).efficiency).toBe(1)
    expect(parseForecastQuery({ ...RANGE, target_sec: '0' }, TODAY).targetSec).toBe(0)
    expect(parseForecastQuery({ ...RANGE, target_sec: '300' }, TODAY).targetSec).toBe(300)
    expect(parseForecastQuery({ ...RANGE, target_sec: '20.5' }, TODAY).targetSec).toBe(20.5)
    expect(parseForecastQuery({ ...RANGE, target_pct: '0.999' }, TODAY).targetPct).toBe(0.999)
    expect(parseForecastQuery({ ...RANGE, target_pct: '0.01' }, TODAY).targetPct).toBe(0.01)
    expect(parseForecastQuery({ ...RANGE, patience_sec: '10' }, TODAY).patienceSec).toBe(10)
    expect(parseForecastQuery({ ...RANGE, patience_sec: '3600' }, TODAY).patienceSec).toBe(3600)
  })

  // Review finding W2-2: outside these bounds one request could cost up to 31 s of CPU
  // per day of range on the server's only thread; W2-1: a target_pct within 2e-16 of 1
  // and a denormal patience ended in a 500.
  it.each([
    ['target_pct', '0.9991', 'must be a number greater than 0 and at most 0.999'],
    ['target_pct', '0.9999999999999999', 'must be a number greater than 0 and at most 0.999'],
    ['target_sec', '300.5', 'must be a number from 0 to 300'],
    ['target_sec', '3600', 'must be a number from 0 to 300'],
    ['patience_sec', '9.99', 'must be a number from 10 to 3600'],
    ['patience_sec', '1', 'must be a number from 10 to 3600'],
    ['patience_sec', '0.000001', 'must be a number from 10 to 3600'],
    ['patience_sec', '1e-320', 'must be a number from 10 to 3600'],
    ['patience_sec', '3600.5', 'must be a number from 10 to 3600'],
    ['patience_sec', '86400', 'must be a number from 10 to 3600'],
  ])('refuses the costly or unreachable %s=%s', (field, value, message) => {
    const error = caught(() => parseForecastQuery({ ...RANGE, [field]: value }, TODAY))
    expect(error.statusCode).toBe(422)
    expect(error.data.issues).toEqual([{ path: field, message }])
    expect(error.message).toBe(`${field}: ${message}`)
  })

  it('applies the same bounds to the /api/planned body', () => {
    const paths = issuePaths(() =>
      parsePlannedBody({
        ...RANGE,
        target_pct: 0.9995,
        target_sec: 301,
        patience_sec: 5,
        planned: [],
      })
    )
    expect(paths).toEqual(['target_pct', 'target_sec', 'patience_sec'])
  })

  it.each([
    ['efficiency', '1.5'],
    ['efficiency', '-0.1'],
    ['target_pct', '0'],
    ['target_pct', '1'],
    ['target_sec', '-1'],
    ['target_sec', '301'],
    ['patience_sec', '0'],
    ['patience_sec', '-5'],
    ['patience_sec', '3601'],
    ['queue_model', 'erlang_b'],
    ['recency', 'latest'],
    ['include_holidays', 'maybe'],
    ['start', '2026-13-01'],
    ['end', '2026-02-30'],
    ['start', '2026-1-01'],
  ])('rejects %s=%s with 422 naming the field', (field, value) => {
    expect(issuePaths(() => parseForecastQuery({ ...RANGE, [field]: value }, TODAY))).toEqual([
      field,
    ])
  })

  it.each(['', ' ', 'abc', 'NaN', 'Infinity', '-Infinity', '0x1', '1e999', '1,5'])(
    'rejects the number %j',
    (value) => {
      expect(issuePaths(() => parseForecastQuery({ ...RANGE, efficiency: value }, TODAY))).toEqual(
        ['efficiency']
      )
    }
  )

  it.each([
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
  ])('reads include_holidays=%s', (value, expected) => {
    expect(parseForecastQuery({ ...RANGE, include_holidays: value }, TODAY).includeHolidays).toBe(
      expected
    )
  })

  it('collects every bad field into one 422', () => {
    const paths = issuePaths(() =>
      parseForecastQuery(
        { start: '2026-13-01', efficiency: '2', target_pct: '1', recency: 'x' },
        TODAY
      )
    )
    expect(paths).toEqual(['start', 'efficiency', 'target_pct', 'recency'])
  })

  it('checks field validity before the range', () => {
    const error = caught(() =>
      parseForecastQuery({ start: '2026-12-03', end: '2026-12-01', efficiency: '2' }, TODAY)
    )
    expect(error.statusCode).toBe(422)
  })

  it('refuses an end before the start with 400 end_before_start', () => {
    const error = caught(() => parseForecastQuery({ start: '2026-12-03', end: '2026-12-01' }, TODAY))
    expect(error.statusCode).toBe(400)
    expect(error.data.code).toBe('end_before_start')
    expect(error.message).toBe('end 2026-12-01 is before start 2026-12-03')
  })

  it('takes a missing end as today + 29 days whatever the start (final-main)', () => {
    const error = caught(() => parseForecastQuery({ start: '2027-01-01' }, TODAY))
    expect(error.data.code).toBe('end_before_start')
    expect(error.message).toBe('end 2026-12-18 is before start 2027-01-01')
  })

  it('allows 366 days and refuses 367 with the exact message', () => {
    expect(parseForecastQuery({ start: '2026-11-20', end: '2027-11-20' }, TODAY).end).toBe(
      '2027-11-20'
    )
    const error = caught(() => parseForecastQuery({ start: '2026-11-20', end: '2027-11-21' }, TODAY))
    expect(error.statusCode).toBe(400)
    expect(error.data.code).toBe('range_too_long')
    expect(error.message).toBe('range is 367 days; maximum is 366')
  })

  it('takes the last value of a repeated parameter', () => {
    expect(parseForecastQuery({ ...RANGE, efficiency: ['0.2', '0.4'] }, TODAY).efficiency).toBe(
      0.4
    )
  })
})

describe('parsePlannedBody', () => {
  it('reads a roster with defaults for the controls', () => {
    const input = parsePlannedBody({ ...RANGE, planned: [ITEM] })
    expect(input).toEqual({
      ...RANGE,
      efficiency: 0.65625,
      targetPct: 0.8,
      targetSec: 30,
      queueModel: 'erlang_a',
      patienceSec: null,
      recency: 'weighted',
      includeHolidays: true,
      planned: [ITEM],
    })
  })

  it('reads every control as JSON values; patience_sec may be null', () => {
    const input = parsePlannedBody({
      ...RANGE,
      efficiency: 0.7,
      target_pct: 0.85,
      target_sec: 20,
      queue_model: 'erlang_c',
      patience_sec: null,
      recency: 'recent',
      include_holidays: false,
      planned: [],
    })
    expect(input).toMatchObject({
      efficiency: 0.7,
      targetPct: 0.85,
      targetSec: 20,
      queueModel: 'erlang_c',
      patienceSec: null,
      recency: 'recent',
      includeHolidays: false,
      planned: [],
    })
  })

  it('requires start, end and planned', () => {
    expect(issuePaths(() => parsePlannedBody({ end: RANGE.end, planned: [] }))).toEqual(['start'])
    expect(issuePaths(() => parsePlannedBody({ start: RANGE.start, planned: [] }))).toEqual([
      'end',
    ])
    expect(issuePaths(() => parsePlannedBody({ ...RANGE }))).toEqual(['planned'])
    expect(issuePaths(() => parsePlannedBody(null))).toEqual([''])
    expect(issuePaths(() => parsePlannedBody([]))).toEqual([''])
  })

  it.each([
    [{ planned: 4.5 }, 'planned.0.planned'],
    [{ planned: -1 }, 'planned.0.planned'],
    [{ planned: 1001 }, 'planned.0.planned'],
    [{ planned: '4' }, 'planned.0.planned'],
    [{ shift: 'Swing' }, 'planned.0.shift'],
    [{ date: '2026-02-30' }, 'planned.0.date'],
  ])('rejects the item %j', (change, path) => {
    expect(issuePaths(() => parsePlannedBody({ ...RANGE, planned: [{ ...ITEM, ...change }] }))).toEqual(
      [path]
    )
  })

  it('accepts planned 0 and 1000', () => {
    const input = parsePlannedBody({
      ...RANGE,
      planned: [
        { ...ITEM, planned: 0 },
        { ...ITEM, planned: 1000 },
      ],
    })
    expect(input.planned.map((p) => p.planned)).toEqual([0, 1000])
  })

  it('allows at most 1098 items', () => {
    const items = (n: number) => Array.from({ length: n }, () => ITEM)
    expect(parsePlannedBody({ ...RANGE, planned: items(1098) }).planned).toHaveLength(1098)
    expect(issuePaths(() => parsePlannedBody({ ...RANGE, planned: items(1099) }))).toEqual([
      'planned',
    ])
  })

  it('rejects mistyped controls together', () => {
    const paths = issuePaths(() =>
      parsePlannedBody({
        ...RANGE,
        efficiency: '0.5',
        target_pct: 1,
        queue_model: 'erlang_b',
        patience_sec: 0,
        include_holidays: 'false',
        planned: [],
      })
    )
    expect(paths).toEqual([
      'efficiency',
      'target_pct',
      'queue_model',
      'patience_sec',
      'include_holidays',
    ])
  })

  it('applies the two range refusals after validation', () => {
    expect(
      caught(() => parsePlannedBody({ start: '2026-12-03', end: '2026-12-01', planned: [] })).data
        .code
    ).toBe('end_before_start')
    expect(
      caught(() => parsePlannedBody({ start: '2026-11-20', end: '2027-11-21', planned: [] })).data
        .code
    ).toBe('range_too_long')
  })
})
