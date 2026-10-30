// The consent state of the public site (synthwerk#45). Client side only: the server renders the
// same HTML for every visitor, so a page can be cached or prerendered. The banner shows after
// hydration when the `sw_consent` cookie holds no valid choice.
import {
  CONSENT_COOKIE,
  type ConsentChoice,
  consentCookie,
  parseConsent,
  readCookie
} from '~/utils/consent'

interface ConsentState {
  /** The cookie was read (client only). Before that nothing non-essential may load. */
  ready: boolean
  choice: ConsentChoice | null
  /** The banner is open: no choice yet, or the visitor opened the settings. */
  open: boolean
  /** The visitor opened the banner from "Cookie settings": it takes the focus. */
  focus: boolean
  /** The status line after a save, for screen readers. */
  announce: string
}

export function useConsent() {
  const state = useState<ConsentState>('site-consent', () => ({
    ready: false,
    choice: null,
    open: false,
    focus: false,
    announce: ''
  }))

  /** Reads the cookie. Call it in onMounted. */
  function load() {
    if (!import.meta.client || state.value.ready) return
    const choice = parseConsent(readCookie(document.cookie, CONSENT_COOKIE))
    state.value = { ready: true, choice, open: choice === null, focus: false, announce: '' }
  }

  /**
   * Saves a choice in the cookie. A withdrawn analytics consent reloads the page: a loaded
   * script cannot be unloaded, a fresh page loads none.
   */
  function save(choice: ConsentChoice, announce: string) {
    if (!import.meta.client) return
    const withdrawn = state.value.choice?.analytics === true && !choice.analytics
    // biome-ignore lint/suspicious/noDocumentCookie: one first-party cookie, all browsers; the Cookie Store API is not in every browser
    document.cookie = consentCookie(choice, window.location.protocol === 'https:')
    state.value = { ready: true, choice, open: false, focus: false, announce }
    if (withdrawn) window.location.reload()
  }

  function openSettings() {
    state.value = { ...state.value, open: true, focus: true, announce: '' }
  }

  return { state, load, save, openSettings }
}
