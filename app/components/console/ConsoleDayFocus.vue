<script setup lang="ts">
  // One day, hour by hour (dayfocus.js): the call load, what the grid recommends, then
  // what the slider roster delivers in the same hour. A table on wider screens, a list
  // of hours on phones.
  import { useConsole } from '~/composables/console/useConsoleState'

  const { ui, dayFocus, openHourFrom } = useConsole()
</script>

<template>
  <section class="card dayfocus reveal day-only" style="--i: 3" aria-label="One day, hour by hour">
    <header class="card-head">
      <h2 id="dayFocusTitle">{{ ui.dayFocusTitle }}</h2>
      <span class="key miss"><i></i>Misses your answer target</span>
    </header>
    <div class="focus-scroll desktop-only" id="dayFocus" @click="openHourFrom">
      <table v-if="dayFocus" class="focus">
        <colgroup>
          <col class="f-label" />
          <col v-for="h in dayFocus.hours" :key="h.key" />
        </colgroup>
        <thead>
          <tr class="f-groups">
            <th></th>
            <th v-for="t in dayFocus.tours" :key="t.name" class="edge" :colspan="t.count">
              {{ t.name }}<small>{{ t.span }}</small>
            </th>
          </tr>
          <tr class="f-chart">
            <th>Predicted calls</th>
            <td
              v-for="h in dayFocus.hours"
              :key="h.key"
              :class="dayFocus.firstOfTour.has(h.hour) ? 'edge' : ''"
              :data-k="h.key"
              :title="h.title"
            >
              <span class="fv">{{ h.fv }}</span
              ><i :style="{ height: h.height }"></i>
            </td>
          </tr>
          <tr class="f-hours">
            <th></th>
            <td
              v-for="h in dayFocus.hours"
              :key="h.key"
              :class="dayFocus.firstOfTour.has(h.hour) ? 'edge' : ''"
              :data-k="h.key"
            >
              {{ String(h.hour).padStart(2, '0') }}
            </td>
          </tr>
        </thead>
        <tbody>
          <template v-for="(row, i) in dayFocus.rows" :key="i">
            <tr v-if="'section' in row" :class="`f-section ${row.tone}`">
              <th :colspan="dayFocus.hours.length + 1">
                <span>{{ row.section }}</span>
              </th>
            </tr>
            <tr v-else>
              <th>{{ row.label }}</th>
              <td v-for="cell in row.cells" :key="cell.key" :class="cell.cls" :data-k="cell.key">
                {{ cell.text }}
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <div class="hlist mobile-only" id="dayFocusList" @click="openHourFrom">
      <template v-if="dayFocus">
        <div class="hhead" aria-hidden="true">
          <span>Hour</span><span>Calls</span><span>Recommended</span><span>Your roster</span>
        </div>
        <template v-for="t in dayFocus.list.tours" :key="t.name">
          <h3 class="htour">
            {{ t.name }}<small>{{ t.span }}</small>
          </h3>
          <button v-for="r in t.rows" :key="r.key" type="button" class="hrow" :data-k="r.key">
            <span class="hh">{{ r.hh }}</span
            ><span class="hcalls"
              ><i :style="{ width: r.width }"></i><b>{{ r.calls }}</b></span
            ><span :class="['hpair', { miss: r.recMiss }]"
              ><i :class="r.recCls">{{ r.recStaff }}</i
              ><small>{{ r.recLevel }}</small></span
            ><span :class="['hpair', { miss: r.ownMiss }]"
              ><i class="chip-s ownroster">{{ r.ownStaff }}</i
              ><small>{{ r.ownLevel }}</small></span
            >
          </button>
        </template>
      </template>
    </div>
  </section>
</template>
