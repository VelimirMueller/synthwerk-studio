<script setup lang="ts">
// The test system banner (synthwerk#45): on every environment that is not prd. The legal texts
// are placeholders until the #49 sign-off, so a test system must never look like the real site.
import type { Locale } from '#shared/sections'

const props = defineProps<{ locale: Locale }>()
// The env of the running server, also on a prerendered page (useSiteConfig).
const { config } = useSiteConfig()
const text = computed(() => SITE_TEXTS[props.locale].envBanner(config.value.env))
</script>

<template>
  <p v-if="showEnvBanner(config.env)" class="site-env-banner" role="note" data-site-env-banner>
    {{ text }}
  </p>
</template>
