<script setup lang="ts">
// The frame of every public page (synthwerk#45): language, skip link, test system banner,
// legal links, cookie settings, the consent banner and the script gate. No session, no studio
// navigation. Every request goes to the own origin until the visitor allows analytics.
import type { Locale } from '#shared/sections'

const props = defineProps<{ locale: Locale; slug: string; title: string }>()
const texts = computed(() => SITE_TEXTS[props.locale])
const { load, openSettings } = useConsent()

useHead(() => ({
  htmlAttrs: { lang: props.locale },
  title: props.title,
  link: [
    { rel: 'alternate', hreflang: props.locale, href: sitePath(props.locale, props.slug) },
    {
      rel: 'alternate',
      hreflang: props.locale === 'de' ? 'en' : 'de',
      href: switchPath(props.locale, props.slug)
    }
  ]
}))

onMounted(load)
</script>

<template>
  <div class="site">
    <a class="site-skip" href="#site-main">{{ texts.skipLink }}</a>
    <SiteEnvBanner :locale="locale" />
    <header class="site-header">
      <NuxtLink :to="sitePath(locale)" class="site-brand">Synthwerk</NuxtLink>
      <NuxtLink
        :to="switchPath(locale, slug)"
        :hreflang="locale === 'de' ? 'en' : 'de'"
        :lang="locale === 'de' ? 'en' : 'de'"
        class="site-link"
      >
        {{ texts.switchLabel }}
      </NuxtLink>
    </header>
    <main id="site-main" class="site-main" tabindex="-1">
      <slot />
    </main>
    <SiteSlot name="mascot" />
    <SiteSlot name="widget" />
    <footer class="site-footer">
      <nav :aria-label="texts.footerLabel">
        <ul class="site-footer__links">
          <li v-for="page in LEGAL_PAGES" :key="page">
            <NuxtLink :to="sitePath(locale, LEGAL_SLUGS[locale][page])" class="site-link">
              {{ texts.legal[page] }}
            </NuxtLink>
          </li>
          <li>
            <button type="button" class="site-link site-link--button" @click="openSettings">
              {{ texts.cookieSettings }}
            </button>
          </li>
        </ul>
      </nav>
    </footer>
    <SiteConsentBanner :locale="locale" />
    <SiteAnalytics />
  </div>
</template>
