// The public read route of the builder (synthwerk#109): GET /api/site/pages/{locale}/{slug}.
// It serves the live version of a page of the site org (NUXT_SITE_ORG_ID) and nothing else.
// - No session and no cookie is read. The answer is the same for every visitor.
// - Only `BuilderStore.getLive`: a draft or an older version is never reachable.
// - A strong ETag over the body. If-None-Match gives 304. Cache-Control is public and short,
//   so a publish or a roll back shows within CACHE_MAX_AGE seconds.
// - No third-party request: the route reads the studio database only.
import { createHash } from 'node:crypto'
import {
  createError,
  getRequestHeader,
  getRouterParam,
  type H3Event,
  isError,
  setResponseHeader,
  setResponseStatus
} from 'h3'
import { LOCALES, type Locale, SLUG_PATTERN } from '../../shared/sections'
import type { LivePage } from '../../shared/site'
import { BuilderConfigError } from './builder-config'
import { type BuilderStore, BuilderStoreError } from './builder-store'
import { type SiteConfig, SiteConfigError } from './site-config'

export interface SiteApiDeps {
  site: SiteConfig | SiteConfigError
  store: (() => Promise<BuilderStore>) | BuilderConfigError
  log?: (level: 'warn' | 'error', message: string) => void
}

/** Seconds a browser or a CDN may keep a live page before it asks again. */
export const CACHE_MAX_AGE = 60
/** Seconds a CDN may serve a stale copy while it asks again in the background. */
export const STALE_WHILE_REVALIDATE = 300
export const LIVE_CACHE_CONTROL = `public, max-age=${CACHE_MAX_AGE}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`
/** A missing page is cached for a short time too, so a probe does not reach the database often. */
export const MISSING_CACHE_CONTROL = 'public, max-age=30'

const STATUS_TEXT: Record<number, string> = {
  404: 'Not Found',
  503: 'Service Unavailable'
}

export class SiteApi {
  constructor(private readonly deps: SiteApiDeps) {}

  /** GET /api/site/pages/{locale}/{slug} -> the live page, 304, 404 or 503. */
  async live(event: H3Event): Promise<LivePage | null> {
    const locale = getRouterParam(event, 'locale') ?? ''
    const slug = getRouterParam(event, 'slug') ?? ''
    if (!LOCALES.includes(locale as Locale) || !SLUG_PATTERN.test(slug)) {
      throw this.notFound(event)
    }
    const { site, store: open } = this.deps
    if (site instanceof SiteConfigError) throw unavailable(event, 'site_not_configured')
    if (open instanceof BuilderConfigError) throw unavailable(event, 'site_not_configured')
    let page: Awaited<ReturnType<BuilderStore['getLive']>>
    try {
      const store = await open()
      page = await store.getLive(site.orgId, slug, locale as Locale)
    } catch (err) {
      if (isError(err)) throw err
      // The live version went away between the two reads (a race with a delete): not found.
      if (err instanceof BuilderStoreError) throw this.notFound(event)
      const code = (err as { code?: unknown } | null)?.code
      const name = err instanceof Error ? err.name : 'error'
      this.deps.log?.('warn', `database call failed (${typeof code === 'string' ? code : name})`)
      throw unavailable(event, 'site_unavailable')
    }
    if (!page) throw this.notFound(event)
    const body: LivePage = {
      slug,
      locale: locale as Locale,
      version: page.version,
      publishedAt: page.publishedAt,
      content: page.content
    }
    const etag = etagOf(body)
    setResponseHeader(event, 'cache-control', LIVE_CACHE_CONTROL)
    setResponseHeader(event, 'etag', etag)
    setResponseHeader(event, 'vary', 'accept-encoding')
    if (matches(getRequestHeader(event, 'if-none-match'), etag)) {
      setResponseStatus(event, 304, 'Not Modified')
      return null
    }
    return body
  }

  private notFound(event: H3Event) {
    setResponseHeader(event, 'cache-control', MISSING_CACHE_CONTROL)
    return fail(404, 'page_not_found')
  }
}

/** A strong ETag: sha256 of the JSON body, base64url. Same content, same tag on every server. */
export function etagOf(body: LivePage): string {
  return `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url')}"`
}

/** If-None-Match: `*`, one tag or a list. A weak tag (W/) matches its strong form (RFC 9110). */
export function matches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === etag)
}

function unavailable(event: H3Event, code: string) {
  setResponseHeader(event, 'cache-control', 'no-store')
  return fail(503, code)
}

function fail(status: number, code: string) {
  const text = STATUS_TEXT[status] ?? 'Error'
  return createError({ statusCode: status, statusMessage: text, message: text, data: { code } })
}
