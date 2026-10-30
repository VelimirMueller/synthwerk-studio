<script setup lang="ts">
import { SwButton, SwCard, SwInput, SwPill } from '@synthwerk/ui-vue'
import type { StudioApp } from '~/composables/useApps'

definePageMeta({ middleware: 'auth' })

const { session } = useAuthSession()
const { create } = useApps()
const canManage = computed(() => canManageApps(session.value?.roles))

const {
  data: apps,
  error: loadError,
  refresh
} = await useFetch<StudioApp[]>('/api/apps', {
  default: () => []
})

const name = ref('')
const origins = ref('')
const pending = ref(false)
const formError = ref('')

async function onCreate() {
  formError.value = ''
  pending.value = true
  try {
    const app = await create(name.value, parseOrigins(origins.value))
    await navigateTo(`/apps/${app.id}`)
  } catch (err) {
    formError.value = problemText(err)
    await refresh()
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <main class="page">
    <p><NuxtLink to="/me">Profile</NuxtLink></p>
    <h1>Apps</h1>
    <p class="muted">
      An app is one website with the chat. Only the origins in its list may use the chat.
    </p>
    <p v-if="loadError" class="notice" role="alert">{{ problemText(loadError) }}</p>

    <SwCard
      v-for="app in apps"
      :key="app.id"
      eyebrow="App"
      :title="app.name"
      :href="`/apps/${app.id}`"
    >
      <span class="pills">
        <SwPill v-for="o in app.allowedOrigins" :key="o">{{ o }}</SwPill>
      </span>
    </SwCard>
    <p v-if="!loadError && apps.length === 0" class="muted">No apps yet.</p>

    <SwCard v-if="canManage" eyebrow="New app" title="Add an app">
      <form id="new-app" class="form" @submit.prevent="onCreate">
        <div class="field">
          <label for="new-app-name">Name</label>
          <SwInput id="new-app-name" v-model="name" maxlength="128" required />
        </div>
        <label class="field">
          <span>Allowed origins, one per line</span>
          <textarea
            v-model="origins"
            class="textarea"
            rows="3"
            placeholder="https://shop.example"
            required
          />
          <span class="muted hint">
            Scheme, host and port only, like https://shop.example. http only for localhost.
          </span>
        </label>
        <p v-if="formError" class="notice" role="alert">{{ formError }}</p>
      </form>
      <template #footer>
        <SwButton type="submit" form="new-app" :disabled="pending">Create app</SwButton>
      </template>
    </SwCard>
    <p v-else class="muted">Only an owner or an admin of the org adds apps.</p>
  </main>
</template>
