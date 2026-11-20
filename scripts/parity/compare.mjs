// Comparison rules for the legacy goldens (parity rung P3, docs/testing.md), shared by
// scripts/parity/compare-goldens.mjs (live server) and tests/server/forecast/golden.test.ts
// (frozen fixture), so both judge an answer the same way.
//
//   compareAnswer(expected, actual, { path }) -> { differences, warnings }
//     expected / actual: { status, body }
//
// - status exact; for a non-200 answer only the status is compared (the old 422 bodies
//   are FastAPI's, ours are the Nuxt error shape);
// - same key sets (order ignored) and array lengths;
// - booleans, nulls, strings exact; two integers exact; any other pair of numbers within
//   abs 1e-9 + rel 1e-9 (Python and V8 differ in the last digits);
// - days[].predicted_calls and days[].shifts.*.predicted_calls (rounded to 2 decimals on
//   both sides from sums taken in a different order) within 0.0100001;
// - expected_talk strings exact, except that a one-minute difference is a WARNING when the
//   matching expected_talk_sec agree within 1e-6 (a sum that lands on half a minute);
// - /api/model created_at_utc is ignored (the time of the training run).

export const ABS_TOLERANCE = 1e-9
export const REL_TOLERANCE = 1e-9
export const ROUNDED_TOLERANCE = 0.0100001
export const TALK_SEC_TOLERANCE = 1e-6

const ROUNDED_PATHS = [
  /^days\[\d+\]\.predicted_calls$/,
  /^days\[\d+\]\.shifts\.[A-Za-z]+\.predicted_calls$/,
]

function kind(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function minutesOf(text) {
  const match = /^(?:(\d+)h )?(\d+)m$/.exec(text)
  if (!match) return null
  return Number(match[1] ?? 0) * 60 + Number(match[2])
}

function join(path, key) {
  return typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key
}

function numbersAgree(expected, got, path) {
  if (Number.isInteger(expected) && Number.isInteger(got)) return expected === got
  const diff = Math.abs(expected - got)
  if (ROUNDED_PATHS.some((re) => re.test(path))) return diff <= ROUNDED_TOLERANCE
  return diff <= ABS_TOLERANCE + REL_TOLERANCE * Math.abs(expected)
}

function walk(expected, got, path, out, ctx) {
  const ek = kind(expected)
  const gk = kind(got)
  if (ek !== gk) {
    out.differences.push({ path, expected, got, why: `type ${ek} vs ${gk}` })
    return
  }
  if (ek === 'array') {
    if (expected.length !== got.length) {
      out.differences.push({
        path: `${path}.length`,
        expected: expected.length,
        got: got.length,
        why: 'array length',
      })
      return
    }
    expected.forEach((item, i) => walk(item, got[i], join(path, i), out, ctx))
    return
  }
  if (ek === 'object') {
    const ignored = ctx.ignoreKeys(path)
    const eKeys = Object.keys(expected).filter((k) => !ignored.includes(k))
    const gKeys = Object.keys(got).filter((k) => !ignored.includes(k))
    const missing = eKeys.filter((k) => !(k in got))
    const extra = gKeys.filter((k) => !(k in expected))
    if (missing.length || extra.length) {
      out.differences.push({
        path: path || '(root)',
        expected: eKeys.slice().sort(),
        got: gKeys.slice().sort(),
        why: `keys missing [${missing.join(', ')}] extra [${extra.join(', ')}]`,
      })
    }
    for (const key of eKeys) {
      if (key in got)
        walk(expected[key], got[key], join(path, key), out, {
          ...ctx,
          parent: expected,
          gotParent: got,
        })
    }
    return
  }
  if (ek === 'number') {
    if (!numbersAgree(expected, got, path))
      out.differences.push({ path, expected, got, why: 'number' })
    return
  }
  if (expected === got) return
  if (ek === 'string' && path.endsWith('expected_talk')) {
    const em = minutesOf(expected)
    const gm = minutesOf(got)
    const eSec = ctx.parent?.expected_talk_sec
    const gSec = ctx.gotParent?.expected_talk_sec
    if (
      em !== null &&
      gm !== null &&
      Math.abs(em - gm) === 1 &&
      typeof eSec === 'number' &&
      typeof gSec === 'number' &&
      Math.abs(eSec - gSec) <= TALK_SEC_TOLERANCE
    ) {
      out.warnings.push({
        path,
        expected,
        got,
        why: `one minute apart at expected_talk_sec ${eSec}`,
      })
      return
    }
  }
  out.differences.push({ path, expected, got, why: ek })
}

// `requestPath` is the API path of the request ('/api/model', ...).
export function compareAnswer(expected, actual, { requestPath } = {}) {
  const out = { differences: [], warnings: [] }
  if (expected.status !== actual.status) {
    out.differences.push({
      path: 'status',
      expected: expected.status,
      got: actual.status,
      why: 'status',
    })
    return out
  }
  if (expected.status !== 200) return out
  const ignoreKeys = (path) =>
    requestPath === '/api/model' && path === '' ? ['created_at_utc'] : []
  walk(expected.body, actual.body, '', out, { ignoreKeys })
  return out
}

export function formatDifference(d) {
  const show = (v) => {
    const text = JSON.stringify(v)
    return text && text.length > 160 ? `${text.slice(0, 157)}...` : text
  }
  return `${d.path}: expected ${show(d.expected)} got ${show(d.got)} (${d.why})`
}
