// Parity rung P4 (PLAN.md section 12): the TypeScript workbook reader gives exactly the
// calls of the proven Python parser (db.client_files.read_call_records) on SYNTHETIC
// workbooks written by openpyxl, and refuses every file Python refuses. With
// V4W_LEGACY_DIR set it also reads the legacy stack's synthetic workbooks and compares
// them with the CSV the legacy databases were loaded from.
// Needs forecast/.venv (pnpm forecast:setup); without it this test fails, never skips.
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseWorkbook, type ParsedCall } from '../../../server/utils/ingest/parser'
import { callLine, summarizeDays, type CallValues } from '../../../server/utils/ingest/days'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SCRIPT = fileURLToPath(new URL('./make_cases.py', import.meta.url))
const PYTHON = join(REPO_ROOT, 'forecast', '.venv', 'bin', 'python')
const LEGACY_DIR = process.env.V4W_LEGACY_DIR
const SETUP_TIMEOUT = 180_000

type PyCall = [string, number, number, number, number, boolean]
type PyResult = { calls: PyCall[] } | { error: true }

function sorted(calls: CallValues[]): [string, string][] {
  return calls
    .map((call): [string, string] => [call.startTs, callLine(call)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
}

function fromPython([startTs, inQueue, agent, abandon, routing, abandoned]: PyCall): CallValues {
  return {
    startTs,
    inQueueSec: inQueue,
    agentSec: agent,
    abandonSec: abandon,
    routingSec: routing,
    abandoned,
  }
}

async function readAll(path: string) {
  const calls: ParsedCall[] = []
  const result = await parseWorkbook(path, {
    maxRows: 1_000_000,
    onRows: (_sheet, rows) => {
      calls.push(...rows)
    },
  })
  return { result, calls }
}

async function readCsv(path: string): Promise<CallValues[]> {
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()) })
  const calls: CallValues[] = []
  let header = true
  for await (const line of lines) {
    if (header) {
      header = false
      continue
    }
    const [ts, inQueue, agent, abandon, routing, abandoned] = line.split(',')
    const number = (text: string | undefined) =>
      text === undefined || text === '' ? null : Number(text)
    calls.push({
      startTs: ts!.replace(' ', 'T'),
      inQueueSec: number(inQueue),
      agentSec: number(agent),
      abandonSec: number(abandon),
      routingSec: number(routing),
      abandoned: abandoned === 'True',
    })
  }
  return calls
}

let folder = ''
let python: Record<string, PyResult> = {}

beforeAll(async () => {
  if (!existsSync(PYTHON)) {
    throw new Error(`${PYTHON} not found: run pnpm forecast:setup`)
  }
  folder = await mkdtemp(join(tmpdir(), 'v4w-parity-parser-'))
  const run = spawnSync(PYTHON, ['-I', SCRIPT, folder], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (run.status !== 0) {
    throw new Error(`make_cases.py failed (exit ${run.status}): ${run.stderr}`)
  }
  python = JSON.parse(run.stdout) as Record<string, PyResult>
}, SETUP_TIMEOUT)

afterAll(async () => {
  if (folder) await rm(folder, { recursive: true, force: true })
})

describe('P4: the TypeScript reader against the Python parser', () => {
  it('covers every case the Python script wrote', () => {
    expect(Object.keys(python).length).toBeGreaterThanOrEqual(14)
    expect(Object.values(python).some((r) => 'error' in r)).toBe(true)
    expect(Object.values(python).some((r) => 'calls' in r)).toBe(true)
  })

  it('gives identical calls where Python reads the file, and an error where it refuses', async () => {
    for (const [name, expected] of Object.entries(python)) {
      const { result, calls } = await readAll(join(folder, name))
      if ('error' in expected) {
        expect(result.errors.length, `${name}: TypeScript must refuse it too`).toBeGreaterThan(0)
        continue
      }
      expect(result.errors, `${name}: unexpected errors`).toEqual([])
      expect(sorted(calls), name).toEqual(sorted(expected.calls.map(fromPython)))
    }
  })
})

describe.runIf(LEGACY_DIR)('P4: the legacy synthetic workbooks (V4W_LEGACY_DIR)', () => {
  const workbooks = () => join(LEGACY_DIR!, 'synthetic', 'workbooks')
  const csv = (name: string) => join(LEGACY_DIR!, 'synthetic', name)

  it('week 1 (raw layout) gives exactly the 1,313 calls of calls_week1.csv.gz', async () => {
    const { result, calls } = await readAll(
      join(workbooks(), 'SYNTHETIC V4W Call Records - Nov 9th 2026 thru Nov 15th 2026.xlsx')
    )
    expect(result.errors).toEqual([])
    expect(calls).toHaveLength(1313)
    expect(sorted(calls)).toEqual(sorted(await readCsv(csv('calls_week1.csv.gz'))))
  })

  it('week 2 (validity layout) gives exactly the 365 calls of calls_week2.csv.gz', async () => {
    const { result, calls } = await readAll(
      join(
        workbooks(),
        'SYNTHETIC Nov 16 2026 to Nov 17 2026 - Actual Data for Validity Testing.xlsx'
      )
    )
    expect(result.errors).toEqual([])
    expect(calls).toHaveLength(365)
    expect(sorted(calls)).toEqual(sorted(await readCsv(csv('calls_week2.csv.gz'))))
  })

  it('the multi-year book gives 387,921 calls, every day equal to calls_history.csv.gz', async () => {
    const lines = new Map<string, string[]>()
    let peakRss = process.memoryUsage().rss
    const started = performance.now()
    const result = await parseWorkbook(
      join(workbooks(), 'SYNTHETIC V4W Call Records - CY 21 - CY 26.xlsx'),
      {
        maxRows: 1_000_000,
        onRows: (_sheet, rows) => {
          for (const call of rows) {
            const day = call.startTs.slice(0, 10)
            const dayLines = lines.get(day) ?? []
            dayLines.push(callLine(call))
            lines.set(day, dayLines)
          }
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
        },
      }
    )
    const seconds = (performance.now() - started) / 1000
    console.log(
      `[P4] multi-year workbook: ${result.totalRows} calls on ${result.sheets.length} sheets ` +
        `read in ${seconds.toFixed(1)} s, peak RSS ${Math.round(peakRss / 1e6)} MB (test process)`
    )
    expect(result.errors).toEqual([])
    expect(result.totalRows).toBe(387_921)

    const fromBook = new Map(
      [...lines].map(([day, dayLines]) => [
        day,
        summarizeDays(dayLines.map((line) => lineToCall(line))).get(day)!,
      ])
    )
    const fromCsv = summarizeDays(await readCsv(csv('calls_history.csv.gz')))
    expect(fromBook.size).toBe(fromCsv.size)
    expect(new Map([...fromBook].sort())).toEqual(fromCsv)
  })
})

// The fingerprint line back into values (the reader never writes NULLs).
function lineToCall(line: string): CallValues {
  const [startTs, inQueue, agent, abandon, routing, abandoned] = line.split('|')
  return {
    startTs: startTs!,
    inQueueSec: Number(inQueue),
    agentSec: Number(agent),
    abandonSec: Number(abandon),
    routingSec: Number(routing),
    abandoned: abandoned === '1',
  }
}
