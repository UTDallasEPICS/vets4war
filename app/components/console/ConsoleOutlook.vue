<script setup lang="ts">
  // Outlook: the roster you set (the three sliders) beside what the grid recommends,
  // the hang-ups by shift, and the four window totals.
  import { useConsole } from '~/composables/console/useConsoleState'
  import type { ShiftName } from '#shared/types/api'

  const {
    ui,
    ctl,
    feedback,
    rosterStat,
    recStat,
    leadRender,
    summaryTiles,
    split,
    onRosterInput,
    useRecommended,
    useCurrent,
  } = useConsole()

  const SHIFT_SLIDERS = [
    { name: 'Overnight', span: '00:00 to 08:30', id: 'rosterO' },
    { name: 'Day', span: '08:00 to 16:30', id: 'rosterD' },
    { name: 'Evening', span: '16:00 to 00:30', id: 'rosterE' },
  ] as const
  const SPLIT_ROWS: ShiftName[] = ['Overnight', 'Day', 'Evening']
</script>

<template>
  <section class="outlook" aria-label="Outlook for the selected dates">
    <article class="card ink reveal" style="--i: 0">
      <header class="card-head">
        <h2>With your roster</h2>
        <div class="card-actions">
          <span
            class="roster-mode"
            id="rosterMode"
            role="status"
            aria-live="polite"
            :hidden="ui.rosterPreset !== 'custom'"
            >Custom</span
          >
          <button
            type="button"
            class="pill preset"
            id="rosterReal"
            :aria-pressed="ui.rosterPreset === 'current'"
            title="Back to what the partner actually staffed Oct 14-20 2026"
            @click="useCurrent"
          >
            Current 4/4/6
          </button>
          <button
            type="button"
            class="pill preset"
            id="rosterRec"
            :aria-pressed="ui.rosterPreset === 'recommended'"
            title="Set each shift to our recommended peak for the selected dates (capped)"
            @click="useRecommended"
          >
            Use recommended
          </button>
        </div>
      </header>
      <div class="lead-slot" id="rosterStat">
        <ConsoleLeadBlock v-if="rosterStat" :key="leadRender" :vm="rosterStat" />
      </div>
      <div
        class="shifts"
        title="The people actually scheduled, per shift. The numbers above show the hang-ups and answered-in-time this roster gives."
      >
        <div v-for="s in SHIFT_SLIDERS" :key="s.id" class="shift">
          <label :for="s.id"
            >{{ s.name }}<small>{{ s.span }}</small></label
          >
          <div class="shift-row">
            <span class="val roster-val num" :id="`${s.id}Val`">{{ feedback[s.id].label }}</span>
            <div class="range roster-range">
              <input
                type="range"
                :id="s.id"
                min="0"
                max="10"
                step="1"
                :aria-label="`Staff, ${s.name}`"
                :value="ctl[s.id]"
                :style="{ '--fill': feedback[s.id].fill }"
                @input="onRosterInput(s.id, $event)"
              />
            </div>
          </div>
        </div>
      </div>
    </article>
    <article class="card reveal" style="--i: 1">
      <header class="card-head"><h2>If staffed as recommended</h2></header>
      <div class="lead-slot" id="recStat">
        <ConsoleLeadBlock v-if="recStat" :key="leadRender" :vm="recStat" />
      </div>
      <div class="split" id="shiftSplit" aria-label="Hang-ups by shift">
        <div class="split-head">
          <h3>Hang-ups by shift</h3>
          <span class="key"><i></i>Your roster</span
          ><span class="key rec"><i></i>As recommended</span>
        </div>
        <div
          v-for="name in SPLIT_ROWS"
          :key="name"
          class="srow"
          :data-shift="name"
          :title="split.get(name)?.title"
        >
          <span class="sname">{{ name }}</span>
          <div class="sbars">
            <div class="sbar">
              <i :style="split.get(name) ? { width: split.get(name)!.ownWidth } : undefined"></i
              ><b>{{ split.get(name)?.ownText }}</b>
            </div>
            <div class="sbar rec">
              <i :style="split.get(name) ? { width: split.get(name)!.recWidth } : undefined"></i
              ><b>{{ split.get(name)?.recText }}</b>
            </div>
          </div>
        </div>
      </div>
    </article>
    <section class="summary reveal" style="--i: 2" id="summary" aria-label="Window summary">
      <div v-for="tile in summaryTiles" :key="tile.k" class="stat">
        <div class="k">{{ tile.k }}</div>
        <div class="v">{{ tile.v }}</div>
        <div class="d">{{ tile.d }}</div>
      </div>
    </section>
  </section>
</template>
