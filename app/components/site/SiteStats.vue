<script setup lang="ts">
// The public numbers of the site (synthwerk#47): uptime and answered chats over 30 days, p95.
// From /api/site/stats (own origin, cached 60 s); pulse stays inside the network. A missing value
// shows "-". The numbers load on the client: a prerendered page must not keep old numbers.
import type { Locale } from '#shared/sections'

const props = defineProps<{ locale: Locale }>()
const texts = computed(() => DEMO_TEXTS[props.locale].stats)
const stats = ref<Parameters<typeof formatStats>[1]>(null)
const view = computed(() => formatStats(props.locale, stats.value))

onMounted(async () => {
  try {
    stats.value = await $fetch('/api/site/stats')
  } catch {
    stats.value = null
  }
})
</script>

<template>
  <section class="site-stats" :aria-label="texts.label">
    <dl class="site-stats__list">
      <div class="site-stats__item">
        <dt>{{ texts.uptime }}</dt>
        <dd data-stat="uptime">{{ view.uptime }}</dd>
      </div>
      <div class="site-stats__item">
        <dt>{{ texts.p95 }}</dt>
        <dd data-stat="p95">{{ view.p95 }}</dd>
      </div>
      <div class="site-stats__item">
        <dt>{{ texts.chats }}</dt>
        <dd data-stat="chats">{{ view.chats }}</dd>
      </div>
    </dl>
  </section>
</template>
