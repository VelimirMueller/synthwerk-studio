<script setup lang="ts">
// A public page (synthwerk#45, #109): /de, /en, /de/{slug}, /en/{slug}. No session and no auth
// middleware: a visitor never needs to sign in.
// - /de and /en show the live builder page with the slug `home`.
// - A legal slug (impressum, datenschutz, imprint, privacy, cookies) renders the static legal
//   page with its placeholder. A builder page with that slug never shows.
// - Any other slug shows the live builder version from /api/site. No live version: 404.
import { SLUG_PATTERN } from '#shared/sections'

definePageMeta({
  validate: (route) =>
    isLocale(route.params.locale) &&
    (route.params.slug === undefined ||
      route.params.slug === '' ||
      (typeof route.params.slug === 'string' && SLUG_PATTERN.test(route.params.slug)))
})

const route = useRoute()
const locale = isLocale(route.params.locale) ? route.params.locale : 'en'
const slug =
  typeof route.params.slug === 'string' && route.params.slug ? route.params.slug : HOME_SLUG
const legal = legalPageOf(locale, slug)
const data = legal ? null : await useLivePage(locale, slug)

const title = computed(() =>
  legal ? SITE_TEXTS[locale].legal[legal] : (data?.value?.content.title ?? 'Synthwerk')
)
</script>

<template>
  <SiteShell :locale="locale" :slug="slug" :title="title">
    <SiteLegalPage v-if="legal" :locale="locale" :page="legal" />
    <PageView v-else-if="data" :content="data.content" />
  </SiteShell>
</template>
