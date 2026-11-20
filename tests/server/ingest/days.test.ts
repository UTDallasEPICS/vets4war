// Day summaries and the per-day plan: what makes two days "the same calls".
import { describe, it, expect } from 'vitest'
import {
  callLine,
  daysWithoutCalls,
  listDays,
  partialEdgeDays,
  planDays,
  summarizeDays,
  type CallValues,
} from '../../../server/utils/ingest/days'

function call(startTs: string, overrides: Partial<CallValues> = {}): CallValues {
  return {
    startTs,
    inQueueSec: 5,
    agentSec: 300,
    abandonSec: 0,
    routingSec: 5,
    abandoned: false,
    ...overrides,
  }
}

const DAY_A = [
  call('2026-10-20T00:05:00'),
  call('2026-10-20T08:00:00', { abandoned: true, agentSec: 0, abandonSec: 40 }),
  call('2026-10-20T23:30:00', { inQueueSec: 12.3456 }),
]

describe('callLine', () => {
  it('writes the fixed text form', () => {
    expect(callLine(call('2026-10-20T08:00:00'))).toBe(
      '2026-10-20T08:00:00|5.000|300.000|0.000|5.000|0'
    )
    expect(callLine(call('2026-10-20T08:00:00', { inQueueSec: 12.3456, abandoned: true }))).toBe(
      '2026-10-20T08:00:00|12.346|300.000|0.000|5.000|1'
    )
  })

  it('writes a missing duration as nothing, so it differs from 0', () => {
    const missing = callLine(call('2026-10-20T08:00:00', { routingSec: null }))
    expect(missing).toBe('2026-10-20T08:00:00|5.000|300.000|0.000||0')
    expect(missing).not.toBe(callLine(call('2026-10-20T08:00:00', { routingSec: 0 })))
  })

  it('writes -0 like 0 and rounds a half to even at three decimals', () => {
    expect(callLine(call('2026-10-20T08:00:00', { inQueueSec: -0 }))).toContain('|0.000|')
    expect(callLine(call('2026-10-20T08:00:00', { inQueueSec: 0.0625 }))).toContain('|0.062|')
  })
})

describe('summarizeDays', () => {
  it('ignores row order', () => {
    const a = summarizeDays(DAY_A)
    const b = summarizeDays([...DAY_A].reverse())
    expect(a).toEqual(b)
    expect(a.get('2026-10-20')!.rows).toBe(3)
    expect(a.get('2026-10-20')!.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a NULL duration gives a different fingerprint from 0', () => {
    const zero = summarizeDays([call('2026-10-20T08:00:00', { agentSec: 0 })])
    const none = summarizeDays([call('2026-10-20T08:00:00', { agentSec: null })])
    expect(zero.get('2026-10-20')!.fingerprint).not.toBe(none.get('2026-10-20')!.fingerprint)
  })

  it('groups by the calendar day of the wall-clock start', () => {
    const days = summarizeDays([call('2026-10-20T23:59:59'), call('2026-10-21T00:00:00')])
    expect([...days.keys()]).toEqual(['2026-10-20', '2026-10-21'])
  })
})

describe('planDays', () => {
  const file = summarizeDays([...DAY_A, call('2026-10-21T10:00:00'), call('2026-10-22T10:00:00')])

  it('new, identical and conflict, oldest first', () => {
    const stored = summarizeDays([
      ...[...DAY_A].reverse(),
      call('2026-10-22T10:00:00', { agentSec: 301 }),
      call('2026-10-23T10:00:00'),
    ])
    expect(planDays(file, stored)).toEqual([
      { day: '2026-10-20', rows: 3, existing_rows: 3, status: 'identical' },
      { day: '2026-10-21', rows: 1, existing_rows: 0, status: 'new' },
      { day: '2026-10-22', rows: 1, existing_rows: 1, status: 'conflict' },
    ])
  })

  it('a day with one call fewer is a conflict', () => {
    const stored = summarizeDays(DAY_A.slice(1))
    expect(planDays(summarizeDays(DAY_A), stored)[0]).toEqual({
      day: '2026-10-20',
      rows: 3,
      existing_rows: 2,
      status: 'conflict',
    })
  })
})

describe('partialEdgeDays', () => {
  it('flags a first day with no call before 03:00 and a last day with none from 21:00', () => {
    const hours = new Map<string, number[]>([
      ['2026-10-20', [3, 4, 22]],
      ['2026-10-21', [0, 12, 23]],
      ['2026-10-22', [0, 1, 20]],
    ])
    expect(partialEdgeDays(hours)).toEqual(['2026-10-20', '2026-10-22'])
  })

  it('accepts whole first and last days', () => {
    const hours = new Map<string, number[]>([
      ['2026-10-20', [2, 21]],
      ['2026-10-21', [0, 21]],
    ])
    expect(partialEdgeDays(hours)).toEqual([])
  })

  it('flags a single day once', () => {
    expect(partialEdgeDays(new Map([['2026-10-20', [5, 6]]]))).toEqual(['2026-10-20'])
  })
})

describe('daysWithoutCalls and listDays', () => {
  it('lists the gaps between the first and the last day', () => {
    expect(daysWithoutCalls(['2026-10-23', '2026-10-20', '2026-10-21'])).toEqual(['2026-10-22'])
    expect(daysWithoutCalls(['2026-10-20'])).toEqual([])
    expect(daysWithoutCalls([])).toEqual([])
  })

  it('lists at most ten days, then how many more', () => {
    const days = Array.from({ length: 12 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
    expect(listDays(days)).toBe(`${days.slice(0, 10).join(', ')} and 2 more`)
    expect(listDays(['2026-10-02', '2026-10-01'])).toBe('2026-10-01, 2026-10-02')
  })
})
