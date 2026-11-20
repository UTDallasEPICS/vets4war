<script setup lang="ts">
  // The console's own layout: no header, the old console's stylesheet scoped to .v4w,
  // and its font. Instrument Sans is loaded from Google Fonts exactly as final-main's
  // page did (two preconnects, the width axis 75..100 that the condensed numerals
  // use); the generic font module would drop the width axis.
  import '~/assets/css/console.css'

  const colorMode = useColorMode()

  useHead({
    link: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Instrument+Sans:wdth,wght@75..100,400..700&display=swap',
      },
    ],
  })
</script>

<template>
  <div class="v4w" :data-theme="colorMode.value === 'dark' ? 'dark' : 'light'">
    <slot />
  </div>
</template>
