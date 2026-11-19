// GET /api/admin/uploads: the last 50 uploads, newest first.
import { defineEventHandler } from 'h3'
import { db } from '../../../utils/db'
import { listUploads } from '../../../utils/ingest/service'
import { toUploadSummary } from '../../../utils/mappers'
import { requireAdmin } from '../../../utils/session'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return { uploads: listUploads(db).map(toUploadSummary) }
})
