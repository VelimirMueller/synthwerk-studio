<script setup lang="ts">
import { SwButton, SwCard, SwInput, SwTerminalSnippet } from '@synthwerk/ui-vue'
import {
  accents,
  buildSnippet,
  defaultSettings,
  greetingProblem,
  greetingProblemText,
  langs,
  MAX_GREETING,
  modes,
  positions,
  themes,
  usableUrl,
  type WidgetSettings
} from '#shared/widget'
import type { StudioApp } from '~/composables/useApps'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const id = computed(() => String(route.params.appId ?? ''))
const { session } = useAuthSession()
const { update, remove } = useApps()
const canManage = computed(() => canManageApps(session.value?.roles))
const { widget } = useRuntimeConfig().public

const { data: app, error: loadError } = await useFetch<StudioApp>(
  () => `/api/apps/${encodeURIComponent(id.value)}`
)

// Edit copies. The preview reads `settings`, so it changes on every input, without a save.
const name = ref('')
const origins = ref('')
const settings = reactive<WidgetSettings>(defaultSettings())
function load(a: StudioApp) {
  name.value = a.name
  origins.value = a.allowedOrigins.join('\n')
  Object.assign(settings, a.widgetSettings)
}
watch(app, (a) => a && load(a), { immediate: true })

const saving = ref('')
const message = ref('')
const failure = ref('')

async function save(part: 'app' | 'settings') {
  failure.value = ''
  message.value = ''
  saving.value = part
  try {
    app.value = await update(
      id.value,
      part === 'app'
        ? { name: name.value, allowedOrigins: parseOrigins(origins.value) }
        : { widgetSettings: { ...settings } }
    )
    message.value = part === 'app' ? 'App saved.' : 'Widget settings saved.'
  } catch (err) {
    failure.value = problemText(err)
  } finally {
    saving.value = ''
  }
}

async function onDelete() {
  if (!app.value || !window.confirm(`Delete ${app.value.name}? Its chat stops working.`)) return
  failure.value = ''
  try {
    await remove(id.value)
    await navigateTo('/apps')
  } catch (err) {
    failure.value = problemText(err)
  }
}

const target = computed(() => ({
  scriptUrl: widget.scriptUrl,
  scriptIntegrity: widget.scriptIntegrity ?? '',
  apiUrl: widget.apiUrl
}))
const snippetReady = computed(
  () => usableUrl(target.value.scriptUrl) && usableUrl(target.value.apiUrl)
)
const snippet = computed(() => (app.value ? buildSnippet(app.value.id, target.value) : ''))
const snippetLines = computed(() => snippet.value.split('\n').map((text) => ({ text })))
const greetingLeft = computed(() => MAX_GREETING - [...settings.greeting].length)
// The same rule as the BFF, identity and the widget. Trimmed like the BFF trims it.
const greetingError = computed(() => {
  const problem = greetingProblem(settings.greeting.trim())
  return problem ? greetingProblemText[problem] : ''
})

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(copiedTimer))
async function copySnippet() {
  try {
    await navigator.clipboard.writeText(snippet.value)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    failure.value = 'The browser did not allow the copy. Select the snippet and copy it.'
  }
}

const labels: Record<string, string> = {
  'bottom-right': 'Bottom right',
  'bottom-left': 'Bottom left',
  default: 'Default',
  contrast: 'High contrast',
  system: 'Follow the system',
  light: 'Light',
  dark: 'Dark',
  auto: 'Browser language',
  de: 'German',
  en: 'English',
  flagship: 'Indigo (flagship)',
  lab: 'Violet (lab)',
  ops: 'Magenta (ops)',
  venture: 'Amber (venture)'
}
</script>

<template>
  <main class="page">
    <p><NuxtLink to="/apps">All apps</NuxtLink></p>
    <p v-if="loadError" class="notice" role="alert">{{ problemText(loadError) }}</p>
    <template v-if="app">
      <h1>{{ app.name }}</h1>
      <p class="muted">App id <code>{{ app.id }}</code></p>
      <p v-if="message" class="muted" role="status">{{ message }}</p>
      <p v-if="failure" class="notice" role="alert">{{ failure }}</p>

      <SwCard eyebrow="Step 1" title="Embed the chat">
        <p class="muted">
          Put this on every page that shows the chat. Your site hands in the token of its signed-in
          user; signed-out visitors see a sign-in prompt.
        </p>
        <template v-if="snippetReady">
          <SwTerminalSnippet title="index.html" :lines="snippetLines" />
        </template>
        <p v-else class="notice" role="alert">
          The snippet needs the widget script URL and the edge URL. Ask the operator to set
          NUXT_PUBLIC_WIDGET_SCRIPT_URL and NUXT_PUBLIC_WIDGET_API_URL.
        </p>
        <template #footer>
          <SwButton :disabled="!snippetReady" @click="copySnippet">
            {{ copied ? 'Copied' : 'Copy snippet' }}
          </SwButton>
        </template>
      </SwCard>

      <SwCard eyebrow="Step 2" title="Allowed origins">
        <form id="app-form" class="form" @submit.prevent="save('app')">
          <div class="field">
            <label for="app-name">Name</label>
            <SwInput id="app-name" v-model="name" maxlength="128" :disabled="!canManage" required />
          </div>
          <label class="field">
            <span>Allowed origins, one per line</span>
            <textarea v-model="origins" class="textarea" rows="4" :disabled="!canManage" required />
            <span class="muted hint">
              The page origin must match exactly: scheme, host and port. Add http://localhost:3000
              to test on your machine.
            </span>
          </label>
        </form>
        <template v-if="canManage" #footer>
          <SwButton type="submit" form="app-form" :disabled="saving !== ''">Save app</SwButton>
        </template>
      </SwCard>

      <SwCard eyebrow="Step 3" title="Widget settings">
        <div class="settings">
          <form id="settings-form" class="form" @submit.prevent="save('settings')">
            <label class="field">
              <span>Position</span>
              <select v-model="settings.position" class="select" :disabled="!canManage">
                <option v-for="v in positions" :key="v" :value="v">{{ labels[v] }}</option>
              </select>
            </label>
            <label class="field">
              <span>Theme</span>
              <select v-model="settings.theme" class="select" :disabled="!canManage">
                <option v-for="v in themes" :key="v" :value="v">{{ labels[v] }}</option>
              </select>
            </label>
            <label class="field">
              <span>Mode</span>
              <select v-model="settings.mode" class="select" :disabled="!canManage">
                <option v-for="v in modes" :key="v" :value="v">{{ labels[v] }}</option>
              </select>
            </label>
            <label class="field">
              <span>Language</span>
              <select v-model="settings.lang" class="select" :disabled="!canManage">
                <option v-for="v in langs" :key="v" :value="v">{{ labels[v] }}</option>
              </select>
            </label>
            <label class="field">
              <span>Colour</span>
              <select v-model="settings.accent" class="select" :disabled="!canManage">
                <option v-for="v in accents" :key="v" :value="v">{{ labels[v] }}</option>
              </select>
            </label>
            <label class="field">
              <span>Greeting</span>
              <textarea
                v-model="settings.greeting"
                class="textarea"
                rows="2"
                :disabled="!canManage"
                :aria-invalid="greetingError !== ''"
                aria-describedby="greeting-hint"
                placeholder="Empty: the widget's own greeting"
              />
              <span id="greeting-hint" class="muted hint" :class="{ over: greetingError !== '' }">
                {{ greetingLeft }}
                characters left. Plain text.
              </span>
              <span v-if="greetingError" class="notice" role="alert">{{ greetingError }}</span>
            </label>
          </form>
          <WidgetPreview :settings="settings" />
        </div>
        <p class="muted hint">
          The widget loads these settings when the page loads (widgets#34). An attribute on
          &lt;synthwerk-chat&gt; wins over them.
        </p>
        <template v-if="canManage" #footer>
          <SwButton
            type="submit"
            form="settings-form"
            :disabled="saving !== '' || greetingError !== ''"
          >
            Save settings
          </SwButton>
        </template>
      </SwCard>

      <SwCard v-if="canManage" eyebrow="Danger" title="Delete this app">
        <p class="muted">The chat stops working on every listed origin.</p>
        <template #footer>
          <SwButton kind="secondary" @click="onDelete">Delete app</SwButton>
        </template>
      </SwCard>
    </template>
  </main>
</template>
