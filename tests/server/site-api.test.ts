// The public read route GET /api/site/pages/{locale}/{slug} (synthwerk#109) on an h3 app, with
// the builder store on PGlite. No session anywhere: the route must answer without one.
import { createApp, createRouter, eventHandler, toWebHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BuilderConfigError } from '../../server/lib/builder-config'
import { BuilderStore } from '../../server/lib/builder-store'
import {
  etagOf,
  LIVE_CACHE_CONTROL,
  MISSING_CACHE_CONTROL,
  matches,
  SiteApi,
  type SiteApiDeps
} from '../../server/lib/site-api'
import { readSiteConfig, SiteConfigError } from '../../server/lib/site-config'
import { newSection, type PageContent } from '../../shared/sections'
import type { LivePage } from '../../shared/site'
import { type TestDb, testDb } from '../support/pglite'

const ORG = 'site-org'
const OTHER = 'other-org'
const ADA = 'user:ada'
const SECRET_URL = 'postgres://studio:very-secret-pw@db.internal:5432/studio'

let db: TestDb
let store: BuilderStore
let logs: string[]

beforeEach(async () => {
  db = await testDb()
  store = new BuilderStore(db)
  logs = []
})
afterEach(() => db.close())

function site(deps: Partial<SiteApiDeps> = {}) {
  const api = new SiteApi({
    site: readSiteConfig({ site: { orgId: ORG } }),
    store: async () => store,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...deps
  })
  const app = createApp()
  app.use(
    createRouter().get(
      '/api/site/pages/:locale/:slug',
      eventHandler((e) => api.live(e))
    )
  )
  const web = toWebHandler(app)
  return (path: string, headers: Record<string, string> = {}) =>
    web(new Request(`http://localhost:3000${path}`, { headers }))
}

function content(title: string, heading: string): PageContent {
  const hero = newSection('hero', 'h1')
  if (hero.type === 'hero') hero.title = heading
  return { title, sections: [hero] }
}

/** Creates a page, saves `drafts` one by one and publishes each. Returns the page id. */
async function published(org: string, slug: string, locale: 'de' | 'en', ...drafts: PageContent[]) {
  const page = await store.createPage(org, ADA, { slug, locale, title: 'x' })
  let revision = 1
  for (const draft of drafts) {
    await store.saveDraft(org, page.id, ADA, revision, draft)
    revision += 1
    await store.publish(org, page.id, ADA, revision)
  }
  return { id: page.id, revision }
}

const code = async (res: Response) =>
  ((await res.json()) as { data?: { code?: string } }).data?.code

describe('GET /api/site/pages/{locale}/{slug}', () => {
  it('answers the live version with cache headers and an ETag, and no author', async () => {
    await published(ORG, 'pricing', 'en', content('Pricing', 'Plans'))
    const res = await site()('/api/site/pages/en/pricing')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe(LIVE_CACHE_CONTROL)
    const body = (await res.json()) as LivePage
    expect(body).toMatchObject({ slug: 'pricing', locale: 'en', version: 1 })
    expect(body.content.title).toBe('Pricing')
    expect(res.headers.get('etag')).toBe(etagOf(body))
    expect(JSON.stringify(body)).not.toContain('ada')
    expect(Object.keys(body).sort()).toEqual([
      'content',
      'locale',
      'publishedAt',
      'slug',
      'version'
    ])
  })

  it('never shows the draft', async () => {
    const { id, revision } = await published(ORG, 'home', 'de', content('Start', 'Live'))
    await store.saveDraft(ORG, id, ADA, revision, content('Start', 'Draft only'))
    const res = await site()('/api/site/pages/de/home')
    const body = (await res.json()) as LivePage
    expect(JSON.stringify(body)).toContain('Live')
    expect(JSON.stringify(body)).not.toContain('Draft only')
  })

  it('answers 404 for a page without a live version', async () => {
    await store.createPage(ORG, ADA, { slug: 'soon', locale: 'en', title: 'Soon' })
    const res = await site()('/api/site/pages/en/soon')
    expect(res.status).toBe(404)
    expect(await code(res)).toBe('page_not_found')
    expect(res.headers.get('cache-control')).toBe(MISSING_CACHE_CONTROL)
  })

  it('serves the site org only, never another org', async () => {
    await published(OTHER, 'secret', 'en', content('Other', 'Other org'))
    const res = await site()('/api/site/pages/en/secret')
    expect(res.status).toBe(404)
  })

  it('keeps the locales apart', async () => {
    await published(ORG, 'home', 'de', content('Start', 'Deutsch'))
    expect((await site()('/api/site/pages/en/home')).status).toBe(404)
  })

  it.each([
    '/api/site/pages/fr/home',
    '/api/site/pages/en/Home',
    '/api/site/pages/en/-home',
    '/api/site/pages/en/home%2F..'
  ])('answers 404 for a bad locale or slug: %s', async (path) => {
    const res = await site()(path)
    expect(res.status).toBe(404)
  })

  it('publish then roll back: the old version shows again, with a new ETag', async () => {
    const { id } = await published(
      ORG,
      'home',
      'en',
      content('Home', 'Version one'),
      content('Home', 'Version two')
    )
    const get = site()
    const v2 = await get('/api/site/pages/en/home')
    const v2Tag = v2.headers.get('etag') ?? ''
    expect(JSON.stringify(await v2.json())).toContain('Version two')

    await store.rollback(ORG, id, ADA, 1)
    const v1 = await get('/api/site/pages/en/home', { 'if-none-match': v2Tag })
    expect(v1.status).toBe(200)
    expect(v1.headers.get('etag')).not.toBe(v2Tag)
    const body = (await v1.json()) as LivePage
    expect(body.version).toBe(1)
    expect(JSON.stringify(body)).toContain('Version one')
  })

  it('answers 304 without a body for a matching If-None-Match', async () => {
    await published(ORG, 'home', 'en', content('Home', 'Hi'))
    const get = site()
    const first = await get('/api/site/pages/en/home')
    const tag = first.headers.get('etag') ?? ''
    for (const header of [tag, `W/${tag}`, `"nope", ${tag}`, '*']) {
      const res = await get('/api/site/pages/en/home', { 'if-none-match': header })
      expect(res.status).toBe(304)
      expect(await res.text()).toBe('')
      expect(res.headers.get('etag')).toBe(tag)
      expect(res.headers.get('cache-control')).toBe(LIVE_CACHE_CONTROL)
    }
    expect((await get('/api/site/pages/en/home', { 'if-none-match': '"nope"' })).status).toBe(200)
  })

  it('ignores a session cookie: the answer is the same for every visitor', async () => {
    await published(ORG, 'home', 'en', content('Home', 'Hi'))
    const get = site()
    const anon = await get('/api/site/pages/en/home')
    const withCookie = await get('/api/site/pages/en/home', { cookie: 'sw_session=abc' })
    expect(withCookie.headers.get('etag')).toBe(anon.headers.get('etag'))
    expect(withCookie.headers.get('set-cookie')).toBeNull()
  })

  it('answers 503 site_not_configured without an org or a database', async () => {
    const noOrg = site({ site: new SiteConfigError('site is not configured') })
    const noDb = site({ store: new BuilderConfigError('builder is not configured') })
    for (const get of [noOrg, noDb]) {
      const res = await get('/api/site/pages/en/home')
      expect(res.status).toBe(503)
      expect(await code(res)).toBe('site_not_configured')
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('answers 503 site_unavailable when the database fails; the log has no URL', async () => {
    const err = Object.assign(new Error(`connect failed ${SECRET_URL}`), { code: 'ECONNREFUSED' })
    const res = await site({
      store: async () => {
        throw err
      }
    })('/api/site/pages/en/home')
    expect(res.status).toBe(503)
    expect(await code(res)).toBe('site_unavailable')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(logs).toEqual(['warn: database call failed (ECONNREFUSED)'])
    expect(logs.join()).not.toContain('very-secret-pw')

    db.failNext = new TypeError('boom')
    expect((await site()('/api/site/pages/en/home')).status).toBe(503)
    expect(logs.at(-1)).toBe('warn: database call failed (TypeError)')
  })
})

describe('matches', () => {
  it('reads If-None-Match', () => {
    expect(matches(undefined, '"a"')).toBe(false)
    expect(matches('', '"a"')).toBe(false)
    expect(matches('"b"', '"a"')).toBe(false)
    expect(matches(' "b" , "a"', '"a"')).toBe(true)
  })
})

describe('readSiteConfig', () => {
  it('needs an org id that matches the org pattern and never echoes it', () => {
    expect(readSiteConfig({ site: { orgId: ' org_1 ' } })).toEqual({ orgId: 'org_1' })
    expect(() => readSiteConfig({})).toThrow('set NUXT_SITE_ORG_ID')
    expect(() => readSiteConfig({ site: { orgId: 42 } })).toThrow(SiteConfigError)
    expect(() => readSiteConfig({ site: { orgId: 'bad org/../x' } })).toThrow(
      /^NUXT_SITE_ORG_ID must match/
    )
    try {
      readSiteConfig({ site: { orgId: 'bad org/../x' } })
    } catch (err) {
      expect((err as Error).message).not.toContain('bad org')
    }
  })
})
