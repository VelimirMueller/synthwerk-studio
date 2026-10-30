<script setup lang="ts">
// A place for a later embed (synthwerk#45): the mascot (#48) and the chat widget. Empty today.
// It loads nothing: a widget may load only after its own wiring and, where needed, consent.
defineProps<{ name: 'mascot' | 'widget' }>()
</script>

<template>
  <div class="site-slot" :data-site-slot="name" aria-hidden="true" />
</template>
