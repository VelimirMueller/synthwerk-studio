<script setup lang="ts">
// The script gate of the public site (synthwerk#45). Umami loads only when the visitor allowed
// analytics and NUXT_PUBLIC_SITE_ANALYTICS_SCRIPT_URL and _WEBSITE_ID are set. Without both,
// no request leaves the page. The server never renders the script tag. On a prerendered page the
// script waits for the settings of the running server (useSiteConfig).
const { state } = useConsent()
const site = useSiteConfig()
const script = computed(() =>
  state.value.ready && site.ready.value
    ? analyticsScript(state.value.choice, site.config.value.analytics)
    : null
)

useHead(() => ({
  script: script.value
    ? [
        {
          key: 'site-analytics',
          src: script.value.src,
          defer: true,
          'data-website-id': script.value.websiteId,
          // Umami honours the browser's Do Not Track setting too.
          'data-do-not-track': 'true'
        }
      ]
    : []
}))
</script>

<template>
  <span hidden />
</template>
