import { Readable } from 'node:stream'

// The request body of an upload, read up to a limit. A body that declares no size
// (Transfer-Encoding: chunked, as a proxy that streams bodies sends it) is read too, and
// keeping it stops as soon as it passes the limit, so the limit holds without a declared
// Content-Length.
//
// What is left of a refused request is read and dropped, never kept, and the answer
// (null) comes once it is all in, so the client can finish sending and then read the
// refusal. Node closes the connection when a server answers before the request is in,
// and closing it on a client that is still sending makes the system reset it: the
// refusal is lost, and the client, or a proxy in front of the server, sees a dropped
// connection (a proxy answers 502) instead of the 413. Past DISCARD_BYTES more the
// connection is dropped after all.
export const DISCARD_BYTES = 64 * 1024 * 1024

export async function readBodyWithin(
  source: AsyncIterable<Buffer | string>,
  maxBytes: number
): Promise<Buffer | null> {
  if (source instanceof Readable) return readStreamWithin(source, maxBytes)
  const chunks: Buffer[] = []
  let size = 0
  const iterator = source[Symbol.asyncIterator]()
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    const buffer = toBuffer(next.value)
    size += buffer.length
    if (size > maxBytes) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}

const toBuffer = (chunk: Buffer | string) =>
  typeof chunk === 'string' ? Buffer.from(chunk) : chunk

function readStreamWithin(stream: Readable, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const stop = () => {
      stream.off('data', onData)
      stream.off('end', onEnd)
      stream.off('error', onError)
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = toBuffer(chunk)
      size += buffer.length
      if (size <= maxBytes) {
        chunks.push(buffer)
        return
      }
      stop()
      chunks.length = 0
      void discardRest(stream).then(() => resolve(null))
    }
    const onEnd = () => {
      stop()
      resolve(Buffer.concat(chunks, size))
    }
    const onError = (error: Error) => {
      stop()
      reject(error)
    }
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
  })
}

// Resolves once the stream has ended, or is gone (dropped past the cap, or the client
// gave up: that error has nobody left to tell).
function discardRest(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    let dropped = 0
    const drop = (chunk: Buffer | string) => {
      dropped += chunk.length
      if (dropped > DISCARD_BYTES) {
        stream.off('data', drop)
        stream.destroy()
      }
    }
    stream.on('data', drop)
    stream.on('error', () => {})
    stream.once('end', () => resolve())
    stream.once('close', () => resolve())
  })
}
