// The request body of an upload, read up to a limit. A body that declares no size
// (Transfer-Encoding: chunked, as a proxy that streams bodies sends it) is read too, and
// reading stops as soon as it passes the limit, so the limit holds without a declared
// Content-Length.
//
// Stopping leaves the request as it is rather than destroying it (which leaving a
// `for await` loop would do): a destroyed request takes the connection with it before
// the refusal is sent. The route answers with Connection: close instead, and the
// connection goes once the answer is out.
export async function readBodyWithin(
  source: AsyncIterable<Buffer | string>,
  maxBytes: number
): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  const iterator = source[Symbol.asyncIterator]()
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    const buffer = typeof next.value === 'string' ? Buffer.from(next.value) : next.value
    size += buffer.length
    if (size > maxBytes) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}
