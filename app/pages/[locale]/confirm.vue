<script setup lang="ts">
// The confirm page of the lead form (synthwerk#105): /de/confirm, /en/confirm. The mail link
// carries the token in the fragment (#token=…), so it never reaches a server log or a referrer.
// A click sends it: a mail scanner that opens the link confirms nothing.
import { SwButton, SwCard } from '@synthwerk/ui-vue'
import { TOKEN_PATTERN } from '#shared/leads'

definePageMeta({ validate: (route) => isLocale(route.params.locale) })

const route = useRoute()
const locale = isLocale(route.params.locale) ? route.params.locale : 'en'
const texts = computed(() => SITE_TEXTS[locale].lead)
useHead({ meta: [{ name: 'robots', content: 'noindex' }] })

const token = ref('')
const state = ref<'ready' | 'missing' | 'sending' | 'done' | 'invalid' | 'failed'>('ready')

onMounted(() => {
  const value = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''
  // The token leaves the address bar: no copy in the history or a shared screen.
  history.replaceState(history.state, '', window.location.pathname)
  if (TOKEN_PATTERN.test(value)) token.value = value
  else state.value = 'missing'
})

async function confirm() {
  if ((state.value !== 'ready' && state.value !== 'failed') || !token.value) return
  state.value = 'sending'
  try {
    await $fetch('/api/site/leads/confirm', { method: 'POST', body: { token: token.value } })
    state.value = 'done'
    token.value = ''
  } catch (err) {
    const status = (err as { statusCode?: number } | null)?.statusCode
    state.value = status === 410 ? 'invalid' : 'failed'
  }
}
</script>

<template>
  <SiteShell :locale="locale" :slug="CONFIRM_SLUG" :title="texts.confirmTitle">
    <SwCard :title="texts.confirmTitle">
      <p v-if="state === 'done'" role="status">{{ texts.confirmed }}</p>
      <p v-else-if="state === 'invalid'" role="alert">{{ texts.linkInvalid }}</p>
      <p v-else-if="state === 'missing'" role="alert">{{ texts.noToken }}</p>
      <template v-else>
        <p>{{ texts.confirmBody }}</p>
        <p v-if="state === 'failed'" class="notice" role="alert">{{ texts.failed }}</p>
        <SwButton :disabled="state === 'sending' || !token" @click="confirm">
          {{ state === 'sending' ? texts.confirming : texts.confirmButton }}
        </SwButton>
      </template>
    </SwCard>
  </SiteShell>
</template>
