// Public site settings (synthwerk#109, #45). The org that owns the public pages is a config value
// (NUXT_SITE_ORG_ID), never a request value: a visitor cannot read the pages of another org.
// The lead form (synthwerk#105) also needs the public origin of the site (NUXT_SITE_ORIGIN): the
// form must come from it, and the confirm link points to it. Never taken from the Host header.

import { ORG_PATTERN } from './builder-api'

export interface SiteConfig {
  /** The org whose live builder pages the public site serves. */
  orgId: string
  /** `scheme://host[:port]` of the public site, or null: the lead form answers 503. */
  origin: string | null
  /**
   * Take the client address for the rate limit from the last X-Forwarded-For entry (the one the
   * edge proxy added). Only behind a proxy that sets it (NUXT_SITE_TRUST_FORWARDED_FOR).
   */
  trustForwardedFor: boolean
}

export interface RawSiteConfig {
  site?: { orgId?: unknown; origin?: unknown; trustForwardedFor?: unknown }
}

export class SiteConfigError extends Error {}

/** `https://host[:port]`, or `http://` for localhost only. Returns the canonical origin. */
function readOrigin(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SiteConfigError('NUXT_SITE_ORIGIN must be an origin like https://synthwerk.dev')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash ||
    raw.endsWith('/')
  ) {
    throw new SiteConfigError('NUXT_SITE_ORIGIN must be an origin like https://synthwerk.dev')
  }
  return url.origin
}

/** Reads and checks the site settings. The message names the variable only. */
export function readSiteConfig(raw: RawSiteConfig): SiteConfig {
  const value = typeof raw.site?.orgId === 'string' ? raw.site.orgId.trim() : ''
  if (value === '') throw new SiteConfigError('site is not configured: set NUXT_SITE_ORG_ID')
  if (!ORG_PATTERN.test(value)) {
    throw new SiteConfigError('NUXT_SITE_ORG_ID must match ^[A-Za-z0-9_-]{1,64}$')
  }
  const trust = raw.site?.trustForwardedFor
  return {
    orgId: value,
    origin: readOrigin(raw.site?.origin),
    trustForwardedFor: trust === true || trust === 'true'
  }
}
