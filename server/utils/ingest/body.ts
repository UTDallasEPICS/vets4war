// The request body of an upload, read up to a limit. A body that declares no size
// (Transfer-Encoding: chunked, as a proxy that streams bodies sends it) is read too, and
// reading stops as soon as it passes the limit, so the limit holds without a declared
// Content-Length.
export async function readBodyWithin(
  source: AsyncIterable<Buffer | string>,
  maxBytes: number
): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of source) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > maxBytes) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}
