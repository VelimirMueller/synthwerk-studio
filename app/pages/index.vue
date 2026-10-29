<script setup lang="ts">
import { SwButton, SwCard } from '@synthwerk/ui-vue'

const route = useRoute()
const { load } = useAuthSession()
const session = await load()

// Text for the codes the BFF puts on /?error= (server/lib/auth.ts SIGN_IN_ERRORS).
const messages: Record<string, string> = {
  access_denied: 'The sign-in was cancelled.',
  mfa_required: 'This sign-in had no second factor. Sign in with a passkey or a second factor.',
  login_expired: 'The sign-in took too long or was opened twice. Try again.',
  login_failed: 'The sign-in failed. Try again.'
}
const error = computed(() => {
  const code = route.query.error
  if (typeof code !== 'string') return ''
  // Own keys only: ?error=constructor must not reach Object.prototype.
  return Object.hasOwn(messages, code) ? messages[code] : messages.login_failed
})

function signIn() {
  return navigateTo(signInUrl('/me'), { external: true })
}
</script>

<template>
  <main class="page">
    <h1>Synthwerk Studio</h1>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <SwCard
      v-if="session"
      eyebrow="Signed in"
      :title="session.user.name || session.user.username"
      href="/me"
    >
      Open your profile.
    </SwCard>
    <SwCard v-if="canViewHealth(session)" eyebrow="Pulse" title="Health" href="/health">
      Live status and numbers of the platform.
    </SwCard>
    <SwCard v-else eyebrow="Studio" title="Sign in">
      <p class="muted">Sign in with your Synthwerk account.</p>
      <template #footer>
        <SwButton @click="signIn">Sign in</SwButton>
      </template>
    </SwCard>
  </main>
</template>
