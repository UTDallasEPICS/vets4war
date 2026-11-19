// The cases of final-main's tests/test_erlang.py and tests/test_erlang_a.py, re-expressed
// for the TypeScript port. Exact agreement with the Python is tests/parity/staffing.
import { describe, it, expect } from 'vitest'
import { erlangA, erlangC, requiredAgents } from '#shared/utils/erlang'

const AHT = 600
const PATIENCE = 400
const TARGET_SEC = 30
const HUGE_PATIENCE = 1e12 // Erlang A -> Erlang C limit
const LIMIT_TOLERANCE = 1e-6

const erlangCServiceLevel = (agents: number, load: number, aht: number, t: number) =>
  1 - erlangC(agents, load) * Math.exp((-(agents - load) * t) / aht)

describe('erlangC and requiredAgents (Erlang C)', () => {
  it('needs no agents for no calls', () => {
    expect(requiredAgents(0, 600)).toBe(0)
  })

  it('never needs fewer agents for more calls', () => {
    const results = [1, 5, 10, 20, 30, 45, 60, 90, 120].map((v) => requiredAgents(v, 600, 0.8, 30))
    for (let i = 1; i < results.length; i++)
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1]!)
  })

  it('never needs fewer agents for a stricter target', () => {
    const results = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95].map((t) => requiredAgents(30, 600, t, 30))
    for (let i = 1; i < results.length; i++)
      expect(results[i]).toBeGreaterThanOrEqual(results[i - 1]!)
  })

  it.each([
    [1, 0.1],
    [2, 1.5],
    [5, 4.9],
    [6, 5.0],
    [10, 2.0],
    [50, 40.0],
    [3, 3.0], // unstable: agents == load
    [2, 5.0], // unstable: agents < load
    [4, 0.0], // no load
  ])('stays in [0, 1] for %i agents at load %d', (agents, load) => {
    const p = erlangC(agents, load)
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(1)
  })

  it('gives the edge values: no load never waits, an unstable queue always waits', () => {
    expect(erlangC(4, 0)).toBe(0)
    expect(erlangC(3, 3)).toBe(1)
    expect(erlangC(2, 5)).toBe(1)
    expect(erlangC(0, 1)).toBe(1)
  })

  it('needs 8 agents for 30 calls an hour at 10 minutes, 80% in 30 s', () => {
    // load 5.0 erlangs; service level by agents: 6 -> 0.441, 7 -> 0.707, 8 -> 0.856
    expect(requiredAgents(30, 600, 0.8, 30)).toBe(8)
    expect(requiredAgents(30, 600)).toBe(8)
    expect(requiredAgents(30, AHT, 0.8, TARGET_SEC, null)).toBe(8)
  })

  it('throws RangeError on invalid input', () => {
    expect(() => requiredAgents(-1, 600)).toThrow(RangeError)
    expect(() => requiredAgents(5, 0)).toThrow(RangeError)
    expect(() => requiredAgents(5, 600, 0)).toThrow(RangeError)
    expect(() => requiredAgents(5, 600, 1.01)).toThrow(RangeError)
    expect(() => requiredAgents(5, 600, 0.8, -1)).toThrow(RangeError)
    expect(() => requiredAgents(5, 600, 0.8, 30, 0)).toThrow(RangeError)
  })
})

describe('erlangA (M/M/N+M)', () => {
  it.each([
    [2, 0.5],
    [3, 1.5],
    [8, 5.0],
    [12, 10.0],
  ])('approaches Erlang C as patience grows (%i agents, load %d)', (agents, load) => {
    const a = erlangA(agents, load, AHT, HUGE_PATIENCE, TARGET_SEC)
    expect(Math.abs(a.wait_prob - erlangC(agents, load))).toBeLessThan(LIMIT_TOLERANCE)
    expect(
      Math.abs(a.service_level - erlangCServiceLevel(agents, load, AHT, TARGET_SEC))
    ).toBeLessThan(LIMIT_TOLERANCE)
    expect(a.abandon_prob).toBeLessThan(LIMIT_TOLERANCE)
  })

  it.each([
    [1, 0.3],
    [2, 1.5],
    [4, 3.0],
    [6, 5.0],
    [3, 6.0],
  ])('keeps its probabilities consistent (%i agents, load %d)', (agents, load) => {
    const a = erlangA(agents, load, AHT, PATIENCE, TARGET_SEC)
    expect(a.abandon_prob).toBeGreaterThanOrEqual(0)
    expect(a.abandon_prob).toBeLessThanOrEqual(a.wait_prob)
    expect(a.wait_prob).toBeLessThanOrEqual(1)
    expect(a.service_level).toBeGreaterThanOrEqual(0)
    expect(a.service_level).toBeLessThanOrEqual(1)
    expect(a.service_level).toBeLessThanOrEqual(1 - a.abandon_prob + 1e-12)
  })

  it('is monotonic in agents: fewer hang-ups, better service, less waiting', () => {
    const results = Array.from({ length: 14 }, (_, i) =>
      erlangA(i + 1, 5.0, AHT, PATIENCE, TARGET_SEC)
    )
    for (let i = 1; i < results.length; i++) {
      const lower = results[i - 1]!
      const higher = results[i]!
      expect(higher.abandon_prob).toBeLessThanOrEqual(lower.abandon_prob + 1e-12)
      expect(higher.service_level).toBeGreaterThanOrEqual(lower.service_level - 1e-12)
      expect(higher.wait_prob).toBeLessThanOrEqual(lower.wait_prob + 1e-12)
    }
  })

  it('has less patient callers abandon more', () => {
    const patient = erlangA(6, 5.0, AHT, 900, TARGET_SEC)
    const impatient = erlangA(6, 5.0, AHT, 60, TARGET_SEC)
    expect(impatient.abandon_prob).toBeGreaterThan(patient.abandon_prob)
  })

  it('handles the edge cases and rejects invalid input', () => {
    expect(erlangA(4, 0, AHT, PATIENCE, TARGET_SEC)).toEqual({
      wait_prob: 0,
      abandon_prob: 0,
      service_level: 1,
    })
    expect(erlangA(0, 2, AHT, PATIENCE, TARGET_SEC)).toEqual({
      wait_prob: 1,
      abandon_prob: 1,
      service_level: 0,
    })
    expect(() => erlangA(3, 2, AHT, 0, TARGET_SEC)).toThrow(RangeError)
    expect(() => erlangA(3, 2, 0, PATIENCE, TARGET_SEC)).toThrow(RangeError)
  })

  it('finds the smallest agent count that meets the target with patience', () => {
    const n = requiredAgents(30, AHT, 0.8, TARGET_SEC, PATIENCE)
    expect(n).toBeGreaterThanOrEqual(1)
    expect(erlangA(n, 5.0, AHT, PATIENCE, TARGET_SEC).service_level).toBeGreaterThanOrEqual(0.8)
    if (n > 1) {
      expect(erlangA(n - 1, 5.0, AHT, PATIENCE, TARGET_SEC).service_level).toBeLessThan(0.8)
    }
  })
})
