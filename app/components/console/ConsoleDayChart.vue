<script setup lang="ts">
  // Hang-ups day by day: a pair of bars per day (your roster, as recommended); click
  // one to open that day.
  import { computed } from 'vue'
  import { useConsole } from '~/composables/console/useConsoleState'

  const { dayChart, dayChartPatch, view, onDayChartClick } = useConsole()
  const picked = computed(() => (view.value?.type === 'day' ? view.value.date : null))
</script>

<template>
  <section
    class="card daychart reveal range-only desktop-only"
    style="--i: 3"
    aria-label="Hang-ups day by day"
  >
    <header class="card-head">
      <h2>Hang-ups day by day</h2>
      <span class="key"><i></i>Your roster</span><span class="key rec"><i></i>As recommended</span>
    </header>
    <div :class="dayChart.cls" id="dayChart" @click="onDayChartClick">
      <button
        v-for="bar in dayChart.bars"
        :key="bar.date"
        type="button"
        :class="[bar.cls, { picked: bar.date === picked }]"
        :data-day="bar.date"
        :title="dayChartPatch.get(bar.date)?.label"
        :aria-label="dayChartPatch.get(bar.date)?.label"
      >
        <span class="dv">{{ dayChartPatch.get(bar.date)?.dv }}</span
        ><span class="track"
          ><i
            class="b-roster"
            :style="
              dayChartPatch.has(bar.date)
                ? { height: dayChartPatch.get(bar.date)!.roster }
                : undefined
            "
          ></i
          ><i
            class="b-rec"
            :style="
              dayChartPatch.has(bar.date) ? { height: dayChartPatch.get(bar.date)!.rec } : undefined
            "
          ></i></span
        ><span class="dl"
          ><b>{{ bar.weekday }}</b
          >{{ bar.dayNumber }}</span
        >
      </button>
    </div>
  </section>
</template>
