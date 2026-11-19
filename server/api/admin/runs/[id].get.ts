// GET /api/admin/runs/:id: one run with its gate table and log tail.
import { defineEventHandler } from 'h3'
import { db } from '../../../utils/db'
import { routeId } from '../../../utils/ingest'
import { toRunDetail } from '../../../utils/mappers'
import { getRun } from '../../../utils/retrain/runner'
import { requireAdmin } from '../../../utils/session'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return { run: toRunDetail(getRun(db, routeId(event, 'run'))) }
})
