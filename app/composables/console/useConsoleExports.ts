// The three exports of the console (exportCsv, exportPng, exportReport of final-main's
// web/app.js): same file names, same content.
import { csvRows, toCsv } from '~/utils/console/logic'
import { buildReport } from '~/utils/console/report'
import { drawGridPng } from '~/utils/console/png'
import { isoDate, pad2 } from '~/utils/console/format'
import type { ConsoleState } from './useConsoleState'

// The report opens in a new window with the print dialog, so "Save as PDF" gives the
// file. If the browser blocks the window, the same page downloads as HTML.
const PRINT_DELAY_MS = 250

function download(name: string, blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(a.href)
    a.remove()
  }, 0)
}

function localStamp(d: Date): string {
  return `${isoDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function useConsoleExports(state: ConsoleState) {
  function exportCsv() {
    const { cache, computedHours, judged } = state.snapshot()
    if (!cache) return
    const csv = toCsv(csvRows(computedHours, judged))
    download(
      `v4w-staffing-${cache.window.start}-to-${cache.window.end}.csv`,
      new Blob([csv], { type: 'text/csv' })
    )
  }

  // The grid is redrawn on a canvas from the computed hours, not screenshotted, so the
  // export never depends on scroll position, viewport or theme.
  function exportPng() {
    const { cache, judged, hourIndex, scale } = state.snapshot()
    if (!cache) return
    const cv = document.createElement('canvas')
    drawGridPng(cv, {
      start: cache.window.start,
      end: cache.window.end,
      efficiencyText: state.ctl.effNum,
      serviceLevelText: state.ctl.slNum,
      targetSec: state.targetSec(),
      sourceLabel: cache.source ? cache.source.label : '',
      tours: state.visibleTours(),
      days: judged,
      hourIndex,
      levelOf: scale.levelOf,
      exportedAt: new Date(),
    })
    cv.toBlob((blob) => {
      if (blob) {
        download(`v4w-staffing-grid-${cache.window.start}-to-${cache.window.end}.png`, blob)
      }
    }, 'image/png')
  }

  function exportReport() {
    const { cache, computedHours, judged } = state.snapshot()
    if (!cache || computedHours.length === 0) {
      state.showError('Nothing to report yet: wait for the forecast to load, then try again.')
      return
    }
    const c = state.controls()
    let html: string
    try {
      html = buildReport({
        start: cache.window.start,
        end: cache.window.end,
        settings: {
          efficiencyPct: Number(state.ctl.effNum),
          slPct: Number(state.ctl.slNum),
          targetSec: c.targetSec,
          patienceSec: c.patienceSec,
        },
        sourceLabel: cache.source ? cache.source.label : '',
        caveat: cache.window.caveat || '',
        generatedAt: localStamp(new Date()),
        hours: computedHours,
        days: judged,
      })
    } catch (err) {
      state.showError(`The report could not be built (${(err as Error).message}).`)
      return
    }
    const name = `v4w-staffing-report-${cache.window.start}-to-${cache.window.end}`
    const w = window.open('', '_blank')
    if (!w) {
      download(`${name}.html`, new Blob([html], { type: 'text/html' }))
      return
    }
    // The report is a whole document built by buildReport (every value escaped there).
    w.document.open()
    w.document.write(html)
    w.document.close()
    w.focus()
    setTimeout(() => w.print(), PRINT_DELAY_MS)
  }

  return { exportCsv, exportPng, exportReport }
}
