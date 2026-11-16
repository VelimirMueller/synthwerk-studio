<script setup lang="ts">
// A place for a later embed (synthwerk#45): the mascot (#48). Empty today. The `widget` place
// is SiteDemo now (synthwerk#47). It loads nothing: a widget may load only after its own wiring
// and, where needed, consent.
defineProps<{ name: 'mascot' }>()
</script>

<template>
  <div class="site-slot" :data-site-slot="name" aria-hidden="true" />
</template>
