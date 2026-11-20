// SYNTHETIC test inputs for the console logic: the sample week of final-main's
// tests/web_checks.js (4 to 9 calls an hour with an evening peak) and an in-memory
// storage.
import type { BaseHour, Controls } from '../../../app/utils/console/logic'

export interface SampleDay {
  date: string
  is_weekend: boolean
  holiday: string | null
}

export function sampleWeek(): { hours: BaseHour[]; days: SampleDay[] } {
  const hours: BaseHour[] = []
  const days: SampleDay[] = []
  for (let d = 0; d < 7; d++) {
    const date = `2026-10-${String(5 + d).padStart(2, '0')}`
    days.push({ date, is_weekend: d >= 5, holiday: d === 3 ? 'Test Day' : null })
    for (let h = 0; h < 24; h++) {
      const shape = 4 + 5 * Math.max(0, Math.sin(((h - 6) / 24) * Math.PI * 2 + 1))
      hours.push({
        date,
        hour: h,
        predicted_calls: shape,
        predicted_real_calls: shape * 0.6,
        aht_sec: 600 + 20 * (h % 5),
      })
    }
  }
  return { hours, days }
}

export const SAMPLE_CONTROLS: Controls = {
  efficiency: 0.65,
  targetPct: 0.8,
  targetSec: 30,
  patienceSec: 256,
}

export function fakeStorage() {
  const data: Record<string, string> = {}
  return {
    data,
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => {
      data[k] = String(v)
    },
  }
}
