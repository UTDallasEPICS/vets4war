<script setup lang="ts">
  const colorMode = useColorMode()

  function toggleTheme() {
    colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
  }

  const { user, isAdmin, signOut } = await useSessionUser()
</script>

<template>
  <div
    class="flex min-h-screen flex-col bg-white text-gray-900 transition-colors duration-300 dark:bg-gray-900 dark:text-gray-100"
  >
    <header
      class="sticky top-0 z-50 border-b border-gray-200 bg-white/75 backdrop-blur-md dark:border-gray-800 dark:bg-gray-900/75"
    >
      <!-- On a phone the row wraps (brand and links, then the buttons) instead of pushing
           the page sideways; below sm Sign out is an icon with an accessible name. -->
      <UContainer class="flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
        <div class="flex items-center gap-3 sm:gap-6">
          <NuxtLink to="/" class="font-bold sm:text-lg">Vets4Warriors staffing</NuxtLink>
          <nav v-if="user" class="flex items-center gap-3 text-sm sm:gap-4" aria-label="Main">
            <NuxtLink to="/" class="hover:underline">Staffing</NuxtLink>
            <NuxtLink v-if="isAdmin" to="/admin" class="hover:underline">Admin</NuxtLink>
          </nav>
        </div>

        <div class="ml-auto flex items-center gap-1 sm:gap-2">
          <span v-if="user" class="hidden text-sm text-gray-500 sm:inline dark:text-gray-400">
            {{ user.email }}
          </span>
          <UButton
            v-if="user"
            color="neutral"
            variant="ghost"
            icon="i-heroicons-arrow-right-start-on-rectangle-20-solid"
            aria-label="Sign out"
            @click="signOut"
          >
            <span class="hidden sm:inline">Sign out</span>
          </UButton>
          <!-- Both icons, chosen by the `dark` class: the server cannot know the stored
               theme, and markup that depends on it would mismatch at hydration (a
               production build keeps the server's icon). -->
          <UButton
            color="neutral"
            variant="ghost"
            square
            @click="toggleTheme"
            aria-label="Toggle Theme"
          >
            <span class="flex dark:hidden">
              <UIcon name="i-heroicons-sun-20-solid" class="size-5" />
            </span>
            <span class="hidden dark:flex">
              <UIcon name="i-heroicons-moon-20-solid" class="size-5" />
            </span>
          </UButton>
        </div>
      </UContainer>
    </header>

    <main class="flex-1">
      <slot />
    </main>
  </div>
</template>
