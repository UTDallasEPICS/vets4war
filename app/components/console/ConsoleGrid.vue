<script setup lang="ts">
  // The staffing grid: one row per date, one cell per visible hour, a roster cell per
  // tour. Rows re-render only when their own data, selection, active hour or picked
  // state changes (v-memo), so dragging a selection stays cheap on a 366-day range.
  import { computed } from 'vue'
  import { useConsole, MAJOR_HOURS } from '~/composables/console/useConsoleState'
  import { key as hourKey, shiftKey } from '~/utils/console/logic'

  const {
    ui,
    view,
    selection,
    grid,
    cells,
    peaks,
    profile,
    rosterCells,
    onRowsPointerDown,
    onRowsPointerMove,
    onRowsPointerEnd,
    onRowsClick,
    onRowsKeydown,
    onRowsInput,
  } = useConsole()

  const pad2 = (n: number) => String(n).padStart(2, '0')
  const activeKey = computed(() => (view.value?.type === 'hour' ? view.value.key : null))
  const pickedDate = computed(() => (view.value?.type === 'day' ? view.value.date : null))

  function selSig(date: string): string {
    const sel = selection.value
    return sel && sel.dates.includes(date) ? `${sel.hours[0]}-${sel.hours[1]}` : ''
  }
  function activeIn(date: string): string {
    const k = activeKey.value
    return k && k.startsWith(`${date}:`) ? k : ''
  }
  function cellClass(date: string, hour: number): string {
    const k = hourKey(date, hour)
    const vm = cells.value.get(k)
    let cls = vm ? vm.cls : `h${MAJOR_HOURS.has(hour) ? ' major' : ''}`
    const sel = selection.value
    if (sel && sel.dates.includes(date) && hour >= sel.hours[0] && hour <= sel.hours[1]) {
      cls += ' sel'
    }
    if (activeKey.value === k) cls += ' active'
    return cls
  }
  // A roster field keeps what the person is typing while it has focus (the old page
  // never rewrote the focused field); otherwise it shows their own number, or nothing
  // when the shift follows the recommendation.
  function rosterValue(date: string, shift: string): string {
    const planKey = shiftKey(date, shift)
    const active = document.activeElement as HTMLInputElement | null
    if (active?.closest?.('td.roster')?.getAttribute('data-plan') === planKey) return active.value
    return rosterCells.value.get(planKey)?.own ?? ''
  }
</script>

<template>
  <table class="grid" id="grid" :style="grid.minWidth ? { minWidth: grid.minWidth } : undefined">
    <colgroup id="gridCols">
      <template v-if="grid.tours.length">
        <col class="c-date" />
        <template v-for="(t, ti) in grid.tours" :key="t.spec.name">
          <col v-if="ti > 0" class="c-gap" />
          <col v-for="h in t.hours" :key="h" class="c-h" />
          <col class="c-roster" />
        </template>
      </template>
    </colgroup>
    <thead id="gridHead">
      <template v-if="grid.tours.length">
        <tr>
          <th class="date"></th>
          <template v-for="(t, ti) in grid.tours" :key="t.spec.name">
            <th v-if="ti > 0" class="gap" aria-hidden="true"></th>
            <th class="group" :colspan="t.hours.length + 1">
              {{ t.spec.name }}<small>{{ t.spec.span }}</small>
            </th>
          </template>
        </tr>
        <tr class="profile">
          <th class="date pf-label">Average calls<br />per hour</th>
          <template v-for="(t, ti) in grid.tours" :key="t.spec.name">
            <th v-if="ti > 0" class="gap" aria-hidden="true"></th>
            <th
              v-for="h in t.hours"
              :key="h"
              :class="['pf', { peak: profile.get(h) && peaks.has(h) }]"
              :data-h="h"
              :title="profile.has(h) ? (profile.get(h)?.title ?? '') : undefined"
            >
              <template v-if="profile.get(h)"
                ><span class="pv">{{ profile.get(h)!.pv }}</span
                ><i :style="{ height: profile.get(h)!.height }"></i
              ></template>
            </th>
            <th></th>
          </template>
        </tr>
        <tr>
          <th class="date"></th>
          <template v-for="(t, ti) in grid.tours" :key="t.spec.name">
            <th v-if="ti > 0" class="gap" aria-hidden="true"></th>
            <th
              v-for="h in t.hours"
              :key="h"
              :class="['hh', { major: MAJOR_HOURS.has(h), peak: peaks.has(h) }]"
              :data-h="h"
              :title="
                cells.size
                  ? peaks.has(h)
                    ? 'One of the four busiest hours in this window'
                    : ''
                  : undefined
              "
            >
              {{ pad2(h) }}
            </th>
            <th
              class="roster"
              title="The tour's busiest hour sets the number to roster. Type your own to compare."
            >
              Roster
            </th>
          </template>
        </tr>
      </template>
    </thead>
    <tbody
      id="rows"
      :class="{ fresh: ui.rowsFresh }"
      @pointerdown="onRowsPointerDown"
      @pointermove="onRowsPointerMove"
      @pointerup="onRowsPointerEnd"
      @pointercancel="onRowsPointerEnd"
      @click="onRowsClick"
      @keydown="onRowsKeydown"
      @input="onRowsInput"
    >
      <tr
        v-for="row in grid.rows"
        :key="row.date"
        v-memo="[
          grid,
          cells,
          rosterCells,
          pickedDate === row.date,
          selSig(row.date),
          activeIn(row.date),
        ]"
        :class="[row.cls, { picked: pickedDate === row.date }]"
        :data-d="row.date"
        :style="{ '--r': row.index }"
      >
        <td class="date">
          <button type="button" class="date-btn" :data-day="row.date" :title="row.title">
            <div class="d">
              {{ row.weekday }}<span>{{ row.dayMonth }}</span>
            </div>
            <div class="meta">{{ row.meta }}</div>
          </button>
        </td>
        <template v-for="(t, ti) in grid.tours" :key="t.spec.name">
          <td v-if="ti > 0" class="gap" aria-hidden="true"></td>
          <td
            v-for="h in t.hours"
            :key="h"
            :class="cellClass(row.date, h)"
            :data-k="hourKey(row.date, h)"
            :data-d="row.date"
            :data-h="h"
            tabindex="0"
            :style="
              cells.get(hourKey(row.date, h))
                ? { '--lvl': cells.get(hourKey(row.date, h))!.lvl }
                : undefined
            "
            :aria-label="cells.get(hourKey(row.date, h))?.aria"
            :title="cells.get(hourKey(row.date, h))?.title"
          >
            <template v-if="cells.get(hourKey(row.date, h))?.over"
              ><span class="n">{{ cells.get(hourKey(row.date, h))!.text }}</span
              ><span class="cl"
                >{{ cells.get(hourKey(row.date, h))!.over!.cl
                }}<span class="cl-cap">
                  at {{ cells.get(hourKey(row.date, h))!.over!.cap }}</span
                ></span
              ></template
            >
            <span v-else-if="cells.get(hourKey(row.date, h))" class="n">{{
              cells.get(hourKey(row.date, h))!.text
            }}</span>
          </td>
          <td
            :class="rosterCells.get(shiftKey(row.date, t.spec.name))?.cls ?? 'roster'"
            :data-plan="shiftKey(row.date, t.spec.name)"
            :title="rosterCells.get(shiftKey(row.date, t.spec.name))?.title"
          >
            <input
              type="number"
              name="planned"
              min="0"
              max="99"
              step="1"
              inputmode="numeric"
              autocomplete="off"
              :aria-label="`Planned staff, ${t.spec.name}, ${row.date}`"
              :data-d="row.date"
              :data-s="t.spec.name"
              :placeholder="rosterCells.get(shiftKey(row.date, t.spec.name))?.placeholder"
              :value="rosterValue(row.date, t.spec.name)"
            /><span
              :class="rosterCells.get(shiftKey(row.date, t.spec.name))?.verdictCls ?? 'verdict'"
              ><template v-if="rosterCells.get(shiftKey(row.date, t.spec.name))"
                >{{ rosterCells.get(shiftKey(row.date, t.spec.name))!.verdictText
                }}<span
                  v-if="rosterCells.get(shiftKey(row.date, t.spec.name))!.lost !== null"
                  class="lost"
                  >{{ rosterCells.get(shiftKey(row.date, t.spec.name))!.lost }}</span
                ></template
              ></span
            >
          </td>
        </template>
      </tr>
    </tbody>
  </table>
</template>
