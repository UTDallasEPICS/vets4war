import { defineEventHandler } from 'h3'
import { easternToday } from '#shared/utils/dates'
import { db } from '../utils/db'
import { env } from '../utils/env'
import { readJsonBody } from '../utils/http'
import { postPlanned } from '../utils/forecast/service'
import { requireUser } from '../utils/session'

// POST /api/planned: a supervisor's roster judged against the forecast.
export default defineEventHandler(async (event) => {
  requireUser(event)
  const body = await readJsonBody(event)
  return postPlanned(db, { dataSourceKind: env.V4W_DATA_SOURCE, today: easternToday() }, body)
})
