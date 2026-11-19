// Streaming reader for the partner's call-records workbooks (the raw export, the
// validity-testing workbook, the multi-year export). The specification is the proven
// Python parser (forecast/db/client_files.py + db/load_week.parse_call_records); where
// that parser silently accepts something odd (a number as a date, 24:00:00, "0x10"
// seconds), this one refuses the row instead of guessing.
//
// Nothing here ever puts a cell value into a message: problems name the sheet, the
// column and Excel row numbers only.
import ExcelJS from 'exceljs'
import { REQUIRED_CALL_COLUMNS } from '../../../shared/utils/constants'
import type { UploadIssue } from '../../../shared/types/api'
import { pipeline, type Readable } from 'node:stream'
import { ArchiveError, inspectArchive, openPart, type ArchiveInfo } from './archive'
import { MAX_LISTED, ROW_BATCH } from './limits'
import { createPartNormalizer, type PartKind } from './xml'

export type RequiredColumn = (typeof REQUIRED_CALL_COLUMNS)[number]

export interface ParsedCall {
  startTs: string // 'YYYY-MM-DDTHH:MM:SS', wall-clock, no zone
  inQueueSec: number
  agentSec: number
  abandonSec: number
  routingSec: number
  abandoned: boolean
}

export interface ParseResult {
  sheets: { name: string; rows: number }[] // the call sheets, in the order they were read
  totalRows: number
  errors: UploadIssue[]
}

export interface ParseOptions {
  maxRows: number
  onSheet?(name: string): void
  // Batches of at most ROW_BATCH calls, in sheet order; awaited before reading on.
  onRows(sheet: string, rows: ParsedCall[]): void | Promise<void>
}

const DURATION_COLUMNS = [
  ['InQueue', 'inQueueSec'],
  ['Agent_Time', 'agentSec'],
  ['Abandon_Time', 'abandonSec'],
  ['Routing_Time', 'routingSec'],
] as const

// No call sheet, but a sheet with at least this many of the seven names is taken to be
// a call sheet with columns missing, and the message names them.
const NEAR_MISS_COLUMNS = 4
const SECONDS_PER_DAY = 86_400
// A time cell is a fraction of a day counted from the workbook's date origin.
const EXCEL_EPOCH = Date.UTC(1899, 11, 30)
const EXCEL_EPOCH_1904 = Date.UTC(1904, 0, 1)
// One reading of each digit (no nested quantifiers to backtrack through): a long run of
// digits that ends badly is refused in linear time (review N-2 class).
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/
const US_DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
const CLOCK = /^(\d{1,2}):(\d{2}):(\d{2})$/
// A cell the reader returned in a form this parser does not know. Not empty, so a row
// made of such cells fails loudly instead of being skipped as blank.
const UNREADABLE = '\u0000unreadable'

const READER_OPTIONS = {
  sharedStrings: 'cache',
  styles: 'cache',
  hyperlinks: 'ignore',
  worksheets: 'emit',
} as const

// One cell as a plain value: formula cells give their cached result, rich text its text,
// hyperlink cells their text; error cells and empty cells are null.
export function readCell(value: unknown): string | number | Date | null {
  if (isErrorCell(value)) return null
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'object') {
    const cell = value as Record<string, unknown>
    if (Array.isArray(cell.richText)) {
      return cell.richText.map((part) => String((part as { text?: unknown }).text ?? '')).join('')
    }
    if ('formula' in cell || 'sharedFormula' in cell) return readCell(cell.result)
    if ('text' in cell) return readCell(cell.text)
  }
  return UNREADABLE
}

function isErrorCell(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'error' in value
}

function isEmpty(value: string | number | Date | null): boolean {
  return value === null || (typeof value === 'string' && value.trim() === '')
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

function calendarDay(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null
  if (date.getUTCDate() !== day) return null
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

function readDay(value: string | number | Date | null): string | null {
  if (value instanceof Date) {
    return calendarDay(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate())
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  const iso = ISO_DAY.exec(text)
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const us = US_DAY.exec(text)
  if (us) return calendarDay(Number(us[3]), Number(us[1]), Number(us[2]))
  return null
}

function readClock(value: string | number | Date | null, epoch: number): string | null {
  let seconds: number
  if (value instanceof Date) {
    seconds = Math.round((value.getTime() - epoch) / 1000)
  } else if (typeof value === 'string') {
    const clock = CLOCK.exec(value.trim())
    if (!clock) return null
    const [h, m, s] = [Number(clock[1]), Number(clock[2]), Number(clock[3])]
    if (h > 23 || m > 59 || s > 59) return null
    seconds = h * 3600 + m * 60 + s
  } else return null
  if (seconds < 0 || seconds >= SECONDS_PER_DAY) return null
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`
}

function readSeconds(column: string, value: string | number | Date | null): number | string {
  if (isEmpty(value)) return `${column} is empty`
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && DECIMAL.test(value.trim())) n = Number(value.trim())
  else return `${column} is not a number`
  if (!Number.isFinite(n)) return `${column} is not a number`
  if (n < 0) return `${column} is negative`
  return n + 0 // -0 becomes 0
}

// One call row: the seven required cells as the reader gave them. Pure. date1904: the
// workbook counts dates (and so time cells) from 1904-01-01.
export function parseRow(
  cells: Record<RequiredColumn, unknown>,
  options: { date1904?: boolean } = {}
): ParsedCall | { problem: string } {
  for (const column of REQUIRED_CALL_COLUMNS) {
    if (isErrorCell(cells[column])) {
      return { problem: `${column} holds an Excel error value (such as #N/A)` }
    }
  }
  const value = (column: RequiredColumn) => readCell(cells[column])
  const day = readDay(value('Start_Date'))
  if (!day) return { problem: 'Start_Date is not a date' }
  const clock = readClock(value('start_time'), options.date1904 ? EXCEL_EPOCH_1904 : EXCEL_EPOCH)
  if (!clock) return { problem: 'start_time is not a time of day (H:MM:SS)' }
  const seconds: Partial<Record<(typeof DURATION_COLUMNS)[number][1], number>> = {}
  for (const [column, key] of DURATION_COLUMNS) {
    const read = readSeconds(column, value(column))
    if (typeof read === 'string') return { problem: read }
    seconds[key] = read
  }
  const flag = value('Abandon')
  const text = typeof flag === 'string' ? flag.trim().toUpperCase() : null
  if (text !== 'Y' && text !== 'N') {
    return { problem: isEmpty(flag) ? 'Abandon is empty' : 'Abandon is not Y or N' }
  }
  return {
    startTs: `${day}T${clock}`,
    inQueueSec: seconds.inQueueSec!,
    agentSec: seconds.agentSec!,
    abandonSec: seconds.abandonSec!,
    routingSec: seconds.routingSec!,
    abandoned: text === 'Y',
  }
}

function listRows(rows: number[], total: number): string {
  const shown = rows.slice(0, MAX_LISTED).map((n) => n.toLocaleString('en-US'))
  const more = total - shown.length
  const listed =
    more > 0
      ? `${shown.join(', ')} and ${more.toLocaleString('en-US')} more`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
        : shown[0]
  return `Excel row${total > 1 ? 's' : ''} ${listed}`
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

type WorksheetRows = AsyncIterable<ExcelJS.Row>

// The steps of exceljs' streaming WorkbookReader, called one part at a time. Its own walk
// over the zip is not used: on workbooks whose worksheets come before the workbook part
// (openpyxl writes them that way) it parks sheets in temp files and, in this sandbox,
// read the same file as zero calls in two of six runs without any error. Driving the
// steps ourselves gives a fixed order (relationships, workbook, styles, strings, then
// each sheet in workbook order), no temp files, and parts capped at their declared size.
// exceljs is pinned (4.4.0); tests/parity/parser checks this path against Python.
// Every part goes through createPartNormalizer first (xml.ts says why).
interface ReaderSteps {
  properties?: { model?: { date1904?: boolean } }
  _parseRels(stream: Readable): Promise<void>
  _parseWorkbook(stream: Readable): Promise<void>
  _parseStyles(stream: Readable): Promise<void>
  _parseSharedStrings(stream: Readable): AsyncIterable<unknown>
  _parseWorksheet(
    stream: Readable,
    id: string
  ): Iterable<{ eventType: string; value: WorksheetRows }>
}

async function* worksheets(path: string, archive: ArchiveInfo) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(
    path,
    READER_OPTIONS
  ) as unknown as ReaderSteps
  const open = (part: string, kind: PartKind = 'other') => {
    const normalized = createPartNormalizer(kind)
    // pipeline hands a failure of either stage to the last one, so the reader sees it.
    pipeline(openPart(path, archive.parts.get(part)!), normalized, () => {})
    return normalized
  }
  await reader._parseRels(open(archive.workbookRels))
  await reader._parseWorkbook(open(archive.workbook, 'workbook'))
  // Dates read in the wrong date system are four years off without any error: the
  // reader's own reading of the setting must agree with the archive's.
  if (Boolean(reader.properties?.model?.date1904) !== archive.date1904) {
    throw new Error('the workbook date system was not read consistently')
  }
  if (archive.styles) await reader._parseStyles(open(archive.styles))
  if (archive.sharedStrings) {
    for await (const _ of reader._parseSharedStrings(
      open(archive.sharedStrings, 'sharedStrings')
    )) {
      // 'cache' keeps the strings on the reader; nothing is emitted per string.
    }
  }
  let index = 0
  for (const sheet of archive.sheets) {
    if (!sheet.part) continue
    index++
    for (const event of reader._parseWorksheet(open(sheet.part, 'worksheet'), String(index))) {
      if (event.eventType === 'worksheet') yield { name: sheet.name, rows: event.value }
    }
  }
}

export async function parseWorkbook(path: string, options: ParseOptions): Promise<ParseResult> {
  const result: ParseResult = { sheets: [], totalRows: 0, errors: [] }
  let archive: ArchiveInfo
  try {
    archive = await inspectArchive(path)
  } catch (error) {
    if (!(error instanceof ArchiveError)) throw error
    result.errors.push({ code: error.code, message: error.message })
    return result
  }

  const nearMisses: { sheet: string; missing: string[] }[] = []
  const badRows = new Map<
    string,
    { sheet: string; problem: string; rows: number[]; count: number }
  >()
  let stopped = false
  let sheetsRead = 0

  for await (const { name, rows: worksheet } of worksheets(path, archive)) {
    sheetsRead++
    if (stopped) break
    let columns: Map<RequiredColumn, number> | null = null
    let rows = 0
    let batch: ParsedCall[] = []
    for await (const row of worksheet) {
      if (columns === null) {
        if (row.number !== 1) break
        const header = new Map<string, number>()
        ;(row.values as unknown[]).forEach((cell, index) => {
          const text = readCell(cell)
          if (text === null || text instanceof Date) return
          const label = String(text).trim()
          if (!header.has(label)) header.set(label, index)
        })
        const missing = REQUIRED_CALL_COLUMNS.filter((column) => !header.has(column))
        if (missing.length > 0) {
          if (REQUIRED_CALL_COLUMNS.length - missing.length >= NEAR_MISS_COLUMNS) {
            nearMisses.push({ sheet: name, missing })
          }
          break
        }
        columns = new Map(REQUIRED_CALL_COLUMNS.map((column) => [column, header.get(column)!]))
        options.onSheet?.(name)
        continue
      }
      const values = row.values as unknown[]
      const cells = {} as Record<RequiredColumn, unknown>
      let filled = false
      for (const [column, index] of columns) {
        cells[column] = values[index]
        if (isErrorCell(values[index]) || !isEmpty(readCell(values[index]))) filled = true
      }
      // Excel leaves fully blank rows after the last call; a row with SOME call fields
      // filled is parsed, so it fails loudly instead of being dropped.
      if (!filled) continue
      const parsed = parseRow(cells, { date1904: archive.date1904 })
      if ('problem' in parsed) {
        const key = `${name}\u0000${parsed.problem}`
        const group = badRows.get(key) ?? {
          sheet: name,
          problem: parsed.problem,
          rows: [],
          count: 0,
        }
        if (group.rows.length < MAX_LISTED) group.rows.push(row.number)
        group.count++
        badRows.set(key, group)
        continue
      }
      if (result.totalRows >= options.maxRows) {
        stopped = true
        break
      }
      result.totalRows++
      rows++
      batch.push(parsed)
      if (batch.length === ROW_BATCH) {
        await options.onRows(name, batch)
        batch = []
        await yieldToEventLoop()
      }
    }
    if (batch.length) {
      await options.onRows(name, batch)
      await yieldToEventLoop()
    }
    if (columns !== null) result.sheets.push({ name, rows })
  }
  // A sheet that was never read would be calls missing without a word: never let that
  // pass as a short file.
  const worksheetCount = archive.sheets.filter((sheet) => sheet.part).length
  if (!stopped && sheetsRead !== worksheetCount) {
    throw new Error(`read ${sheetsRead} of ${worksheetCount} worksheets`)
  }

  if (result.sheets.length === 0) {
    if (nearMisses.length) {
      for (const { sheet, missing } of nearMisses) {
        result.errors.push({
          code: 'missing_columns',
          message:
            `Sheet "${sheet}" is missing the column${missing.length > 1 ? 's' : ''} ` +
            `${missing.join(', ')}. A call-records sheet needs ${REQUIRED_CALL_COLUMNS.join(', ')}.`,
        })
      }
    } else {
      result.errors.push({
        code: 'no_call_sheet',
        message:
          'No sheet in this workbook holds call records: none has the header row ' +
          `${REQUIRED_CALL_COLUMNS.join(', ')}. Check it is the call-records export.`,
      })
    }
  }
  for (const group of badRows.values()) {
    result.errors.push({
      code: 'bad_rows',
      message: `Sheet "${group.sheet}": ${group.problem} on ${listRows(group.rows, group.count)}.`,
    })
  }
  if (stopped) {
    const limit = options.maxRows.toLocaleString('en-US')
    result.errors.push({
      code: 'too_many_rows',
      message: `The file has more than ${limit} calls; the upload limit is ${limit}. Split it into smaller files.`,
    })
  }
  return result
}
