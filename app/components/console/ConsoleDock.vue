<script setup lang="ts">
  // The settings dock (dates, efficiency, service level, hours shown, holidays) and the
  // "hours changed" toast under it.
  import { useConsole } from '~/composables/console/useConsoleState'

  const {
    ctl,
    ui,
    oneDay,
    feedback,
    slMarks,
    toggleDock,
    stepDay,
    onStartChange,
    onEndChange,
    onEffInput,
    onEffNumInput,
    onEffNumChange,
    onSlInput,
    onSlNumInput,
    onSlNumChange,
    onTsecInput,
    onHFromInput,
    onHToInput,
    onHolidaysChange,
  } = useConsole()
</script>

<template>
  <section :class="['dock glass', { open: ui.dockOpen }]" id="dock" aria-label="Forecast settings">
    <div class="ctl ctl-dates">
      <div class="name-row">
        <label class="name" for="start" id="datesLabel">{{ oneDay ? 'Day' : 'Dates' }}</label
        ><button
          type="button"
          class="pill dock-toggle"
          id="dockToggle"
          :aria-expanded="ui.dockOpen"
          aria-controls="dock"
          @click="toggleDock"
        >
          {{ ui.dockOpen ? 'Hide settings' : 'Settings' }}
        </button>
      </div>
      <div class="ctl-row">
        <button
          type="button"
          class="stepbtn day-only"
          id="dayPrev"
          aria-label="Previous day"
          @click="stepDay(-1)"
        >
          <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
            <path
              d="M6.5 1L1.5 6l5 5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <input
          class="field-in"
          type="date"
          id="start"
          autocomplete="off"
          :value="ctl.start"
          @change="onStartChange"
        /><span class="muted range-only">to</span
        ><input
          class="field-in range-only"
          type="date"
          id="end"
          autocomplete="off"
          aria-label="End date"
          :value="ctl.end"
          @change="onEndChange"
        />
        <button
          type="button"
          class="stepbtn day-only"
          id="dayNext"
          aria-label="Next day"
          @click="stepDay(1)"
        >
          <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
            <path
              d="M1.5 1l5 5-5 5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
    <div
      class="ctl"
      title="Share of a shift a person is free for inbound calls. Below 20% the numbers stop being useful."
    >
      <label class="name" for="eff">Staff efficiency</label>
      <div class="ctl-row">
        <div class="range caution">
          <input
            type="range"
            id="eff"
            min="0"
            max="100"
            step="0.1"
            :value="ctl.eff"
            :style="{ '--fill': feedback.effFill }"
            @input="onEffInput"
          />
        </div>
        <span class="val"
          ><input
            class="field-in"
            type="number"
            id="effNum"
            min="0"
            max="100"
            step="0.1"
            inputmode="decimal"
            autocomplete="off"
            aria-label="Efficiency percent"
            :value="ctl.effNum"
            @input="onEffNumInput"
            @change="onEffNumChange"
          />
          %</span
        >
      </div>
    </div>
    <div class="ctl" title="Tick: the 90% industry standard.">
      <label class="name" for="sl">Calls answered in time</label>
      <div class="ctl-row">
        <div class="range" id="slTrack">
          <span class="tick" :style="{ left: slMarks.tickLeft }"></span
          ><input
            type="range"
            id="sl"
            min="80"
            max="95"
            step="1"
            :value="ctl.sl"
            :style="{ '--fill': feedback.slFill }"
            @input="onSlInput"
          />
        </div>
        <span class="val"
          ><input
            class="field-in"
            type="number"
            id="slNum"
            min="80"
            max="95"
            step="1"
            inputmode="numeric"
            autocomplete="off"
            aria-label="Service level percent"
            :value="ctl.slNum"
            @input="onSlNumInput"
            @change="onSlNumChange"
          />
          %</span
        >
        <label class="muted" for="tsec">within</label>
        <!-- max="3600" is the old page's markup, kept so both pages compare equal. The
             read API takes at most MAX_TARGET_SEC (shared/utils/constants.ts): a larger
             value is refused with a message by controlProblem() in useConsoleState.ts. -->
        <input
          class="field-in"
          type="number"
          id="tsec"
          min="0"
          max="3600"
          step="5"
          inputmode="numeric"
          autocomplete="off"
          :value="ctl.tsec"
          @input="onTsecInput"
        /><span class="muted">s</span>
      </div>
    </div>
    <div class="ctl">
      <span class="name" id="hoursLabel">Hours shown</span>
      <div class="ctl-row">
        <div
          class="range dual"
          id="hoursTrack"
          role="group"
          aria-labelledby="hoursLabel"
          :style="{ '--a': feedback.hoursA, '--b': feedback.hoursB }"
        >
          <span class="rail"></span>
          <input
            type="range"
            id="hFrom"
            min="0"
            max="23"
            step="1"
            aria-label="First hour shown"
            :value="ctl.hFrom"
            @input="onHFromInput"
          />
          <input
            type="range"
            id="hTo"
            min="0"
            max="23"
            step="1"
            aria-label="Last hour shown"
            :value="ctl.hTo"
            @input="onHToInput"
          />
        </div>
        <span class="val" id="hoursVal">{{ feedback.hoursVal }}</span>
      </div>
    </div>
    <div class="ctl">
      <span class="name">Holidays</span>
      <div class="ctl-row">
        <label class="switch"
          ><input
            type="checkbox"
            id="holidays"
            autocomplete="off"
            :checked="ctl.holidays"
            @change="onHolidaysChange"
          /><span class="knob"></span>Holiday effects</label
        >
      </div>
    </div>
  </section>
  <div
    :class="['changed glass', { quiet: ui.changedQuiet }]"
    id="changed"
    role="status"
    aria-live="polite"
  >
    {{ ui.changedText }}
  </div>
</template>
