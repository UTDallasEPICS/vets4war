// POST /api/admin/uploads/:id/import: bring a checked file into `calls`.
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
  const { upload, run, queued } = importUpload(db, useIngestDeps(), id, parsed.data, user)
  // `queued`: the run returned is the one already in progress; a re-run follows it.
  return { upload: uploadDetail(db, upload), run: run ? toRunSummary(run) : null, queued }
})
