<script setup lang="ts">
  // Calls for each hour of one day, coloured like the grid (charts.js hourBars).
  import type { HourBarsVm } from '~/composables/console/useConsoleState'

  defineProps<{ vm: HourBarsVm | null }>()
</script>

<template>
  <div v-if="vm" class="hourchart">
    <div class="hourbars" role="img" :aria-label="vm.label">
      <i
        v-for="(bar, i) in vm.bars"
        :key="i"
        :class="bar.cls"
        :style="{ height: bar.height }"
        :title="bar.title"
      ></i>
    </div>
    <div class="houraxis" aria-hidden="true">
      <span v-for="tick in vm.axis" :key="tick.text" :style="{ left: tick.left }">{{
        tick.text
      }}</span>
    </div>
  </div>
</template>
