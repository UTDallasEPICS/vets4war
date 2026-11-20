import { defineEventHandler, getQuery } from 'h3'
import { easternToday } from '#shared/utils/dates'
import { db } from '../utils/db'
import { env } from '../utils/env'
import { getForecast } from '../utils/forecast/service'
import { requireUser } from '../utils/session'

// GET /api/forecast: hours, shift roll-up per day and the window summary.
export default defineEventHandler((event) => {
  requireUser(event)
  return getForecast(
    db,
    { dataSourceKind: env.V4W_DATA_SOURCE, today: easternToday() },
    getQuery(event)
  )
})
