<script setup lang="ts">
  // Lead block of an outlook card: the hang-up count, then its figures. Re-created on
  // every render (keyed by the parent) so the count can roll from its last value.
  import type { LeadVm } from '~/composables/console/useConsoleState'

  defineProps<{ vm: LeadVm }>()
</script>

<template>
  <div class="lead-top" :title="vm.note">
    <div class="lead-n">
      <span class="n num">{{ vm.count }}</span
      ><span class="u">hang-ups</span>
    </div>
    <dl v-if="vm.figs.length" class="figs">
      <div v-for="[k, v] in vm.figs" :key="k" class="fig">
        <dt>{{ k }}</dt>
        <dd class="num">{{ v }}</dd>
      </div>
    </dl>
  </div>
</template>
