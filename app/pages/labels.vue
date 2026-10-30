<script setup lang="ts">
import { SwButton, SwCard, SwInput, SwPill } from '@synthwerk/ui-vue'
import type { LabelSet, RuntimeLabel } from '~/composables/useLabelsApi'

definePageMeta({ middleware: 'auth' })

const api = useLabelsApi()

const set = ref<LabelSet | null>(null)
const loading = ref(false)
/** Id of the label with a running delete. */
const busy = ref('')
const error = ref('')
const notice = ref('')

const name = ref('')
const topic = ref('')
const prompt = ref('')
const newTopic = ref(false)
/** Parent of a new topic. Empty = root. */
const topicParent = ref('')
const adding = ref(false)

const options = computed(() => topicOptions(set.value?.topics ?? []))
const canAdd = computed(
  () => !adding.value && name.value.trim() !== '' && topic.value.trim() !== ''
)

async function handle(err: unknown) {
  const e = orgApiError(err)
  if (e.status === 401) return navigateTo(signInUrl('/labels'), { external: true })
  error.value = labelsErrorText(e)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    set.value = await api.get()
  } catch (err) {
    await handle(err)
  } finally {
    loading.value = false
  }
}

async function add() {
  adding.value = true
  error.value = ''
  notice.value = ''
  try {
    const label = await api.add({
      name: name.value.trim(),
      topic: topic.value.trim(),
      prompt: prompt.value.trim() || null,
      newTopic: newTopic.value,
      topicParent: newTopic.value ? topicParent.value || null : null
    })
    notice.value = `The label ${label.name} is added.`
    name.value = ''
    prompt.value = ''
    if (newTopic.value) {
      topic.value = ''
      newTopic.value = false
      topicParent.value = ''
    }
    // The set changed (own set, new topic, count): read it again.
    set.value = await api.get()
  } catch (err) {
    await handle(err)
  } finally {
    adding.value = false
  }
}

async function remove(label: RuntimeLabel) {
  busy.value = label.id
  error.value = ''
  notice.value = ''
  try {
    await api.remove(label.id)
    notice.value = `The label ${label.name} is deleted.`
    set.value = await api.get()
  } catch (err) {
    await handle(err)
  } finally {
    busy.value = ''
  }
}

function onNewTopic() {
  // A new topic needs a typed name; an existing topic comes from the list.
  topic.value = ''
  topicParent.value = ''
}

onMounted(() => load())
</script>

<template>
  <main class="page">
    <StudioNav />
    <h1>Labels</h1>
    <p class="muted">
      The labels the image model can give to the pictures of your org. Changes apply to this org
      only.
    </p>
    <p v-if="error" class="notice" role="alert">{{ error }}</p>
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>

    <SwCard v-if="set" eyebrow="Label set" :title="set.custom ? 'Own set' : 'Default set'">
      <dl class="facts">
        <dt>Set</dt>
        <dd>
          <SwPill :kind="set.custom ? 'accent' : 'neutral'">
            {{ set.custom ? 'Own set of this org' : 'Default set' }}
          </SwPill>
        </dd>
        <dt>Labels</dt>
        <dd>{{ set.total_labels }}</dd>
        <dt>Added</dt>
        <dd>{{ set.labels.length }}</dd>
      </dl>
    </SwCard>

    <SwCard v-if="set" eyebrow="Add" title="Add a label">
      <form id="new-label" class="form" @submit.prevent="add">
        <div class="field">
          <label for="label-name">Name</label>
          <SwInput id="label-name" v-model="name" maxlength="80" :disabled="adding" />
        </div>
        <label class="check">
          <input v-model="newTopic" type="checkbox" :disabled="adding" @change="onNewTopic">
          <span>New topic</span>
        </label>
        <label v-if="!newTopic" class="field">
          <span>Topic</span>
          <select v-model="topic" class="select" :disabled="adding">
            <option value="" disabled>Choose a topic</option>
            <option v-for="o in options" :key="o.id" :value="o.id">{{ o.text }}</option>
          </select>
        </label>
        <template v-else>
          <div class="field">
            <label for="label-topic">New topic</label>
            <SwInput id="label-topic" v-model="topic" maxlength="80" :disabled="adding" />
          </div>
          <label class="field">
            <span>Parent topic</span>
            <select v-model="topicParent" class="select" :disabled="adding">
              <option value="">No parent (root)</option>
              <option v-for="o in options" :key="o.id" :value="o.id">{{ o.text }}</option>
            </select>
          </label>
        </template>
        <div class="field">
          <label for="label-prompt">Prompt (optional)</label>
          <SwInput id="label-prompt" v-model="prompt" maxlength="200" :disabled="adding" />
          <span class="muted hint">
            The text the model compares with the image, for example "a photo of a red barn". Empty =
            the name.
          </span>
        </div>
      </form>
      <p class="muted hint">
        Adding a label can take up to about 30 seconds. The first change copies the default set into
        an own set for this org only.
      </p>
      <template #footer>
        <SwButton type="submit" form="new-label" :disabled="!canAdd">
          {{ adding ? 'Adding…' : 'Add label' }}
        </SwButton>
      </template>
    </SwCard>

    <h2>Added labels</h2>
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Topic</th>
            <th scope="col">Prompt</th>
            <th scope="col">Id</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in set?.labels ?? []" :key="l.id">
            <td>{{ l.name }}</td>
            <td>{{ topicPath(l.path) }}</td>
            <td class="muted">{{ l.prompt ?? '' }}</td>
            <td class="mono">{{ l.id }}</td>
            <td>
              <SwButton kind="ghost" size="sm" :disabled="busy !== '' || adding" @click="remove(l)">
                Delete
              </SwButton>
            </td>
          </tr>
          <tr v-if="set && set.labels.length === 0">
            <td colspan="5" class="muted">No added labels. The org uses the packaged labels.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="loading" class="muted" role="status">Loading…</p>
  </main>
</template>
