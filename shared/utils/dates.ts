// Calendar arithmetic on 'YYYY-MM-DD' strings. Everything runs in UTC so the server's
// and the browser's local time zones never shift a date.

const DAY_MS = 86_400_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function toUtcMs(iso: string): number {
  const match = ISO_DATE.exec(iso)
  if (!match) throw new RangeError(`not a YYYY-MM-DD date: ${iso}`)
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function fromUtcMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// A real calendar date in the exact form YYYY-MM-DD (2026-02-30 is not).
export function isIsoDate(s: string): boolean {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false
  return fromUtcMs(toUtcMs(s)) === s
}

export function addDays(iso: string, n: number): string {
  return fromUtcMs(toUtcMs(iso) + n * DAY_MS)
}

// b - a in whole days.
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS)
}

// ISO weekday: 1 = Monday .. 7 = Sunday.
export function isoWeekday(iso: string): number {
  const day = new Date(toUtcMs(iso)).getUTCDay()
  return day === 0 ? 7 : day
}

// Every date from start through end, inclusive; empty when end is before start.
export function dateRange(start: string, end: string): string[] {
  const days = daysBetween(start, end)
  return Array.from({ length: Math.max(days + 1, 0) }, (_, i) => addDays(start, i))
}

// Today's date on the partner's line (America/New_York), whatever the server's zone.
export function easternToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
