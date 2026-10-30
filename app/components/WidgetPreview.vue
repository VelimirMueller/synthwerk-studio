<script setup lang="ts">
// A live picture of the chat widget for the current settings. It is not the widget itself:
// the widget bundle has no host yet. Colours come from @synthwerk/tokens through data-theme,
// data-mode and data-group on the frame, the same attributes the widget uses.
import type { WidgetSettings } from '#shared/widget'

const props = defineProps<{ settings: WidgetSettings }>()

const text = {
  en: {
    greeting: 'Hi! How can I help?',
    placeholder: 'Ask a question',
    send: 'Send',
    title: 'Chat'
  },
  de: {
    greeting: 'Hallo! Wie kann ich helfen?',
    placeholder: 'Stell eine Frage',
    send: 'Senden',
    title: 'Chat'
  }
}

const lang = computed(() => (props.settings.lang === 'de' ? 'de' : 'en'))
const t = computed(() => text[lang.value])
const greeting = computed(() => props.settings.greeting || t.value.greeting)
// `system` sets no data-mode, so the tokens follow prefers-color-scheme like the widget.
const mode = computed(() => (props.settings.mode === 'system' ? undefined : props.settings.mode))
</script>

<template>
  <figure class="preview" aria-label="Widget preview">
    <div
      class="preview__frame"
      :data-theme="settings.theme"
      :data-mode="mode"
      :data-group="settings.accent"
      :lang="lang"
    >
      <div class="preview__page" aria-hidden="true">
        <span class="preview__line" />
        <span class="preview__line preview__line--short" />
        <span class="preview__line" />
      </div>
      <div class="preview__dock" :class="`preview__dock--${settings.position}`">
        <section class="preview__panel">
          <header class="preview__head">{{ t.title }}</header>
          <p class="preview__bubble">{{ greeting }}</p>
          <div class="preview__input">
            <span class="muted">{{ t.placeholder }}</span>
            <span class="preview__send">{{ t.send }}</span>
          </div>
        </section>
        <span class="preview__launcher" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <title>Chat</title>
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
          </svg>
        </span>
      </div>
    </div>
    <figcaption class="muted">
      Preview. It changes as you edit. Language
      {{ settings.lang === 'auto' ? 'follows the browser' : lang }}.
    </figcaption>
  </figure>
</template>

<style scoped>
.preview {
  margin: 0;
  display: grid;
  gap: 0.5rem;
}

.preview__frame {
  position: relative;
  min-height: 22rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--fg);
  overflow: hidden;
  font-family: var(--font-sans);
}

.preview__page {
  display: grid;
  gap: 0.5rem;
  padding: 1rem;
}

.preview__line {
  height: 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.preview__line--short {
  width: 60%;
}

.preview__dock {
  position: absolute;
  bottom: 1rem;
  display: grid;
  gap: 0.75rem;
  justify-items: end;
}

.preview__dock--bottom-right {
  right: 1rem;
}

.preview__dock--bottom-left {
  left: 1rem;
  justify-items: start;
}

.preview__panel {
  width: min(16rem, calc(100vw - 6rem));
  display: grid;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.preview__head {
  font-weight: 600;
}

.preview__bubble {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-md);
  background: var(--surface-2);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.preview__input {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border-control);
  border-radius: var(--radius-md);
  font-size: 0.875rem;
}

.preview__send {
  color: var(--accent-2-text);
  font-weight: 600;
}

.preview__launcher {
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  background: var(--accent-2);
  color: var(--accent-2-fg);
}
</style>
