<script setup lang="ts">
// A legal page of the public site (synthwerk#45). The text is a placeholder until the legal
// sign-off of synthwerk#49. Do not write legal text here: it comes from Velimir and legal.
// The cookie page also lists the technical facts (cookie name, purpose, duration): they are
// facts about the code, not legal text.
import type { Locale } from '#shared/sections'
import type { LegalPage } from '~/utils/site'

const props = defineProps<{ locale: Locale; page: LegalPage }>()
const texts = computed(() => SITE_TEXTS[props.locale])
const { state, openSettings } = useConsent()
</script>

<template>
  <article class="site-legal" :data-legal-page="page">
    <h1>{{ texts.legal[page] }}</h1>
    <p class="site-placeholder" data-legal-placeholder>
      <strong>{{ texts.placeholderLabel }}:</strong> {{ LEGAL_PLACEHOLDER }}
    </p>
    <section v-if="page === 'cookies'" aria-labelledby="site-cookie-facts">
      <h2 id="site-cookie-facts">{{ texts.cookieFacts.title }}</h2>
      <p class="muted">{{ texts.cookieFacts.note }}</p>
      <table class="site-table">
        <thead>
          <tr>
            <th scope="col">{{ texts.cookieFacts.name }}</th>
            <th scope="col">{{ texts.cookieFacts.purpose }}</th>
            <th scope="col">{{ texts.cookieFacts.duration }}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row"><code>{{ CONSENT_COOKIE }}</code></th>
            <td>{{ texts.cookieFacts.consentPurpose }}</td>
            <td>{{ texts.cookieFacts.consentDuration }}</td>
          </tr>
          <tr>
            <th scope="row">Umami</th>
            <td>{{ texts.cookieFacts.analyticsPurpose }}</td>
            <td>{{ texts.cookieFacts.analyticsDuration }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="state.ready">{{ texts.cookieFacts.current(state.choice?.analytics ?? null) }}</p>
      <button type="button" class="site-link site-link--button" @click="openSettings">
        {{ texts.cookieSettings }}
      </button>
    </section>
  </article>
</template>
