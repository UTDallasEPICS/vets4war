// The streaming workbook reader: the partner's three layouts, every accepted cell
// variant, every refusal, and that no message ever carries a cell value. Workbooks are
// SYNTHETIC and written at test time with the exceljs writer.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  parseRow,
  parseWorkbook,
  readCell,
  type ParsedCall,
  type RequiredColumn,
} from '../../../server/utils/ingest/parser'
import {
  HEADER,
  SKILL,
  call,
  clock,
  day,
  rawLayout,
  validityLayout,
  withTempDir,
  writeWorkbook,
  type SheetSpec,
} from './fixtures/workbooks'
import {
  DATE_STYLE,
  TIME_STYLE,
  callRow,
  handmadeWorkbook,
  headerRow,
  serialDay,
} from './fixtures/handmade'

const SEP_1 = [
  call('2026-09-01', '00:00:32', 18, 1290, 0, 17, 'N'),
  call('2026-09-01', '00:59:59', 45, 0, 45, 20, 'Y'),
  call('2026-09-01', '13:05:00', 31, 600, 0, 30, 'N'),
]
const SEP_2 = [call('2026-09-02', '13:05:00', 5, 60, 0, 5, 'N')]

async function parse(sheets: SheetSpec[], maxRows = 1000) {
  return withTempDir(async (dir) => {
    const path = await writeWorkbook(join(dir, 'book.xlsx'), sheets)
    const calls: ParsedCall[] = []
    const batches: { sheet: string; size: number }[] = []
    const opened: string[] = []
    const result = await parseWorkbook(path, {
      maxRows,
      onSheet: (name) => opened.push(name),
      onRows(sheet, rows) {
        batches.push({ sheet, size: rows.length })
        calls.push(...rows)
      },
    })
    return { result, calls, batches, opened }
  })
}

function cells(values: Partial<Record<RequiredColumn, unknown>>): Record<RequiredColumn, unknown> {
  return {
    Start_Date: day('2026-09-01'),
    start_time: clock('08:00:00'),
    InQueue: 5,
    Agent_Time: 300,
    Abandon_Time: 0,
    Routing_Time: 5,
    Abandon: 'N',
    ...values,
  }
}

describe('parseWorkbook: layouts', () => {
  it('reads every call of the raw export', async () => {
    const { result, calls, opened } = await parse(rawLayout([...SEP_1, ...SEP_2]))
    expect(result.errors).toEqual([])
    expect(result.totalRows).toBe(4)
    expect(result.sheets).toEqual([{ name: 'Call Records', rows: 4 }])
    expect(opened).toEqual(['Call Records'])
    expect(calls[0]).toEqual({
      startTs: '2026-09-01T00:00:32',
      inQueueSec: 18,
      agentSec: 1290,
      abandonSec: 0,
      routingSec: 17,
      abandoned: false,
    })
    expect(calls.map((c) => c.abandoned)).toEqual([false, true, false, false])
  })

  it('gives the same calls for the validity-testing layout (summary sheets, extra Hour column)', async () => {
    const raw = await parse(rawLayout([...SEP_1, ...SEP_2]))
    const validity = await parse(validityLayout([...SEP_1, ...SEP_2]))
    expect(validity.result.errors).toEqual([])
    expect(validity.result.sheets).toEqual([{ name: 'Call Records - Sep 1 to Sep 2', rows: 4 }])
    expect(validity.calls).toEqual(raw.calls)
  })

  it('reads the multi-year layout: a Definitions sheet, then one sheet per year', async () => {
    const { result, calls } = await parse([
      {
        name: 'Definitions',
        rows: [
          ['InQueue', 'seconds waiting'],
          ['Abandon', 'Y or N'],
        ],
      },
      {
        name: 'CY 2025',
        rows: [HEADER, call('2025-12-31', '23:10:00', 5, 60, 0, 5, 'N')],
      },
      {
        name: 'CY 2026',
        rows: [
          HEADER,
          call('2025-12-31', '23:59:30', 5, 60, 0, 5, 'N'),
          call('2026-01-01', '00:00:10', 5, 60, 0, 5, 'Y'),
        ],
      },
    ])
    expect(result.errors).toEqual([])
    expect(result.sheets).toEqual([
      { name: 'CY 2025', rows: 1 },
      { name: 'CY 2026', rows: 2 },
    ])
    expect(calls.map((c) => c.startTs)).toEqual([
      '2025-12-31T23:10:00',
      '2025-12-31T23:59:30',
      '2026-01-01T00:00:10',
    ])
  })

  it('finds columns by name, ignores extra columns and trims padded header names', async () => {
    const header = [
      'Abandon ',
      ' Hour',
      'Routing_Time',
      ' Start_Date',
      'start_time  ',
      'Agent_Time',
    ]
    const { result, calls } = await parse([
      {
        name: 'Calls',
        rows: [
          [...header, 'InQueue', 'Abandon_Time', 'Skill_Name'],
          ['Y', '13', 20, day('2026-09-01'), clock('13:05:00'), 0, 40, 40, SKILL],
        ],
      },
    ])
    expect(result.errors).toEqual([])
    expect(calls).toEqual([
      {
        startTs: '2026-09-01T13:05:00',
        inQueueSec: 40,
        agentSec: 0,
        abandonSec: 40,
        routingSec: 20,
        abandoned: true,
      },
    ])
  })

  it('skips fully blank rows in the middle and after the last call', async () => {
    const blank = [null, null, null, null, null, null, null, null]
    const skillOnly = [SKILL, null, null, null, null, null, null, null]
    const { result, calls } = await parse(
      rawLayout([SEP_1[0]!, blank, skillOnly, SEP_1[1]!, SEP_1[2]!, blank, blank])
    )
    expect(result.errors).toEqual([])
    expect(calls).toHaveLength(3)
  })

  it('accepts a formula cell with a cached result, rich text and a hyperlink cell', async () => {
    const { result, calls } = await parse(
      rawLayout([
        [
          SKILL,
          day('2026-09-01'),
          clock('08:00:00'),
          { formula: '2*6', result: 12 },
          { formula: '100+20', result: 120 },
          0,
          { formula: '"1"&"1"', result: '11' },
          { richText: [{ text: ' ' }, { text: 'y' }] },
        ],
        [
          SKILL,
          { text: '2026-09-01', hyperlink: 'https://example.org/' },
          '08:30:00',
          1,
          2,
          0,
          3,
          'N',
        ],
      ])
    )
    expect(result.errors).toEqual([])
    expect(calls.map((c) => [c.inQueueSec, c.agentSec, c.routingSec, c.abandoned])).toEqual([
      [12, 120, 11, true],
      [1, 2, 3, false],
    ])
    expect(calls[1]!.startTs).toBe('2026-09-01T08:30:00')
  })

  it('reports call batches of at most 5,000 in sheet order', async () => {
    const rows: unknown[][] = []
    for (let i = 0; i < 12_001; i++) {
      const seconds = i % 86_400
      const time = [seconds / 3600, (seconds % 3600) / 60, seconds % 60]
        .map((n) => String(Math.floor(n)).padStart(2, '0'))
        .join(':')
      rows.push(call('2026-09-03', time, 1, 2, 0, 1, 'N'))
    }
    const { result, batches } = await parse(rawLayout(rows), 20_000)
    expect(result.totalRows).toBe(12_001)
    expect(batches.map((b) => b.size)).toEqual([5000, 5000, 2001])
    expect(new Set(batches.map((b) => b.sheet))).toEqual(new Set(['Call Records']))
  }, 60_000)
})

describe('parseRow: accepted cell variants', () => {
  it.each([
    ['a date cell', day('2026-09-01')],
    ['a date cell with a time part (ignored)', new Date('2026-09-01T17:45:00.000Z')],
    ['text YYYY-MM-DD', '2026-09-01'],
    ['text YYYY-MM-DD with a time part', '2026-09-01 00:00:00'],
    ['text M/D/YYYY', '9/1/2026'],
    ['text MM/DD/YYYY', '09/01/2026'],
  ])('Start_Date as %s', (_, value) => {
    expect(parseRow(cells({ Start_Date: value }))).toMatchObject({ startTs: '2026-09-01T08:00:00' })
  })

  it.each([
    ['a time cell', clock('13:05:09'), '13:05:09'],
    [
      'a time cell a few ms off a whole second',
      new Date(Date.UTC(1899, 11, 30, 13, 5, 8, 600)),
      '13:05:09',
    ],
    ['text H:MM:SS', '8:05:00', '08:05:00'],
    ['text HH:MM:SS', ' 23:59:59 ', '23:59:59'],
  ])('start_time as %s', (_, value, expected) => {
    expect(parseRow(cells({ start_time: value }))).toMatchObject({
      startTs: `2026-09-01T${expected}`,
    })
  })

  it.each([
    ['an integer', 12, 12],
    ['a float', 12.25, 12.25],
    ['numeric text', ' 12.5 ', 12.5],
    ['numeric text with an exponent', '1e2', 100],
    ['zero', 0, 0],
    ['negative zero', -0, 0],
  ])('a duration as %s', (_, value, expected) => {
    const parsed = parseRow(cells({ InQueue: value })) as ParsedCall
    expect(Object.is(parsed.inQueueSec, expected)).toBe(true)
  })

  it.each([
    ['Y', true],
    ['N', false],
    ['y', true],
    [' N ', false],
  ])('Abandon %j', (value, expected) => {
    expect(parseRow(cells({ Abandon: value }))).toMatchObject({ abandoned: expected })
  })
})

describe('parseRow: refusals', () => {
  it.each([
    ['Start_Date', 'a number', 46266, 'Start_Date is not a date'],
    ['Start_Date', 'not a calendar date', '2026-02-30', 'Start_Date is not a date'],
    ['Start_Date', 'words', 'yesterday', 'Start_Date is not a date'],
    ['Start_Date', 'empty', null, 'Start_Date is not a date'],
    ['start_time', 'a number', 0.5, 'start_time is not a time of day (H:MM:SS)'],
    ['start_time', '24:00:00', '24:00:00', 'start_time is not a time of day (H:MM:SS)'],
    ['start_time', 'minutes over 59', '8:61:00', 'start_time is not a time of day (H:MM:SS)'],
    ['start_time', 'no seconds', '08:05', 'start_time is not a time of day (H:MM:SS)'],
    ['start_time', 'empty', null, 'start_time is not a time of day (H:MM:SS)'],
    [
      'start_time',
      'a time cell that rounds to 24:00:00',
      new Date(Date.UTC(1899, 11, 30, 23, 59, 59, 600)),
      'start_time is not a time of day (H:MM:SS)',
    ],
    [
      'start_time',
      'a date on the next day',
      new Date(Date.UTC(1899, 11, 31, 10, 0, 0)),
      'start_time is not a time of day (H:MM:SS)',
    ],
    ['InQueue', 'empty', null, 'InQueue is empty'],
    ['InQueue', 'blank text', '  ', 'InQueue is empty'],
    ['Agent_Time', 'words', 'abc', 'Agent_Time is not a number'],
    ['Agent_Time', 'hex text', '0x10', 'Agent_Time is not a number'],
    ['Abandon_Time', 'a date', day('2026-09-01'), 'Abandon_Time is not a number'],
    ['Routing_Time', 'negative', -1, 'Routing_Time is negative'],
    ['Routing_Time', 'infinite text', 'Infinity', 'Routing_Time is not a number'],
    ['Abandon', 'Maybe', 'Maybe', 'Abandon is not Y or N'],
    ['Abandon', 'a number', 1, 'Abandon is not Y or N'],
    ['Abandon', 'empty', null, 'Abandon is empty'],
    ['Abandon', 'a boolean', true, 'Abandon is not Y or N'],
  ] as const)('%s as %s', (column, _, value, problem) => {
    expect(parseRow(cells({ [column]: value }))).toEqual({ problem })
  })
})

describe('readCell', () => {
  it('unwraps formula results, rich text and hyperlink text; errors are empty', () => {
    expect(readCell({ formula: 'A1', result: 7 })).toBe(7)
    expect(readCell({ sharedFormula: 'A1', result: 'x' })).toBe('x')
    expect(readCell({ formula: 'A1' })).toBeNull()
    expect(readCell({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab')
    expect(readCell({ text: 'N', hyperlink: 'https://example.org' })).toBe('N')
    expect(readCell({ error: '#N/A' })).toBeNull()
    expect(readCell({ formula: 'A1', result: { error: '#DIV/0!' } })).toBeNull()
    expect(readCell(undefined)).toBeNull()
  })
})

describe('parseWorkbook: refusals', () => {
  // Distinctive values in the bad cells; none of them may appear in any message.
  const SECRET_TEXT = 'SECRETVALUE'
  const SECRET_NUMBER = -987654

  it('collects bad rows per sheet and problem with real Excel row numbers, never a value', async () => {
    const rows: unknown[][] = [...SEP_1]
    for (let i = 0; i < 12; i++) rows.push(call('2026-09-01', '14:00:00', 1, 2, 0, 1, SECRET_TEXT))
    rows.push(call('2026-09-01', '15:00:00', SECRET_NUMBER, 2, 0, 1, 'N'))
    rows.push([SKILL, day('2026-09-01'), SECRET_TEXT, 1, 2, 0, 1, 'N'])
    const { result } = await parse([
      { name: 'Summary', rows: [['nothing here']] },
      { name: 'Calls', rows: [HEADER, ...rows] },
    ])
    expect(result.errors).toEqual([
      {
        code: 'bad_rows',
        message:
          'Sheet "Calls": Abandon is not Y or N on Excel rows 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 and 2 more.',
      },
      { code: 'bad_rows', message: 'Sheet "Calls": InQueue is negative on Excel row 17.' },
      {
        code: 'bad_rows',
        message: 'Sheet "Calls": start_time is not a time of day (H:MM:SS) on Excel row 18.',
      },
    ])
    const text = JSON.stringify(result)
    expect(text).not.toContain(SECRET_TEXT)
    expect(text).not.toContain(String(SECRET_NUMBER))
    expect(text).not.toContain('987')
  })

  it('a row with some call fields filled fails instead of being skipped', async () => {
    const { result } = await parse(
      rawLayout([...SEP_1, [SKILL, day('2026-09-01'), null, 18, 100, 0, 17, 'N']])
    )
    expect(result.errors).toEqual([
      {
        code: 'bad_rows',
        message: 'Sheet "Call Records": start_time is not a time of day (H:MM:SS) on Excel row 5.',
      },
    ])
  })

  it('stops at maxRows with too_many_rows', async () => {
    const { result, calls } = await parse(rawLayout([...SEP_1, ...SEP_2]), 2)
    expect(calls).toHaveLength(2)
    expect(result.totalRows).toBe(2)
    expect(result.errors).toEqual([
      {
        code: 'too_many_rows',
        message:
          'The file has more than 2 calls; the upload limit is 2. Split it into smaller files.',
      },
    ])
  })

  it('names the missing columns of a sheet that has most of them', async () => {
    const header = HEADER.filter((name) => name !== 'Routing_Time' && name !== 'InQueue')
    const { result } = await parse([{ name: 'Calls', rows: [header] }])
    expect(result.errors).toEqual([
      {
        code: 'missing_columns',
        message:
          'Sheet "Calls" is missing the columns InQueue, Routing_Time. A call-records sheet needs ' +
          'Start_Date, start_time, InQueue, Agent_Time, Abandon_Time, Routing_Time, Abandon.',
      },
    ])
  })

  it('refuses a workbook without a call sheet', async () => {
    const { result } = await parse([
      { name: 'Staffing', rows: [['SATURDAY 8/1', 'SUNDAY 8/2']] },
      { name: 'Definitions', rows: [['InQueue', 'Abandon', 'start_time']] },
    ])
    expect(result.errors.map((e) => e.code)).toEqual(['no_call_sheet'])
  })

  it('takes the header from row 1 only', async () => {
    const { result } = await parse([{ name: 'Calls', rows: [[], HEADER, SEP_1[0]!] }])
    expect(result.errors.map((e) => e.code)).toEqual(['no_call_sheet'])
  })

  it('refuses a file that is not a workbook before reading it', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'calls.xlsx')
      await writeFile(path, 'Start_Date,start_time\n2026-09-01,08:00:00\n')
      const result = await parseWorkbook(path, { maxRows: 10, onRows: () => {} })
      expect(result.errors.map((e) => e.code)).toEqual(['not_a_workbook'])
    })
  })
})

// Markup real files carry that the exceljs writer never produces (fixtures/handmade.ts).
// Each of these was read differently from the Python parser before the part normaliser.
describe('parseWorkbook: markup written by Excel and other export tools', () => {
  const NOV_10 = serialDay('2026-11-10')
  const AT_0813 = (8 * 3600 + 13 * 60) / 86_400
  const base = { serialDay: NOV_10, dayFraction: AT_0813, durations: [5, 0, 12, 3], flag: 'Y' }
  const EXPECTED: ParsedCall = {
    startTs: '2026-11-10T08:13:00',
    inQueueSec: 5,
    agentSec: 0,
    abandonSec: 12,
    routingSec: 3,
    abandoned: true,
  }

  async function read(book: Buffer) {
    return withTempDir(async (dir) => {
      const path = join(dir, 'book.xlsx')
      await writeFile(path, book)
      const calls: ParsedCall[] = []
      const result = await parseWorkbook(path, {
        maxRows: 1000,
        onRows: (_sheet, rows) => {
          calls.push(...rows)
        },
      })
      return { result, calls }
    })
  }

  it('reads an ISO 8601 date cell (t="d") as its date, never as a serial number (W3-1)', async () => {
    const { result, calls } = await read(
      handmadeWorkbook({
        rows:
          headerRow() +
          callRow(2, base, {
            B: `<c r="B2" s="${DATE_STYLE}" t="d"><v>2026-11-10T00:00:00Z</v></c>`,
          }),
      })
    )
    expect(result.errors).toEqual([])
    expect(calls).toEqual([EXPECTED])
  })

  it('reads a formula cell by its cached result, also a cached 0 and shared formulas (W3-2)', async () => {
    const formulas = {
      D: '<c r="D2"><f t="shared" ref="D2:D3" si="0">5+0*A1</f><v>5</v></c>',
      E: '<c r="E2"><f>0+0</f><v>0</v></c>',
      F: '<c r="F2"><f>12+0</f><v>12</v></c>',
      H: '<c r="H2" t="str"><f>IF(1=1,"Y","N")</f><v>Y</v></c>',
    }
    const child = { ...formulas, D: '<c r="D3"><f t="shared" si="0"/><v>5</v></c>' }
    const rename = (cells: Record<string, string>, r: number) =>
      Object.fromEntries(
        Object.entries(cells).map(([k, v]) => [k, v.replace(/r="([A-H])2"/, `r="$1${r}"`)])
      )
    const { result, calls } = await read(
      handmadeWorkbook({
        rows: headerRow() + callRow(2, base, formulas) + callRow(3, base, rename(child, 3)),
      })
    )
    expect(result.errors).toEqual([])
    expect(calls).toEqual([EXPECTED, EXPECTED])
  })

  it('applies the date format to a formula date and time (=DATE(), =TIME())', async () => {
    const { result, calls } = await read(
      handmadeWorkbook({
        rows:
          headerRow() +
          callRow(2, base, {
            B: `<c r="B2" s="${DATE_STYLE}"><f>DATE(2026,11,10)</f><v>${NOV_10}</v></c>`,
            C: `<c r="C2" s="${TIME_STYLE}"><f>TIME(8,13,0)</f><v>${AT_0813}</v></c>`,
          }),
      })
    )
    expect(result.errors).toEqual([])
    expect(calls).toEqual([EXPECTED])
  })

  it.each(['1', 'true'] as const)(
    'reads a workbook in the 1904 date system (date1904="%s") (W3-3)',
    async (flag) => {
      const { result, calls } = await read(
        handmadeWorkbook({
          date1904: flag,
          rows: headerRow() + callRow(2, { ...base, serialDay: serialDay('2026-11-10', true) }),
        })
      )
      expect(result.errors).toEqual([])
      expect(calls).toEqual([EXPECTED])
    }
  )

  it('says a cell holds an Excel error instead of calling it empty', async () => {
    const { result, calls } = await read(
      handmadeWorkbook({
        rows: headerRow() + callRow(2, base, { E: '<c r="E2" t="e"><f>NA()</f><v>#N/A</v></c>' }),
      })
    )
    expect(calls).toEqual([])
    expect(result.errors).toEqual([
      {
        code: 'bad_rows',
        message:
          'Sheet "Calls": Agent_Time holds an Excel error value (such as #N/A) on Excel row 2.',
      },
    ])
  })

  it('reads rows and cells written without r references', async () => {
    const strip = (xml: string) => xml.replace(/ r="[A-Z]*\d+"/g, '')
    const { result, calls } = await read(
      handmadeWorkbook({ rows: strip(headerRow() + callRow(2, base) + callRow(3, base)) })
    )
    expect(result.errors).toEqual([])
    expect(calls).toEqual([EXPECTED, EXPECTED])
  })

  it('reads parts whose elements carry a namespace prefix (<x:row>)', async () => {
    const { result, calls } = await read(
      handmadeWorkbook({ prefix: 'x', rows: headerRow() + callRow(2, base) })
    )
    expect(result.errors).toEqual([])
    expect(calls).toEqual([EXPECTED])
  })

  it('ignores phonetic guides in shared strings and joins rich-text inline runs', async () => {
    const header = headerRow()
      .replace(
        '<c r="H1" t="inlineStr"><is><t>Abandon</t></is></c>',
        '<c r="H1" t="s"><v>0</v></c>'
      )
      .replace('<is><t>Start_Date</t></is>', '<is><r><t>Start_</t></r><r><t>Date</t></r></is>')
    const { result, calls } = await read(
      handmadeWorkbook({
        sharedStrings:
          '<si><t>Abandon</t><rPh sb="0" eb="1"><t>アバンドン</t></rPh><phoneticPr fontId="1"/></si>',
        rows: header + callRow(2, base),
      })
    )
    expect(result.errors).toEqual([])
    expect(calls).toEqual([EXPECTED])
  })
})
