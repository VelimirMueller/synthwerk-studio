<script setup lang="ts">
import { SwButton } from '@synthwerk/ui-vue'

definePageMeta({ middleware: 'auth' })

const api = useOrgApi()
const events = ref<OrgAuditEvent[]>([])
const cursor = ref<string | undefined>()
const loading = ref(false)
const loaded = ref(false)
const error = ref('')

async function load(more = false) {
  loading.value = true
  error.value = ''
  try {
    const page = await api.listAuditEvents(more ? cursor.value : undefined)
    events.value = more ? [...events.value, ...page.items] : page.items
    cursor.value = page.next_cursor
    loaded.value = true
  } catch (err) {
    const e = orgApiError(err)
    if (e.status === 401) return navigateTo(signInUrl('/audit'), { external: true })
    error.value =
      e.code === 'forbidden' || (e.status === 403 && e.code === '')
        ? 'Only owners and admins can see the audit list of this org.'
        : orgErrorText(e)
  } finally {
    loading.value = false
  }
}

const lines = computed(() => events.value.map((e) => ({ ...e, line: describeAuditEvent(e) })))

const date = (value: string) => {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

onMounted(() => load())
</script>

<template>
  <main class="page">
    <StudioNav />
    <h1>Audit</h1>
    <p class="muted">The admin actions of your org, newest first.</p>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <ol class="audit">
      <li v-for="e in lines" :key="e.id" class="audit__item">
        <time class="muted" :datetime="e.time">{{ date(e.time) }}</time>
        <span>{{ e.line.text }}</span>
        <span class="muted mono">{{ e.line.kind }}</span>
      </li>
      <li v-if="loaded && events.length === 0" class="muted">No events yet.</li>
    </ol>
    <p v-if="loading" class="muted" role="status">Loading…</p>
    <SwButton v-if="cursor && !loading" kind="secondary" @click="load(true)">Load more</SwButton>
  </main>
</template>
