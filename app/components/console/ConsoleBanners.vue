<script setup lang="ts">
  // The error banner and the holiday-coverage note.
  import { useConsole } from '~/composables/console/useConsoleState'

  const { ui } = useConsole()
</script>

<template>
  <div class="banner error" id="error" role="alert" :hidden="ui.errorHidden">
    {{ ui.errorText }}
  </div>
  <div class="banner error" id="controlError" role="alert" :hidden="!ui.controlProblem">
    {{ ui.controlProblem }}
  </div>
  <div class="banner note" id="holidayNote" :hidden="ui.holidayNoteHidden">
    {{ ui.holidayNote }}
  </div>
</template>
