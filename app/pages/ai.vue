<script setup lang="ts">
import { SwButton, SwCard, SwInput } from '@synthwerk/ui-vue'
import type { AiSettings } from '~/composables/useAiSettings'

definePageMeta({ middleware: 'auth' })

const { session } = useAuthSession()
const { save: saveSettings } = useAiSettings()
const canManage = computed(() => canManageApps(session.value?.roles))

const {
  data: settings,
  error: loadError,
  refresh
} = await useFetch<AiSettings>('/api/ai-settings', { immediate: canManage.value })

const loadProblem = computed(() => (loadError.value ? aiSettingsError(loadError.value) : null))
const forbidden = ref(false)
const showForm = computed(
  () => canManage.value && !forbidden.value && loadProblem.value?.status !== 403
)

// Edit copies. Numbers stay text in the form; save() reads them.
const form = reactive({
  model: '',
  allowedModels: [] as string[],
  systemPrompt: '',
  maxInputChars: '',
  userTokensPerDay: '',
  temperature: ''
})
function load(s: AiSettings) {
  form.model = s.model
  form.allowedModels = [...s.allowedModels]
  form.systemPrompt = s.systemPrompt
  form.maxInputChars = String(s.maxInputChars)
  form.userTokensPerDay = String(s.userTokensPerDay)
  form.temperature = s.temperature === null ? '' : String(s.temperature)
}
watch(settings, (s) => s && load(s), { immediate: true })

// The default model is always allowed.
watch(
  () => form.model,
  (m) => {
    if (m && !form.allowedModels.includes(m)) form.allowedModels.push(m)
  }
)

const bounds = computed(() => settings.value?.bounds)
const promptLength = computed(() => [...form.systemPrompt].length)
const promptLeft = computed(() => (bounds.value?.systemPromptMaxChars ?? 0) - promptLength.value)
const planLimit = computed(() => {
  const n = bounds.value?.userTokensPerDay ?? 0
  return n === 0 ? 'no limit' : `${n.toLocaleString()} tokens`
})
const updated = computed(() => {
  const v = settings.value?.updatedAt
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString()
})

const versionLine = computed(() => {
  const v = settings.value?.version ?? 0
  if (v === 0) return 'Version 0. Nobody saved settings yet: these are the defaults.'
  return updated.value ? `Version ${v}, saved ${updated.value}.` : `Version ${v}.`
})

const saving = ref(false)
const message = ref('')
const failure = ref('')
const conflict = ref(false)

const whole = (text: string) => (/^[0-9]+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN)

async function save() {
  if (!settings.value) return
  message.value = ''
  failure.value = ''
  conflict.value = false
  const b = settings.value.bounds
  const maxInputChars = whole(form.maxInputChars)
  const userTokensPerDay = whole(form.userTokensPerDay)
  const temperature = form.temperature.trim() === '' ? null : Number(form.temperature.trim())
  // The BFF and llm check again. These checks only give a clear text early.
  if (!(maxInputChars >= 1 && maxInputChars <= b.maxInputChars)) {
    failure.value = `Max characters of one message: a whole number from 1 to ${b.maxInputChars}.`
    return
  }
  if (!(userTokensPerDay >= 0)) {
    failure.value = 'Tokens per user per day: a whole number, 0 or more.'
    return
  }
  if (temperature !== null && !(temperature >= 0 && temperature <= b.temperatureMax)) {
    failure.value = `Temperature: a number from 0 to ${b.temperatureMax}, or empty for the model default.`
    return
  }
  saving.value = true
  try {
    settings.value = await saveSettings({
      version: settings.value.version,
      model: form.model,
      allowedModels: b.models.filter((m) => form.allowedModels.includes(m)),
      systemPrompt: form.systemPrompt,
      maxInputChars,
      userTokensPerDay,
      temperature
    })
    message.value = 'AI settings saved.'
  } catch (err) {
    const e = aiSettingsError(err)
    if (e.status === 401) return navigateTo(signInUrl('/ai'), { external: true })
    if (e.status === 403 && e.code !== 'csrf_failed') forbidden.value = true
    else if (e.code === 'version_conflict') conflict.value = true
    else failure.value = aiSettingsErrorText(e)
  } finally {
    saving.value = false
  }
}

async function reload() {
  conflict.value = false
  message.value = ''
  failure.value = ''
  await refresh()
  if (settings.value) load(settings.value)
}
</script>

<template>
  <main class="page">
    <StudioNav />
    <h1>AI settings</h1>
    <p class="muted">
      The model, the system prompt and the limits of the chat in your org. The next message of every
      user uses the saved values.
    </p>

    <p v-if="!showForm" class="notice" role="alert">
      Only owners and admins can change the AI settings.
    </p>
    <template v-else>
      <p v-if="loadProblem" class="notice" role="alert">{{ aiSettingsErrorText(loadProblem) }}</p>
      <p v-if="message" class="muted" role="status">{{ message }}</p>
      <p v-if="failure" class="notice" role="alert">{{ failure }}</p>
      <div v-if="conflict" class="notice" role="alert">
        <p>The settings changed. Reload them.</p>
        <SwButton kind="secondary" @click="reload">Reload</SwButton>
      </div>

      <SwCard v-if="settings && bounds" eyebrow="Org" title="Model and prompt">
        <p class="muted">{{ versionLine }}</p>
        <form id="ai-form" class="form" @submit.prevent="save">
          <label class="field">
            <span>Default model</span>
            <select v-model="form.model" class="select">
              <option v-for="m in bounds.models" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>

          <fieldset class="field choices">
            <legend>Allowed models</legend>
            <label v-for="m in bounds.models" :key="m">
              <input
                v-model="form.allowedModels"
                type="checkbox"
                :value="m"
                :disabled="m === form.model"
              >
              {{ m }}
            </label>
            <span class="muted hint">Users may pick these. The default model stays allowed.</span>
          </fieldset>

          <label class="field">
            <span>System prompt</span>
            <textarea
              v-model="form.systemPrompt"
              class="textarea"
              rows="8"
              :maxlength="bounds.systemPromptMaxChars"
              placeholder="Empty: the system prompt of the service"
            />
            <span class="muted hint" :class="{ over: promptLeft < 0 }">
              {{ promptLength }}
              / {{ bounds.systemPromptMaxChars }} characters. Plain text.
            </span>
          </label>

          <div class="field">
            <label for="ai-max-input">Max characters of one message</label>
            <SwInput id="ai-max-input" v-model="form.maxInputChars" inputmode="numeric" required />
            <span class="muted hint"
              >1 to {{ bounds.maxInputChars }}. A longer message is refused.</span
            >
          </div>

          <div class="field">
            <label for="ai-user-tokens">Tokens per user per day</label>
            <SwInput
              id="ai-user-tokens"
              v-model="form.userTokensPerDay"
              inputmode="numeric"
              required
            />
            <span class="muted hint">0: the plan limit only. Plan limit: {{ planLimit }}.</span>
          </div>

          <div class="field">
            <label for="ai-temperature">Temperature</label>
            <SwInput id="ai-temperature" v-model="form.temperature" inputmode="decimal" />
            <span class="muted hint">
              0 to {{ bounds.temperatureMax }}. Empty: the model default.
            </span>
          </div>
        </form>
        <template #footer>
          <SwButton type="submit" form="ai-form" :disabled="saving || promptLeft < 0">
            Save settings
          </SwButton>
        </template>
      </SwCard>
    </template>
  </main>
</template>
