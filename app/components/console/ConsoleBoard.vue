<script setup lang="ts">
  // The board: heading, legend, the grid (or, before the first retrain, the empty
  // state), and the notes on how the numbers are worked out.
  import { computed, shallowRef } from 'vue'
  import type { ComputedRef } from 'vue'
  import { useConsole } from '~/composables/console/useConsoleState'

  const { ui, story, gridNote } = useConsole()

  const session = shallowRef<{ isAdmin: ComputedRef<boolean> } | null>(null)
  void useSessionUser().then((s) => {
    session.value = s
  })
  const isAdmin = computed(() => session.value?.isAdmin.value === true)
</script>

<template>
  <section class="board reveal" style="--i: 4" aria-label="People to schedule per hour">
    <div class="board-head">
      <h2>People to schedule, hour by hour</h2>
      <p>Click an hour or a day to open it. Drag to total hours.</p>
    </div>
    <div class="legend" id="legend">
      <span data-legend="under" title="Under the shift cap, one shade per person"
        ><span class="sw under"></span>Under cap (<b id="legendRange">{{ ui.legendRange }}</b
        >)</span
      >
      <span data-legend="at" title="At the shift cap: 7 people, Evening 6"
        ><span class="sw at"></span>At cap</span
      >
      <span
        data-legend="over"
        title="Over the shift cap. The small line is the service level you would get at the cap."
        ><span class="sw over"></span>Over cap</span
      >
      <span title="A Roster cell where you typed your own number"
        ><span class="sw own"></span>Your number</span
      >
      <span><span class="sw hol"></span>Holiday</span>
    </div>
    <div v-if="ui.noForecast" class="card" id="noForecast">
      <p class="hint">No forecast yet. An admin needs to load call data and run a retrain.</p>
      <NuxtLink v-if="isAdmin" to="/admin" class="pill primary">Open admin</NuxtLink>
    </div>
    <div v-else class="grid-scroll" id="gridScroll">
      <ConsoleGrid />
    </div>
    <details class="notes">
      <summary>How these numbers are worked out</summary>
      <p id="story">
        <template v-if="story?.kind === 'plain'">{{ story.text }}</template>
        <template v-else-if="story?.kind === 'gap'"
          >Scheduled hours exceed expected talk time by <b>{{ story.gap }}</b
          >{{ story.ratio }}. {{ story.rest
          }}<template v-if="story.fewer">
            With one fewer person every hour, hang-ups would rise from
            <b>{{ story.fewer.from }}</b> to <b>{{ story.fewer.to }}</b
            >.</template
          ></template
        >
      </p>
      <p id="gridNote">{{ gridNote }}</p>
      <p id="caveat">{{ ui.caveat }}</p>
    </details>
  </section>
</template>
