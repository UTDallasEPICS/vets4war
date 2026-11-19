// The upload route's multipart extractor, on bodies built by the platform's own FormData
// encoder (what a browser sends).
import { describe, it, expect } from 'vitest'
import { filePart } from '../../../server/utils/ingest/multipart'

async function encode(form: FormData): Promise<{ body: Buffer; type: string }> {
  const request = new Request('http://localhost/', { method: 'POST', body: form })
  return {
    body: Buffer.from(await request.arrayBuffer()),
    type: request.headers.get('content-type')!,
  }
}

describe('filePart', () => {
  it('returns the named part byte for byte, with its file name', async () => {
    // Bytes that look like line breaks and delimiters must come through untouched.
    const bytes = Buffer.concat([
      Buffer.from('PK\u0003\u0004\r\n\r\n--'),
      Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)),
      Buffer.from('\r\n--not-the-boundary\r\n'),
    ])
    const form = new FormData()
    form.append('note', 'first')
    form.append('file', new Blob([bytes]), 'SYNTHETIC calls "2026".xlsx')
    form.append('after', 'last')
    const { body, type } = await encode(form)
    const part = filePart(body, type, 'file')
    expect(part?.filename).toBe('SYNTHETIC calls %222026%22.xlsx')
    expect(part?.data.equals(bytes)).toBe(true)
  })

  it('returns null when there is no such part', async () => {
    const form = new FormData()
    form.append('other', new Blob(['x']), 'x.xlsx')
    const { body, type } = await encode(form)
    expect(filePart(body, type, 'file')).toBeNull()
  })

  it('returns null for a body that is not multipart or has no boundary', () => {
    expect(filePart(Buffer.from('{"file":1}'), 'application/json', 'file')).toBeNull()
    expect(filePart(Buffer.from('x'), 'multipart/form-data', 'file')).toBeNull()
  })

  it('reads a hand-written body with a quoted boundary and an empty file', () => {
    const body = Buffer.from(
      'preamble\r\n--b"1\r\nContent-Disposition: form-data; name="file"; filename="a.xlsx"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n\r\n--b"1--\r\n'
    )
    // A quoted boundary may hold characters a bare one may not.
    const part = filePart(
      Buffer.from(body.toString().replaceAll('b"1', 'b:1')),
      'multipart/form-data; boundary="b:1"',
      'file'
    )
    expect(part).toEqual({ filename: 'a.xlsx', data: Buffer.alloc(0) })
  })

  it('returns null for a part that is cut off', async () => {
    const form = new FormData()
    form.append('file', new Blob(['abc']), 'a.xlsx')
    const { body, type } = await encode(form)
    expect(filePart(body.subarray(0, body.length - 20), type, 'file')).toBeNull()
  })
})
