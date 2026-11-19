// Text and rounding rules the API shares with final-main's Python, so answers match
// the old ones digit for digit.

// api/main.py: format_duration. 152280 -> '42h 18m'; under an hour -> '18m'.
// Minutes round half up; no thousands separator.
export function formatDuration(seconds: number): string {
  const total = Math.floor(seconds / 60 + 0.5)
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

// Python's round(x, digits) for a float: correctly rounded from the double's exact
// binary value, and an exact tie goes to the even digit. toFixed is exact too but
// breaks ties away from zero, so ties are found in the exact decimal expansion (a
// tie has at most digits + 1 decimals, so 100 digits of toFixed show it exactly).
export function pyRound(x: number, digits: number): number {
  if (!Number.isInteger(digits) || digits < 0 || digits > 20) {
    throw new RangeError(`digits must be an integer in 0..20, got ${digits}`)
  }
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x
  const magnitude = Math.abs(x)
  const [intPart = '0', frac = ''] = magnitude.toFixed(100).split('.')
  const rest = frac.slice(digits)
  let text = magnitude.toFixed(digits)
  if (rest[0] === '5' && /^0*$/.test(rest.slice(1))) {
    const kept = frac.slice(0, digits)
    const lastDigit = Number(digits === 0 ? intPart[intPart.length - 1] : kept[kept.length - 1])
    if (lastDigit % 2 === 0) text = digits === 0 ? intPart : `${intPart}.${kept}`
  }
  const rounded = Number(text)
  return x < 0 ? -rounded : rounded
}
