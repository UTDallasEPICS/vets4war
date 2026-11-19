<script setup lang="ts">
  // The staffing console. Rendered in the browser only, as the old page was: "today",
  // the date formats and the stored theme are browser facts, and client-only rendering
  // avoids hydration mismatches.
  definePageMeta({ layout: 'console' })
  useHead({ title: 'Vets4Warriors Staffing' })
</script>

<template>
  <ClientOnly>
    <ConsoleApp />
  </ClientOnly>
</template>
