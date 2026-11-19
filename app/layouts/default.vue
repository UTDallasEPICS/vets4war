<script setup lang="ts">
  const colorMode = useColorMode()

  const isDark = computed({
    get() {
      return colorMode.value === 'dark'
    },
    set() {
      colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
    },
  })

  const { user, isAdmin, signOut } = await useSessionUser()
</script>

<template>
  <div
    class="flex min-h-screen flex-col bg-white text-gray-900 transition-colors duration-300 dark:bg-gray-900 dark:text-gray-100"
  >
    <header
      class="sticky top-0 z-50 border-b border-gray-200 bg-white/75 backdrop-blur-md dark:border-gray-800 dark:bg-gray-900/75"
    >
      <UContainer class="flex h-16 items-center justify-between gap-4">
        <div class="flex items-center gap-6">
          <NuxtLink to="/" class="text-lg font-bold">Vets4Warriors staffing</NuxtLink>
          <nav v-if="user" class="flex items-center gap-4 text-sm" aria-label="Main">
            <NuxtLink to="/" class="hover:underline">Staffing</NuxtLink>
            <NuxtLink v-if="isAdmin" to="/admin" class="hover:underline">Admin</NuxtLink>
          </nav>
        </div>

        <div class="flex items-center gap-2">
          <span v-if="user" class="hidden text-sm text-gray-500 sm:inline dark:text-gray-400">
            {{ user.email }}
          </span>
          <UButton v-if="user" color="neutral" variant="ghost" label="Sign out" @click="signOut" />
          <UButton
            :icon="isDark ? 'i-heroicons-moon-20-solid' : 'i-heroicons-sun-20-solid'"
            color="neutral"
            variant="ghost"
            @click="isDark = !isDark"
            aria-label="Toggle Theme"
          />
        </div>
      </UContainer>
    </header>

    <main class="flex-1">
      <slot />
    </main>
  </div>
</template>
