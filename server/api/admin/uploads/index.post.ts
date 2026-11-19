// POST /api/admin/uploads: one multipart part named `file` (PLAN.md 8.4). Answers 202
// while the file is read in the background, or 200 with the upload that already holds
// these exact bytes.
import { defineEventHandler, getRequestHeader, setResponseHeader, setResponseStatus } from 'h3'
import { db } from '../../../utils/db'
import { apiError, validationError } from '../../../utils/http'
import { useIngestDeps } from '../../../utils/ingest'
import { readBodyWithin } from '../../../utils/ingest/body'
import { filePart } from '../../../utils/ingest/multipart'
import { receiveUpload } from '../../../utils/ingest/service'
import { toUploadSummary } from '../../../utils/mappers'
import { requireAdmin } from '../../../utils/session'

// Room for the multipart boundaries and part headers around the file itself.
const MULTIPART_OVERHEAD = 64 * 1024

export default defineEventHandler(async (event) => {
  const user = requireAdmin(event)
  const deps = useIngestDeps()

  const limit = Math.floor(deps.maxBytes / (1024 * 1024))
  const tooLarge = () =>
    apiError(
      413,
      'too_large',
      `The file is larger than the upload limit of ${limit} MB. Split it into smaller files (one year per file works).`
    )
  // Refuse by the declared size before reading the body into memory. A body without a
  // declared size (chunked) is read, and refused as soon as it passes the limit.
  const declared = getRequestHeader(event, 'content-length')
  if (declared !== undefined && Number(declared) > deps.maxBytes + MULTIPART_OVERHEAD) {
    throw tooLarge()
  }
  const body = await readBodyWithin(event.node.req, deps.maxBytes + MULTIPART_OVERHEAD)
  if (body === null) {
    setResponseHeader(event, 'Connection', 'close')
    throw tooLarge()
  }
  const file = filePart(body, getRequestHeader(event, 'content-type') ?? '', 'file')
  if (!file) {
    throw validationError([{ path: 'file', message: 'Choose a .xlsx file to upload.' }])
  }

  try {
    const { upload, existing } = await receiveUpload(db, deps, {
      filename: file.filename || 'upload.xlsx',
      data: file.data,
      user: { id: user.id, email: user.email },
    })
    setResponseStatus(event, existing ? 200 : 202)
    return { upload: toUploadSummary(upload) }
  } catch (error) {
    if ((error as { data?: { code?: string } }).data?.code === 'busy') {
      setResponseHeader(event, 'Retry-After', 5)
    }
    throw error
  }
})
