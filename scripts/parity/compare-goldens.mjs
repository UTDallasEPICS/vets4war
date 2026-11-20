// Replays the 44 recorded requests of the legacy (final-main) API against a running new
// server and compares every answer with the recorded one (rules: ./compare.mjs). Parity
// rung P3 (docs/testing.md): legacy goldens of the SYNTHETIC reference stack.
//
//   node scripts/parity/compare-goldens.mjs --base http://localhost:3000 \
//     --golden <legacy>/golden/a --db <the server's SQLite file> --email admin@example.org \
//     [--only <name>] [--json <report file>]
//
// Requests come from <golden>/../requests.json, answers from <golden>/<name>.json. Signs
// in through scripts/lib/dev-signin.mjs (reads the code from --db). Prints PASS/FAIL per
// golden with up to five differences, WARN lines, then the totals; exits 1 when any failed.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { devSignIn } from '../lib/dev-signin.mjs'
import { compareAnswer, formatDifference } from './compare.mjs'

const MAX_SHOWN = 5

function usage(message) {
  if (message) console.error(message)
  console.error(
    'usage: node scripts/parity/compare-goldens.mjs --base <url> --golden <dir> --db <sqlite file> ' +
      '--email <address> [--only <name>] [--json <report file>]'
  )
  process.exit(2)
}

function requestUrl(base, request) {
  const url = new URL(request.path, base)
  for (const [key, value] of Object.entries(request.params ?? {})) {
    url.searchParams.set(key, String(value))
  }
  return url
}

async function replay(base, cookie, request) {
  const headers = { cookie, accept: 'application/json' }
  const init = { method: request.method, headers }
  if (request.json !== undefined) {
    headers['content-type'] = 'application/json'
    headers.origin = new URL(base).origin
    init.body = JSON.stringify(request.json)
  }
  const started = performance.now()
  const response = await fetch(requestUrl(base, request), init)
  const text = await response.text()
  const ms = Math.round(performance.now() - started)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body, ms }
}

async function main() {
  let values
  try {
    ;({ values } = parseArgs({
      options: {
        base: { type: 'string' },
        golden: { type: 'string' },
        db: { type: 'string' },
        email: { type: 'string' },
        only: { type: 'string' },
        json: { type: 'string' },
      },
    }))
  } catch (error) {
    usage(error.message)
  }
  if (!values.base || !values.golden || !values.db || !values.email)
    usage('missing a required option')

  const goldenDir = resolve(values.golden)
  const requests = JSON.parse(readFileSync(join(dirname(goldenDir), 'requests.json'), 'utf8'))
  const selected = values.only ? requests.filter((r) => r.name === values.only) : requests
  if (!selected.length) usage(`no request named ${values.only}`)

  const { cookie } = await devSignIn({
    baseUrl: values.base,
    dbPath: values.db,
    email: values.email,
  })

  const report = { base: values.base, golden: goldenDir, results: [] }
  let passed = 0
  let failed = 0
  let warned = 0
  for (const request of selected) {
    const expected = JSON.parse(readFileSync(join(goldenDir, `${request.name}.json`), 'utf8'))
    let actual
    try {
      actual = await replay(values.base, cookie, request)
    } catch (error) {
      actual = { status: 0, body: String(error), ms: 0 }
    }
    const { differences, warnings } = compareAnswer(expected, actual, { requestPath: request.path })
    const ok = differences.length === 0
    if (ok) passed += 1
    else failed += 1
    warned += warnings.length
    console.log(`${ok ? 'PASS' : 'FAIL'} ${request.name} (${actual.status}, ${actual.ms} ms)`)
    for (const d of differences.slice(0, MAX_SHOWN)) console.log(`    ${formatDifference(d)}`)
    if (differences.length > MAX_SHOWN)
      console.log(`    ... ${differences.length - MAX_SHOWN} more`)
    if (!ok && actual.status !== 200 && expected.status === 200) {
      console.log(`    answer: ${JSON.stringify(actual.body).slice(0, 300)}`)
    }
    for (const w of warnings) console.log(`    WARN ${formatDifference(w)}`)
    report.results.push({
      name: request.name,
      ok,
      status: actual.status,
      expected_status: expected.status,
      ms: actual.ms,
      differences: differences.length,
      first_differences: differences.slice(0, MAX_SHOWN),
      warnings,
    })
  }
  console.log(`${passed} passed, ${failed} failed, ${warned} warnings`)
  report.totals = { passed, failed, warnings: warned }
  if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`)
  process.exit(failed ? 1 : 0)
}

await main()
