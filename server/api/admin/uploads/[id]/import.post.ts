// POST /api/admin/uploads/:id/import: bring a checked file into `calls` (PLAN.md 8.4).
import { defineEventHandler, readBody } from 'h3'
import { db } from '../../../../utils/db'
import { issuesFromZod, validationError } from '../../../../utils/http'
import { routeId, useIngestDeps } from '../../../../utils/ingest'
import { importRequestSchema, importUpload, uploadDetail } from '../../../../utils/ingest/service'
import { toRunSummary } from '../../../../utils/mappers'
import { requireAdmin } from '../../../../utils/session'

export default defineEventHandler(async (event) => {
  const user = requireAdmin(event)
  const id = routeId(event, 'upload')
  const parsed = importRequestSchema.safeParse(await readBody(event).catch(() => null))
  if (!parsed.success) throw validationError(issuesFromZod(parsed.error))
  const { upload, run } = importUpload(db, useIngestDeps(), id, parsed.data, user)
  return { upload: uploadDetail(upload), run: run ? toRunSummary(run) : null }
})
