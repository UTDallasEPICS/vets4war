// SYNTHETIC call-records workbooks written at test time with the exceljs WRITER, in the
// partner's layouts (as forecast/tests/test_client_files.py builds them with openpyxl).
// No real call data anywhere.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'

export const HEADER = [
  'Skill_Name',
  'Start_Date',
  'start_time',
  'InQueue',
  'Agent_Time',
  'Abandon_Time',
  'Routing_Time',
  'Abandon',
]
export const SKILL = 'Vets4Warriors_Call'

const TIME_EPOCH = Date.UTC(1899, 11, 30)

export function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`)
}

// A time-of-day cell value: a Date on 1899-12-30, as Excel and exceljs store times.
export function clock(text: string): Date {
  const [h, m, s] = text.split(':').map(Number)
  return new Date(TIME_EPOCH + ((h! * 60 + m!) * 60 + s!) * 1000)
}

// (date, clock, in_queue, agent, abandon, routing, flag) -> a full row with Skill_Name.
export function call(
  date: string,
  time: string,
  inQueue: number,
  agent: number,
  abandon: number,
  routing: number,
  flag: string
): unknown[] {
  return [SKILL, day(date), clock(time), inQueue, agent, abandon, routing, flag]
}

// A whole synthetic day: one call every `everyMinutes` from 00:10 to 23:50.
export function wholeDay(date: string, everyMinutes = 60, flag: (i: number) => string = () => 'N') {
  const rows: unknown[][] = []
  for (let minute = 10, i = 0; minute < 24 * 60; minute += everyMinutes, i++) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:05`
    rows.push(call(date, time, 10 + (i % 7), 300 + i, 0, 9, flag(i)))
  }
  return rows
}

export interface SheetSpec {
  name: string
  rows: unknown[][]
}

export async function writeWorkbook(path: string, sheets: SheetSpec[]): Promise<string> {
  const book = new ExcelJS.Workbook()
  for (const spec of sheets) {
    const sheet = book.addWorksheet(spec.name)
    for (const values of spec.rows) {
      const row = sheet.addRow(values)
      row.eachCell((cell) => {
        if (cell.value instanceof Date) {
          cell.numFmt = cell.value.getTime() < Date.UTC(1900, 0, 1) ? 'hh:mm:ss' : 'yyyy-mm-dd'
        }
      })
    }
  }
  await book.xlsx.writeFile(path)
  return path
}

// The raw export: calls on the only sheet.
export function rawLayout(rows: unknown[][]): SheetSpec[] {
  return [{ name: 'Call Records', rows: [HEADER, ...rows] }]
}

// The validity-testing workbook: summary sheets first, the calls on a later sheet with
// an extra Hour column, a pivot sheet after it.
export function validityLayout(rows: unknown[][]): SheetSpec[] {
  return [
    { name: 'Offered vs Abandoned', rows: [['Calls Offered', rows.length]] },
    { name: 'Staff By Shift', rows: [[null, null, '12AM- 8AM', '8AM - 4 PM', '4PM - 12 AM']] },
    {
      name: 'Call Records - Sep 1 to Sep 2',
      rows: [
        [...HEADER, 'Hour'],
        ...rows.map((row) => [...row, String((row[2] as Date).getUTCHours()).padStart(2, '0')]),
      ],
    },
    { name: 'Pivot Table', rows: [['Count of Skill_Name', 'Column Labels']] },
  ]
}

export async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'v4w-test-'))
  try {
    return await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
