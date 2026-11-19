<script setup lang="ts">
  // Top bar: brand, the period, the data source, the view switch, the theme and the
  // exports; then two additions of the rebuild in the same style: Admin (admins only)
  // and Sign out.
  import { computed, ref, shallowRef } from 'vue'
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
    <span :class="ui.badgeCls" id="sourceBadge">{{ ui.badgeText }}</span>
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
      <button
        type="button"
        class="pill"
        id="exportReport"
        title="Printable summary of the selected period; save it as a PDF from the print dialog"
        @click="exportReport"
      >
        Export report
      </button>
      <button
        type="button"
        class="pill"
        id="exportCsv"
        title="Every hour, with your planned staff and verdicts"
        @click="exportCsv"
      >
        Export CSV
      </button>
      <button
        type="button"
        class="pill"
        id="exportPng"
        title="The grid as currently computed"
        @click="exportPng"
      >
        Export image
      </button>
      <NuxtLink v-if="isAdmin" to="/admin" class="pill" id="adminLink">Admin</NuxtLink>
      <button type="button" class="pill" id="signOut" :disabled="signingOut" @click="signOut">
        {{ signOutFailed ? 'Sign out failed, try again' : 'Sign out' }}
      </button>
    </div>
  </header>
</template>
