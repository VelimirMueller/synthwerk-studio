<script setup lang="ts">
// The consent banner of the public site (synthwerk#45). Not modal: the page stays usable.
// Both choices are buttons of the same kind and size: refusing is as easy as accepting.
// Opened from "Cookie settings", it takes the focus; a choice gives the focus back.
import { SwButton } from '@synthwerk/ui-vue'
import type { Locale } from '#shared/sections'

const props = defineProps<{ locale: Locale }>()
const texts = computed(() => SITE_TEXTS[props.locale])
const { state, save } = useConsent()
const title = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

watch(
  () => state.value.open && state.value.focus,
  async (focus) => {
    if (!focus) return
    // Opened by the visitor from "Cookie settings": move the focus into the banner.
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    title.value?.focus()
  }
)

function choose(analytics: boolean) {
  save({ analytics }, texts.value.consent.saved(analytics))
  returnFocus?.focus()
  returnFocus = null
}
</script>

<template>
  <section
    v-if="state.ready && state.open"
    class="site-consent"
    aria-labelledby="site-consent-title"
    aria-describedby="site-consent-body"
  >
    <h2 id="site-consent-title" ref="title" tabindex="-1">{{ texts.consent.title }}</h2>
    <p id="site-consent-body">{{ texts.consent.body }}</p>
    <div class="site-consent__actions">
      <SwButton kind="secondary" data-consent="reject" @click="choose(false)">
        {{ texts.consent.reject }}
      </SwButton>
      <SwButton kind="secondary" data-consent="accept" @click="choose(true)">
        {{ texts.consent.accept }}
      </SwButton>
      <NuxtLink :to="sitePath(locale, LEGAL_SLUGS[locale].cookies)" class="site-link">
        {{ texts.consent.more }}
      </NuxtLink>
    </div>
  </section>
  <p class="sr-only" role="status" aria-live="polite">{{ state.announce }}</p>
</template>
