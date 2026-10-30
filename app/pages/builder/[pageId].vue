<script setup lang="ts">
import { SwButton, SwCard, SwInput, SwPill } from '@synthwerk/ui-vue'
import {
  LIMITS,
  newSection,
  newSectionId,
  type PageContent,
  SECTION_LABELS,
  SECTION_TYPES,
  type SectionType
} from '#shared/sections'
import type { BuilderEvent, BuilderPage, BuilderVersion } from '~/composables/useBuilderApi'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const id = computed(() => String(route.params.pageId ?? ''))
const api = useBuilderApi()

const page = ref<BuilderPage | null>(null)
/** The edit copy of the draft. The preview reads it, so it changes on every input. */
const draft = ref<PageContent>({ title: '', sections: [] })
/** The draft as the server has it, to see unsaved changes. */
const saved = ref('')
const events = ref<BuilderEvent[]>([])
const viewed = ref<BuilderVersion | null>(null)
const view = ref<'edit' | 'preview'>('edit')
const addType = ref<SectionType>('hero')

const busy = ref('')
const error = ref('')
const notice = ref('')

const dirty = computed(() => page.value !== null && JSON.stringify(draft.value) !== saved.value)
const canPublish = computed(() => !busy.value && !dirty.value && page.value?.changed === true)

async function handle(err: unknown) {
  const e = orgApiError(err)
  if (e.status === 401) return navigateTo(signInUrl(`/builder/${id.value}`), { external: true })
  error.value = builderErrorText(e, builderErrorField(err))
}

function apply(p: BuilderPage) {
  page.value = p
  draft.value = cloneContent(p.draft)
  saved.value = JSON.stringify(draft.value)
}

async function load() {
  error.value = ''
  try {
    apply(await api.get(id.value))
    events.value = (await api.events(id.value)).items
  } catch (err) {
    await handle(err)
  }
}

/** Runs one write, then reads the page and its history again. */
async function act(name: string, call: () => Promise<unknown>, done: string) {
  if (busy.value) return
  busy.value = name
  error.value = ''
  notice.value = ''
  try {
    await call()
    await load()
    notice.value = done
  } catch (err) {
    await handle(err)
  } finally {
    busy.value = ''
  }
}

const save = () =>
  act(
    'save',
    async () => {
      const p = page.value
      if (p) await api.saveDraft(p.id, p.draftRevision, cloneContent(draft.value))
    },
    'Draft saved.'
  )

const publish = () =>
  act(
    'publish',
    async () => {
      const p = page.value
      if (p) await api.publish(p.id, p.draftRevision)
    },
    'Published. The new version is live.'
  )

function rollback(version: number) {
  if (!window.confirm(`Make version ${version} live again? The draft does not change.`)) return
  void act('rollback', () => api.rollback(id.value, version), `Version ${version} is live again.`)
}

async function show(version: number) {
  error.value = ''
  try {
    viewed.value = await api.version(id.value, version)
  } catch (err) {
    await handle(err)
  }
}

function addSection() {
  draft.value.sections.push(newSection(addType.value, newSectionId()))
}

function move(index: number, by: -1 | 1) {
  const list = draft.value.sections
  const [item] = list.splice(index, 1)
  if (item) list.splice(index + by, 0, item)
}

function removeSection(index: number) {
  draft.value.sections.splice(index, 1)
}

const date = (value: string) => {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}

onBeforeRouteLeave(() => {
  if (dirty.value && !window.confirm('The draft has unsaved changes. Leave the page?')) return false
})

/** A reload or a closed tab also asks while the draft has unsaved changes. */
function onUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault()
}

onMounted(() => {
  window.addEventListener('beforeunload', onUnload)
  void load()
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', onUnload))
</script>

<template>
  <main class="page">
    <StudioNav />
    <p><NuxtLink to="/builder">← All pages</NuxtLink></p>
    <h1>{{ page?.draft.title ?? 'Page' }}</h1>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>

    <SwCard v-if="page" eyebrow="State" :title="`/${page.slug} (${page.locale.toUpperCase()})`">
      <dl class="facts">
        <dt>Live</dt>
        <dd>
          <SwPill v-if="page.liveVersion" kind="accent">Version {{ page.liveVersion }}</SwPill>
          <SwPill v-else>Not published</SwPill>
        </dd>
        <dt>Draft</dt>
        <dd>
          <SwPill v-if="dirty" kind="solid">Unsaved changes</SwPill>
          <SwPill v-else-if="page.changed">Saved, not published</SwPill>
          <SwPill v-else>Same as live</SwPill>
        </dd>
        <dt>Last save</dt>
        <dd>{{ date(page.draftUpdatedAt) }} by {{ actorLabel(page.draftUpdatedBy) }}</dd>
      </dl>
      <template #footer>
        <div class="builder-row">
          <SwButton kind="secondary" :disabled="!dirty || busy !== ''" @click="save">
            {{ busy === 'save' ? 'Saving…' : 'Save draft' }}
          </SwButton>
          <SwButton :disabled="!canPublish" @click="publish">
            {{ busy === 'publish' ? 'Publishing…' : 'Publish' }}
          </SwButton>
        </div>
        <p v-if="dirty" class="muted hint">Save the draft first. Publish takes the saved draft.</p>
      </template>
    </SwCard>

    <div v-if="page" class="builder-row">
      <SwPill
        as="button"
        :kind="view === 'edit' ? 'solid' : 'neutral'"
        :aria-pressed="view === 'edit'"
        @click="view = 'edit'"
      >
        Edit
      </SwPill>
      <SwPill
        as="button"
        :kind="view === 'preview' ? 'solid' : 'neutral'"
        :aria-pressed="view === 'preview'"
        @click="view = 'preview'"
      >
        Preview draft
      </SwPill>
    </div>

    <template v-if="page && view === 'edit'">
      <div class="field">
        <label for="page-title">Page title</label>
        <SwInput id="page-title" v-model="draft.title" :maxlength="LIMITS.short" />
      </div>

      <div v-for="(section, i) in draft.sections" :key="section.id" class="builder-section">
        <div class="builder-section__head">
          <h3>{{ i + 1 }}. {{ SECTION_LABELS[section.type] }}</h3>
          <SwButton kind="ghost" size="sm" :disabled="i === 0" @click="move(i, -1)">Up</SwButton>
          <SwButton
            kind="ghost"
            size="sm"
            :disabled="i === draft.sections.length - 1"
            @click="move(i, 1)"
          >
            Down
          </SwButton>
          <SwButton kind="ghost" size="sm" @click="removeSection(i)">Remove</SwButton>
        </div>
        <BuilderSectionForm
          :model-value="section"
          @update:model-value="(s) => (draft.sections[i] = s)"
        />
      </div>
      <p v-if="draft.sections.length === 0" class="muted">No sections yet. Add the first one.</p>

      <div class="builder-row">
        <label class="sr-only" for="add-type">Section type</label>
        <select id="add-type" v-model="addType" class="select builder-add">
          <option v-for="t in SECTION_TYPES" :key="t" :value="t">{{ SECTION_LABELS[t] }}</option>
        </select>
        <SwButton
          kind="secondary"
          :disabled="draft.sections.length >= LIMITS.sections"
          @click="addSection"
        >
          Add section
        </SwButton>
      </div>
    </template>

    <PageView v-if="page && view === 'preview'" :content="draft" />

    <h2 v-if="page">Published versions</h2>
    <div v-if="page" class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Title</th>
            <th scope="col">Published</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in page.versions" :key="v.version">
            <td class="pills">
              v{{ v.version }}
              <SwPill v-if="v.version === page.liveVersion" kind="accent">Live</SwPill>
            </td>
            <td>{{ v.title }}</td>
            <td class="muted">{{ date(v.publishedAt) }} by {{ actorLabel(v.publishedBy) }}</td>
            <td class="builder-row">
              <SwButton kind="ghost" size="sm" @click="show(v.version)">View</SwButton>
              <SwButton
                kind="ghost"
                size="sm"
                :disabled="v.version === page.liveVersion || busy !== ''"
                @click="rollback(v.version)"
              >
                Roll back
              </SwButton>
            </td>
          </tr>
          <tr v-if="page.versions.length === 0">
            <td colspan="4" class="muted">Nothing published yet.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <template v-if="viewed">
      <div class="builder-row">
        <h2 class="builder-viewed">Version {{ viewed.version }}</h2>
        <SwButton kind="ghost" size="sm" @click="viewed = null">Close</SwButton>
      </div>
      <PageView :content="viewed.content" />
    </template>

    <template v-if="page">
      <h2>History</h2>
      <ul class="builder-history">
        <li v-for="e in events" :key="e.id">
          <time class="muted" :datetime="e.time">{{ date(e.time) }}</time>
          {{ builderEventText(e.type, e.data) }} by {{ actorLabel(e.actor) }}
        </li>
        <li v-if="events.length === 0" class="muted">No events yet.</li>
      </ul>
    </template>
  </main>
</template>
