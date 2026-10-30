<script setup lang="ts">
import { SwButton, SwCard, SwInput } from '@synthwerk/ui-vue'
// The lead form of a builder page (synthwerk#105). On the public site it sends to
// POST /api/site/leads; the visitor then gets a confirm mail (double opt-in). In the editor
// preview there is no page context: the form shows, but it sends nothing.
// No third-party request: the form posts to the own origin only.
import { checkLeadEmail, MAX_EMAIL_LENGTH, MAX_NAME_LENGTH } from '#shared/leads'
import type { LeadSection } from '#shared/sections'

const props = defineProps<{ section: LeadSection }>()
const context = inject<SitePageContext | null>(SITE_PAGE_KEY, null)
const texts = computed(() => SITE_TEXTS[context?.locale ?? 'en'].lead)
const id = computed(() => `lead-${props.section.id}`)

const email = ref('')
const name = ref('')
const consent = ref(false)
/** Honeypot: hidden from people, bots fill it. */
const website = ref('')
const state = ref<'idle' | 'sending' | 'sent'>('idle')
const error = ref('')

function errorText(err: unknown): string {
  const status = (err as { statusCode?: number } | null)?.statusCode
  const code = (err as { data?: { data?: { code?: unknown } } } | null)?.data?.data?.code
  if (code === 'invalid_email') return texts.value.invalidEmail
  if (code === 'consent_required') return texts.value.consentRequired
  if (status === 429) return texts.value.tooMany
  return texts.value.failed
}

async function submit() {
  if (!context || state.value !== 'idle') return
  error.value = ''
  if (!checkLeadEmail(email.value)) {
    error.value = texts.value.invalidEmail
    return
  }
  if (!consent.value) {
    error.value = texts.value.consentRequired
    return
  }
  state.value = 'sending'
  try {
    await $fetch('/api/site/leads', {
      method: 'POST',
      body: {
        locale: context.locale,
        slug: context.slug,
        sectionId: props.section.id,
        email: email.value.trim(),
        ...(props.section.nameField ? { name: name.value.trim() } : {}),
        consent: true,
        website: website.value
      }
    })
    state.value = 'sent'
    email.value = ''
    name.value = ''
  } catch (err) {
    state.value = 'idle'
    error.value = errorText(err)
  }
}
</script>

<template>
  <SwCard :title="section.title">
    <PageRichText :text="section.body" />
    <p v-if="state === 'sent'" class="lead-form__done" role="status">{{ texts.sent }}</p>
    <form v-else class="form lead-form" novalidate @submit.prevent="submit">
      <div class="field">
        <label :for="`${id}-email`">{{ texts.email }}</label>
        <SwInput
          :id="`${id}-email`"
          v-model="email"
          type="email"
          autocomplete="email"
          required
          :maxlength="MAX_EMAIL_LENGTH"
        />
      </div>
      <div v-if="section.nameField" class="field">
        <label :for="`${id}-name`">{{ texts.name }}</label>
        <SwInput
          :id="`${id}-name`"
          v-model="name"
          autocomplete="name"
          :maxlength="MAX_NAME_LENGTH"
        />
      </div>
      <div class="lead-form__trap" aria-hidden="true">
        <label :for="`${id}-website`">Website</label>
        <input :id="`${id}-website`" v-model="website" type="text" tabindex="-1" autocomplete="off">
      </div>
      <div class="check lead-form__consent">
        <input
          :id="`${id}-consent`"
          v-model="consent"
          type="checkbox"
          required
          :aria-labelledby="`${id}-consent-text`"
        >
        <!-- Not a <label>: the text has paragraphs and links (a link must not tick the box). -->
        <div :id="`${id}-consent-text`"><PageRichText :text="section.consent" /></div>
      </div>
      <p v-if="error" class="notice" role="alert">{{ error }}</p>
      <p v-if="!context" class="muted hint">{{ texts.preview }}</p>
      <div>
        <SwButton type="submit" :disabled="!context || state === 'sending'">
          {{ state === 'sending' ? texts.sending : section.button }}
        </SwButton>
      </div>
    </form>
  </SwCard>
</template>
