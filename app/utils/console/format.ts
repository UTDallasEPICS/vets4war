// Text helpers of the console (the small helpers at the top of final-main's web/app.js).
// Dates are shown in the browser's own locale, as the old page did; the date strings
// themselves are 'YYYY-MM-DD' read as local midnight.
import type { Verdict } from '#shared/types/api'

const SECONDS_PER_MINUTE = 60

export const pad2 = (n: number | string) => String(n).padStart(2, '0')
export const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
export function localDate(s: string): Date {
  return new Date(s + 'T00:00:00')
}
export function shortDate(s: string): string {
  return localDate(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
export function longDate(s: string): string {
  return localDate(s).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
}
export function dayLabel(s: string): string {
  return localDate(s).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

// app.js formatDuration: like the API's, but hours carry the browser's thousands
// separator (toLocaleString).
export function formatDurationUi(sec: number): string {
  const minutes = Math.floor(sec / SECONDS_PER_MINUTE + 0.5)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h.toLocaleString()}h ${m}m` : `${m}m`
}

const VERDICT_SHORT: Record<Verdict, string> = {
  understaffed: 'Under',
  'on target': 'On target',
  overstaffed: 'Over',
  'exceeds capacity': 'Exceeds cap',
}
export function verdictShort(v: string): string {
  return VERDICT_SHORT[v as Verdict] || v
}
export const verdictClass = (v: string | null | undefined) => (v ? `v-${v.replace(/ /g, '-')}` : '')

export function clampInt<F>(v: unknown, lo: number, hi: number, fallback: F): number | F {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
export function clampTenth<F>(v: unknown, lo: number, hi: number, fallback: F): number | F {
  const n = Math.round(Number(v) * 10) / 10
  return Number.isFinite(n) && String(v).trim() !== '' ? Math.min(hi, Math.max(lo, n)) : fallback
}
