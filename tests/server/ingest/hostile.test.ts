// Review N-2: the reader's work must be linear in the size of what it reads, whatever a
// workbook holds. Lazy patterns such as <f>[\s\S]*?</f> are quadratic on unclosed tags:
// a 2.7 KB workbook with one row of 200,000 unclosed <f> froze the production server for
// 42.5 s. Each case here is small, hostile, and must end (read or refused) in well under
// a second; the old code took from seconds to minutes on each.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { inspectArchive } from '../../../server/utils/ingest/archive'
import { parseRow, parseWorkbook } from '../../../server/utils/ingest/parser'
import { createPartNormalizer, type PartKind } from '../../../server/utils/ingest/xml'
import { handmadeWorkbook, headerRow } from './fixtures/handmade'
import { withTempDir } from './fixtures/workbooks'
import { buildZip } from './fixtures/zip'

const N = 200_000
// Generous for a loaded machine; the quadratic code needs from ~2 s (N = 40,000) to
// minutes (N = 200,000) for each of these.
const BOUND_MS = 1500

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; value: T | Error }> {
  const started = performance.now()
  let value: T | Error
  try {
    value = await work()
  } catch (error) {
    value = error as Error
  }
  return { ms: performance.now() - started, value }
}

async function normalize(kind: PartKind, text: string) {
  let out = ''
  for await (const piece of Readable.from([text]).pipe(createPartNormalizer(kind))) out += piece
  return out
}

async function readBook(book: Buffer) {
  return withTempDir(async (dir) => {
    const path = join(dir, 'hostile.xlsx')
    await writeFile(path, book)
    return parseWorkbook(path, { maxRows: 1000, onRows: () => {} })
  })
}

const SHEET_HEAD =
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1">'
const SHEET_TAIL = '</c></row></sheetData></worksheet>'

describe('hostile workbooks end quickly (review N-2)', () => {
  it("the reviewer's file: one row of 200,000 unclosed <f>, refused in well under a second", async () => {
    const book = handmadeWorkbook({
      rows: headerRow() + `<row r="2"><c r="B2"><v>1</v>${'<f>'.repeat(N)}</c></row>`,
    })
    const { ms, value } = await timed(() => readBook(book))
    expect(value).toBeInstanceOf(Error)
    expect(ms).toBeLessThan(BOUND_MS)
  })

  it.each([
    ['worksheet', 'unclosed <f>', SHEET_HEAD + '<f>'.repeat(N) + SHEET_TAIL],
    ['worksheet', 'unclosed <is>', SHEET_HEAD + '<is>'.repeat(N) + SHEET_TAIL],
    [
      'worksheet',
      'unclosed <t> in an inline string',
      SHEET_HEAD + '<is>' + '<t>'.repeat(N) + '</is>' + SHEET_TAIL,
    ],
    ['worksheet', '<row without >', SHEET_HEAD + '<row'.repeat(N)],
    ['worksheet', '<c without >', SHEET_HEAD + '<c'.repeat(N)],
    ['worksheet', 'unclosed quotes', SHEET_HEAD + '<c a="'.repeat(N)],
    ['worksheet', 'unclosed comments', SHEET_HEAD + '<!--'.repeat(N)],
    ['worksheet', 'a root that never closes', '<a'.repeat(N)],
    [
      'sharedStrings',
      'unclosed <rPh>',
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>a</t>' +
        '<rPh>'.repeat(N) +
        '</si></sst>',
    ],
  ] as const)('the normaliser on %s with %s', async (kind, _what, text) => {
    const { ms } = await timed(() => normalize(kind, text))
    expect(ms).toBeLessThan(BOUND_MS)
  })

  it.each([
    ['200,000 "<sheet " without >', '<workbook><sheets>' + '<sheet '.repeat(N), '<Relationships>'],
    [
      '200,000 "<Relationship " without >',
      '<workbook><sheets/></workbook>',
      '<Relationships>' + '<Relationship '.repeat(N),
    ],
    [
      'one attribute name a million characters long',
      `<workbook><sheets><sheet ${'a'.repeat(1_000_000)}/></sheets></workbook>`,
      `<Relationships><Relationship ${'a'.repeat(1_000_000)}/></Relationships>`,
    ],
  ])('the archive check on a workbook part with %s', async (_what, workbook, rels) => {
    const book = buildZip([
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: rels },
    ])
    const { ms, value } = await timed(() =>
      withTempDir(async (dir) => {
        const path = join(dir, 'hostile.xlsx')
        await writeFile(path, book)
        return inspectArchive(path)
      })
    )
    expect(value).toBeInstanceOf(Error) // no sheet: not a workbook
    expect(ms).toBeLessThan(BOUND_MS)
  })

  it('a duration of 32,767 digits that ends in a letter is refused at once', () => {
    const started = performance.now()
    const parsed = parseRow({
      Start_Date: '2026-11-10',
      start_time: '08:00:00',
      InQueue: '1'.repeat(32_767) + 'x',
      Agent_Time: 1,
      Abandon_Time: 0,
      Routing_Time: 1,
      Abandon: 'N',
    })
    expect(parsed).toEqual({ problem: 'InQueue is not a number' })
    // the old pattern backtracked through every split of the digits: ~0.4 s per cell
    expect(performance.now() - started).toBeLessThan(50)
  })
})
