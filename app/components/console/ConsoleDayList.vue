<script setup lang="ts">
  // Phone layout of the day-by-day view: one tappable row per day with its calls, the
  // roster number for each shift and the hang-ups either way. Tapping a day opens it in
  // one-day mode.
  import { useConsole } from '~/composables/console/useConsoleState'

  const { dayList, onDayListClick } = useConsole()
</script>

<template>
  <section
    class="daylist reveal range-only mobile-only"
    style="--i: 3"
    id="dayList"
    aria-label="Day by day"
    @click="onDayListClick"
  >
    <template v-if="dayList">
      <div class="dhead" aria-hidden="true">
        <span>Day</span><span class="dchips"><i>Night</i><i>Day</i><i>Eve</i></span
        ><span>Hang-ups</span>
      </div>
      <button
        v-for="row in dayList"
        :key="row.date"
        type="button"
        :class="row.cls"
        :data-day="row.date"
      >
        <span class="dd"
          ><b>{{ row.weekday }}</b> {{ row.date_
          }}<small>{{ row.calls }} calls{{ row.holiday ? `, ${row.holiday}` : '' }}</small></span
        ><span class="dchips"
          ><i v-for="(chip, i) in row.chips" :key="i" :class="chip.cls">{{ chip.text }}</i></span
        ><span class="dlost"
          ><b>{{ row.lost }}</b
          ><small>{{ row.rec }} recommended</small></span
        >
      </button>
    </template>
  </section>
</template>
