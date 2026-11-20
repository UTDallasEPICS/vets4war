// The one file part of an upload request. h3's readMultipartFormData walks the body
// byte by byte in JavaScript: on the 15 MB multi-year workbook that held the event loop
// for about 0.9 s, so every other request waited. This finds the boundaries with
// Buffer.indexOf (native) and returns the part's bytes without copying them.

export interface FilePart {
  filename: string
  data: Buffer
}

const CRLF = Buffer.from('\r\n')
const HEADER_END = Buffer.from('\r\n\r\n')

function boundaryOf(contentType: string): string | null {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  return match ? (match[1] ?? match[2] ?? null) : null
}

function parameter(header: string, name: string): string | null {
  const match = new RegExp(`;\\s*${name}="((?:[^"\\\\]|\\\\.)*)"`, 'i').exec(header)
  if (match) return match[1]!.replace(/\\(.)/g, '$1')
  const bare = new RegExp(`;\\s*${name}=([^;\\s]+)`, 'i').exec(header)
  return bare ? bare[1]! : null
}

// The part named `field` of a multipart/form-data body, or null when the body is not
// multipart or has no such part.
export function filePart(body: Buffer, contentType: string, field: string): FilePart | null {
  if (!/^multipart\/form-data\b/i.test(contentType)) return null
  const boundary = boundaryOf(contentType)
  if (!boundary) return null
  const delimiter = Buffer.from(`--${boundary}`)
  const separator = Buffer.concat([CRLF, delimiter])
  let at = body.indexOf(delimiter)
  if (at !== 0 && at !== -1) {
    // A preamble is allowed before the first delimiter; it ends with CRLF.
    at = body.indexOf(separator)
    if (at !== -1) at += CRLF.length
  }
  while (at !== -1) {
    const afterDelimiter = at + delimiter.length
    // "--" right after a delimiter closes the body.
    if (body[afterDelimiter] === 0x2d && body[afterDelimiter + 1] === 0x2d) return null
    const headersStart = afterDelimiter + CRLF.length
    const headersEnd = body.indexOf(HEADER_END, headersStart)
    if (headersEnd === -1) return null
    const next = body.indexOf(separator, headersEnd + HEADER_END.length)
    if (next === -1) return null
    const headers = body.toString('utf8', headersStart, headersEnd).split('\r\n')
    const disposition = headers.find((line) => /^content-disposition:/i.test(line)) ?? ''
    if (parameter(disposition, 'name') === field) {
      return {
        filename: parameter(disposition, 'filename') ?? '',
        data: body.subarray(headersEnd + HEADER_END.length, next),
      }
    }
    at = next + CRLF.length
  }
  return null
}
