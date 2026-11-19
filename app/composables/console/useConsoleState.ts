// The behaviour of the staffing console: final-main's web/app.js, function by function.
// All numbers come from app/utils/console (logic.ts and the shared arithmetic
// underneath); this file reads the controls, keeps the cached forecast, and turns each
// of the old page's render steps into a view model that the components draw. The view
// models change at the same moments the old page rewrote its DOM, so what is on screen
// (including what stays on screen after a failed load) follows the old page.
//
// Data flow:
//   date range / holidays change   -> fetch /api/forecast (network)
//   efficiency / service level     -> recompute() in the browser (no network)
//   hours shown                    -> rebuild the grid columns (no network)
//   planned value edited           -> store + re-judge that shift (no network)
import { computed, inject, nextTick, provide, reactive, ref, shallowRef } from 'vue'
import type { InjectionKey } from 'vue'
import type {
  DataSource,
  ForecastDay,
  ForecastParams,
  HolidayCoverage,
  QuickHangups,
  WindowSummary,
} from '#shared/types/api'
import { MAX_TARGET_PCT, MAX_TARGET_SEC } from '#shared/utils/constants'
import {
  SHIFTS,
  SECONDS_PER_HOUR,
  abandonedOneFewer,
  capState,
  computeHours,
  dayStats,
  diffCells,
  discreteScale,
  judgeRoster,
  key as hourKey,
  peakHours,
  rollupShifts,
  rosterOutcome,
  shiftKey,
  shiftTradeoff,
  summarize,
} from '~/utils/console/logic'
import type {
  BaseHour,
  CapState,
  ComputedHour,
  Controls,
  JudgedDay,
  Roster,
  Scale,
  ShiftSpec,
} from '~/utils/console/logic'
import { AXIS_HOURS, daySplit, share, shiftSplit, topOf } from '~/utils/console/charts'
import {
  BAR_PX,
  UNDEF,
  atRoster,
  focusPct,
  misses,
  rowSpecs,
  whole,
} from '~/utils/console/dayfocus'
import {
  clampInt,
  clampTenth,
  dayLabel,
  formatDurationUi as formatDuration,
  isoDate,
  localDate,
  longDate,
  pad2,
  pct,
  shortDate,
  verdictClass,
  verdictShort,
} from '~/utils/console/format'
import { countTo, pulse } from '~/utils/console/motion'
import { useForecast } from './useForecast'
import { usePlannedStore } from './usePlannedStore'

const DEBOUNCE_MS = 60
const CHANGED_VISIBLE_MS = 2500
const DEFAULT_HORIZON_DAYS = 30
const SECONDS_PER_MINUTE = 60
export const MAJOR_HOURS = new Set([0, 6, 12, 18])
export const SL_MIN = 80
export const SL_MAX = 95
const SL_STANDARD = 90
// above this heat level the numeral takes the deep-cell ink
const DEEP_LEVEL = 0.6
const THUMB_PX = 20
// Narrowest the grid columns may get, in px (mirrors the compact col rules of the
// stylesheet). Above this the 24 hours always fit the panel; below it (phones) the grid
// scrolls sideways instead.
const GRID_PX = { date: 128, hour: 24, roster: 78, gap: 3, tourGap: 10 }
// how long the freshly loaded table keeps its single fade
const ROW_FADE_MS = 300
// tallest bar in the calls-per-hour strip
const PROFILE_BAR_PX = 26
// Day chart: above these many days the per-day numbers, then the labels, no longer fit.
const DAY_VALUES_MAX = 35
const DAY_LABELS_MAX = 62
// The partner's own efficiency calculator: 315 of 480 shift minutes on inbound =
// 65.625%, shown to one decimal.
export const DEFAULT_EFF_PCT = 65.6
// What the partner actually staffed Oct 14-20 2026 (validation file).
export const CURRENT_ROSTER: Roster = { Overnight: 4, Day: 4, Evening: 6 }
// Staff-per-shift sliders go to this, above the shift caps, so what-ifs are not cut off.
export const ROSTER_SLIDER_MAX = 10
// The answer-time field's own cap, as on the old page (its markup keeps max="3600" so
// the page compares equal to the old one). It is not what the read API accepts: that
// bound, and the one on the service level, are MAX_TARGET_SEC and MAX_TARGET_PCT of
// shared/utils/constants.ts, and controlProblem() below refuses a setting past them.
const TSEC_MAX = 3600
const TSEC_DEFAULT = 30

export interface Cache {
  key: string
  hours: BaseHour[]
  days: ForecastDay[]
  window: WindowSummary
  params: ForecastParams
  source: DataSource
  coverage: HolidayCoverage
  quick: QuickHangups | null
}
export type Judged = JudgedDay<ForecastDay>
export type View =
  { type: 'hour'; key: string } | { type: 'day'; date: string } | { type: 'selection' }
export interface Selection {
  dates: string[]
  hours: [number, number]
}
export interface VisibleTour {
  spec: ShiftSpec
  hours: number[]
}

// ---- view models: what each old render step wrote ----
export interface GridVm {
  tours: VisibleTour[]
  rows: GridRowVm[]
  minWidth: string
}
export interface GridRowVm {
  date: string
  cls: string
  index: number
  title: string
  weekday: string
  dayMonth: string
  meta: string
}
export interface CellVm {
  cls: string
  lvl: string
  text: string
  over: { cl: string; cap: number } | null
  aria: string
  title: string
}
export interface ProfileVm {
  title: string
  pv: string
  height: string
}
export interface RosterCellVm {
  cls: string
  placeholder: string
  own: string
  verdictCls: string
  verdictText: string
  lost: string | null
  title: string
}
export interface LeadVm {
  count: string
  figs: [string, string][]
  note: string
}
export interface StatVm {
  k: string
  v: string
  d: string
}
export type StoryVm =
  | { kind: 'plain'; text: string }
  | {
      kind: 'gap'
      gap: string
      ratio: string
      rest: string
      fewer: { from: string; to: string } | null
    }
export interface SplitVm {
  ownWidth: string
  ownText: string
  recWidth: string
  recText: string
  title: string
}
export interface DayBarVm {
  date: string
  cls: string
  weekday: string
  dayNumber: number
}
export interface DayBarPatch {
  dv: string
  roster: string
  rec: string
  label: string
}
export interface DayListRowVm {
  date: string
  cls: string
  weekday: string
  date_: string
  calls: string
  holiday: string | null
  chips: { cls: string; text: string }[]
  lost: string
  rec: string
}
export interface FocusVm {
  tours: { name: string; span: string; count: number }[]
  firstOfTour: Set<number>
  hours: {
    key: string
    hour: number
    title: string
    fv: string
    height: string
  }[]
  rows: (
    | { section: string; tone: string }
    | { label: string; cells: { key: string; cls: string; text: string }[] }
  )[]
  list: {
    tours: {
      name: string
      span: string
      rows: {
        key: string
        hh: string
        width: string
        calls: string
        recCls: string
        recMiss: boolean
        recStaff: string
        recLevel: string
        ownMiss: boolean
        ownStaff: string
        ownLevel: string
      }[]
    }[]
  }
}
export interface HourBarsVm {
  bars: { cls: string; height: string; title: string }[]
  label: string
  axis: { left: string; text: string }[]
}
export interface LineVm {
  k: string
  v: string
  f: string
  cls: string
}
export interface TradeoffVm {
  name: string
  span: string
  calls: number
  cap: number
  targetSec: number
  rows: {
    cls: string
    staff: number
    label: string | null
    effective: number
    sl: string
    lostShare: string
    lost: number
    late: number
  }[]
}
export type SheetBodyVm =
  | {
      kind: 'hour'
      chips: { cls: string; text: string }[]
      capState: CapState
      staff: string
      bars: HourBarsVm | null
      lines: LineVm[]
      reason: string | null
      foot: { date: string; focus: boolean } | null
    }
  | { kind: 'selection'; hint: string; tiles: [string, string][] }
  | { kind: 'missing'; hint: string }
  | {
      kind: 'day'
      holiday: string | null
      tiles: [string, string][]
      bars: HourBarsVm | null
      tours: {
        name: string
        need: string
        planned: string
        following: boolean
        verdictCls: string
        verdict: string
        level: string | null
      }[]
      lines: LineVm[]
      tradeoffs: TradeoffVm[]
      hint: string
      foot: { date: string } | null
    }

const KEY: InjectionKey<ConsoleState> = Symbol('v4w-console')

export function provideConsoleState(state: ConsoleState) {
  provide(KEY, state)
}
export function useConsole(): ConsoleState {
  const state = inject(KEY)
  if (!state) throw new Error('useConsole() outside the console root')
  return state
}

export type ConsoleState = ReturnType<typeof createConsoleState>

export function createConsoleState() {
  const store = usePlannedStore()
  const forecast = useForecast()

  // ---- the controls, as the old page's input values (strings) ----
  const ctl = reactive({
    start: '',
    end: '',
    eff: String(DEFAULT_EFF_PCT),
    effNum: String(DEFAULT_EFF_PCT),
    sl: '80',
    slNum: '80',
    tsec: '30',
    hFrom: '0',
    hTo: '23',
    holidays: true,
    rosterO: '4',
    rosterD: '4',
    rosterE: '6',
  })

  // ---- state ----
  let cache: Cache | null = null
  let computedHours: ComputedHour[] = []
  let judged: Judged[] = []
  let hourIndex = new Map<string, ComputedHour>()
  let scale: Scale = { lo: 0, hi: 0, steps: 1, levelOf: () => 0 }
  const view = shallowRef<View | null>(null)
  const selection = shallowRef<Selection | null>(null)
  // the date range to go back to when one-day mode ends
  const dayMode = shallowRef<{ start: string; end: string } | null>(null)
  let changedTimer: ReturnType<typeof setTimeout> | undefined

  // ---- what the page shows ----
  const ui = reactive({
    isLoading: false,
    ready: false,
    pageSub: 'Loading the forecast',
    badgeCls: 'badge src-unlabeled',
    badgeText: 'Checking data source',
    badgeHidden: false,
    errorHidden: true,
    errorText: '',
    controlProblem: '',
    noForecast: false,
    holidayNoteHidden: true,
    holidayNote: '',
    changedText: '',
    changedQuiet: true,
    dockOpen: false,
    legendRange: '',
    caveat: '',
    dayFocusTitle: 'One day, hour by hour',
    sheetTitle: 'Details',
    rowsFresh: false,
    // Which preset the roster sliders match: the partner's current 4/4/6, our
    // recommendation, or neither (shown as "Custom").
    rosterPreset: 'current' as 'current' | 'recommended' | 'custom',
  })
  const grid = shallowRef<GridVm>({ tours: [], rows: [], minWidth: '' })
  const cells = shallowRef(new Map<string, CellVm>())
  const peaks = shallowRef(new Set<number>())
  const profile = shallowRef(new Map<number, ProfileVm | null>())
  const rosterCells = shallowRef(new Map<string, RosterCellVm>())
  const rosterStat = shallowRef<LeadVm | null>(null)
  const recStat = shallowRef<LeadVm | null>(null)
  const leadRender = ref(0)
  const summaryTiles = shallowRef<StatVm[]>([])
  const story = shallowRef<StoryVm | null>(null)
  const split = shallowRef(new Map<string, SplitVm>())
  const dayChart = shallowRef<{ cls: string; bars: DayBarVm[] }>({ cls: 'daybars', bars: [] })
  const dayChartPatch = shallowRef(new Map<string, DayBarPatch>())
  const dayList = shallowRef<DayListRowVm[] | null>(null)
  const dayFocus = shallowRef<FocusVm | null>(null)
  const sheetBody = shallowRef<SheetBodyVm | null>(null)
  const gridNote = ref('')

  const sheetOpen = computed(() => view.value !== null)
  const oneDay = computed(() => dayMode.value !== null)

  // ---- helpers ----
  function targetSec(): number {
    const v = Number(ctl.tsec)
    return Number.isFinite(v) && v >= 0 ? Math.min(v, TSEC_MAX) : TSEC_DEFAULT
  }
  function patienceSec(): number | null {
    return cache ? cache.params.patience_sec : null
  }
  function rawControls(): Controls {
    return {
      efficiency: Number(ctl.effNum) / 100,
      targetPct: Number(ctl.slNum) / 100,
      targetSec: targetSec(),
      patienceSec: patienceSec(),
    }
  }
  // What the efficiency, service-level and answer-time fields hold is used as typed (as
  // on the old page) while the arithmetic and the read API accept it. A value they
  // refuse (the old page threw and silently stopped updating, or sent a value the API
  // now refuses) leaves the page on the last valid setting, with a message, until the
  // field is corrected or snaps back when it loses focus.
  let lastValid: Controls | null = null
  function controlProblem(c: Controls): string | null {
    if (!(c.efficiency >= 0 && c.efficiency <= 1)) {
      return 'Staff efficiency must be a number from 0 to 100%.'
    }
    // 1 to 99 whole or decimal percent: sent with two decimals that is 0.01 to 0.99,
    // inside the read API's 0 < target_pct <= MAX_TARGET_PCT
    const sent = Number(c.targetPct.toFixed(2))
    if (!(c.targetPct >= 0.01 && c.targetPct <= 0.99 && sent <= MAX_TARGET_PCT)) {
      return 'Calls answered in time must be a number from 1 to 99%.'
    }
    if (c.targetSec > MAX_TARGET_SEC) {
      return `Answer time must be a number from 0 to ${MAX_TARGET_SEC} s.`
    }
    return null
  }
  function controls(): Controls {
    const c = rawControls()
    if (controlProblem(c) === null || lastValid === null) {
      lastValid = c
      return c
    }
    return { ...lastValid, patienceSec: c.patienceSec }
  }
  function checkControls() {
    const problem = controlProblem(rawControls())
    ui.controlProblem = problem
      ? `${problem} The numbers below are for the last valid setting.`
      : ''
  }
  const rangeKey = () => `${ctl.start}|${ctl.end}|${ctl.holidays}`
  function hourRange(): [number, number] {
    const a = Number(ctl.hFrom)
    const b = Number(ctl.hTo)
    return [Math.min(a, b), Math.max(a, b)]
  }
  function inHours(h: number) {
    const [a, b] = hourRange()
    return h >= a && h <= b
  }
  // Visible columns, tour by tour: hour cells, then the tour's roster cell. A tour with
  // no visible hours drops out, roster included.
  function visibleTours(): VisibleTour[] {
    return SHIFTS.map((spec) => ({ spec, hours: spec.core.filter(inHours) })).filter(
      (t) => t.hours.length > 0
    )
  }

  // ---- controls: sync + feedback ----
  function roster(): Roster {
    return {
      Overnight: clampInt(ctl.rosterO, 0, ROSTER_SLIDER_MAX, CURRENT_ROSTER.Overnight),
      Day: clampInt(ctl.rosterD, 0, ROSTER_SLIDER_MAX, CURRENT_ROSTER.Day),
      Evening: clampInt(ctl.rosterE, 0, ROSTER_SLIDER_MAX, CURRENT_ROSTER.Evening),
    }
  }
  function paintRoster(r: Roster) {
    ctl.rosterO = String(r.Overnight)
    ctl.rosterD = String(r.Day)
    ctl.rosterE = String(r.Evening)
    updateRosterPreset()
  }
  const sameRoster = (a: Roster, b: Roster) =>
    a.Overnight === b.Overnight && a.Day === b.Day && a.Evening === b.Evening
  function updateRosterPreset() {
    const value = roster()
    if (sameRoster(value, CURRENT_ROSTER)) ui.rosterPreset = 'current'
    else if (judged.length > 0 && sameRoster(value, recommendedRoster()))
      ui.rosterPreset = 'recommended'
    else ui.rosterPreset = 'custom'
  }
  // Our recommended peak per shift over the loaded dates. Falls back to the current
  // value when the recommendation is undefined (efficiency 0).
  function recommendedRoster(): Roster {
    const now = roster()
    return Object.fromEntries(
      SHIFTS.map((spec) => {
        const peaksOf = judged
          .map((d) => d.shifts[spec.name].staff_needed)
          .filter((n): n is number => n !== null)
        return [
          spec.name,
          peaksOf.length ? Math.min(Math.max(...peaksOf), ROSTER_SLIDER_MAX) : now[spec.name],
        ]
      })
    ) as Roster
  }
  const fraction = (value: string, min: number, max: number) => (Number(value) - min) / (max - min)
  const fill = (value: string, min: number, max: number) =>
    (fraction(value, min, max) * 100).toFixed(1) + '%'
  // Thumb centre along a track, so marks line up with where the thumb sits.
  const along = (f: number) => `calc(${THUMB_PX / 2}px + (100% - ${THUMB_PX}px) * ${f.toFixed(4)})`
  const feedback = computed(() => {
    const [a, b] = hourRange()
    const r = roster()
    return {
      effFill: fill(ctl.eff, 0, 100),
      slFill: fill(ctl.sl, SL_MIN, SL_MAX),
      hoursA: along(a / 23),
      hoursB: along(b / 23),
      hoursVal: a === 0 && b === 23 ? 'All day' : `${pad2(a)}:00 to ${pad2(b)}:59`,
      rosterO: { label: String(r.Overnight), fill: fill(ctl.rosterO, 0, ROSTER_SLIDER_MAX) },
      rosterD: { label: String(r.Day), fill: fill(ctl.rosterD, 0, ROSTER_SLIDER_MAX) },
      rosterE: { label: String(r.Evening), fill: fill(ctl.rosterE, 0, ROSTER_SLIDER_MAX) },
    }
  })
  const at = (v: number) => (v - SL_MIN) / (SL_MAX - SL_MIN)
  const slMarks = {
    tickLeft: along(at(SL_STANDARD)),
  }
  function flashChanged(n: number) {
    ui.changedText = n > 0 ? `${n} hour${n === 1 ? '' : 's'} changed` : 'No hours changed'
    ui.changedQuiet = false
    clearTimeout(changedTimer)
    changedTimer = setTimeout(() => {
      ui.changedQuiet = true
    }, CHANGED_VISIBLE_MS)
  }

  // ---- fetch ----
  let inflight = 0
  // whether a load has ever told the page its data source
  let sourceShown = false
  async function refresh() {
    const k = rangeKey()
    if (cache && cache.key === k) {
      recompute()
      return
    }
    const id = ++inflight
    ui.isLoading = true
    try {
      const c = controls()
      const data = await forecast.load({
        start: ctl.start,
        end: ctl.end,
        includeHolidays: ctl.holidays,
        efficiency: c.efficiency,
        targetPct: c.targetPct,
        targetSec: c.targetSec,
      })
      if (id !== inflight) return
      cache = {
        key: k,
        hours: data.hours.map((h) => ({
          date: h.date,
          hour: h.hour,
          predicted_calls: h.predicted_calls,
          predicted_real_calls: h.predicted_real_calls,
          aht_sec: h.aht_sec,
        })),
        days: data.days,
        window: data.window,
        params: data.params,
        source: data.data_source,
        coverage: data.holiday_coverage,
        quick: data.quick_hangups || null,
      }
      ui.errorHidden = true
      ui.noForecast = false
      renderSourceBadge(cache.source)
      ui.holidayNoteHidden = !cache.coverage.message
      ui.holidayNote = cache.coverage.message || ''
      selection.value = null
      const v = view.value
      if (v && v.type === 'day' && !cache.days.some((d) => d.date === v.date)) closeSheet()
      if (view.value && view.value.type !== 'day') closeSheet()
      buildGrid(cache.days)
      buildDayChart(cache.days)
      ui.rowsFresh = true
      setTimeout(() => {
        ui.rowsFresh = false
      }, ROW_FADE_MS)
      computedHours = []
      recompute()
    } catch (err) {
      if (id !== inflight) return
      cache = null
      const failure = err as { code?: string; message?: string; data?: Record<string, unknown> }
      if (failure.code === 'no_forecast') {
        ui.noForecast = true
        ui.errorHidden = true
      } else {
        ui.noForecast = false
        ui.errorHidden = false
        ui.errorText =
          failure.code === 'outside_horizon'
            ? String(failure.message)
            : failure.code === 'implausible_patience'
              ? implausiblePatienceText(failure.data?.patience_sec)
              : `The forecast did not load (${failure.message}). Change a date to retry.`
      }
      // The answer is in: the header stops saying it is loading. A data source shown by an
      // earlier load stays (it does not depend on the dates); before any load there is
      // none to show.
      ui.pageSub =
        failure.code === 'no_forecast'
          ? 'No forecast yet'
          : failure.code === 'outside_horizon'
            ? 'No forecast for these dates'
            : 'The forecast did not load'
      if (!sourceShown) {
        ui.badgeHidden = true
        ui.badgeText = ''
      }
      grid.value = { ...grid.value, rows: [] }
      dayChart.value = { ...dayChart.value, bars: [] }
    } finally {
      if (id === inflight) {
        ui.isLoading = false
        ui.ready = true
      }
    }
  }
  // 503 implausible_patience: the forecast was written with a caller-patience estimate
  // the read API refuses to compute with. No date can work until an admin corrects the
  // call data, so the usual "Change a date to retry" would mislead; and the server's own
  // sentence ends with advice for someone calling the API (send patience_sec, or use
  // Erlang C), which this page has no controls for. So the page says it in its own words.
  function implausiblePatienceText(storedSec: unknown): string {
    const measured =
      typeof storedSec === 'number' && Number.isFinite(storedSec)
        ? `Measured from the call data, callers give up after ${Number(storedSec.toFixed(2))} s ` +
          `on average, which is implausibly short: the waiting times in the call data look wrong.`
        : `How long callers wait before they give up could not be measured from the call ` +
          `data: its waiting times look wrong.`
    return (
      `The forecast cannot be shown. ${measured} An admin needs to correct the call data ` +
      `and run a retrain.`
    )
  }
  function renderSourceBadge(src: DataSource | null | undefined) {
    if (!src) return
    sourceShown = true
    ui.badgeHidden = false
    ui.badgeCls = `badge src-${src.kind}`
    ui.badgeText =
      src.kind === 'unlabeled'
        ? src.label
        : `${src.label}, ${shortDate(src.start)} ${src.start.slice(0, 4)} to ${shortDate(src.end)} ${src.end.slice(0, 4)}`
  }

  // ---- grid skeleton (per range and per hours shown) ----
  function buildGrid(days: ForecastDay[]) {
    const tours = visibleTours()
    const hourCount = tours.reduce((n, t) => n + t.hours.length, 0)
    // A narrow empty column separates one tour from the next.
    const gapCount = Math.max(0, tours.length - 1)
    const minWidth = `${GRID_PX.date + hourCount * (GRID_PX.hour + GRID_PX.gap) + tours.length * (GRID_PX.roster + GRID_PX.gap) + gapCount * (GRID_PX.tourGap + GRID_PX.gap) + GRID_PX.gap}px`
    // Predicted calls per day (whole day, whatever hours are shown): the same sum the
    // day sheet shows, so the row label and the sheet always agree.
    const dayCalls = new Map<string, number>()
    cache!.hours.forEach((h) =>
      dayCalls.set(h.date, (dayCalls.get(h.date) || 0) + h.predicted_calls)
    )
    const today = isoDate(new Date())
    const rows = days.map((day, rowIndex) => {
      const cls = [
        day.is_weekend ? 'weekend' : '',
        day.date === today ? 'today' : '',
        day.holiday ? 'holiday' : '',
      ]
        .join(' ')
        .trim()
      const dt = localDate(day.date)
      const callsText = `${Math.round(dayCalls.get(day.date) || 0).toLocaleString()} calls`
      const meta =
        callsText + (day.holiday ? `, ${day.holiday}` : day.date === today ? ', today' : '')
      return {
        date: day.date,
        cls,
        index: rowIndex,
        title: `${callsText} predicted for the whole day${day.holiday ? `. ${day.holiday}` : ''}`,
        weekday: dt.toLocaleDateString(undefined, { weekday: 'short' }),
        dayMonth: dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        meta,
      }
    })
    grid.value = { tours, rows, minWidth }
    gridNote.value =
      'Tours overlap by 30 minutes. The overlap hour counts toward the roster of both tours it touches, and toward the calls of the tour it starts. ' +
      "Roster shows the tour's busiest hour; type a number to plan your own, or clear it to follow the recommendation."
  }

  // ---- recompute (no network) ----
  function recompute() {
    checkControls()
    if (!cache) return
    const c = controls()
    const next = computeHours(cache.hours, c)
    const changed = diffCells(computedHours, next)
    const first = computedHours.length === 0
    computedHours = next
    hourIndex = new Map(computedHours.map((h) => [hourKey(h.date, h.hour), h]))
    judged = judgeRoster(rollupShifts(cache.days, computedHours), store, c)
    updateRosterPreset()
    repaint()
    renderSummary(c)
    renderDayFocus(c)
    renderSheet()
    if (!first) flashChanged(changed)
  }
  function repaint() {
    patchCells(computedHours)
    patchShifts(judged)
    renderLegend()
  }

  // Average predicted calls for each hour of the day across the loaded dates.
  function hourMeans(hours: ComputedHour[]): Map<number, number> {
    const sum = new Map<number, number>()
    const n = new Map<number, number>()
    hours.forEach((h) => {
      sum.set(h.hour, (sum.get(h.hour) || 0) + h.predicted_calls)
      n.set(h.hour, (n.get(h.hour) || 0) + 1)
    })
    return new Map([...sum].map(([hour, total]) => [hour, total / n.get(hour)!]))
  }
  function patchProfile(hours: ComputedHour[]) {
    const means = hourMeans(hours)
    const top = Math.max(0, ...means.values())
    const next = new Map<number, ProfileVm | null>()
    for (let hour = 0; hour < 24; hour++) {
      const mean = means.get(hour)
      if (mean === undefined) {
        next.set(hour, null)
        continue
      }
      next.set(hour, {
        title: `${pad2(hour)}:00, ${mean.toFixed(1)} calls on average across these dates`,
        pv: mean.toFixed(1),
        height: `${top > 0 ? Math.round((mean / top) * PROFILE_BAR_PX) : 0}px`,
      })
    }
    profile.value = next
  }

  function patchCells(hours: ComputedHour[]) {
    scale = discreteScale(
      hours.filter((h) => h.cap_state === 'under').map((h) => h.staff_to_schedule)
    )
    peaks.value = new Set(peakHours(hours))
    patchProfile(hours)
    const next = new Map<string, CellVm>()
    hours.forEach((h) => {
      const staff = h.staff_to_schedule
      const lvl = h.cap_state === 'under' ? scale.levelOf(staff as number) : 0
      next.set(hourKey(h.date, h.hour), {
        cls:
          `h cap-${h.cap_state}${MAJOR_HOURS.has(h.hour) ? ' major' : ''}${lvl > DEEP_LEVEL ? ' deep' : ''}` +
          `${h.implausible ? ' implausible' : ''}`,
        lvl: lvl.toFixed(3),
        text: staff === null ? UNDEF : String(staff),
        over:
          h.cap_state === 'over'
            ? { cl: pct(h.service_level_if_capped as number), cap: h.cap }
            : null,
        aria: `${h.date} ${pad2(h.hour)}:00, ${staff === null ? 'undefined' : staff} people to schedule`,
        title: `${dayLabel(h.date)}, ${pad2(h.hour)}:00. ${h.predicted_calls.toFixed(1)} calls predicted`,
      })
    })
    cells.value = next
  }

  function patchShifts(days: Judged[]) {
    const next = new Map<string, RosterCellVm>()
    const targetSecNow = controls().targetSec
    days.forEach((day) => {
      SHIFTS.forEach((spec) => {
        const s = day.shifts[spec.name]
        const p = day.planned[spec.name]
        const vm: RosterCellVm = {
          cls: `roster cap-${capState(s.staff_needed, s.cap)}${p.is_own ? ' own' : ''}`,
          placeholder: s.staff_needed === null ? UNDEF : String(s.staff_needed),
          own: p.is_own ? String(p.planned) : '',
          verdictCls: 'verdict',
          verdictText: UNDEF,
          lost: null,
          title: '',
        }
        if (p.verdict !== null) {
          if (p.is_own) {
            // Option 1: the cost of the typed number, in calls, right in the cell.
            vm.verdictCls = `verdict ${verdictClass(p.verdict)}`
            vm.verdictText = `${verdictShort(p.verdict)}${p.delta ? ` ${p.delta > 0 ? '+' : ''}${p.delta}` : ''}`
            vm.lost =
              p.totals === null || p.totals === undefined
                ? null
                : `${Math.round(p.totals.lost)} lost · ${pct(p.totals.lostShare as number)}`
          } else {
            vm.verdictText = `Peak · ${pct(p.service_level as number)}`
          }
          const t = p.totals
          vm.title =
            `${p.is_own ? `${p.verdict}: ${p.planned} planned vs ${p.recommended} recommended` : `${p.recommended} recommended (the tour's busiest hour)`}. ` +
            `${p.effective_agents} on inbound after efficiency; the weakest hour answers ${pct(p.service_level as number, 1)} in time` +
            `${p.abandon_share === null ? '' : ` and loses ${pct(p.abandon_share, 1)} of callers`}.` +
            (t === null || t === undefined
              ? ''
              : ` Over the whole tour: about ${Math.round(t.lost)} of ${Math.round(t.calls)} calls hang up ` +
                `(${pct(t.lostShare as number, 1)}), ${Math.round(t.late)} are answered after ${targetSecNow} s.` +
                (p.recommendedTotals && p.is_own
                  ? ` At the recommended ${p.recommended}: about ${Math.round(p.recommendedTotals.lost)} hang up.`
                  : ''))
        }
        next.set(shiftKey(day.date, spec.name), vm)
      })
    })
    rosterCells.value = next
  }

  function renderLegend() {
    ui.legendRange = scale.lo === scale.hi ? `${scale.lo}` : `${scale.lo} to ${scale.hi}`
  }

  // ---- summary ----
  // Measured share of hang-ups too fast for staffing to prevent. Context only; already
  // inside the model's total.
  function quickHangupNote(q: QuickHangups | null): string {
    if (!q || q.quick_share_of_abandoned === null) return ''
    return (
      ` In the last ${q.window_days} days of data (${q.first_day} to ${q.last_day}), ${pct(q.quick_share_of_abandoned, 0)} of hang-ups ` +
      `(${q.n_quick.toLocaleString()} of ${q.n_abandoned.toLocaleString()}) came within ${q.threshold_sec} s, too fast for any staffing to answer.`
    )
  }
  const lostText = (v: number | null) => (v === null ? UNDEF : Math.round(v).toLocaleString())

  // Hang-ups by shift. The rows are fixed markup; only bar lengths and numbers change,
  // so the bars slide as a slider moves.
  function patchShiftSplit(c: Controls) {
    const rows = shiftSplit(computedHours, roster(), c)
    const top = topOf(rows)
    const next = new Map<string, SplitVm>()
    rows.forEach((row) => {
      next.set(row.name, {
        ownWidth: share(row.roster, top),
        ownText: lostText(row.roster),
        recWidth: share(row.recommended, top),
        recText: lostText(row.recommended),
        title: `${row.name}: ${lostText(row.calls)} calls. Hang-ups: ${lostText(row.roster)} with your roster, ${lostText(row.recommended)} as recommended.`,
      })
    })
    split.value = next
  }

  // Hang-ups day by day. Skeleton per date range, values patched per recompute.
  function buildDayChart(days: ForecastDay[]) {
    const today = isoDate(new Date())
    dayChart.value = {
      cls: `daybars${days.length > DAY_VALUES_MAX ? ' dense' : ''}${days.length > DAY_LABELS_MAX ? ' packed' : ''}`,
      bars: days.map((day) => {
        const dt = localDate(day.date)
        return {
          date: day.date,
          cls: [
            'db',
            day.is_weekend ? 'weekend' : '',
            day.holiday ? 'holiday' : '',
            day.date === today ? 'today' : '',
          ]
            .join(' ')
            .trim(),
          weekday: dt.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2),
          dayNumber: dt.getDate(),
        }
      }),
    }
    dayChartPatch.value = new Map()
  }
  function patchDayChart(c: Controls) {
    const days = cache!.days
    const rows = daySplit(days, computedHours, roster(), c)
    // Phone layout of the same days (hidden on wider screens).
    const byDate = new Map(rows.map((r) => [r.date, r]))
    dayList.value = judged.map((day) => {
      const row = byDate.get(day.date) || { calls: 0, roster: null, recommended: null }
      const lost = (v: number | null | undefined) =>
        v === null || v === undefined ? '-' : Math.round(v).toLocaleString()
      return {
        date: day.date,
        cls: ['drow', day.is_weekend ? 'weekend' : '', day.holiday ? 'holiday' : '']
          .join(' ')
          .trim(),
        weekday: localDate(day.date).toLocaleDateString(undefined, { weekday: 'short' }),
        date_: shortDate(day.date),
        calls: lost(row.calls),
        holiday: day.holiday,
        chips: SHIFTS.map((spec) => {
          const s = day.shifts[spec.name]
          const p = day.planned[spec.name]
          return {
            cls: `chip-s cap-${capState(s.staff_needed, s.cap)}${p.is_own ? ' own' : ''}`,
            text: p.planned === null ? '-' : String(p.planned),
          }
        }),
        lost: lost(row.roster),
        rec: lost(row.recommended),
      }
    })
    const top = topOf(rows)
    const holidays = new Map(days.map((d) => [d.date, d.holiday]))
    const next = new Map<string, DayBarPatch>()
    rows.forEach((row) => {
      const hol = holidays.get(row.date)
      next.set(row.date, {
        dv: lostText(row.roster),
        roster: share(row.roster, top),
        rec: share(row.recommended, top),
        label:
          `${dayLabel(row.date)}${hol ? `, ${hol}` : ''}: ${lostText(row.calls)} calls. ` +
          `Hang-ups: ${lostText(row.roster)} with your roster, ${lostText(row.recommended)} as recommended.`,
      })
    })
    dayChartPatch.value = next
  }

  // Lead block of an outlook card: the hang-up count, then its figures.
  const leadBlock = (count: string, figs: [string, string][], note: string): LeadVm => ({
    count,
    figs,
    note,
  })

  function renderSummary(c: Controls) {
    const cc = cache!
    const s = summarize(computedHours)
    const fewer = abandonedOneFewer(computedHours, c)
    const span = `${shortDate(cc.window.start)} to ${shortDate(cc.window.end)}`
    ui.pageSub =
      cc.days.length === 1
        ? longDate(cc.window.start)
        : `${dayLabel(cc.window.start)} to ${dayLabel(cc.window.end)}, ${cc.days.length} days`
    const talkHours = s.talkSec / SECONDS_PER_HOUR
    if (s.personHours === null) {
      story.value = {
        kind: 'plain',
        text: 'Scheduled person-hours are undefined at 0% efficiency.',
      }
    } else {
      const gap = s.personHours - talkHours
      const ratio = talkHours > 0 ? s.personHours / talkHours : null
      story.value = {
        kind: 'gap',
        gap: formatDuration(Math.max(0, gap) * SECONDS_PER_HOUR),
        ratio: ratio ? ` (${ratio.toFixed(1)}×)` : '',
        rest: `That gap is the efficiency setting (${ctl.effNum}% of a shift on inbound) plus the queue slack needed to answer ${ctl.slNum}% within ${c.targetSec} s.`,
        fewer:
          fewer !== null && s.abandoned !== null
            ? {
                from: Math.round(s.abandoned).toLocaleString(),
                to: Math.round(fewer).toLocaleString(),
              }
            : null,
      }
    }
    const r = roster()
    const atRosterNow = rosterOutcome(computedHours, r, c)
    const recShare = s.abandoned !== null && s.calls > 0 ? s.abandoned / s.calls : null
    // Lead: hang-ups at the roster on the sliders (the partner's real 4/4/6 by default).
    rosterStat.value =
      atRosterNow === null
        ? leadBlock(UNDEF, [], 'Needs Erlang A and efficiency above 0')
        : leadBlock(
            Math.round(atRosterNow.abandoned).toLocaleString(),
            [
              ['Share of calls', pct(atRosterNow.abandonShare as number, 1)],
              [`Answered within ${c.targetSec} s`, pct(atRosterNow.serviceLevel as number, 1)],
            ],
            `${r.Overnight}/${r.Day}/${r.Evening} staff, ${span}`
          )
    // Beside it: what our recommendation would give. Labelled so it is never read as
    // the roster the partner actually runs.
    recStat.value =
      s.abandoned === null
        ? leadBlock(UNDEF, [], 'Undefined at 0% efficiency')
        : leadBlock(
            Math.round(s.abandoned).toLocaleString(),
            (
              [['Share of calls', recShare === null ? UNDEF : pct(recShare, 1)]] as [
                string,
                string,
              ][]
            ).concat(
              fewer === null ? [] : [['With one person fewer', Math.round(fewer).toLocaleString()]]
            ),
            `Every hour staffed as the grid recommends, ${span}`
          )
    leadRender.value++
    void nextTick(() => {
      const rosterMoved = countTo(document.querySelector('#rosterStat .n'), 'roster')
      countTo(document.querySelector('#recStat .n'), 'recommended')
      if (rosterMoved)
        pulse(document.querySelector<HTMLElement>('#rosterStat')?.closest<HTMLElement>('.card'))
    })
    summaryTiles.value = [
      {
        k: 'Predicted calls',
        v: Math.round(s.calls).toLocaleString(),
        d: `${s.n.toLocaleString()} hours`,
      },
      {
        k: 'Real calls',
        v: Math.round(s.realCalls).toLocaleString(),
        d: 'Calls that lasted 2 mins',
      },
      {
        k: 'Expected talk time',
        v: formatDuration(s.talkSec),
        d: `Average call ${s.meanAht === null ? '?' : (s.meanAht / SECONDS_PER_MINUTE).toFixed(1)} min`,
      },
      {
        k: 'Person-hours to schedule',
        v: s.personHours === null ? UNDEF : s.personHours.toLocaleString(),
        d: '',
      },
    ]
    patchShiftSplit(c)
    patchDayChart(c)
    ui.caveat =
      `${cc.window.caveat} Callers are assumed to give up after ${Math.round(c.patienceSec || 0)} s on average, measured from ` +
      `${cc.params.patience_source?.kind === 'estimated' ? cc.params.patience_source.n_abandoned.toLocaleString() : 'the'} past hang-ups.` +
      quickHangupNote(cc.quick)
  }

  // ---- one-day mode ----
  // Looking at one day is the same forecast request with start = end, so every number,
  // control and export behaves exactly as it does for a range. The page swaps the
  // day-by-day chart for an hour-by-hour board of that day.
  function enterDay(date: string) {
    if (dayMode.value === null) dayMode.value = { start: ctl.start, end: ctl.end }
    ctl.start = date
    ctl.end = date
    debounced(refresh)
  }
  function exitDay() {
    if (dayMode.value === null) return
    ctl.start = dayMode.value.start
    ctl.end = dayMode.value.end
    dayMode.value = null
    debounced(refresh)
  }
  // The day to open on: the one in the detail sheet, else today if loaded, else the
  // first date.
  function defaultDay(): string {
    const v = view.value
    if (v && v.type === 'day') return v.date
    const today = isoDate(new Date())
    return cache && cache.days.some((d) => d.date === today) ? today : ctl.start
  }
  function stepDay(offset: number) {
    const d = localDate(ctl.start)
    if (Number.isNaN(d.getTime())) return
    d.setDate(d.getDate() + offset)
    enterDay(isoDate(d))
  }
  function renderDayFocus(c: Controls) {
    if (dayMode.value === null) {
      dayFocus.value = null
      return
    }
    const date = cache!.window.start
    ui.dayFocusTitle = `${longDate(date)}, hour by hour`
    dayFocus.value = buildFocus(
      computedHours.filter((h) => h.date === date && inHours(h.hour)),
      roster(),
      c
    )
  }
  function buildFocus(dayHours: ComputedHour[], r: Roster, c: Controls): FocusVm | null {
    if (dayHours.length === 0) return null
    const top = Math.max(0, ...dayHours.map((h) => h.predicted_calls))
    const own = new Map(dayHours.map((h) => [h.hour, atRoster(h, r, c)]))
    const tours = SHIFTS.map((spec) => ({
      spec,
      hours: dayHours.filter((h) => spec.core.includes(h.hour)),
    })).filter((t) => t.hours.length > 0)
    const firstOfTour = new Set(tours.map((t) => t.hours[0]!.hour))
    const edge = (h: ComputedHour) => (firstOfTour.has(h.hour) ? ' edge' : '')
    return {
      tours: tours.map((t) => ({ name: t.spec.name, span: t.spec.span, count: t.hours.length })),
      firstOfTour,
      hours: dayHours.map((h) => ({
        key: hourKey(h.date, h.hour),
        hour: h.hour,
        title: `${pad2(h.hour)}:00, ${h.predicted_calls.toFixed(1)} calls predicted`,
        fv: h.predicted_calls.toFixed(1),
        height: `${top > 0 ? Math.round((h.predicted_calls / top) * BAR_PX) : 0}px`,
      })),
      rows: rowSpecs(c).map((spec) => {
        if ('section' in spec) return { section: spec.section, tone: spec.tone || '' }
        return {
          label: spec.label,
          cells: dayHours.map((h) => {
            const { text, cls = '' } = spec.cell(h, own.get(h.hour)!)
            return { key: hourKey(h.date, h.hour), cls: `${cls}${edge(h)}`.trim(), text }
          }),
        }
      }),
      list: {
        tours: tours.map((t) => ({
          name: t.spec.name,
          span: t.spec.span,
          rows: t.hours.map((h) => {
            const o = atRoster(h, r, c)
            return {
              key: hourKey(h.date, h.hour),
              hh: pad2(h.hour),
              width: `${top > 0 ? ((h.predicted_calls / top) * 100).toFixed(1) : 0}%`,
              calls: h.predicted_calls.toFixed(1),
              recCls: `chip-s cap-${h.cap_state}`,
              recMiss: misses(h.service_level_delivered, c),
              recStaff: whole(h.staff_to_schedule),
              recLevel: focusPct(h.service_level_delivered),
              ownMiss: misses(o.service_level, c),
              ownStaff: whole(o.staff),
              ownLevel: focusPct(o.service_level),
            }
          }),
        })),
      },
    }
  }

  // ---- detail sheet ----
  function inSelection(h: { date: string; hour: number }): boolean {
    const sel = selection.value
    return !!sel && sel.dates.includes(h.date) && h.hour >= sel.hours[0] && h.hour <= sel.hours[1]
  }
  function openSheet(next: View) {
    view.value = next
    renderSheet()
  }
  function closeSheet() {
    view.value = null
    if (selection.value) applySelection(null)
  }
  function applySelection(sel: Selection | null) {
    selection.value = sel
  }
  function renderSheet() {
    const v = view.value
    if (!v || !cache) return
    if (v.type === 'hour' && hourIndex.has(v.key)) {
      const h = hourIndex.get(v.key)!
      ui.sheetTitle = `${dayLabel(h.date)}, ${pad2(h.hour)}:00`
      sheetBody.value = hourView(h)
      return
    }
    if (v.type === 'selection' && selection.value) {
      ui.sheetTitle = 'Selection'
      sheetBody.value = selectionView()
      return
    }
    if (v.type === 'day') {
      ui.sheetTitle = longDate(v.date)
      sheetBody.value = dayView(v.date)
      return
    }
    closeSheet()
  }
  const line = (k: string, v: string, f = '', cls = ''): LineVm => ({ k, v, f, cls })
  function hourBars(dayHours: ComputedHour[], activeHour: number | null = null): HourBarsVm | null {
    if (dayHours.length === 0) return null
    const top = Math.max(0, ...dayHours.map((h) => h.predicted_calls))
    return {
      bars: dayHours.map((h) => ({
        cls: `hb cap-${h.cap_state}${h.hour === activeHour ? ' on' : ''}`,
        height: share(h.predicted_calls, top),
        title: `${pad2(h.hour)}:00, ${h.predicted_calls.toFixed(1)} calls`,
      })),
      label: `Predicted calls for each hour of the day, busiest ${top.toFixed(1)} calls`,
      axis: AXIS_HOURS.map((h) => ({ left: `${((h / 23) * 100).toFixed(2)}%`, text: pad2(h) })),
    }
  }
  function hourView(h: ComputedHour): SheetBodyVm {
    const c = controls()
    const day = cache!.days.find((d) => d.date === h.date)
    const chips = [
      h.cap_state === 'over' ? { cls: 'chip over', text: 'Over the cap' } : null,
      h.cap_state === 'at' ? { cls: 'chip at', text: 'At the cap' } : null,
      day && day.holiday ? { cls: 'chip hol', text: day.holiday } : null,
    ].filter((x): x is { cls: string; text: string } => x !== null)
    const lines = [
      line('Predicted calls', h.predicted_calls.toFixed(1), 'Forecast for this hour'),
      line(
        'Handle time',
        formatDuration(h.aht_sec),
        'Average for this weekday and hour, recent calls weighted more'
      ),
      line(
        'Expected talk time',
        formatDuration(h.load_erlangs * SECONDS_PER_HOUR),
        `${h.predicted_calls.toFixed(1)} calls × ${formatDuration(h.aht_sec)}`
      ),
    ]
    const base = {
      kind: 'hour' as const,
      chips,
      capState: h.cap_state,
      staff: h.staff_to_schedule === null ? UNDEF : String(h.staff_to_schedule),
      bars: hourBars(
        computedHours.filter((x) => x.date === h.date),
        h.hour
      ),
    }
    if (h.staff_to_schedule === null) return { ...base, lines, reason: h.reason, foot: null }
    lines.push(
      line(
        'Answered in time',
        pct(h.service_level_delivered as number, 1),
        `Target ${ctl.slNum}% within ${c.targetSec} s`
      ),
      line(
        'Hang-ups',
        pct(h.abandon_share as number, 1),
        'Callers who give up before a peer answers'
      )
    )
    if (h.cap_state === 'over') {
      lines.push(
        line(
          `With only ${h.cap} people`,
          pct(h.service_level_if_capped as number, 1),
          "Answered in time if you can't staff above the cap",
          'out'
        )
      )
    }
    return {
      ...base,
      lines,
      reason: h.reason || null,
      foot: { date: h.date, focus: dayMode.value === null },
    }
  }
  function selectionView(): SheetBodyVm {
    const sel = selection.value!
    const rows = computedHours.filter(inSelection)
    const s = summarize(rows)
    return {
      kind: 'selection',
      hint: `${sel.dates.length} day${sel.dates.length === 1 ? '' : 's'}, ${pad2(sel.hours[0])}:00 to ${pad2(sel.hours[1])}:59, ${rows.length} hours`,
      tiles: [
        ['Person-hours', s.personHours === null ? UNDEF : s.personHours.toLocaleString()],
        ['Peak staff', s.peakStaff === null ? UNDEF : String(s.peakStaff)],
        ['Predicted calls', Math.round(s.calls).toLocaleString()],
        [
          'Hang-ups if staffed as recommended',
          s.abandoned === null ? UNDEF : Math.round(s.abandoned).toLocaleString(),
        ],
      ],
    }
  }
  function dayView(date: string): SheetBodyVm {
    const day = judged.find((d) => d.date === date)
    if (!day) {
      return {
        kind: 'missing',
        hint: `${date} is outside the dates loaded. Widen the dates to see it.`,
      }
    }
    const dayHours = computedHours.filter((h) => h.date === date)
    const st = dayStats(day, dayHours)
    const hoursList = (hs: number[]) =>
      hs.length ? hs.map((h) => `${pad2(h)}:00`).join(', ') : 'None'
    return {
      kind: 'day',
      holiday: day.holiday,
      tiles: [
        ['Predicted calls', Math.round(st.calls).toLocaleString()],
        ['Busiest hour', st.peakHour === null ? UNDEF : `${pad2(st.peakHour)}:00`],
        ['Peak staff', st.peakStaff === null ? UNDEF : String(st.peakStaff)],
        [
          'Hang-ups if staffed as recommended',
          st.abandoned === null ? UNDEF : Math.round(st.abandoned).toLocaleString(),
        ],
      ],
      bars: hourBars(dayHours),
      tours: SHIFTS.map((spec) => {
        const s = day.shifts[spec.name]
        const p = day.planned[spec.name]
        return {
          name: spec.name,
          need: s.staff_needed === null ? UNDEF : String(s.staff_needed),
          planned: p.planned === null ? UNDEF : String(p.planned),
          following: !p.is_own,
          verdictCls: verdictClass(p.verdict),
          verdict: p.verdict ? verdictShort(p.verdict) : UNDEF,
          level: p.service_level === null ? null : `${pct(p.service_level)} in time`,
        }
      }),
      lines: [
        line('At the cap', hoursList(st.atCap)),
        line('Over the cap', hoursList(st.overCap), '', st.overCap.length ? 'out' : ''),
      ],
      tradeoffs: SHIFTS.map((spec) => tradeoffTable(spec, day)).filter(
        (t): t is TradeoffVm => t !== null
      ),
      hint:
        `Rows with the same "On phones" number give the same result: after breaks, outbound and admin ` +
        `(efficiency ${ctl.effNum}%), that extra person adds no time on inbound.`,
      foot: dayMode.value === null ? { date } : null,
    }
  }
  // Option 2: every staff number from 1 to the shift's cap and what it costs over the
  // tour, in calls. Recommended and planned rows are marked.
  function tradeoffTable(spec: ShiftSpec, day: Judged): TradeoffVm | null {
    const s = day.shifts[spec.name]
    const p = day.planned[spec.name]
    const c = controls()
    const rows = shiftTradeoff(s.core_hours, s.cap, c)
    if (rows.length === 0) return null
    return {
      name: spec.name,
      span: spec.span,
      calls: Math.round(rows[0]!.calls),
      cap: s.cap,
      targetSec: c.targetSec,
      rows: rows.map((r) => ({
        cls: [
          r.staff === s.staff_needed ? 'rec' : '',
          p.is_own && r.staff === p.planned ? 'plan' : '',
        ]
          .join(' ')
          .trim(),
        staff: r.staff,
        label:
          r.staff === s.staff_needed
            ? 'recommended'
            : p.is_own && r.staff === p.planned
              ? 'planned'
              : null,
        effective: r.effective,
        sl: pct(r.serviceLevel as number),
        lostShare: pct(r.lostShare as number, 1),
        lost: Math.round(r.lost),
        late: Math.round(r.late),
      })),
    }
  }

  // ---- grid interaction ----
  const cellOf = (e: Event) =>
    (e.target as Element | null)?.closest?.<HTMLElement>('td.h[data-k]') ?? null
  let drag: { anchor: HTMLElement; moved: boolean } | null = null
  function rectFrom(a: HTMLElement, b: HTMLElement): Selection {
    const dates = cache!.days.map((d) => d.date)
    const [i0, i1] = [dates.indexOf(a.dataset.d!), dates.indexOf(b.dataset.d!)].sort(
      (x, y) => x - y
    ) as [number, number]
    const [h0, h1] = [Number(a.dataset.h), Number(b.dataset.h)].sort((x, y) => x - y) as [
      number,
      number,
    ]
    return { dates: dates.slice(i0, i1 + 1), hours: [h0, h1] }
  }
  function onRowsPointerDown(e: PointerEvent) {
    const c = cellOf(e)
    if (c && e.button === 0) drag = { anchor: c, moved: false }
  }
  function onRowsPointerMove(e: PointerEvent) {
    if (!drag) return
    const node = document.elementFromPoint(e.clientX, e.clientY)
    const c = node?.closest?.<HTMLElement>('td.h[data-k]')
    if (!c || (c === drag.anchor && !drag.moved)) return
    drag.moved = true
    applySelection(rectFrom(drag.anchor, c))
    // Opening the sheet narrows the page, which would slide cells under the pointer
    // mid-drag. So a closed sheet opens on release; an open one keeps its totals live
    // while you drag.
    if (view.value) openSheet({ type: 'selection' })
  }
  function onRowsPointerEnd() {
    if (drag && drag.moved && selection.value) openSheet({ type: 'selection' })
    setTimeout(() => {
      drag = null
    }, 0)
  }
  function onRowsClick(e: MouseEvent) {
    const dayBtn = (e.target as Element | null)?.closest?.<HTMLElement>('[data-day]')
    if (dayBtn) {
      applySelection(null)
      openSheet({ type: 'day', date: dayBtn.dataset.day! })
      return
    }
    const c = cellOf(e)
    if (!c || (drag && drag.moved)) return
    applySelection(null)
    const v = view.value
    if (v && v.type === 'hour' && v.key === c.dataset.k) closeSheet()
    else openSheet({ type: 'hour', key: c.dataset.k! })
  }
  function onRowsKeydown(e: KeyboardEvent) {
    const c = cellOf(e)
    if (c && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      applySelection(null)
      openSheet({ type: 'hour', key: c.dataset.k! })
    }
  }
  function onRowsInput(e: Event) {
    const input = (e.target as Element | null)?.closest?.<HTMLInputElement>('td.roster input')
    if (!input || !cache) return
    const v = input.value.trim()
    store.set(input.dataset.d!, input.dataset.s!, v === '' ? null : clampInt(v, 0, 99, null))
    judged = judgeRoster(rollupShifts(cache.days, computedHours), store, controls())
    updateRosterPreset()
    patchShifts(judged)
    const cur = view.value
    if (cur && cur.type === 'day' && cur.date === input.dataset.d) renderSheet()
  }
  function onSheetBodyClick(e: MouseEvent) {
    const target = e.target as Element
    const day = target.closest<HTMLElement>('[data-open-day]')
    if (day) openSheet({ type: 'day', date: day.dataset.openDay! })
    if (target.closest('[data-clear-selection]')) closeSheet()
    const focus = target.closest<HTMLElement>('[data-focus-day]')
    if (focus) enterDay(focus.dataset.focusDay!)
  }
  function onDayChartClick(e: MouseEvent) {
    const bar = (e.target as Element).closest<HTMLElement>('[data-day]')
    if (bar) {
      applySelection(null)
      openSheet({ type: 'day', date: bar.dataset.day! })
    }
  }
  function openHourFrom(e: MouseEvent) {
    const cell = (e.target as Element).closest<HTMLElement>('[data-k]')
    if (cell) {
      applySelection(null)
      openSheet({ type: 'hour', key: cell.dataset.k! })
    }
  }
  function onDayListClick(e: MouseEvent) {
    const row = (e.target as Element).closest<HTMLElement>('[data-day]')
    if (!row) return
    enterDay(row.dataset.day!)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  function toggleDock() {
    ui.dockOpen = !ui.dockOpen
  }
  function onModeDay() {
    if (dayMode.value === null) enterDay(defaultDay())
  }
  const onModeRange = exitDay
  function onDocumentKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && view.value) closeSheet()
    // One-day mode: left and right arrows step a day, unless a field or slider has the keys.
    if (
      dayMode.value === null ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')
    ) {
      return
    }
    if ((e.target as Element | null)?.closest?.('input, textarea, select')) return
    e.preventDefault()
    stepDay(e.key === 'ArrowLeft' ? -1 : 1)
  }

  // ---- wiring ----
  let timer: ReturnType<typeof setTimeout> | undefined
  function debounced(fn: () => unknown) {
    clearTimeout(timer)
    timer = setTimeout(fn, DEBOUNCE_MS)
  }
  const onLocal = () => debounced(recompute)
  // An input whose value the page corrects: the DOM must show the corrected value even
  // when the bound value did not change.
  const setInput = (e: Event, value: string) => {
    const input = e.target as HTMLInputElement
    if (input.value !== value) input.value = value
  }
  function onEffInput(e: Event) {
    ctl.eff = (e.target as HTMLInputElement).value
    ctl.effNum = ctl.eff
    onLocal()
  }
  function onEffNumInput(e: Event) {
    ctl.effNum = (e.target as HTMLInputElement).value
    ctl.eff = String(clampTenth(ctl.effNum, 0, 100, DEFAULT_EFF_PCT))
    onLocal()
  }
  function onEffNumChange(e: Event) {
    ctl.effNum = ctl.eff
    setInput(e, ctl.effNum)
    onLocal()
  }
  function onSlInput(e: Event) {
    ctl.sl = (e.target as HTMLInputElement).value
    ctl.slNum = ctl.sl
    onLocal()
  }
  function onSlNumInput(e: Event) {
    ctl.slNum = (e.target as HTMLInputElement).value
    ctl.sl = String(clampInt(ctl.slNum, SL_MIN, SL_MAX, SL_MIN))
    onLocal()
  }
  function onSlNumChange(e: Event) {
    ctl.slNum = ctl.sl
    setInput(e, ctl.slNum)
    onLocal()
  }
  function onTsecInput(e: Event) {
    ctl.tsec = (e.target as HTMLInputElement).value
    onLocal()
  }
  function onRosterInput(name: 'rosterO' | 'rosterD' | 'rosterE', e: Event) {
    ctl[name] = (e.target as HTMLInputElement).value
    paintRoster(roster())
    onLocal()
  }
  function setRoster(r: Roster) {
    paintRoster(r)
    onLocal()
  }
  const useRecommended = () => setRoster(recommendedRoster())
  const useCurrent = () => setRoster(CURRENT_ROSTER)
  function onHours() {
    if (!cache) return
    buildGrid(cache.days)
    repaint()
    applySelection(selection.value)
  }
  function onHFromInput(e: Event) {
    let v = (e.target as HTMLInputElement).value
    if (Number(v) > Number(ctl.hTo)) v = ctl.hTo
    ctl.hFrom = v
    setInput(e, v)
    onHours()
  }
  function onHToInput(e: Event) {
    let v = (e.target as HTMLInputElement).value
    if (Number(v) < Number(ctl.hFrom)) v = ctl.hFrom
    ctl.hTo = v
    setInput(e, v)
    onHours()
  }
  function onHolidaysChange(e: Event) {
    ctl.holidays = (e.target as HTMLInputElement).checked
    debounced(refresh)
  }
  function onStartChange(e: Event) {
    ctl.start = (e.target as HTMLInputElement).value
    if (dayMode.value !== null) ctl.end = ctl.start
    debounced(refresh)
  }
  function onEndChange(e: Event) {
    ctl.end = (e.target as HTMLInputElement).value
    debounced(refresh)
  }

  function init() {
    const today = new Date()
    const end = new Date(today)
    end.setDate(end.getDate() + DEFAULT_HORIZON_DAYS - 1)
    ctl.start = isoDate(today)
    ctl.end = isoDate(end)
    dayMode.value = null
    ctl.eff = String(DEFAULT_EFF_PCT)
    ctl.effNum = String(DEFAULT_EFF_PCT)
    ctl.sl = '80'
    paintRoster(CURRENT_ROSTER)
    ctl.slNum = '80'
    ctl.tsec = '30'
    ctl.hFrom = '0'
    ctl.hTo = '23'
    ctl.holidays = true
    void refresh()
  }
  // Browsers may restore form state after scripts ran (back/forward). pageshow fires
  // after that restore, so defaults are reasserted.
  function onPageShow(e: PageTransitionEvent) {
    if (e.persisted) init()
  }

  // Load the forecast again for the same dates (after a run has produced a new one).
  function reloadForecast() {
    if (cache) cache.key = ''
    debounced(refresh)
  }

  // ---- read access for the exports ----
  const snapshot = () => ({ cache, computedHours, judged, hourIndex, scale })

  return {
    ctl,
    ui,
    view,
    selection,
    dayMode,
    sheetOpen,
    oneDay,
    grid,
    cells,
    peaks,
    profile,
    rosterCells,
    rosterStat,
    recStat,
    leadRender,
    summaryTiles,
    story,
    split,
    dayChart,
    dayChartPatch,
    dayList,
    dayFocus,
    sheetBody,
    gridNote,
    feedback,
    slMarks,
    init,
    reloadForecast,
    onPageShow,
    targetSec,
    controls,
    visibleTours,
    snapshot,
    inSelection,
    closeSheet,
    onRowsPointerDown,
    onRowsPointerMove,
    onRowsPointerEnd,
    onRowsClick,
    onRowsKeydown,
    onRowsInput,
    onSheetBodyClick,
    onDayChartClick,
    openHourFrom,
    onDayListClick,
    toggleDock,
    onModeDay,
    onModeRange,
    stepDay,
    onDocumentKeydown,
    onEffInput,
    onEffNumInput,
    onEffNumChange,
    onSlInput,
    onSlNumInput,
    onSlNumChange,
    onTsecInput,
    onRosterInput,
    useRecommended,
    useCurrent,
    onHFromInput,
    onHToInput,
    onHolidaysChange,
    onStartChange,
    onEndChange,
    showError(text: string) {
      ui.errorHidden = false
      ui.errorText = text
    },
  }
}
