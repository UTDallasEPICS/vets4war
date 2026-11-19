// The period report: the report checks of final-main's tests/web_checks.js.
import { describe, it, expect } from 'vitest'
import {
  computeHours,
  createPlannedStore,
  judgeRoster,
  rollupShifts,
  summarize,
} from '../../../app/utils/console/logic'
import { buildReport } from '../../../app/utils/console/report'
import type { ReportInput } from '../../../app/utils/console/report'
import { fakeStorage, sampleWeek, SAMPLE_CONTROLS as c } from './fixtures'

const { hours, days } = sampleWeek()
const computed = computeHours(hours, c)
const judged = judgeRoster(rollupShifts(days, computed), createPlannedStore(fakeStorage()), c)
const input: ReportInput = {
  start: '2026-10-05',
  end: '2026-10-11',
  settings: { efficiencyPct: 65, slPct: 80, targetSec: 30, patienceSec: 256 },
  sourceLabel: 'Partner data <test>',
  caveat: 'Forecast caveat.',
  generatedAt: '2026-10-18 12:00',
  hours: computed,
  days: judged,
}
const total = (html: string, name: string) =>
  (html.match(new RegExp(`data-total="${name}">([^<]*)<`)) || [])[1]

describe('buildReport', () => {
  const report = buildReport(input)
  const s = summarize(computed)

  it('is a document covering exactly the selected window, one row per day', () => {
    expect(report.startsWith('<!doctype html>')).toBe(true)
    expect(report.includes('2026-10-05') && report.includes('2026-10-11')).toBe(true)
    expect((report.match(/data-day="/g) || []).length).toBe(7)
    expect(report).toContain('Test Day')
    expect(report).toContain('generated 2026-10-18 12:00')
  })

  it('totals equal the page summary', () => {
    expect(total(report, 'calls')).toBe(Math.round(s.calls).toLocaleString('en-US'))
    expect(total(report, 'person-hours')).toBe(s.personHours!.toLocaleString('en-US'))
  })

  it('escapes text from the server', () => {
    expect(report).toContain('Partner data &lt;test&gt;')
    expect(report).not.toContain('<test>')
  })

  it('shows undefined staffing as a dash', () => {
    const zero = { ...c, efficiency: 0 }
    const zeroHours = computeHours(hours, zero)
    const zeroDays = judgeRoster(
      rollupShifts(days, zeroHours),
      createPlannedStore(fakeStorage()),
      zero
    )
    const html = buildReport({
      ...input,
      settings: { ...input.settings, efficiencyPct: 0 },
      hours: zeroHours,
      days: zeroDays,
    })
    expect(total(html, 'person-hours')).toBe('-')
    expect(html).toContain('Undefined at 0% efficiency')
  })

  it('marks a planned number and its verdict', () => {
    const store = createPlannedStore(fakeStorage())
    store.set('2026-10-05', 'Day', 9)
    const planned = judgeRoster(rollupShifts(days, computed), store, c)
    const html = buildReport({ ...input, days: planned })
    expect(html).toContain('9 planned<br><small>')
    expect(html).toContain('exceeds capacity</small>')
  })

  it('refuses an empty window', () => {
    expect(() => buildReport({ ...input, hours: [], days: [] })).toThrow(
      'no forecast hours in the selected period'
    )
    expect(() => buildReport({ ...input, days: [] })).toThrow(
      'no forecast days in the selected period'
    )
  })
})
