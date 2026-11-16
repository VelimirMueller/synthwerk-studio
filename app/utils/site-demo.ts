// The live demo and the public numbers of the site (synthwerk#47): texts in German and English,
// error codes to text, the SSE frame parser of the chat answer and the number format.
import type { Locale } from '#shared/sections'

export interface DemoTexts {
  title: string
  intro: string
  start: string
  loading: string
  signInHint: string
  signIn: string
  chatLabel: string
  chatPlaceholder: string
  send: string
  sending: string
  you: string
  assistant: string
  imageLabel: string
  imageHint: string
  classify: string
  classifying: string
  result: (label: string, percent: string) => string
  uncertain: string
  errors: Record<string, string>
  fallbackError: string
  stats: {
    label: string
    uptime: string
    p95: string
    chats: string
  }
}

export const DEMO_TEXTS: Record<Locale, DemoTexts> = {
  de: {
    title: 'Live-Demo ausprobieren',
    intro:
      'Chatten Sie mit dem Modell oder lassen Sie ein Bild erkennen. Dafür brauchen Sie ein Konto.',
    start: 'Demo starten',
    loading: 'Demo wird geladen …',
    signInHint: 'Melden Sie sich an, um die Demo zu nutzen.',
    signIn: 'Anmelden',
    chatLabel: 'Ihre Nachricht',
    chatPlaceholder: 'Fragen Sie etwas …',
    send: 'Senden',
    sending: 'Antwort kommt …',
    you: 'Sie',
    assistant: 'Synthwerk',
    imageLabel: 'Bild (JPEG, PNG oder WebP, höchstens 5 MiB)',
    imageHint: 'Das Bild geht nur an die Bilderkennung. Wir speichern es nicht in der Demo.',
    classify: 'Bild erkennen',
    classifying: 'Bild wird erkannt …',
    result: (label, percent) => `${label} (${percent})`,
    uncertain: 'Das Modell ist sich nicht sicher.',
    errors: {
      sign_in_required: 'Ihre Anmeldung ist abgelaufen. Bitte melden Sie sich neu an.',
      csrf_failed: 'Die Anfrage wurde abgelehnt. Laden Sie die Seite neu.',
      invalid_request: 'Die Eingabe ist ungültig. Bitte prüfen Sie sie.',
      demo_rate_limited: 'Zu viele Anfragen. Bitte warten Sie kurz.',
      demo_busy: 'Die Demo ist gerade ausgelastet. Bitte versuchen Sie es gleich noch einmal.',
      demo_quota_exhausted:
        'Das Kontingent der Demo ist aufgebraucht. Bitte versuchen Sie es später.',
      demo_not_member: 'Ihr Konto hat keinen Zugang zur Demo.',
      demo_not_configured: 'Dieser Teil der Demo ist noch nicht eingerichtet.',
      demo_unavailable: 'Die Demo ist gerade nicht erreichbar.',
      payload_too_large: 'Das Bild ist größer als 5 MiB.',
      unsupported_media_type: 'Bitte wählen Sie ein JPEG-, PNG- oder WebP-Bild.'
    },
    fallbackError: 'Etwas ist schiefgegangen. Bitte versuchen Sie es noch einmal.',
    stats: {
      label: 'Zahlen der Plattform',
      uptime: 'Verfügbarkeit 30 Tage',
      p95: 'p95',
      chats: 'Beantwortete Chats 30 Tage'
    }
  },
  en: {
    title: 'Try the live demo',
    intro: 'Chat with the model or let it recognize an image. You need an account for this.',
    start: 'Start the demo',
    loading: 'Loading the demo …',
    signInHint: 'Sign in to use the demo.',
    signIn: 'Sign in',
    chatLabel: 'Your message',
    chatPlaceholder: 'Ask something …',
    send: 'Send',
    sending: 'Answer is coming …',
    you: 'You',
    assistant: 'Synthwerk',
    imageLabel: 'Image (JPEG, PNG or WebP, at most 5 MiB)',
    imageHint: 'The image goes to the image recognition only. The demo does not keep it.',
    classify: 'Recognize image',
    classifying: 'Recognizing the image …',
    result: (label, percent) => `${label} (${percent})`,
    uncertain: 'The model is not sure.',
    errors: {
      sign_in_required: 'Your sign-in has ended. Please sign in again.',
      csrf_failed: 'The request was refused. Reload the page.',
      invalid_request: 'The input is not valid. Please check it.',
      demo_rate_limited: 'Too many requests. Please wait a moment.',
      demo_busy: 'The demo is busy. Please try again in a moment.',
      demo_quota_exhausted: 'The demo quota is used up. Please try again later.',
      demo_not_member: 'Your account has no access to the demo.',
      demo_not_configured: 'This part of the demo is not set up yet.',
      demo_unavailable: 'The demo is not available now.',
      payload_too_large: 'The image is larger than 5 MiB.',
      unsupported_media_type: 'Please choose a JPEG, PNG or WebP image.'
    },
    fallbackError: 'Something went wrong. Please try again.',
    stats: {
      label: 'Platform numbers',
      uptime: 'Uptime 30 days',
      p95: 'p95',
      chats: 'Answered chats 30 days'
    }
  }
}

export const DEMO_MAX_MESSAGE = 2000
export const DEMO_MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const DEMO_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

/** The text of an error code; unknown codes get the general text. */
export function demoErrorText(locale: Locale, code: unknown): string {
  const texts = DEMO_TEXTS[locale]
  return (typeof code === 'string' && texts.errors[code]) || texts.fallbackError
}

/** The error code of a refused demo response body (the h3 error shape). */
export function demoErrorCode(body: unknown): string | null {
  const code = (body as { data?: { code?: unknown } } | null)?.data?.code
  return typeof code === 'string' ? code : null
}

export interface SseFrame {
  event: string
  data: string
}

/**
 * Splits SSE text into frames. Returns the complete frames and the rest that waits for more
 * bytes. Comment lines (`: ping`) and `id:` lines are skipped.
 */
export function parseSse(buffer: string): { frames: SseFrame[]; rest: string } {
  const text = buffer.replace(/\r\n?/g, '\n')
  const parts = text.split('\n\n')
  const rest = parts.pop() ?? ''
  const frames: SseFrame[] = []
  for (const part of parts) {
    let event = 'message'
    const data: string[] = []
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') })
  }
  return { frames, rest }
}

/** The text piece of a `delta` frame, or '' for anything else. */
export function deltaText(frame: SseFrame): string {
  if (frame.event !== 'delta') return ''
  try {
    const text = (JSON.parse(frame.data) as { text?: unknown }).text
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

export interface PublicStatsView {
  uptime: string
  p95: string
  chats: string
}

const DASH = '-'

/** The three site numbers. A missing or null value shows as "-". */
export function formatStats(
  locale: Locale,
  stats: {
    uptime_ratio?: number | null
    p95_ms?: number | null
    answered_chats?: number | null
  } | null
): PublicStatsView {
  const tag = locale === 'de' ? 'de-DE' : 'en-GB'
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const uptime = stats?.uptime_ratio
  const p95 = stats?.p95_ms
  const chats = stats?.answered_chats
  return {
    uptime: ok(uptime)
      ? new Intl.NumberFormat(tag, {
          style: 'percent',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(uptime)
      : DASH,
    p95: ok(p95)
      ? `${new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }).format(p95)} ms`
      : DASH,
    chats: ok(chats) ? new Intl.NumberFormat(tag).format(chats) : DASH
  }
}

/** A score from 0 to 1 as a whole percent. */
export function formatScore(locale: Locale, score: number): string {
  return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    style: 'percent',
    maximumFractionDigits: 0
  }).format(score)
}
