<script setup lang="ts">
  // The frame of /auth and /admin, drawn like the console's top bar: the bar-chart mark
  // and the name, then a pill switch between the two pages, then the person and their
  // controls as pills.
  const colorMode = useColorMode()
  const route = useRoute()

  function toggleTheme() {
    colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
  }

  const { user, isAdmin, signOut } = await useSessionUser()

  const subtitle = computed(() =>
    route.path.startsWith('/admin')
      ? 'Admin: call data, forecast runs and people'
      : 'Call-volume forecast and shift staffing'
  )

  const navLink =
    'inline-flex h-[30px] items-center rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap text-muted transition-colors hover:text-default'
  const navActive = '!bg-inverted !text-inverted'
</script>

<template>
  <div class="bg-default text-default flex min-h-screen flex-col">
    <header class="mx-auto w-full max-w-[1280px] px-[max(16px,2vw)] pt-6">
      <!-- On a phone the row wraps (brand, then the switch and the buttons) instead of
           pushing the page sideways; below sm Sign out is an icon with an accessible name. -->
      <div class="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-3">
        <div class="flex min-w-0 items-center gap-3">
          <NuxtLink
            to="/"
            class="flex min-w-0 items-center gap-3 text-[20px] leading-tight font-semibold tracking-[-0.028em] whitespace-nowrap [font-stretch:92%] sm:text-[22px]"
          >
            <span
              class="bg-inverted text-inverted grid size-10 flex-none place-items-center rounded-[11px]"
              aria-hidden="true"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <rect
                  x="2"
                  y="9"
                  width="3.2"
                  height="9"
                  rx="1.6"
                  fill="currentColor"
                  opacity="0.5"
                />
                <rect
                  x="8.4"
                  y="5"
                  width="3.2"
                  height="13"
                  rx="1.6"
                  fill="currentColor"
                  opacity="0.75"
                />
                <rect x="14.8" y="2" width="3.2" height="16" rx="1.6" fill="currentColor" />
              </svg>
            </span>
            Vets4Warriors staffing
          </NuxtLink>
        </div>
        <p class="text-muted hidden min-w-0 truncate text-[13px] lg:block">{{ subtitle }}</p>

        <span class="flex-1" />

        <nav v-if="user" class="bg-elevated inline-flex rounded-full p-[3px]" aria-label="Main">
          <NuxtLink to="/" :class="navLink" :exact-active-class="navActive">Staffing</NuxtLink>
          <NuxtLink v-if="isAdmin" to="/admin" :class="navLink" :active-class="navActive">
            Admin
          </NuxtLink>
        </nav>

        <div class="flex items-center gap-2">
          <span v-if="user" class="text-muted hidden text-[13px] md:inline">
            {{ user.email }}
          </span>
          <!-- Both icons, chosen by the `dark` class: the server cannot know the stored
               theme, and markup that depends on it would mismatch at hydration (a
               production build keeps the server's icon). -->
          <UButton
            color="neutral"
            variant="soft"
            square
            class="size-9 justify-center"
            aria-label="Toggle Theme"
            @click="toggleTheme"
          >
            <span class="flex dark:hidden">
              <UIcon name="i-heroicons-sun-20-solid" class="size-[18px]" />
            </span>
            <span class="hidden dark:flex">
              <UIcon name="i-heroicons-moon-20-solid" class="size-[18px]" />
            </span>
          </UButton>
          <UButton
            v-if="user"
            color="neutral"
            variant="soft"
            class="h-9 px-3 text-[13px] sm:px-4"
            icon="i-heroicons-arrow-right-start-on-rectangle-20-solid"
            aria-label="Sign out"
            @click="signOut"
          >
            <span class="hidden sm:inline">Sign out</span>
          </UButton>
        </div>
      </div>
    </header>

    <main class="mx-auto w-full max-w-[1280px] flex-1 px-[max(16px,2vw)] pt-8 pb-12">
      <slot />
    </main>
  </div>
</template>
