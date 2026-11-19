// The PNG export of the staffing console (exportPng of final-main's web/app.js). The
// grid is redrawn on a canvas from the computed hours, not screenshotted, so the export
// never depends on scroll position, viewport or theme. It shows the hours currently
// shown.
import { EVENING_CAP, MAX_STAFF_PER_SHIFT, key } from './logic'
import type { ComputedHour, JudgedDay, ShiftSpec } from './logic'
import { dayLabel, pad2 } from './format'

export const PNG = {
  cell: 34,
  row: 30,
  date: 120,
  roster: 52,
  pad: 20,
  head: 64,
  lo: '#f4f4f4',
  hi: '#1a4be0',
  bg: '#ffffff',
  ink: '#111111',
  mute: '#6b6b6b',
  amber: '#9a5b00',
  amberBg: '#fbefd9',
  red: '#c5301c',
  rosterBg: '#f4f4f4',
  green: '#17713f',
  maxMix: 0.85,
} as const

const UNDEF = '-'
const MAJOR_HOURS = new Set([0, 6, 12, 18])
// above this heat level the numeral takes the deep-cell ink
const DEEP_LEVEL = 0.6

export interface PngInput {
  start: string
  end: string
  // the efficiency and service-level fields as typed (percent)
  efficiencyText: string
  serviceLevelText: string
  targetSec: number
  sourceLabel: string
  tours: { spec: ShiftSpec; hours: number[] }[]
  days: JudgedDay<{ date: string; holiday?: string | null }>[]
  hourIndex: Map<string, ComputedHour>
  levelOf: (staff: number) => number
  exportedAt: Date
}

function hexToRgb(h: string): number[] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a)
  const B = hexToRgb(b)
  return `rgb(${A.map((x, i) => Math.round(x + (B[i]! - x) * t)).join(',')})`
}

interface Col {
  h?: number
  tour?: ShiftSpec
  x: number
  w: number
}

// Draws the grid on `cv` (resized to fit) at twice the CSS pixel size.
export function drawGridPng(cv: HTMLCanvasElement, input: PngInput): void {
  const P = PNG
  const font = 'system-ui, -apple-system, Inter, sans-serif'
  const cols: Col[] = []
  input.tours.forEach((t) => {
    t.hours.forEach((h) => cols.push({ h, x: 0, w: 0 }))
    cols.push({ tour: t.spec, x: 0, w: 0 })
  })
  let x = P.pad + P.date
  cols.forEach((col) => {
    col.x = x
    col.w = col.tour ? P.roster : P.cell
    x += col.w + 2
  })
  const W = x + P.pad
  const H = P.pad * 2 + P.head + input.days.length * (P.row + 2) + 24
  cv.width = W * 2
  cv.height = H * 2
  const g = cv.getContext('2d')
  if (!g) return
  g.scale(2, 2)
  g.fillStyle = P.bg
  g.fillRect(0, 0, W, H)
  g.textAlign = 'left'
  g.font = `600 14px ${font}`
  g.fillStyle = P.ink
  g.fillText(
    `Vets4Warriors: people to schedule per hour, ${input.start} to ${input.end}`,
    P.pad,
    P.pad + 12
  )
  g.font = `11px ${font}`
  g.fillStyle = P.mute
  g.fillText(
    `Efficiency ${input.efficiencyText}% · ${input.serviceLevelText}% answered within ${input.targetSec} s · ${input.sourceLabel}`,
    P.pad,
    P.pad + 28
  )
  const y0 = P.pad + P.head
  g.textAlign = 'center'
  cols.forEach((col) => {
    g.font = `${col.tour ? 600 : 400} 10px ${font}`
    g.fillStyle = col.tour || MAJOR_HOURS.has(col.h!) ? P.ink : P.mute
    g.fillText(col.tour ? `${col.tour.short} roster` : pad2(col.h!), col.x + col.w / 2, y0 - 6)
  })
  input.days.forEach((day, r) => {
    const y = y0 + r * (P.row + 2)
    g.textAlign = 'left'
    g.font = `12px ${font}`
    g.fillStyle = P.ink
    g.fillText(`${dayLabel(day.date)}${day.holiday ? ' •' : ''}`, P.pad, y + 19)
    g.textAlign = 'center'
    g.font = `600 12px ${font}`
    cols.forEach((col) => {
      if (col.tour) {
        const p = day.planned[col.tour.name]
        g.fillStyle = P.rosterBg
        g.fillRect(col.x, y, col.w, P.row)
        g.fillStyle =
          p.verdict === null
            ? P.mute
            : !p.is_own
              ? P.ink
              : p.verdict === 'on target'
                ? P.green
                : p.verdict === 'overstaffed'
                  ? P.amber
                  : P.red
        g.fillText(
          p.planned === null ? UNDEF : `${p.planned}${p.is_own ? '*' : ''}`,
          col.x + col.w / 2,
          y + 19
        )
        return
      }
      const hr = input.hourIndex.get(key(day.date, col.h!))
      if (!hr) return
      const st = hr.cap_state
      const lvl = st === 'under' ? input.levelOf(hr.staff_to_schedule as number) : 0
      g.fillStyle =
        st === 'over' ? P.red : st === 'at' ? P.amberBg : mix(P.lo, P.hi, lvl * P.maxMix)
      g.fillRect(col.x, y, col.w, P.row)
      if (st === 'at') {
        g.strokeStyle = P.amber
        g.lineWidth = 2
        g.strokeRect(col.x + 1, y + 1, col.w - 2, P.row - 2)
      }
      g.fillStyle = st === 'over' || lvl > DEEP_LEVEL ? '#fff' : st === 'at' ? P.amber : P.ink
      g.fillText(
        hr.staff_to_schedule === null ? UNDEF : String(hr.staff_to_schedule),
        col.x + col.w / 2,
        y + 19
      )
    })
  })
  g.textAlign = 'left'
  g.font = `10px ${font}`
  g.fillStyle = P.mute
  g.fillText(
    `Red: over the shift cap (${MAX_STAFF_PER_SHIFT}; Evening ${EVENING_CAP}), never clamped. Amber: at the cap. Blue: under, one shade per person. * = your planned number. Exported ${input.exportedAt.toISOString().slice(0, 16).replace('T', ' ')}.`,
    P.pad,
    H - P.pad + 6
  )
}
