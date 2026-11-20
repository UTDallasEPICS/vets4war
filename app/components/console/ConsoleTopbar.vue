<script setup lang="ts">
  // Top bar: brand, the period, the data source, the view switch, the theme and the
  // exports; then two additions of the rebuild in the same style: Admin (admins only)
  // and Sign out.
  import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
  import type { ComputedRef } from 'vue'
  import { useConsole } from '~/composables/console/useConsoleState'
  import { useConsoleExports } from '~/composables/console/useConsoleExports'

  const state = useConsole()
  const { ui, oneDay, onModeDay, onModeRange } = state
  const { exportCsv, exportPng, exportReport } = useConsoleExports(state)

  const colorMode = useColorMode()
  const isDark = computed(() => colorMode.value === 'dark')
  function toggleTheme() {
    colorMode.preference = isDark.value ? 'light' : 'dark'
  }

  // The session is already loaded by the route guard; this only reads it.
  const session = shallowRef<{
    isAdmin: ComputedRef<boolean>
    signOut: () => Promise<void>
  } | null>(null)
  void useSessionUser().then((s) => {
    session.value = s
  })
  const isAdmin = computed(() => session.value?.isAdmin.value === true)

  // The three exports share one menu, so the top bar holds fewer pills. Closes on a
  // choice, a click elsewhere or Escape.
  const exportOpen = ref(false)
  const exportMenu = ref<HTMLElement | null>(null)
  function runExport(action: () => void | Promise<void>) {
    exportOpen.value = false
    void action()
  }
  function closeOnOutside(event: PointerEvent) {
    if (exportMenu.value && !exportMenu.value.contains(event.target as Node)) {
      exportOpen.value = false
    }
  }
  function closeOnEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') exportOpen.value = false
  }
  onMounted(() => {
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', closeOnOutside)
    document.removeEventListener('keydown', closeOnEscape)
  })

  const signingOut = ref(false)
  const signOutFailed = ref(false)
  async function signOut() {
    if (!session.value) return
    signingOut.value = true
    try {
      await session.value.signOut()
    } catch {
      signingOut.value = false
      signOutFailed.value = true
    }
  }
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="mark"
        ><svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <rect x="2" y="9" width="3.2" height="9" rx="1.6" fill="currentColor" opacity="0.5" />
          <rect x="8.4" y="5" width="3.2" height="13" rx="1.6" fill="currentColor" opacity="0.75" />
          <rect x="14.8" y="2" width="3.2" height="16" rx="1.6" fill="currentColor" /></svg
      ></span>
      <div>
        <h1>Vets4Warriors staffing</h1>
        <p class="sub" id="pageSub">{{ ui.pageSub }}</p>
      </div>
    </div>
    <span :class="ui.badgeCls" id="sourceBadge" :hidden="ui.badgeHidden">{{ ui.badgeText }}</span>
    <span class="spacer"></span>
    <div class="seg" role="group" aria-label="What to look at">
      <button type="button" id="modeRange" :aria-pressed="!oneDay" @click="onModeRange">
        Date range
      </button>
      <button
        type="button"
        id="modeDay"
        :aria-pressed="oneDay"
        title="Look at a single day, hour by hour"
        @click="onModeDay"
      >
        One day
      </button>
    </div>
    <div class="actions">
      <button
        type="button"
        class="pill"
        id="themeToggle"
        :aria-pressed="isDark"
        :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
        @click="toggleTheme"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-width="1.5" />
          <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor" /></svg
        ><span class="theme-label">{{ isDark ? 'Light' : 'Dark' }}</span>
      </button>
      <div ref="exportMenu" class="menu">
        <button
          type="button"
          class="pill"
          id="exportMenu"
          aria-haspopup="menu"
          :aria-expanded="exportOpen"
          aria-controls="exportList"
          @click="exportOpen = !exportOpen"
        >
          Export
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M3 4.5 6 7.5l3-3"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <div v-show="exportOpen" id="exportList" class="menu-list glass" role="menu">
          <button type="button" role="menuitem" id="exportReport" @click="runExport(exportReport)">
            Report
            <span class="hint">Printable summary of the period; save it as a PDF</span>
          </button>
          <button type="button" role="menuitem" id="exportCsv" @click="runExport(exportCsv)">
            CSV
            <span class="hint">Every hour, with your planned staff and verdicts</span>
          </button>
          <button type="button" role="menuitem" id="exportPng" @click="runExport(exportPng)">
            Image
            <span class="hint">The grid as currently computed</span>
          </button>
        </div>
      </div>
      <NuxtLink v-if="isAdmin" to="/admin" class="pill" id="adminLink">Admin</NuxtLink>
      <button type="button" class="pill" id="signOut" :disabled="signingOut" @click="signOut">
        {{ signOutFailed ? 'Sign out failed, try again' : 'Sign out' }}
      </button>
    </div>
  </header>
</template>
