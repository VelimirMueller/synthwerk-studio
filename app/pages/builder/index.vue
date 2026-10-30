<script setup lang="ts">
import { SwButton, SwCard, SwInput, SwPill } from '@synthwerk/ui-vue'
import { LIMITS, LOCALES, type Locale, SLUG_PATTERN } from '#shared/sections'
import type { BuilderPageSummary } from '~/composables/useBuilderApi'

definePageMeta({ middleware: 'auth' })

const api = useBuilderApi()
const pages = ref<BuilderPageSummary[] | null>(null)
const error = ref('')
const loading = ref(false)

const slug = ref('')
const locale = ref<Locale>('en')
const title = ref('')
const creating = ref(false)
const slugOk = computed(() => SLUG_PATTERN.test(slug.value.trim()))
const canCreate = computed(() => !creating.value && slugOk.value && title.value.trim() !== '')

async function handle(err: unknown) {
  const e = orgApiError(err)
  if (e.status === 401) return navigateTo(signInUrl('/builder'), { external: true })
  error.value = builderErrorText(e, builderErrorField(err))
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    pages.value = await api.list()
  } catch (err) {
    await handle(err)
  } finally {
    loading.value = false
  }
}

async function create() {
  creating.value = true
  error.value = ''
  try {
    const page = await api.create({
      slug: slug.value.trim(),
      locale: locale.value,
      title: title.value.trim()
    })
    await navigateTo(`/builder/${page.id}`)
  } catch (err) {
    await handle(err)
  } finally {
    creating.value = false
  }
}

onMounted(() => load())
</script>

<template>
  <main class="page">
    <StudioNav />
    <h1>Builder</h1>
    <p class="muted">
      Pages built from sections. Edit the draft, check the preview, publish. Every published version
      stays, so you can roll back.
    </p>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Slug</th>
            <th scope="col">Language</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in pages ?? []" :key="p.id">
            <td><NuxtLink :to="`/builder/${p.id}`">{{ p.title }}</NuxtLink></td>
            <td class="mono">/{{ p.slug }}</td>
            <td>{{ p.locale.toUpperCase() }}</td>
            <td class="pills">
              <SwPill v-if="p.liveVersion" kind="accent">Live v{{ p.liveVersion }}</SwPill>
              <SwPill v-else>Not published</SwPill>
              <SwPill v-if="p.liveVersion && p.changed">Draft changed</SwPill>
            </td>
          </tr>
          <tr v-if="pages && pages.length === 0">
            <td colspan="4" class="muted">No pages yet. Create the first page below.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="loading" class="muted" role="status">Loading…</p>

    <SwCard v-if="pages" eyebrow="New" title="Create a page">
      <form id="new-page" class="form" @submit.prevent="create">
        <div class="field">
          <label for="page-title">Title</label>
          <SwInput id="page-title" v-model="title" :maxlength="LIMITS.short" :disabled="creating" />
        </div>
        <div class="field">
          <label for="page-slug">Slug</label>
          <SwInput
            id="page-slug"
            v-model="slug"
            maxlength="64"
            :invalid="slug !== '' && !slugOk"
            :disabled="creating"
            aria-describedby="page-slug-hint"
          />
          <span id="page-slug-hint" class="muted hint">
            Small letters, digits and "-", for example "pricing". The page path is /slug.
          </span>
        </div>
        <label class="field">
          <span>Language</span>
          <select v-model="locale" class="select" :disabled="creating">
            <option v-for="l in LOCALES" :key="l" :value="l">
              {{ l === 'de' ? 'German' : 'English' }}
            </option>
          </select>
        </label>
      </form>
      <template #footer>
        <SwButton type="submit" form="new-page" :disabled="!canCreate">
          {{ creating ? 'Creating…' : 'Create page' }}
        </SwButton>
      </template>
    </SwCard>
  </main>
</template>
