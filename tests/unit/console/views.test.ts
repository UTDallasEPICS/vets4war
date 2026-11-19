// Chart data, the one-day board's row specs and the text helpers of the console.
import { describe, it, expect } from 'vitest'
import {
  computeHours,
  rosterOutcome,
  summarize,
  createPlannedStore,
  judgeRoster,
  rollupShifts,
} from '../../../app/utils/console/logic'
import { daySplit, outcome, share, shiftSplit, topOf } from '../../../app/utils/console/charts'
import { atRoster, focusPct, misses, rowSpecs, whole } from '../../../app/utils/console/dayfocus'
import {
  clampInt,
  clampTenth,
  formatDurationUi,
  isoDate,
  localDate,
  pad2,
  pct,
  verdictClass,
  verdictShort,
} from '../../../app/utils/console/format'
import { fakeStorage, sampleWeek, SAMPLE_CONTROLS as c } from './fixtures'

const { hours, days } = sampleWeek()
const computed = computeHours(hours, c)
const roster = { Overnight: 4, Day: 4, Evening: 6 }

describe('charts', () => {
  it('outcome pairs the roster with the recommendation', () => {
    const o = outcome(computed, roster, c)
    expect(o.calls).toBeCloseTo(summarize(computed).calls, 12)
    expect(o.roster).toBe(rosterOutcome(computed, roster, c)!.abandoned)
    expect(o.recommended).toBe(summarize(computed).abandoned)
    expect(outcome(computed, roster, { ...c, efficiency: 0 }).roster).toBeNull()
  })

  it('the shift split adds up to the window', () => {
    const rows = shiftSplit(computed, roster, c)
    expect(rows.map((r) => r.name)).toEqual(['Overnight', 'Day', 'Evening'])
    const sum = rows.reduce((a, r) => a + r.roster!, 0)
    expect(sum).toBeCloseTo(rosterOutcome(computed, roster, c)!.abandoned, 9)
  })

  it('the day split has one row per day and adds up too', () => {
    const rows = daySplit(days, computed, roster, c)
    expect(rows.map((r) => r.date)).toEqual(days.map((d) => d.date))
    expect(rows.reduce((a, r) => a + r.recommended!, 0)).toBeCloseTo(
      summarize(computed).abandoned!,
      9
    )
    // a day with no hours has nothing to show
    const empty = daySplit([{ date: '2027-01-01' }], computed, roster, c)[0]!
    expect(empty).toEqual({ date: '2027-01-01', calls: 0, roster: null, recommended: null })
  })

  it('topOf and share scale both series on one axis', () => {
    expect(
      topOf([
        { roster: 3, recommended: 5 },
        { roster: null, recommended: 4 },
      ])
    ).toBe(5)
    expect(topOf([])).toBe(0)
    expect(share(2.5, 5)).toBe('50.0%')
    expect(share(null, 5)).toBe('0%')
    expect(share(3, 0)).toBe('0%')
  })
})

describe('one-day board', () => {
  const h = computed.find((x) => x.date === '2026-10-05' && x.hour === 20)!

  it('atRoster runs the roster number of the hour’s tour', () => {
    const own = atRoster(h, roster, c)
    expect(own.staff).toBe(6)
    expect(own.effective_agents).toBe(Math.floor(6 * c.efficiency))
  })

  it('misses only a known level below the target', () => {
    expect(misses(0.79, c)).toBe(true)
    expect(misses(0.8, c)).toBe(false)
    expect(misses(null, c)).toBe(false)
  })

  it('has the old rows in the old order', () => {
    const specs = rowSpecs(c)
    expect(specs.map((s) => ('section' in s ? `# ${s.section}` : s.label))).toEqual([
      '# Call load',
      'Real calls',
      'Talk time, minutes',
      'Average call, minutes',
      '# As the grid recommends',
      'People to schedule',
      'On phones after efficiency',
      'Answered within 30 s',
      'Hang-ups',
      '# With your roster',
      'People on shift',
      'On phones after efficiency',
      'Answered within 30 s',
      'Hang-ups',
    ])
    const own = atRoster(h, roster, c)
    const cells = specs.flatMap((s) => ('cell' in s ? [s.cell(h, own)] : []))
    expect(cells[0]).toEqual({ text: h.predicted_real_calls.toFixed(1) })
    expect(cells[3]).toEqual({ text: String(h.staff_to_schedule), cls: `staff cap-${h.cap_state}` })
    expect(cells[7]).toEqual({ text: '6', cls: 'staff own' })
  })

  it('formats percentages and whole numbers with a dash for unknowns', () => {
    expect(focusPct(0.805)).toBe('81%')
    expect(focusPct(null)).toBe('-')
    expect(whole(0)).toBe('0')
    expect(whole(undefined)).toBe('-')
  })
})

describe('format helpers', () => {
  it('pad, percent and durations', () => {
    expect(pad2(7)).toBe('07')
    expect(pct(0.8156)).toBe('82%')
    expect(pct(0.8156, 1)).toBe('81.6%')
    expect(formatDurationUi(29)).toBe('0m')
    expect(formatDurationUi(30)).toBe('1m')
    expect(formatDurationUi(152280)).toBe('42h 18m')
    expect(formatDurationUi(3600 * 1234)).toBe(`${(1234).toLocaleString()}h 0m`)
  })

  it('dates are local calendar days', () => {
    expect(isoDate(localDate('2026-11-19'))).toBe('2026-11-19')
    expect(localDate('2026-02-01').getDate()).toBe(1)
  })

  it('verdict labels and classes', () => {
    expect(verdictShort('understaffed')).toBe('Under')
    expect(verdictShort('exceeds capacity')).toBe('Exceeds cap')
    expect(verdictShort('something')).toBe('something')
    expect(verdictClass('on target')).toBe('v-on-target')
    expect(verdictClass(null)).toBe('')
  })

  it('clamps like the old controls', () => {
    expect(clampInt('12', 0, 10, 4)).toBe(10)
    expect(clampInt('2.6', 0, 10, 4)).toBe(3)
    expect(clampInt('abc', 0, 10, 4)).toBe(4)
    expect(clampTenth('65.66', 0, 100, 65.6)).toBe(65.7)
    expect(clampTenth('', 0, 100, 65.6)).toBe(65.6)
    expect(clampTenth('120', 0, 100, 65.6)).toBe(100)
  })

  it('a judged week rolls up without error', () => {
    const j = judgeRoster(rollupShifts(days, computed), createPlannedStore(fakeStorage()), c)
    expect(j).toHaveLength(7)
  })
})
