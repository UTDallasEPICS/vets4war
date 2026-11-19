import { describe, it, expect } from 'vitest'
import {
  addDays,
  dateRange,
  daysBetween,
  easternToday,
  isIsoDate,
  isoWeekday,
} from '#shared/utils/dates'

describe('dates', () => {
  it('accepts only real calendar dates in YYYY-MM-DD form', () => {
    expect(isIsoDate('2026-11-19')).toBe(true)
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2027-02-29')).toBe(false)
    expect(isIsoDate('2026-1-01')).toBe(false)
    expect(isIsoDate('2026-11-19T00:00:00')).toBe(false)
    expect(isIsoDate('')).toBe(false)
  })

  it('adds days across a leap day and a year end', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
    expect(addDays('2026-11-19', 29)).toBe('2026-12-18')
  })

  it('counts days between two dates (b - a)', () => {
    expect(daysBetween('2026-11-19', '2026-11-19')).toBe(0)
    expect(daysBetween('2026-11-19', '2026-12-18')).toBe(29)
    expect(daysBetween('2026-12-18', '2026-11-19')).toBe(-29)
    expect(daysBetween('2028-01-01', '2029-01-01')).toBe(366)
    // a DST change in the US does not matter: arithmetic is in UTC
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2)
  })

  it('gives ISO weekdays, Monday = 1', () => {
    expect(isoWeekday('2026-11-19')).toBe(4)
    expect(isoWeekday('2026-11-16')).toBe(1)
    expect(isoWeekday('2026-11-22')).toBe(7)
  })

  it('lists a range inclusively', () => {
    expect(dateRange('2026-12-30', '2027-01-02')).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ])
    expect(dateRange('2026-11-19', '2026-11-19')).toEqual(['2026-11-19'])
    expect(dateRange('2026-11-20', '2026-11-19')).toEqual([])
  })

  it("takes today's date in New York, not UTC", () => {
    expect(easternToday(new Date('2026-11-19T03:30:00Z'))).toBe('2026-11-18')
    expect(easternToday(new Date('2026-11-19T05:30:00Z'))).toBe('2026-11-19')
    expect(easternToday(new Date('2026-07-01T03:59:00Z'))).toBe('2026-06-30')
    expect(easternToday(new Date('2026-07-01T04:00:00Z'))).toBe('2026-07-01')
  })
})
