// Number formats of the Accuracy tab (components/admin/accuracy).

const US = 'en-US'

// A count of calls. Counted calls are whole and show no decimals; a forecast or an
// average passes `fixed`, so a column keeps the same number of decimals on every row.
export function accuracyCalls(n: number, digits = 1, fixed = false): string {
  return n.toLocaleString(US, {
    minimumFractionDigits: fixed ? digits : 0,
    maximumFractionDigits: digits,
  })
}

// A difference with its sign: +12.5, −3 (a true minus sign).
export function accuracySigned(n: number, digits = 1, suffix = ''): string {
  const rounded = Number(n.toFixed(digits))
  const text = Math.abs(rounded).toLocaleString(US, { maximumFractionDigits: digits })
  if (rounded === 0) return `0${suffix}`
  return `${rounded > 0 ? '+' : '−'}${text}${suffix}`
}

export function accuracyPct(n: number | null, digits = 1): string {
  return n === null ? '–' : `${n.toFixed(digits)}%`
}
