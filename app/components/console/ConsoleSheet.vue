<script setup lang="ts">
  // The detail sheet: opens when you click a day, an hour or drag a selection. Hour
  // view, day view (tiles, hour bars, tours, cap hours, the trade-off tables) and the
  // selection totals.
  import { useConsole } from '~/composables/console/useConsoleState'

  const { ui, sheetOpen, sheetBody, closeSheet, onSheetBodyClick } = useConsole()
</script>

<template>
  <aside class="sheet glass" id="sheet" aria-label="Details" :aria-hidden="!sheetOpen">
    <div class="sheet-head">
      <h2 id="sheetTitle">{{ ui.sheetTitle }}</h2>
      <button
        type="button"
        class="iconbtn"
        id="sheetClose"
        aria-label="Close details"
        @click="closeSheet"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M1 1l10 10M11 1L1 11"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
    <div class="sheet-body" id="sheetBody" @click="onSheetBodyClick">
      <template v-if="sheetBody?.kind === 'hour'">
        <div v-if="sheetBody.chips.length" class="chips">
          <span v-for="chip in sheetBody.chips" :key="chip.cls" :class="chip.cls">{{
            chip.text
          }}</span>
        </div>
        <div :class="`hero-n cap-${sheetBody.capState}`">
          <span class="n">{{ sheetBody.staff }}</span
          ><span class="u">people to schedule</span>
        </div>
        <h3 class="chart-head">Calls through the day</h3>
        <ConsoleHourBars :vm="sheetBody.bars" />
        <ul class="rows">
          <li v-for="l in sheetBody.lines" :key="l.k" :class="l.cls">
            <div class="line">
              <span class="k">{{ l.k }}</span
              ><span class="v">{{ l.v }}</span>
            </div>
            <div v-if="l.f" class="f">{{ l.f }}</div>
          </li>
        </ul>
        <p v-if="sheetBody.reason" class="reason">{{ sheetBody.reason }}</p>
        <div v-if="sheetBody.foot" class="sheet-foot">
          <button type="button" class="pill" :data-open-day="sheetBody.foot.date">
            See the whole day</button
          ><button
            v-if="sheetBody.foot.focus"
            type="button"
            class="pill"
            :data-focus-day="sheetBody.foot.date"
          >
            Look at this day alone
          </button>
        </div>
      </template>
      <template v-else-if="sheetBody?.kind === 'selection'">
        <p class="hint">{{ sheetBody.hint }}</p>
        <div class="tiles">
          <div v-for="[k, v] in sheetBody.tiles" :key="k" class="tile">
            <div class="k">{{ k }}</div>
            <div class="v">{{ v }}</div>
          </div>
        </div>
        <div class="sheet-foot">
          <button type="button" class="pill" data-clear-selection>Clear selection</button>
        </div>
      </template>
      <template v-else-if="sheetBody?.kind === 'missing'">
        <p class="hint">{{ sheetBody.hint }}</p>
      </template>
      <template v-else-if="sheetBody?.kind === 'day'">
        <div v-if="sheetBody.holiday" class="chips">
          <span class="chip hol">{{ sheetBody.holiday }}</span>
        </div>
        <div class="tiles">
          <div v-for="[k, v] in sheetBody.tiles" :key="k" class="tile">
            <div class="k">{{ k }}</div>
            <div class="v">{{ v }}</div>
          </div>
        </div>
        <h3 class="chart-head">Calls through the day</h3>
        <ConsoleHourBars :vm="sheetBody.bars" />
        <table class="tours">
          <tbody>
            <tr>
              <th>Tour</th>
              <th>Need</th>
              <th>Planned</th>
              <th>Verdict</th>
            </tr>
            <tr v-for="t in sheetBody.tours" :key="t.name">
              <td>{{ t.name }}</td>
              <td>{{ t.need }}</td>
              <td>{{ t.planned }}<small v-if="t.following">following</small></td>
              <td :class="t.verdictCls">
                {{ t.verdict }}<small v-if="t.level">{{ t.level }}</small>
              </td>
            </tr>
          </tbody>
        </table>
        <ul class="rows">
          <li v-for="l in sheetBody.lines" :key="l.k" :class="l.cls">
            <div class="line">
              <span class="k">{{ l.k }}</span
              ><span class="v">{{ l.v }}</span>
            </div>
            <div v-if="l.f" class="f">{{ l.f }}</div>
          </li>
        </ul>
        <template v-for="t in sheetBody.tradeoffs" :key="t.name">
          <h3 class="tradeoff-head">
            {{ t.name }} <small>{{ t.span }} · {{ t.calls }} calls · cap {{ t.cap }}</small>
          </h3>
          <table class="tours tradeoff">
            <tbody>
              <tr>
                <th>Staff</th>
                <th title="Scheduled people actually on inbound after efficiency (rounded down)">
                  On phones
                </th>
                <th>In {{ t.targetSec }} s</th>
                <th>Hang up</th>
                <th>Lost calls</th>
                <th>Late</th>
              </tr>
              <tr v-for="r in t.rows" :key="r.staff" :class="r.cls">
                <td>
                  {{ r.staff }}{{ r.label ? ' ' : '' }}<small v-if="r.label">{{ r.label }}</small>
                </td>
                <td>{{ r.effective }}</td>
                <td>{{ r.sl }}</td>
                <td>{{ r.lostShare }}</td>
                <td>{{ r.lost }}</td>
                <td>{{ r.late }}</td>
              </tr>
            </tbody>
          </table>
        </template>
        <p class="hint">{{ sheetBody.hint }}</p>
        <div v-if="sheetBody.foot" class="sheet-foot">
          <button type="button" class="pill" :data-focus-day="sheetBody.foot.date">
            Look at this day alone
          </button>
        </div>
      </template>
    </div>
  </aside>
</template>
