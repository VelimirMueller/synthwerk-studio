<script setup lang="ts">
import { SwButton, SwCard, SwPill } from '@synthwerk/ui-vue'

definePageMeta({ middleware: 'auth' })

const { session, signOut } = useAuthSession()
const pending = ref(false)

async function onSignOut() {
  pending.value = true
  try {
    await signOut()
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <main v-if="session" class="page">
    <h1>{{ session.org.name || 'Your org' }}</h1>
    <nav aria-label="Studio"><NuxtLink to="/apps">Apps</NuxtLink></nav>
    <SwCard eyebrow="Signed in as" :title="session.user.name || session.user.username">
      <dl class="facts">
        <dt>User name</dt>
        <dd>{{ session.user.username }}</dd>
        <dt>Email</dt>
        <dd>{{ session.user.email || '-' }}</dd>
        <dt>Org</dt>
        <dd>{{ session.org.name }} <span class="muted">{{ session.org.id }}</span></dd>
        <dt>Roles</dt>
        <dd>
          <SwPill v-for="r in session.roles" :key="r.role" kind="accent">{{ r.role }}</SwPill>
          <span v-if="session.roles.length === 0" class="muted">none</span>
        </dd>
        <dt>Sign-in factors</dt>
        <dd>
          <SwPill v-for="m in session.amr" :key="m">{{ m }}</SwPill>
          <span v-if="session.amr.length === 0" class="muted">not reported</span>
        </dd>
      </dl>
      <template #footer>
        <SwButton kind="secondary" :disabled="pending" @click="onSignOut">Sign out</SwButton>
      </template>
    </SwCard>
  </main>
</template>
