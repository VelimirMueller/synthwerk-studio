<script setup lang="ts">
// The live demo in the `widget` slot of the public site (synthwerk#47). It makes no request on
// page view: only the click on "Try the live demo" asks /api/auth/session (own origin). Signed
// out: a sign-in link back to this page. Signed in: a chat (llm answer stream) and an image
// upload (vision). Both go to the BFF (/api/site/demo/*), never to a service or a third party.
import { SwButton, SwCard } from '@synthwerk/ui-vue'
import type { Locale } from '#shared/sections'

const props = defineProps<{ locale: Locale }>()
const texts = computed(() => DEMO_TEXTS[props.locale])
const route = useRoute()
const { session, load } = useAuthSession()
const id = useId()

type Phase = 'idle' | 'loading' | 'signed-out' | 'ready'
const phase = ref<Phase>('idle')
const signIn = computed(() => signInUrl(route.fullPath))

interface Turn {
  role: 'user' | 'assistant'
  text: string
}
const turns = ref<Turn[]>([])
const message = ref('')
const conversationId = ref<string | null>(null)
const chatBusy = ref(false)
const chatError = ref('')

const image = ref<File | null>(null)
const visionBusy = ref(false)
const visionError = ref('')
const result = ref<{
  primary: { label: string; score: number }
  labels: { label: string; score: number }[]
  uncertain: boolean
} | null>(null)

async function start() {
  phase.value = 'loading'
  phase.value = (await load()) ? 'ready' : 'signed-out'
}

const csrf = () => session.value?.csrfToken ?? ''

/** The error code of a refused response. A 401 sends the visitor back to the sign-in link. */
async function refusal(res: Response): Promise<string> {
  const code = demoErrorCode(await res.json().catch(() => null))
  if (res.status === 401) {
    session.value = null
    phase.value = 'signed-out'
  }
  return demoErrorText(props.locale, code)
}

async function send() {
  const text = message.value.trim()
  if (!text || chatBusy.value) return
  if ([...text].length > DEMO_MAX_MESSAGE) {
    chatError.value = demoErrorText(props.locale, 'invalid_request')
    return
  }
  chatBusy.value = true
  chatError.value = ''
  try {
    const post = () =>
      fetch('/api/site/demo/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf() },
        body: JSON.stringify(
          conversationId.value
            ? { message: text, conversation_id: conversationId.value }
            : { message: text }
        )
      })
    let res = await post()
    // The page checks the message first, so a 400 with a conversation id means a stale
    // conversation: start a new one once.
    if (res.status === 400 && conversationId.value) {
      conversationId.value = null
      res = await post()
    }
    if (!res.ok || !res.body) {
      chatError.value = await refusal(res)
      return
    }
    conversationId.value = res.headers.get('x-demo-conversation-id') || conversationId.value
    turns.value.push({ role: 'user', text }, { role: 'assistant', text: '' })
    message.value = ''
    const answer = turns.value[turns.value.length - 1] as Turn
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let finished = false
    let failed = false
    const take = (chunk: string) => {
      const parsed = parseSse(chunk)
      buffer = parsed.rest
      for (const frame of parsed.frames) {
        if (failed) return
        if (frame.event === 'error') {
          failed = true
          chatError.value = texts.value.fallbackError
        }
        if (frame.event === 'done') finished = true
        answer.text += deltaText(frame)
      }
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      take(buffer + value)
    }
    // A last frame without the closing blank line.
    if (buffer.trim()) take(`${buffer}\n\n`)
    // The stream ended without `done`: the answer is not complete.
    if (!finished && !chatError.value) chatError.value = texts.value.fallbackError
  } catch {
    chatError.value = texts.value.fallbackError
  } finally {
    chatBusy.value = false
  }
}

function pick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  visionError.value = ''
  result.value = null
  image.value = null
  if (!file) return
  if (!(DEMO_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    visionError.value = demoErrorText(props.locale, 'unsupported_media_type')
  } else if (file.size > DEMO_MAX_IMAGE_BYTES) {
    visionError.value = demoErrorText(props.locale, 'payload_too_large')
  } else {
    image.value = file
  }
}

async function classify() {
  if (!image.value || visionBusy.value) return
  visionBusy.value = true
  visionError.value = ''
  result.value = null
  try {
    const form = new FormData()
    form.set('image', image.value)
    const res = await fetch('/api/site/demo/vision', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf() },
      body: form
    })
    if (!res.ok) {
      visionError.value = await refusal(res)
      return
    }
    result.value = await res.json()
  } catch {
    visionError.value = texts.value.fallbackError
  } finally {
    visionBusy.value = false
  }
}
</script>

<template>
  <section class="site-demo" data-site-slot="widget" :aria-labelledby="`${id}-title`">
    <SwCard>
      <h2 :id="`${id}-title`" class="site-demo__title">{{ texts.title }}</h2>
      <p class="site-demo__intro">{{ texts.intro }}</p>

      <div v-if="phase === 'idle'">
        <SwButton data-demo="start" @click="start">{{ texts.start }}</SwButton>
      </div>
      <p v-else-if="phase === 'loading'" role="status">{{ texts.loading }}</p>
      <p v-else-if="phase === 'signed-out'" class="site-demo__signin">
        {{ texts.signInHint }}
        <a :href="signIn" class="site-link" data-demo="sign-in">{{ texts.signIn }}</a>
      </p>

      <div v-else class="site-demo__panels">
        <form class="form site-demo__chat" data-demo="chat" @submit.prevent="send">
          <ol v-if="turns.length" class="site-demo__turns" aria-live="polite">
            <li
              v-for="(turn, i) in turns"
              :key="i"
              :class="`site-demo__turn site-demo__turn--${turn.role}`"
            >
              <strong>{{ turn.role === 'user' ? texts.you : texts.assistant }}:</strong>
              {{ turn.text }}
            </li>
          </ol>
          <div class="field">
            <label :for="`${id}-message`">{{ texts.chatLabel }}</label>
            <textarea
              :id="`${id}-message`"
              v-model="message"
              class="site-demo__message"
              rows="3"
              :maxlength="DEMO_MAX_MESSAGE"
              :disabled="chatBusy"
              :placeholder="texts.chatPlaceholder"
            />
          </div>
          <p v-if="chatError" class="notice" role="alert">{{ chatError }}</p>
          <div>
            <SwButton type="submit" :disabled="chatBusy || !message.trim()">
              {{ chatBusy ? texts.sending : texts.send }}
            </SwButton>
          </div>
        </form>

        <form class="form site-demo__vision" data-demo="vision" @submit.prevent="classify">
          <div class="field">
            <label :for="`${id}-image`">{{ texts.imageLabel }}</label>
            <input
              :id="`${id}-image`"
              type="file"
              :accept="DEMO_IMAGE_TYPES.join(',')"
              :aria-describedby="`${id}-image-hint`"
              @change="pick"
            >
            <p :id="`${id}-image-hint`" class="muted hint">{{ texts.imageHint }}</p>
          </div>
          <p v-if="visionError" class="notice" role="alert">{{ visionError }}</p>
          <div v-if="result" class="site-demo__result" role="status">
            <p>
              <strong>{{
                texts.result(result.primary.label, formatScore(locale, result.primary.score))
              }}</strong>
            </p>
            <ul v-if="result.labels.length > 1">
              <li v-for="item in result.labels.slice(1)" :key="item.label">
                {{ texts.result(item.label, formatScore(locale, item.score)) }}
              </li>
            </ul>
            <p v-if="result.uncertain" class="muted">{{ texts.uncertain }}</p>
          </div>
          <div>
            <SwButton type="submit" :disabled="visionBusy || !image">
              {{ visionBusy ? texts.classifying : texts.classify }}
            </SwButton>
          </div>
        </form>
      </div>
    </SwCard>
  </section>
</template>
