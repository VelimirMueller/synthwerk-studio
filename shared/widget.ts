// Widget settings and the embed snippet (synthwerk#38). Shared by the pages and the BFF.
// The settings follow contracts `WidgetSettings` (identity spec 0.3.0). The snippet follows
// the real attributes of <synthwerk-chat> (synthwerk-widgets docs/features/chat-widget.md).

export const positions = ['bottom-right', 'bottom-left'] as const
export const themes = ['default', 'contrast'] as const
export const modes = ['system', 'light', 'dark'] as const
export const langs = ['auto', 'de', 'en'] as const
/** Accent groups of @synthwerk/tokens (`data-group`). No free colour. */
export const accents = ['flagship', 'lab', 'ops', 'venture'] as const
export const MAX_GREETING = 280

export interface WidgetSettings {
  position: (typeof positions)[number]
  theme: (typeof themes)[number]
  mode: (typeof modes)[number]
  lang: (typeof langs)[number]
  accent: (typeof accents)[number]
  /** Plain text. Empty = the widget's own greeting. */
  greeting: string
}

export const defaultSettings = (): WidgetSettings => ({
  position: 'bottom-right',
  theme: 'default',
  mode: 'system',
  lang: 'auto',
  accent: 'flagship',
  greeting: ''
})

const oneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)

/** Same rule as identity: 280 characters or less, no control character but a line break. */
export function validGreeting(value: string): boolean {
  if ([...value].length > MAX_GREETING) return false
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose.
  return !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(value)
}

/** Checks settings from a request body. Returns null when one field is not allowed. */
export function readSettings(value: unknown): WidgetSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const keys = Object.keys(v)
  const known = ['position', 'theme', 'mode', 'lang', 'accent', 'greeting']
  if (keys.length !== known.length || !keys.every((k) => known.includes(k))) return null
  if (
    !oneOf(positions, v.position) ||
    !oneOf(themes, v.theme) ||
    !oneOf(modes, v.mode) ||
    !oneOf(langs, v.lang) ||
    !oneOf(accents, v.accent) ||
    typeof v.greeting !== 'string'
  ) {
    return null
  }
  const greeting = v.greeting.trim()
  if (!validGreeting(greeting)) return null
  return {
    position: v.position,
    theme: v.theme,
    mode: v.mode,
    lang: v.lang,
    accent: v.accent,
    greeting
  }
}

/**
 * Reads settings that identity sent. Lenient: a missing or unknown value gets its default, so a
 * new identity value never makes an app unreadable. Request bodies use the strict readSettings.
 */
export function settingsFromIdentity(value: unknown): WidgetSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const d = defaultSettings()
  return {
    position: oneOf(positions, v.position) ? v.position : d.position,
    theme: oneOf(themes, v.theme) ? v.theme : d.theme,
    mode: oneOf(modes, v.mode) ? v.mode : d.mode,
    lang: oneOf(langs, v.lang) ? v.lang : d.lang,
    accent: oneOf(accents, v.accent) ? v.accent : d.accent,
    greeting: typeof v.greeting === 'string' && validGreeting(v.greeting) ? v.greeting : d.greeting
  }
}

/** Where the widget script and the edge live. Both come from the studio runtime config. */
export interface EmbedTarget {
  /** URL of `synthwerk-chat.js`. */
  scriptUrl: string
  /** Edge base URL. The widget calls `/identity` and `/llm` below it. */
  apiUrl: string
}

/** Escapes a value for a double-quoted HTML attribute. */
export const attr = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

/**
 * The embed snippet: one module script, one element, and the hook that hands in the user token.
 * It carries no setting: the widget loads them from the studio (widgets#34), and an attribute
 * would override the studio value. The page shows it as text, never as HTML.
 */
export function buildSnippet(appId: string, target: EmbedTarget): string {
  return [
    `<script type="module" src="${attr(target.scriptUrl)}"></script>`,
    `<synthwerk-chat app-id="${attr(appId)}" api-url="${attr(target.apiUrl)}"></synthwerk-chat>`,
    '<script type="module">',
    '  // After sign-in and sign-out: hand in the access token of the signed-in user, or null.',
    "  document.querySelector('synthwerk-chat').getUserToken = () => yourAuth.accessToken ?? null",
    '</script>'
  ].join('\n')
}

/** A config value the snippet can use: an absolute https URL, or http on localhost. */
export function usableUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}
