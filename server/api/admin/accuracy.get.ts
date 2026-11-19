// GET /api/admin/accuracy?start=YYYY-MM-DD&end=YYYY-MM-DD: the forecast against the calls
// that came, per day, with the error measures (server/utils/accuracy/report.ts).
import { defineEventHandler, getQuery } from 'h3'
import { parseAccuracyQuery, readAccuracy } from '../../utils/accuracy/report'
import { db } from '../../utils/db'
import { requireAdmin } from '../../utils/session'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return readAccuracy(db, parseAccuracyQuery(getQuery(event)))
})
