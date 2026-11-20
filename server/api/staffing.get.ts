import { defineEventHandler, getQuery } from 'h3'
import { easternToday } from '#shared/utils/dates'
import { db } from '../utils/db'
import { env } from '../utils/env'
import { getStaffing } from '../utils/forecast/service'
import { requireUser } from '../utils/session'

// GET /api/staffing: the daily shift roll-up only.
export default defineEventHandler((event) => {
  requireUser(event)
  return getStaffing(
    db,
    { dataSourceKind: env.V4W_DATA_SOURCE, today: easternToday() },
    getQuery(event)
  )
})
