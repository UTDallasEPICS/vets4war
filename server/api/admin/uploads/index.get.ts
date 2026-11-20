// GET /api/admin/uploads: the last 50 uploads, newest first, and the largest file the
// server accepts (V4W_UPLOAD_MAX_MB), so the page can refuse a file that is too large
// before sending it: a browser does not always see the server's early 413.
import { defineEventHandler } from 'h3'
import { db } from '../../../utils/db'
import { useIngestDeps } from '../../../utils/ingest'
import { listUploads } from '../../../utils/ingest/service'
import { toUploadSummary } from '../../../utils/mappers'
import { requireAdmin } from '../../../utils/session'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return { uploads: listUploads(db).map(toUploadSummary), max_bytes: useIngestDeps().maxBytes }
})
