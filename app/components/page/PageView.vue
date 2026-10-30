<script setup lang="ts">
// A whole builder page: the sections in order. The editor preview and the public site use it.
import type { PageContent } from '#shared/sections'

defineProps<{ content: PageContent }>()
</script>

<template>
  <article class="page-view" :aria-label="content.title">
    <PageSection v-for="section in content.sections" :key="section.id" :section="section" />
    <p v-if="content.sections.length === 0" class="muted">The page has no sections yet.</p>
  </article>
</template>
