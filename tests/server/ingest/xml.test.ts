// The part normaliser rewrites XML as it streams: whatever the chunk boundaries, the
// output must be the one a single chunk gives.
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  createPartNormalizer,
  PartTooLargeError,
  type PartKind,
} from '../../../server/utils/ingest/xml'

async function run(kind: PartKind, chunks: (string | Buffer)[]): Promise<string> {
  let out = ''
  for await (const piece of Readable.from(chunks).pipe(createPartNormalizer(kind))) out += piece
  return out
}

const SHEET =
  '<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<x:sheetData><x:row><x:c t="inlineStr"><x:is><x:r><x:t>Ab</x:t></x:r><x:r><x:t>andon</x:t></x:r></x:is></x:c>' +
  '<x:c s="1" t="d"><x:v>2026-11-10T00:00:00</x:v></x:c><x:c><x:f>0+0</x:f><x:v>0</x:v></x:c></x:row>' +
  '<x:row r="7"><x:c><x:f t="shared" si="0"/><x:v>5</x:v></x:c><x:c r="D7"><x:v>1</x:v></x:c><x:c/></x:row>' +
  '</x:sheetData></x:worksheet>'

describe('createPartNormalizer', () => {
  it('rewrites a worksheet into the plain shape', async () => {
    expect(await run('worksheet', [SHEET])).toBe(
      '<?xml version="1.0"?><worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">Abandon</t></is></c>' +
        '<c r="B1" s="1" t="str"><v>2026-11-10T00:00:00</v></c><c r="C1"><v>0</v></c></row>' +
        '<row r="7"><c r="A7"><v>5</v></c><c r="D7"><v>1</v></c><c r="E7"/></row>' +
        '</sheetData></worksheet>'
    )
  })

  it('gives the same text whatever the chunk boundaries, also inside a UTF-8 character', async () => {
    const text = SHEET.replace('andon', 'andón')
    const whole = await run('worksheet', [text])
    const bytes = Buffer.from(text)
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(await run('worksheet', [bytes.subarray(0, cut), bytes.subarray(cut)])).toBe(whole)
    }
    const many: Buffer[] = []
    for (let i = 0; i < bytes.length; i += 7) many.push(bytes.subarray(i, i + 7))
    expect(await run('worksheet', many)).toBe(whole)
  })

  it('drops phonetic guides from shared strings and reads date1904="true" as 1', async () => {
    expect(
      await run('sharedStrings', [
        '<sst><si><t>Abandon</t><rPh sb="0" eb="1"><t>ア</t></rPh><phoneticPr fontId="1"/></si></sst>',
      ])
    ).toBe('<sst><si><t>Abandon</t></si></sst>')
    expect(await run('workbook', ['<workbook><workbookPr date1904="true"/></workbook>'])).toBe(
      '<workbook><workbookPr date1904="1"/></workbook>'
    )
  })

  it('refuses a row it would have to hold beyond the limit instead of growing without end', async () => {
    const huge = '<worksheet><sheetData><row r="1">' + '<c><v>1</v></c>'.repeat(1_200_000)
    await expect(run('worksheet', [huge])).rejects.toBeInstanceOf(PartTooLargeError)
  })
})
