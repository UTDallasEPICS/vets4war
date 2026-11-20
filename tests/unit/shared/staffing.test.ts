// The pure cases of final-main's tests/test_staffing.py and tests/test_caps_and_roster.py,
// re-expressed for the TypeScript port.
import { describe, it, expect } from 'vitest'
import { requiredAgents } from '#shared/utils/erlang'
import {
  DEFAULT_EFFICIENCY,
  EVENING_CAP,
  MAX_PLAUSIBLE_STAFF,
  MAX_STAFF_PER_SHIFT,
  SHIFTS,
  SHIFT_NAMES,
  ZERO_EFFICIENCY_REASON,
  abandonShare,
  capForHour,
  capForShift,
  plannedOutcome,
  schedulePeople,
  serviceLevel,
  shiftOfHour,
  staffForHour,
  verdict,
} from '#shared/utils/staffing'

const CALLS = 5.0 // with AHT 600: load 0.833 erlangs, a typical hour
const AHT = 600
const PATIENCE = 400

describe('schedulePeople', () => {
  it('never leaves fewer than the required agents on inbound, 1% to 100%', () => {
    const failures: number[][] = []
    for (let pct = 1; pct <= 100; pct++) {
      for (let agents = 1; agents <= 20; agents++) {
        const [, effective] = schedulePeople(agents, pct / 100)
        if (effective === null || effective < agents) failures.push([pct, agents])
      }
    }
    expect(failures).toEqual([])
  })

  it('schedules the smallest count that works', () => {
    for (let pct = 1; pct <= 100; pct++) {
      for (let agents = 1; agents <= 20; agents++) {
        const efficiency = pct / 100
        const [scheduled] = schedulePeople(agents, efficiency)
        expect(Math.floor((scheduled! - 1) * efficiency)).toBeLessThan(agents)
      }
    }
  })

  it('rounds up the people and down the effective agents', () => {
    expect(schedulePeople(3, 0.65625)).toEqual([5, 3])
    expect(schedulePeople(4, 0.65)).toEqual([7, 4])
    expect(schedulePeople(3, 0)).toEqual([null, null])
    expect(() => schedulePeople(3, 1.01)).toThrow(RangeError)
    expect(() => schedulePeople(3, -0.01)).toThrow(RangeError)
  })
})

describe('staffForHour', () => {
  it('leaves scheduling undefined at efficiency 0, with the reason', () => {
    const r = staffForHour(CALLS, AHT, 0, 0.8, 30)
    expect(r.agents_required).toBeGreaterThanOrEqual(1)
    expect(r.staff_to_schedule).toBeNull()
    expect(r.effective_agents).toBeNull()
    expect(r.service_level_delivered).toBeNull()
    expect(r.over_cap).toBeNull()
    expect(r.implausible).toBe(false)
    expect(r.reason).toBe(ZERO_EFFICIENCY_REASON)
    expect(r.abandon_share).toBeNull()
  })

  it('returns but flags an implausible number at 1% efficiency', () => {
    const r = staffForHour(CALLS, AHT, 0.01, 0.8, 30)
    expect(r.staff_to_schedule).toBe(Math.ceil(r.agents_required / 0.01))
    expect(r.staff_to_schedule!).toBeGreaterThan(MAX_PLAUSIBLE_STAFF)
    expect(r.implausible).toBe(true)
    expect(r.reason).toContain(String(MAX_PLAUSIBLE_STAFF))
    expect(r.reason).toBe(
      `${r.staff_to_schedule} people in one hour exceeds the plausible bound of 50 for this line; the efficiency input is not actionable`
    )
    expect(r.over_cap).toBe(true)
  })

  it('schedules exactly the required agents at efficiency 1', () => {
    const r = staffForHour(CALLS, AHT, 1, 0.8, 30)
    expect(r.staff_to_schedule).toBe(r.agents_required)
    expect(r.effective_agents).toBe(r.agents_required)
    expect(r.implausible).toBe(false)
    expect(r.reason).toBeNull()
  })

  it.each([-0.01, 1.01])('rejects efficiency %d', (efficiency) => {
    expect(() => staffForHour(CALLS, AHT, efficiency, 0.8, 30)).toThrow(RangeError)
  })

  it('never needs fewer agents for a tighter answer time', () => {
    const byT = Object.fromEntries([20, 30, 45].map((t) => [t, requiredAgents(30, AHT, 0.8, t)]))
    expect(byT[20]).toBeGreaterThanOrEqual(byT[30]!)
    expect(byT[30]).toBeGreaterThanOrEqual(byT[45]!)
    expect(byT[30]).toBe(8)
  })

  it.each([20, 30, 45])('threads target_sec %i through the whole chain', (t) => {
    const r = staffForHour(30, AHT, 0.65, 0.8, t)
    expect(r.agents_required).toBe(requiredAgents(30, AHT, 0.8, t))
    expect(r.service_level_delivered!).toBeGreaterThanOrEqual(0.8)
  })

  it('reports no abandonment under Erlang C', () => {
    const r = staffForHour(CALLS, AHT, 0.65, 0.8, 30)
    expect(r.queue_model).toBe('erlang_c')
    expect(r.patience_sec).toBeNull()
    expect(r.abandon_share).toBeNull()
  })

  it('reports abandonment under Erlang A and meets the target', () => {
    const r = staffForHour(30, AHT, 0.65, 0.8, 30, PATIENCE)
    expect(r.queue_model).toBe('erlang_a')
    expect(r.patience_sec).toBe(PATIENCE)
    expect(r.abandon_share!).toBeGreaterThan(0)
    expect(r.abandon_share!).toBeLessThan(1)
    expect(r.service_level_delivered!).toBeGreaterThanOrEqual(0.8)
    expect(r.abandon_share!).toBeLessThanOrEqual(1 - r.service_level_delivered! + 1e-12)
  })

  it('keeps the queue model at efficiency 0 under Erlang A', () => {
    const r = staffForHour(CALLS, AHT, 0, 0.8, 30, PATIENCE)
    expect(r.staff_to_schedule).toBeNull()
    expect(r.abandon_share).toBeNull()
    expect(r.queue_model).toBe('erlang_a')
  })

  it('flags against the cap it is given', () => {
    const busy = staffForHour(40, 600, 0.65625, 0.8, 30, null, 6)
    expect(busy.over_cap).toBe(busy.staff_to_schedule! > 6)
    expect(staffForHour(40, 600, 0.65625, 0.8, 30, null, 99).over_cap).toBe(false)
    const atDefault = staffForHour(40, 600, 0.65625, 0.8, 30)
    expect(atDefault.over_cap).toBe(atDefault.staff_to_schedule! > MAX_STAFF_PER_SHIFT)
  })
})

describe('shifts and caps', () => {
  it('uses the partner calculator as the default efficiency', () => {
    expect(DEFAULT_EFFICIENCY).toBe(315 / 480)
  })

  it('caps Evening at 6 and the others at 7', () => {
    expect(SHIFT_NAMES).toEqual(['Overnight', 'Day', 'Evening'])
    expect(SHIFTS.map((s) => s.cap)).toEqual([7, 7, EVENING_CAP])
    expect([0, 7, 8, 15, 16, 23].map(capForHour)).toEqual([7, 7, 7, 7, 6, 6])
    expect(capForShift('Evening')).toBe(6)
    expect(capForShift('Day')).toBe(7)
  })

  it('maps hours to the shift whose core contains them', () => {
    expect([0, 8, 16, 23].map(shiftOfHour)).toEqual(['Overnight', 'Day', 'Evening', 'Evening'])
    expect(SHIFTS.map((s) => [s.short, s.span, s.boundary])).toEqual([
      ['O', '00:00 to 08:30', { hour: 8, nextDay: false }],
      ['D', '08:00 to 16:30', { hour: 16, nextDay: false }],
      ['E', '16:00 to 00:30', { hour: 0, nextDay: true }],
    ])
  })

  it('rejects an unknown shift and hour', () => {
    expect(() => capForShift('Lunch' as never)).toThrow(RangeError)
    expect(() => capForHour(24)).toThrow(RangeError)
    expect(() => shiftOfHour(-1)).toThrow(RangeError)
  })
})

describe('verdict', () => {
  it('answers the four cases, capacity first', () => {
    expect(verdict(3, 4)).toBe('understaffed')
    expect(verdict(4, 4)).toBe('on target')
    expect(verdict(5, 4)).toBe('overstaffed')
    expect(verdict(8, 4)).toBe('exceeds capacity')
    expect(verdict(7, 7, capForShift('Evening'))).toBe('exceeds capacity')
    expect(verdict(7, 7, capForShift('Day'))).toBe('on target')
  })
})

describe('plannedOutcome', () => {
  const hour = (calls: number, aht: number) => ({
    load_erlangs: (calls * aht) / 3600,
    aht_sec: aht,
  })

  it('reports the worst hour of the shift', () => {
    const rows = [hour(5, 600), hour(20, 600), hour(10, 600)]
    const out = plannedOutcome(rows, 5, 0.65625, 30, PATIENCE)
    expect(out.effective_agents).toBe(3)
    const levels = rows.map((r) => serviceLevel(3, r.load_erlangs, r.aht_sec, 30, PATIENCE))
    const abandons = rows.map((r) => abandonShare(3, r.load_erlangs, r.aht_sec, 30, PATIENCE)!)
    expect(out.service_level_at_planned).toBe(Math.min(...levels))
    expect(out.service_level_at_planned).toBe(levels[1])
    expect(out.abandon_share_at_planned).toBe(Math.max(...abandons))
  })

  it('has no abandonment under Erlang C', () => {
    expect(plannedOutcome([hour(5, 600)], 4, 0.65625, 30, null).abandon_share_at_planned).toBeNull()
  })

  it('throws like the Python on invalid input', () => {
    expect(() => plannedOutcome([hour(5, 600)], -1, 0.5, 30, null)).toThrow(RangeError)
    expect(() => plannedOutcome([hour(5, 600)], 3, 1.5, 30, null)).toThrow(RangeError)
    expect(() => plannedOutcome([], 3, 0.5, 30, null)).toThrow(RangeError)
  })
})
