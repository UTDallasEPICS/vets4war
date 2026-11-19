// The archive check that runs before any worksheet is parsed: what is refused, and the
// sheet names it reads from the workbook part.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { ArchiveError, inspectArchive } from '../../../server/utils/ingest/archive'
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_SHEETS,
  MAX_UNPACKED_BYTES,
} from '../../../server/utils/ingest/limits'
import { buildZip, workbookEntries, type ZipEntry } from './fixtures/zip'
import { HEADER, rawLayout, withTempDir, writeWorkbook } from './fixtures/workbooks'

async function inspectBytes(bytes: Buffer | string) {
  return withTempDir(async (dir) => {
    const path = join(dir, 'file.xlsx')
    await writeFile(path, bytes)
    return inspectArchive(path)
  })
}

async function refusal(bytes: Buffer | string): Promise<{ code: string; message: string }> {
  try {
    await inspectBytes(bytes)
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError)
    const { code, message } = error as ArchiveError
    return { code, message }
  }
  throw new Error('expected a refusal')
}

const ONE_SHEET = workbookEntries([{ name: 'Calls', target: 'worksheets/sheet1.xml' }])

describe('inspectArchive', () => {
  it('names the sheets of a real workbook in workbook order', async () => {
    await withTempDir(async (dir) => {
      const path = await writeWorkbook(join(dir, 'book.xlsx'), [
        { name: 'Definitions', rows: [['x']] },
        ...rawLayout([]),
        { name: 'A & B <2026>', rows: [HEADER] },
      ])
      const info = await inspectArchive(path)
      expect(info.sheets.map((s) => s.name)).toEqual([
        'Definitions',
        'Call Records',
        'A & B <2026>',
      ])
      expect(info.sheets.every((s) => /^xl\/worksheets\/sheet\d+\.xml$/.test(s.part!))).toBe(true)
      expect(info.entries).toBeGreaterThan(3)
      expect(info.unpackedBytes).toBeGreaterThan(0)
    })
  })

  it('accepts a hand-built workbook with absolute and relative targets', async () => {
    const info = await inspectBytes(
      buildZip(
        workbookEntries([
          { name: 'One', target: '/xl/worksheets/sheet1.xml' },
          { name: 'Two', target: 'worksheets/../worksheets/sheet2.xml' },
        ])
      )
    )
    expect(info.sheets).toEqual([
      { name: 'One', part: 'xl/worksheets/sheet1.xml' },
      { name: 'Two', part: 'xl/worksheets/sheet2.xml' },
    ])
  })

  it('refuses a text file', async () => {
    expect((await refusal('Start_Date,start_time\n2026-09-01,08:00:00\n')).code).toBe(
      'not_a_workbook'
    )
  })

  it('refuses an empty file', async () => {
    expect((await refusal('')).code).toBe('not_a_workbook')
  })

  it('refuses a zip that is not a workbook', async () => {
    const zip = buildZip([{ name: 'notes.txt', data: 'hello' }])
    expect((await refusal(zip)).code).toBe('not_a_workbook')
  })

  it('refuses a workbook part without its relationships', async () => {
    const zip = buildZip(ONE_SHEET.filter((e) => e.name !== 'xl/_rels/workbook.xml.rels'))
    expect((await refusal(zip)).code).toBe('not_a_workbook')
  })

  it('refuses a sheet whose worksheet is missing', async () => {
    const zip = buildZip(ONE_SHEET.filter((e) => !e.name.startsWith('xl/worksheets/')))
    expect((await refusal(zip)).code).toBe('not_a_workbook')
  })

  it('refuses two sheets that share one worksheet', async () => {
    const zip = buildZip(
      workbookEntries([
        { name: 'One', target: 'worksheets/sheet1.xml' },
        { name: 'Copy', target: 'worksheets/sheet1.xml' },
      ])
    )
    expect(await refusal(zip)).toEqual({
      code: 'not_a_workbook',
      message: 'Two or more sheets of this workbook share one worksheet. Export the file again.',
    })
  })

  it('refuses a zip64 archive', async () => {
    const zip = buildZip(ONE_SHEET, { countOverride: 0xffff })
    expect((await refusal(zip)).code).toBe('not_a_workbook')
  })

  it('refuses a local header that disagrees with the central directory', async () => {
    const entries: ZipEntry[] = ONE_SHEET.map((e, i) =>
      i === 2 ? { ...e, local: { compressedSize: 3 } } : e
    )
    expect((await refusal(buildZip(entries))).code).toBe('not_a_workbook')
  })

  it(`refuses more than ${MAX_ARCHIVE_ENTRIES} entries`, async () => {
    const filler = Array.from({ length: MAX_ARCHIVE_ENTRIES }, (_, i) => ({
      name: `xl/media/f${i}.bin`,
      data: 'x',
    }))
    const refused = await refusal(buildZip([...ONE_SHEET, ...filler]))
    expect(refused.code).toBe('too_large_unpacked')
    expect(refused.message).toContain('2,003 parts; the limit is 2,000')
  })

  it('refuses an archive whose directory says it unpacks to more than the limit', async () => {
    const entries: ZipEntry[] = [
      ...ONE_SHEET,
      { name: 'xl/media/big.bin', data: 'x', directory: { size: MAX_UNPACKED_BYTES } },
    ]
    const refused = await refusal(buildZip(entries))
    expect(refused.code).toBe('too_large_unpacked')
    expect(refused.message).toMatch(/^The workbook unpacks to \d+ MB; the limit is 600 MB\./)
  })

  it(`refuses more than ${MAX_SHEETS} sheets`, async () => {
    const sheets = Array.from({ length: MAX_SHEETS + 1 }, (_, i) => ({
      name: `S${i}`,
      target: `worksheets/sheet${i + 1}.xml`,
    }))
    const refused = await refusal(buildZip(workbookEntries(sheets)))
    expect(refused.code).toBe('too_many_sheets')
    expect(refused.message).toContain('33 sheets; the limit is 32')
  })
})
