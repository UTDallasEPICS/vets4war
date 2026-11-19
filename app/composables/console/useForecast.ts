import type { ForecastResponse } from '#shared/types/api'

// The console's one request: GET /api/forecast with exactly the old page's parameters.
// The queue model is fixed to Erlang A with the measured caller patience, and handle
// time uses the default recency weighting: those are not controls on the page.
export const QUEUE_MODEL = 'erlang_a'
export const RECENCY = 'weighted'

export interface ForecastQuery {
  start: string
  end: string
  includeHolidays: boolean
  efficiency: number
  targetPct: number
  targetSec: number
}

export function useForecast() {
  function load(q: ForecastQuery): Promise<ForecastResponse> {
    return apiFetch<ForecastResponse>('/api/forecast', {
      query: {
        start: q.start,
        end: q.end,
        queue_model: QUEUE_MODEL,
        recency: RECENCY,
        include_holidays: String(q.includeHolidays),
        efficiency: q.efficiency.toFixed(2),
        target_pct: q.targetPct.toFixed(2),
        target_sec: String(q.targetSec),
      },
    })
  }
  return { load }
}
