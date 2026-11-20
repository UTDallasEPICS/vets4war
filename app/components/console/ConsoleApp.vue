<script setup lang="ts">
  // The console root: creates the state (the port of web/app.js), puts the page's state
  // classes on the .v4w root of the layout (ready, is-loading, one-day, sheet-open, as
  // the old page did on <body>), and wires the document-level listeners.
  import { onBeforeUnmount, onMounted, shallowRef, watchEffect } from 'vue'
  import { createConsoleState, provideConsoleState } from '~/composables/console/useConsoleState'

  const state = createConsoleState()
  provideConsoleState(state)

  const root = shallowRef<HTMLElement | null>(null)
  const page = useTemplateRef<HTMLElement>('page')

  watchEffect(() => {
    const el = root.value
    if (!el) return
    el.classList.toggle('is-loading', state.ui.isLoading)
    el.classList.toggle('ready', state.ui.ready)
    el.classList.toggle('one-day', state.oneDay.value)
    el.classList.toggle('sheet-open', state.sheetOpen.value)
  })

  onMounted(() => {
    root.value = page.value?.closest<HTMLElement>('.v4w') ?? null
    document.addEventListener('keydown', state.onDocumentKeydown)
    window.addEventListener('pageshow', state.onPageShow)
    state.init()
  })
  onBeforeUnmount(() => {
    document.removeEventListener('keydown', state.onDocumentKeydown)
    window.removeEventListener('pageshow', state.onPageShow)
    root.value?.classList.remove('is-loading', 'ready', 'one-day', 'sheet-open')
  })
</script>

<template>
  <div ref="page" class="page">
    <ConsoleTopbar />
    <ConsoleDock />
    <ConsoleBanners />
    <ConsoleOutlook />
    <ConsoleDayChart />
    <ConsoleDayList />
    <ConsoleDayFocus />
    <ConsoleBoard />
  </div>
  <ConsoleSheet />
</template>
