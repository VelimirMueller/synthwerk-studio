<script setup lang="ts">
import { SwButton, SwCard } from '@synthwerk/ui-vue'
// Confirmed leads of the org (synthwerk#105): owners and admins only (the server checks it).
// Pending addresses never show: a lead counts only after the visitor opened the confirm link.
// The CSV export is a plain download from the own origin (/api/builder/leads/export).
import type { Lead } from '#shared/leads'

definePageMeta({ middleware: 'auth' })

const api = useBuilderApi()
const leads = ref<Lead[] | null>(null)
const next = ref<string | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref('')

async function handle(err: unknown) {
  const e = orgApiError(err)
  if (e.status === 401) return navigateTo(signInUrl('/leads'), { external: true })
  error.value = builderErrorText(e)
}

async function load(more = false) {
  busy.value = more ? 'more' : 'load'
  error.value = ''
  try {
    const page = await api.leads(more ? (next.value ?? undefined) : undefined)
    leads.value = more ? [...(leads.value ?? []), ...page.items] : page.items
    next.value = page.next
  } catch (err) {
    await handle(err)
  } finally {
    busy.value = ''
  }
}

async function remove(lead: Lead) {
  if (busy.value) return
  if (!window.confirm(`Delete the lead ${lead.email}? This cannot be undone.`)) return
  busy.value = lead.id
  error.value = ''
  notice.value = ''
  try {
    await api.removeLead(lead.id)
    leads.value = (leads.value ?? []).filter((l) => l.id !== lead.id)
    notice.value = 'The lead is deleted.'
  } catch (err) {
    await handle(err)
  } finally {
    busy.value = ''
  }
}

const date = (value: string) => {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

onMounted(() => load())
</script>

<template>
  <main class="page">
    <StudioNav />
    <h1>Leads</h1>
    <p class="muted">
      Confirmed addresses from the lead forms of your pages. An address shows only after the visitor
      opened the confirm link. Unconfirmed addresses are deleted after 3 days.
    </p>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>

    <SwCard eyebrow="Export" title="CSV">
      <p class="muted">
        All confirmed leads with the consent text each visitor agreed to. Keep the file safe: it
        holds personal data.
      </p>
      <template #footer>
        <a class="sw-button" href="/api/builder/leads/export" download="leads.csv">Download CSV</a>
      </template>
    </SwCard>

    <div v-if="leads" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Name</th>
            <th scope="col">Page</th>
            <th scope="col">Confirmed</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="lead in leads" :key="lead.id">
            <td>{{ lead.email }}</td>
            <td>{{ lead.name || '–' }}</td>
            <td class="muted">/{{ lead.locale }}/{{ lead.slug }} (v{{ lead.pageVersion }})</td>
            <td class="muted">{{ date(lead.confirmedAt) }}</td>
            <td>
              <SwButton kind="ghost" size="sm" :disabled="busy !== ''" @click="remove(lead)">
                {{ busy === lead.id ? 'Deleting…' : 'Delete' }}
              </SwButton>
            </td>
          </tr>
          <tr v-if="leads.length === 0">
            <td colspan="5" class="muted">No confirmed leads yet.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="busy === 'load'" class="muted">Loading…</p>
    <SwButton v-if="next" kind="secondary" :disabled="busy !== ''" @click="load(true)">
      {{ busy === 'more' ? 'Loading…' : 'Load older leads' }}
    </SwButton>
  </main>
</template>
