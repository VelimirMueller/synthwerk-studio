// Consent for non-essential scripts on the public site (synthwerk#45). German law (TDDDG §25,
// GDPR): no analytics before an opt-in, refusing is as easy as accepting, the choice can change.
// - The choice lives in one first-party cookie, `sw_consent`. No third-party consent vendor.
// - The cookie itself is essential (it stores the choice), so it needs no consent.
// - A cookie we cannot read (old version, edited) counts as "no choice yet": the banner shows.

export const CONSENT_COOKIE = 'sw_consent'
/** About six months. After that the banner asks again. */
export const CONSENT_MAX_AGE_SECONDS = 182 * 24 * 60 * 60
/** Bump when the categories change: an old choice then no longer counts. */
export const CONSENT_VERSION = 1

export interface ConsentChoice {
  /** Umami page view counting. The only non-essential category today. */
  analytics: boolean
}

/** The cookie value of a choice, for example `v1.analytics-yes`. */
export function serializeConsent(choice: ConsentChoice): string {
  return `v${CONSENT_VERSION}.analytics-${choice.analytics ? 'yes' : 'no'}`
}

/** The choice in a cookie value, or null for no valid choice. */
export function parseConsent(value: string | null | undefined): ConsentChoice | null {
  if (value === `v${CONSENT_VERSION}.analytics-yes`) return { analytics: true }
  if (value === `v${CONSENT_VERSION}.analytics-no`) return { analytics: false }
  return null
}

/** The value of one cookie in a `document.cookie` string. */
export function readCookie(cookies: string, name: string): string | null {
  for (const part of cookies.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

/** The Set-Cookie text for `document.cookie`. Secure on https; SameSite=Lax; whole site. */
export function consentCookie(choice: ConsentChoice, secure: boolean): string {
  const attrs = [`Max-Age=${CONSENT_MAX_AGE_SECONDS}`, 'Path=/', 'SameSite=Lax']
  if (secure) attrs.push('Secure')
  return [`${CONSENT_COOKIE}=${serializeConsent(choice)}`, ...attrs].join('; ')
}

/**
 * The analytics script URL when it may load: a consent for analytics and a configured, safe URL.
 * Only https URLs or a path on the own origin. Anything else: null, nothing loads.
 */
export function analyticsScript(
  choice: ConsentChoice | null,
  config: { scriptUrl?: unknown; websiteId?: unknown }
): { src: string; websiteId: string } | null {
  if (!choice?.analytics) return null
  const src = typeof config.scriptUrl === 'string' ? config.scriptUrl.trim() : ''
  const websiteId = typeof config.websiteId === 'string' ? config.websiteId.trim() : ''
  if (!src || !/^[A-Za-z0-9-]{1,64}$/.test(websiteId)) return null
  if (src.startsWith('/') && !src.startsWith('//')) return { src, websiteId }
  try {
    const url = new URL(src)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return { src: url.href, websiteId }
  } catch {
    return null
  }
}
