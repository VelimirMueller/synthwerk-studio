// The public site (synthwerk#109, #45): types and values that the server, the pages and
// nuxt.config.ts share. Relative imports only: nuxt.config.ts imports this file.
import { LOCALES, type Locale, type PageContent } from './sections'

// The answer of GET /api/site/pages/{locale}/{slug} (synthwerk#109). The server route and the
// public pages use the same type. No author and no page id: only what the page shows.

export interface LivePage {
  slug: string
  locale: Locale
  version: number
  publishedAt: string
  content: PageContent
}

export const LEGAL_PAGES = ['imprint', 'privacy', 'cookies'] as const
export type LegalPage = (typeof LEGAL_PAGES)[number]

/** The legal pages are static routes. A builder page with the same slug never shows. */
export const LEGAL_SLUGS: Record<Locale, Record<LegalPage, string>> = {
  de: { imprint: 'impressum', privacy: 'datenschutz', cookies: 'cookies' },
  en: { imprint: 'imprint', privacy: 'privacy', cookies: 'cookies' }
}

/** The paths of every legal page in every locale. nuxt.config.ts prerenders them (#45). */
export const LEGAL_PATHS: readonly string[] = LOCALES.flatMap((locale) =>
  LEGAL_PAGES.map((page) => `/${locale}/${LEGAL_SLUGS[locale][page]}`)
)

/**
 * The public site settings that change per environment: the test system banner and the
 * analytics script (synthwerk#45). GET /api/site/config gives the values of the running server.
 */
export interface PublicSiteConfig {
  env: string
  analytics: { scriptUrl: string; websiteId: string }
}

/** Reads `runtimeConfig.public.site` or an /api/site/config answer. Anything else is empty. */
export function publicSiteConfig(value: unknown): PublicSiteConfig {
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  const site = (typeof value === 'object' && value !== null ? value : {}) as {
    env?: unknown
    analytics?: { scriptUrl?: unknown; websiteId?: unknown } | null
  }
  return {
    env: text(site.env),
    analytics: {
      scriptUrl: text(site.analytics?.scriptUrl),
      websiteId: text(site.analytics?.websiteId)
    }
  }
}
