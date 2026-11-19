import { defineEventHandler } from 'h3'
import { easternToday } from '#shared/utils/dates'
import { db } from '../utils/db'
import { env } from '../utils/env'
import { getModel } from '../utils/forecast/service'
import { requireUser } from '../utils/session'

// GET /api/model: the serving model's metadata plus the data badge (PLAN.md 8.2).
export default defineEventHandler((event) => {
  requireUser(event)
  return getModel(db, { dataSourceKind: env.V4W_DATA_SOURCE, today: easternToday() })
})
