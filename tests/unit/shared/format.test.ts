import { describe, it, expect } from 'vitest'
import { formatDuration, pyRound } from '#shared/utils/format'

describe('formatDuration', () => {
  it('writes hours and minutes, or minutes alone under an hour', () => {
    expect(formatDuration(152280)).toBe('42h 18m')
    expect(formatDuration(18 * 60)).toBe('18m')
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(3600)).toBe('1h 0m')
  })

  it('rounds a half minute up', () => {
    expect(formatDuration(90)).toBe('2m')
    expect(formatDuration(89.9)).toBe('1m')
  })

  it('uses no thousands separator', () => {
    expect(formatDuration(3676418.7)).toBe('1021h 14m')
  })
})

describe('pyRound (Python round)', () => {
  it('rounds from the exact binary value', () => {
    expect(pyRound(2.675, 2)).toBe(2.67) // 2.67499999... in binary
    expect(pyRound(1.005, 2)).toBe(1) // 1.00499999...
    expect(pyRound(50.164999, 2)).toBe(50.16)
    expect(pyRound(50.165001, 2)).toBe(50.17)
  })

  it('sends exact ties to the even digit', () => {
    expect(pyRound(0.125, 2)).toBe(0.12)
    expect(pyRound(0.375, 2)).toBe(0.38)
    expect(pyRound(2.5, 0)).toBe(2)
    expect(pyRound(3.5, 0)).toBe(4)
    expect(pyRound(-0.125, 2)).toBe(-0.12)
  })

  it('leaves values with fewer digits alone', () => {
    expect(pyRound(182.25, 2)).toBe(182.25)
    expect(pyRound(7, 2)).toBe(7)
    expect(pyRound(-3.14159, 3)).toBe(-3.142)
  })
})
