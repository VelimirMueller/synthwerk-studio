<script setup lang="ts">
// The test system banner (synthwerk#45): on every environment that is not prd. The legal texts
// are placeholders until the #49 sign-off, so a test system must never look like the real site.
import type { Locale } from '#shared/sections'

const props = defineProps<{ locale: Locale }>()
const env = useRuntimeConfig().public.site.env
const text = computed(() => SITE_TEXTS[props.locale].envBanner(String(env ?? '')))
</script>

<template>
  <p v-if="showEnvBanner(env)" class="site-env-banner" role="note" data-site-env-banner>
    {{ text }}
  </p>
</template>
