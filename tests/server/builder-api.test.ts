// The /api/builder routes on an h3 app: same wiring as server/api/builder and
// server/middleware/csrf.ts, with the real AuthService (mock OIDC provider), a fake identity and
// the builder store on PGlite.
import { createApp, createRouter, eventHandler, toWebHandler } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BuilderApi, csvCell, MAX_BODY_BYTES } from '../../server/lib/builder-api'
import { BuilderConfigError, readBuilderConfig } from '../../server/lib/builder-config'
import { BuilderStore } from '../../server/lib/builder-store'
import { ROLES_CLAIM } from '../../server/lib/claims'
import { IdentityConfigError, readIdentityConfig } from '../../server/lib/identity-config'
import { SESSION_COOKIE, type SessionRecord, sessionKey } from '../../server/lib/session'
import { newSection } from '../../shared/sections'
import { Browser, buildApp, type Harness, ORIGIN, signIn } from '../support/app'
import { FakeIdentity, IDENTITY_URL, ORG_UUID, problem } from '../support/identity'
import { type TestDb, testDb } from '../support/pglite'
import { MockProvider, ORG_ID } from '../support/provider'

const provider = new MockProvider()
const MEMBERS = `/v1/orgs/${ORG_UUID}/members`
const PAGES = '/api/builder/pages'
const SECRET_URL = 'postgres://studio:very-secret-pw@db.internal:5432/studio'

let harness: Harness
let identity: FakeIdentity
let db: TestDb
let logs: string[]

beforeAll(async () => {
  await provider.start()
})
afterAll(() => provider.stop())

beforeEach(async () => {
  provider.options = {}
  harness = buildApp(provider)
  identity = new FakeIdentity()
  db = await testDb()
  logs = []
})
afterEach(() => db.close())

interface Options {
  identity?: ReturnType<typeof readIdentityConfig> | IdentityConfigError
  store?: (() => Promise<BuilderStore>) | BuilderConfigError
  fetch?: typeof fetch
}

function builderBrowser(options: Options = {}) {
  const api = new BuilderApi({
    auth: harness.service,
    identity: options.identity ?? readIdentityConfig({ identity: { url: IDENTITY_URL } }),
    store: options.store ?? (async () => new BuilderStore(db)),
    fetch: options.fetch ?? identity.fetch,
    log: (level, message) => logs.push(`${level}: ${message}`)
  })
  const app = createApp()
  app.use(
    eventHandler((event) => {
      if (event.path.startsWith('/api/')) harness.service.assertSameOrigin(event)
    })
  )
  const router = createRouter()
    .get(
      '/api/auth/session',
      eventHandler((e) => harness.service.session(e))
    )
    .get(
      PAGES,
      eventHandler((e) => api.list(e))
    )
    .post(
      PAGES,
      eventHandler((e) => api.create(e))
    )
    .get(
      `${PAGES}/:pageId`,
      eventHandler((e) => api.get(e))
    )
    .put(
      `${PAGES}/:pageId/draft`,
      eventHandler((e) => api.saveDraft(e))
    )
    .post(
      `${PAGES}/:pageId/publish`,
      eventHandler((e) => api.publish(e))
    )
    .post(
      `${PAGES}/:pageId/rollback`,
      eventHandler((e) => api.rollback(e))
    )
    .get(
      `${PAGES}/:pageId/versions/:version`,
      eventHandler((e) => api.version(e))
    )
    .get(
      `${PAGES}/:pageId/events`,
      eventHandler((e) => api.events(e))
    )
    .post(
      `${PAGES}/:pageId/unpublish`,
      eventHandler((e) => api.unpublish(e))
    )
    .delete(
      `${PAGES}/:pageId`,
      eventHandler((e) => api.remove(e))
    )
    .post(
      `${PAGES}/:pageId/versions/:version/copy`,
      eventHandler((e) => api.copyVersion(e))
    )
    .get(
      '/api/builder/leads',
      eventHandler((e) => api.leads(e))
    )
    .get(
      '/api/builder/leads/export',
      eventHandler((e) => api.exportLeads(e))
    )
    .delete(
      '/api/builder/leads/:leadId',
      eventHandler((e) => api.removeLead(e))
    )
  app.use(router)
  const web = toWebHandler(app)
  return new Browser({ ...harness, handle: (request) => web(request) })
}

async function signedIn(options?: Options) {
  const auth = new Browser(harness)
  await signIn(auth, provider)
  const browser = builderBrowser(options)
  for (const [k, v] of auth.cookies) browser.cookies.set(k, v)
  const session = await (await browser.fetch('/api/auth/session')).json()
  const id = browser.cookies.get(SESSION_COOKIE) ?? ''
  const record = harness.store.data.get(sessionKey(id)) as SessionRecord
  identity.token = record.tokens.accessToken
  return { browser, csrf: session.csrfToken as string, sub: record.identity.user.sub }
}

const send = (method: string, csrf: string, body?: unknown) => ({
  method,
  headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': csrf },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
})

const errorOf = async (res: Response) =>
  ((await res.json()) as { data?: { code?: string; field?: string } }).data ?? {}

const NEW_PAGE = { slug: 'home', locale: 'en', title: 'Home' }

async function createPage(browser: Browser, csrf: string) {
  const res = await browser.fetch(PAGES, send('POST', csrf, NEW_PAGE))
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; draftRevision: number }
}

describe('/api/builder - authorization', () => {
  it('no session - 401 unauthenticated, nothing called', async () => {
    const res = await builderBrowser().fetch(PAGES)
    expect(res.status).toBe(401)
    expect((await errorOf(res)).code).toBe('unauthenticated')
    expect(identity.calls).toHaveLength(0)
  })

  it('POST without x-csrf-token - 403 csrf_failed, nothing written', async () => {
    const { browser } = await signedIn()
    const res = await browser.fetch(PAGES, send('POST', '', NEW_PAGE))
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe('csrf_failed')
    expect(identity.calls).toHaveLength(0)
    expect((await db.query('select 1 from builder_pages')).rows).toHaveLength(0)
  })

  it('POST from another origin - 403', async () => {
    const { browser, csrf } = await signedIn()
    const init = send('POST', csrf, NEW_PAGE)
    const res = await browser.fetch(PAGES, {
      ...init,
      headers: { ...init.headers, origin: 'https://evil.example' }
    })
    expect(res.status).toBe(403)
  })

  it('token role member - 403 forbidden, identity not called', async () => {
    provider.options = {
      accessClaims: { [ROLES_CLAIM]: { member: { [ORG_ID]: 'demo.auth.localhost' } } }
    }
    const { browser } = await signedIn()
    const res = await browser.fetch(PAGES)
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe('forbidden')
    expect(identity.calls).toHaveLength(0)
  })

  it('stale admin claim: identity refuses the membership - 403, nothing written', async () => {
    identity.answers.set(`GET ${MEMBERS}`, problem(403, 'forbidden'))
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch(PAGES, send('POST', csrf, NEW_PAGE))
    expect(res.status).toBe(403)
    expect((await db.query('select 1 from builder_pages')).rows).toHaveLength(0)
  })

  it('identity refuses the token - 401; identity down - 502 and a log line', async () => {
    identity.answers.set(`GET ${MEMBERS}`, problem(401, 'unauthenticated'))
    const { browser } = await signedIn()
    expect((await browser.fetch(PAGES)).status).toBe(401)
    identity.answers.clear()
    identity.down = true
    const res = await browser.fetch(PAGES)
    expect(res.status).toBe(502)
    expect((await errorOf(res)).code).toBe('upstream_unavailable')
    expect(logs).toEqual(['warn: identity check failed: identity is not reachable'])
  })

  it('org id outside the pattern - 403, identity not called', async () => {
    const bad = 'org/../x'
    provider.options = {
      accessClaims: {
        'urn:zitadel:iam:user:resourceowner:id': bad,
        [ROLES_CLAIM]: { owner: { [bad]: 'demo.auth.localhost' } }
      }
    }
    const { browser } = await signedIn()
    expect((await browser.fetch(PAGES)).status).toBe(403)
    expect(identity.calls).toHaveLength(0)
  })

  it('no database URL - 503 builder_not_configured; no identity URL - 503 identity_not_configured', async () => {
    let config: unknown
    try {
      readBuilderConfig({})
    } catch (err) {
      config = err
    }
    const one = await signedIn({ store: config as BuilderConfigError })
    const res = await one.browser.fetch(PAGES)
    expect(res.status).toBe(503)
    expect((await errorOf(res)).code).toBe('builder_not_configured')

    const two = await signedIn({ identity: new IdentityConfigError('identity is not configured') })
    const res2 = await two.browser.fetch(PAGES)
    expect(res2.status).toBe(503)
    expect((await errorOf(res2)).code).toBe('identity_not_configured')
  })

  it('database down - 503 builder_unavailable, the log has the error code and no URL', async () => {
    const down = Object.assign(new Error(`connect ECONNREFUSED ${SECRET_URL}`), {
      code: 'ECONNREFUSED'
    })
    const { browser } = await signedIn({
      store: async () => {
        throw down
      }
    })
    const res = await browser.fetch(PAGES)
    expect(res.status).toBe(503)
    expect((await errorOf(res)).code).toBe('builder_unavailable')
    expect(logs).toEqual(['warn: database call failed (ECONNREFUSED)'])

    db.failNext = new Error('boom')
    const { browser: b2 } = await signedIn()
    expect((await b2.fetch(PAGES)).status).toBe(503)
    expect(logs.at(-1)).toBe('warn: database call failed (Error)')
    expect(logs.join('\n')).not.toContain('very-secret-pw')
  })
})

describe('/api/builder - pages', () => {
  it('create, list, get; the audit actor is user:<sub>', async () => {
    const { browser, csrf, sub } = await signedIn()
    const page = await createPage(browser, csrf)
    const list = await (await browser.fetch(PAGES)).json()
    expect(list).toEqual([
      expect.objectContaining({ id: page.id, slug: 'home', liveVersion: null })
    ])
    const res = await browser.fetch(`${PAGES}/${page.id}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      draft: { title: 'Home', sections: [] },
      versions: [],
      draftUpdatedBy: `user:${sub}`
    })
    const events = await (await browser.fetch(`${PAGES}/${page.id}/events`)).json()
    expect(events.items).toEqual([
      expect.objectContaining({
        type: 'dev.synthwerk.studio.page.created.v1',
        actor: `user:${sub}`
      })
    ])
    expect(identity.work).toContainEqual(
      expect.objectContaining({ method: 'GET', path: MEMBERS, search: '?limit=1' })
    )
  })

  it.each([
    [{ ...NEW_PAGE, slug: 'Bad Slug' }, 'slug'],
    [{ ...NEW_PAGE, slug: '-x' }, 'slug'],
    [{ ...NEW_PAGE, locale: 'fr' }, 'locale'],
    [{ ...NEW_PAGE, title: ' ' }, 'title'],
    [{ ...NEW_PAGE, title: 'a\u0007b' }, 'title']
  ])('create %j - 400 invalid_request at %s', async (body, field) => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch(PAGES, send('POST', csrf, body))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toEqual({ code: 'invalid_request', field })
  })

  it('create twice - 409 slug_taken; a body that is not an object - 400', async () => {
    const { browser, csrf } = await signedIn()
    await createPage(browser, csrf)
    const res = await browser.fetch(PAGES, send('POST', csrf, NEW_PAGE))
    expect(res.status).toBe(409)
    expect((await errorOf(res)).code).toBe('slug_taken')
    expect((await browser.fetch(PAGES, send('POST', csrf, '[1]'))).status).toBe(400)
    expect((await browser.fetch(PAGES, send('POST', csrf, '{bad'))).status).toBe(400)
  })

  it('unknown or malformed page id - 404 page_not_found; bad version - 404 version_not_found', async () => {
    const { browser, csrf } = await signedIn()
    for (const id of ['nope', '019a3c20-1a2b-7c3d-8e4f-5a6b7c8d9e0f']) {
      const res = await browser.fetch(`${PAGES}/${id}`)
      expect(res.status).toBe(404)
      expect((await errorOf(res)).code).toBe('page_not_found')
    }
    const page = await createPage(browser, csrf)
    for (const v of ['0', 'x', '99999999', '3']) {
      const res = await browser.fetch(`${PAGES}/${page.id}/versions/${v}`)
      expect(res.status).toBe(404)
      expect((await errorOf(res)).code).toBe('version_not_found')
    }
  })
})

describe('/api/builder - edit, publish, roll back', () => {
  const v1 = { title: 'Home', sections: [newSection('hero', 'h1')] }
  const v2 = { title: 'Home', sections: [{ ...newSection('hero', 'h1'), title: 'New headline' }] }

  it('publish a change, roll it back: the old version is live again', async () => {
    const { browser, csrf } = await signedIn()
    const page = await createPage(browser, csrf)
    const url = `${PAGES}/${page.id}`

    let res = await browser.fetch(`${url}/draft`, send('PUT', csrf, { revision: 1, content: v1 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ draftRevision: 2, changed: true })
    res = await browser.fetch(`${url}/publish`, send('POST', csrf, { revision: 2 }))
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ liveVersion: 1, changed: false })

    await browser.fetch(`${url}/draft`, send('PUT', csrf, { revision: 2, content: v2 }))
    res = await browser.fetch(`${url}/publish`, send('POST', csrf, { revision: 3 }))
    expect(await res.json()).toMatchObject({ liveVersion: 2 })

    res = await browser.fetch(`${url}/rollback`, send('POST', csrf, { version: 1 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ liveVersion: 1, changed: true })

    const detail = await (await browser.fetch(url)).json()
    expect(detail.liveVersion).toBe(1)
    expect(detail.versions.map((v: { version: number }) => v.version)).toEqual([2, 1])
    const live = await (await browser.fetch(`${url}/versions/${detail.liveVersion}`)).json()
    expect(live.content).toEqual(v1)

    const events = await (await browser.fetch(`${url}/events`)).json()
    expect(events.items.map((e: { type: string }) => e.type.split('.').at(-2))).toEqual([
      'rolled_back',
      'published',
      'published',
      'created'
    ])
  })

  it('stale revision - 409 draft_conflict; nothing new - 409 no_changes; live version - 409 already_live', async () => {
    const { browser, csrf } = await signedIn()
    const page = await createPage(browser, csrf)
    const url = `${PAGES}/${page.id}`
    await browser.fetch(`${url}/draft`, send('PUT', csrf, { revision: 1, content: v1 }))
    let res = await browser.fetch(`${url}/draft`, send('PUT', csrf, { revision: 1, content: v2 }))
    expect(res.status).toBe(409)
    expect((await errorOf(res)).code).toBe('draft_conflict')
    res = await browser.fetch(`${url}/publish`, send('POST', csrf, { revision: 1 }))
    expect((await errorOf(res)).code).toBe('draft_conflict')
    await browser.fetch(`${url}/publish`, send('POST', csrf, { revision: 2 }))
    res = await browser.fetch(`${url}/publish`, send('POST', csrf, { revision: 2 }))
    expect((await errorOf(res)).code).toBe('no_changes')
    res = await browser.fetch(`${url}/rollback`, send('POST', csrf, { version: 1 }))
    expect((await errorOf(res)).code).toBe('already_live')
    res = await browser.fetch(`${url}/rollback`, send('POST', csrf, { version: 7 }))
    expect(res.status).toBe(404)
    expect((await errorOf(res)).code).toBe('version_not_found')
  })

  it('bad content - 400 invalid_content with the field; bad revision - 400 invalid_request', async () => {
    const { browser, csrf } = await signedIn()
    const page = await createPage(browser, csrf)
    const url = `${PAGES}/${page.id}/draft`
    const bad = {
      title: 'Home',
      sections: [{ ...newSection('cta', 'c1'), cta: { label: 'x', href: 'javascript:alert(1)' } }]
    }
    let res = await browser.fetch(url, send('PUT', csrf, { revision: 1, content: bad }))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toEqual({ code: 'invalid_content', field: 'sections[0].cta.href' })
    for (const revision of [0, 1.5, '1', null]) {
      res = await browser.fetch(url, send('PUT', csrf, { revision, content: v1 }))
      expect(await errorOf(res)).toEqual({ code: 'invalid_request', field: 'revision' })
    }
    res = await browser.fetch(`${PAGES}/${page.id}/rollback`, send('POST', csrf, { version: -1 }))
    expect(await errorOf(res)).toEqual({ code: 'invalid_request', field: 'version' })
    expect((await db.query('select draft from builder_pages')).rows).toEqual([
      { draft: { title: 'Home', sections: [] } }
    ])
  })

  it('a body over the limit - 413 payload_too_large', async () => {
    const { browser, csrf } = await signedIn()
    const page = await createPage(browser, csrf)
    const res = await browser.fetch(
      `${PAGES}/${page.id}/draft`,
      send('PUT', csrf, { revision: 1, content: { title: 'x', pad: 'x'.repeat(MAX_BODY_BYTES) } })
    )
    expect(res.status).toBe(413)
    expect((await errorOf(res)).code).toBe('payload_too_large')
  })
})

describe('readBuilderConfig', () => {
  it('accepts postgres URLs and keeps the value', () => {
    expect(readBuilderConfig({ builder: { databaseUrl: ` ${SECRET_URL} ` } })).toEqual({
      databaseUrl: SECRET_URL
    })
    expect(
      readBuilderConfig({ builder: { databaseUrl: 'postgresql://db/studio' } }).databaseUrl
    ).toBe('postgresql://db/studio')
  })

  it.each([undefined, '', 'not a url', 'https://db/studio', 'postgres:///studio'])(
    'refuses %j and never names the value',
    (databaseUrl) => {
      expect(() => readBuilderConfig({ builder: { databaseUrl } })).toThrow(BuilderConfigError)
      try {
        readBuilderConfig({ builder: { databaseUrl } })
      } catch (err) {
        expect((err as Error).message).toContain('NUXT_BUILDER_DATABASE_URL')
        if (databaseUrl) expect((err as Error).message).not.toContain(databaseUrl)
      }
    }
  )
})

describe('/api/builder - unpublish, delete, copy into draft (synthwerk#108)', () => {
  async function livePage(browser: Browser, csrf: string) {
    const page = await createPage(browser, csrf)
    const content = { title: 'Home', sections: [newSection('hero', 'h1')] }
    let res = await browser.fetch(
      `${PAGES}/${page.id}/draft`,
      send('PUT', csrf, { revision: 1, content })
    )
    expect(res.status).toBe(200)
    res = await browser.fetch(`${PAGES}/${page.id}/publish`, send('POST', csrf, { revision: 2 }))
    expect(res.status).toBe(201)
    return page.id
  }

  const types = async (browser: Browser, id: string) =>
    (
      (await (await browser.fetch(`${PAGES}/${id}/events`)).json()) as { items: { type: string }[] }
    ).items.map((e) => e.type.replace('dev.synthwerk.studio.page.', ''))

  it('unpublish clears the live version and writes an event; a second time is 409 not_live', async () => {
    const { browser, csrf } = await signedIn()
    const id = await livePage(browser, csrf)
    const res = await browser.fetch(`${PAGES}/${id}/unpublish`, send('POST', csrf))
    expect(res.status).toBe(200)
    expect((await res.json()).liveVersion).toBeNull()
    expect((await types(browser, id))[0]).toBe('unpublished.v1')
    const again = await browser.fetch(`${PAGES}/${id}/unpublish`, send('POST', csrf))
    expect(again.status).toBe(409)
    expect((await errorOf(again)).code).toBe('not_live')
    const page = await (await browser.fetch(`${PAGES}/${id}`)).json()
    expect(page.versions).toHaveLength(1)
  })

  it('unpublish needs the CSRF token', async () => {
    const { browser, csrf } = await signedIn()
    const id = await livePage(browser, csrf)
    expect((await browser.fetch(`${PAGES}/${id}/unpublish`, send('POST', ''))).status).toBe(403)
  })

  it('copy puts a version into the draft with the revision; stale revision 409', async () => {
    const { browser, csrf } = await signedIn()
    const id = await livePage(browser, csrf)
    const content = { title: 'Other', sections: [] }
    await browser.fetch(`${PAGES}/${id}/draft`, send('PUT', csrf, { revision: 2, content }))
    const stale = await browser.fetch(
      `${PAGES}/${id}/versions/1/copy`,
      send('POST', csrf, { revision: 2 })
    )
    expect(stale.status).toBe(409)
    expect((await errorOf(stale)).code).toBe('draft_conflict')
    const res = await browser.fetch(
      `${PAGES}/${id}/versions/1/copy`,
      send('POST', csrf, { revision: 3 })
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ draftRevision: 4, title: 'Home', changed: false })
    expect((await types(browser, id))[0]).toBe('version_copied.v1')
    const missing = await browser.fetch(
      `${PAGES}/${id}/versions/9/copy`,
      send('POST', csrf, { revision: 4 })
    )
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('version_not_found')
    const bad = await browser.fetch(
      `${PAGES}/${id}/versions/0/copy`,
      send('POST', csrf, { revision: 4 })
    )
    expect(bad.status).toBe(404)
    const noRev = await browser.fetch(`${PAGES}/${id}/versions/1/copy`, send('POST', csrf, {}))
    expect((await errorOf(noRev)).field).toBe('revision')
  })

  it('delete: owner, slug confirms; page gone, event stays', async () => {
    const { browser, csrf } = await signedIn()
    const id = await livePage(browser, csrf)
    const wrong = await browser.fetch(`${PAGES}/${id}`, send('DELETE', csrf, { slug: 'other' }))
    expect(wrong.status).toBe(409)
    expect((await errorOf(wrong)).code).toBe('confirm_mismatch')
    const noSlug = await browser.fetch(`${PAGES}/${id}`, send('DELETE', csrf, {}))
    expect((await errorOf(noSlug)).field).toBe('slug')
    const res = await browser.fetch(`${PAGES}/${id}`, send('DELETE', csrf, { slug: 'home' }))
    expect(res.status).toBe(204)
    expect((await browser.fetch(`${PAGES}/${id}`)).status).toBe(404)
    const { rows } = await db.query<{ type: string; data: { slug: string } }>(
      'select type, data from builder_events where subject = $1 order by seq desc limit 1',
      [id]
    )
    expect(rows[0]?.type).toBe('dev.synthwerk.studio.page.deleted.v1')
    expect(rows[0]?.data.slug).toBe('home')
  })

  it('delete: the token says owner, identity says admin (stale claim) - 403, nothing deleted', async () => {
    const { browser, csrf, sub } = await signedIn()
    const id = await livePage(browser, csrf)
    identity.answers.set(`GET ${MEMBERS}`, {
      status: 200,
      body: {
        items: [
          { user_id: sub, role: 'admin', status: 'active', updated_at: '2026-10-30T09:00:00Z' }
        ]
      }
    })
    const res = await browser.fetch(`${PAGES}/${id}`, send('DELETE', csrf, { slug: 'home' }))
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe('owner_required')
    identity.answers.clear()
    expect((await browser.fetch(`${PAGES}/${id}`)).status).toBe(200)
  })

  it('delete: the caller is not on the members pages - 403 forbidden', async () => {
    const { browser, csrf } = await signedIn()
    const id = await livePage(browser, csrf)
    identity.answers.set(`GET ${MEMBERS}`, {
      status: 200,
      body: {
        items: [
          {
            user_id: 'someone',
            role: 'owner',
            status: 'active',
            updated_at: '2026-10-30T09:00:00Z'
          }
        ]
      }
    })
    const res = await browser.fetch(`${PAGES}/${id}`, send('DELETE', csrf, { slug: 'home' }))
    expect(res.status).toBe(403)
    identity.answers.clear()
    expect((await browser.fetch(`${PAGES}/${id}`)).status).toBe(200)
  })

  it('delete: the role read follows the members pages', async () => {
    const { browser, csrf, sub } = await signedIn()
    const id = await livePage(browser, csrf)
    let calls = 0
    const base = identity.fetch
    const paged = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/members') && (init?.method ?? 'GET') === 'GET') {
        calls++
        const first = !url.searchParams.get('cursor')
        const items = first
          ? [
              {
                user_id: 'other',
                role: 'member',
                status: 'active',
                updated_at: '2026-10-30T09:00:00Z'
              }
            ]
          : [{ user_id: sub, role: 'owner', status: 'active', updated_at: '2026-10-30T09:00:00Z' }]
        return new Response(JSON.stringify(first ? { items, next_cursor: 'p2' } : { items }), {
          status: 200
        })
      }
      return base(input, init)
    }) as typeof fetch
    const other = builderBrowser({ fetch: paged })
    for (const [k, v] of browser.cookies) other.cookies.set(k, v)
    const res = await other.fetch(`${PAGES}/${id}`, send('DELETE', csrf, { slug: 'home' }))
    expect(res.status).toBe(204)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('delete: an admin gets 403 owner_required, nothing deleted', async () => {
    provider.options = {
      accessClaims: { [ROLES_CLAIM]: { admin: { [ORG_ID]: 'demo.auth.localhost' } } }
    }
    const { browser, csrf } = await signedIn()
    const id = await livePage(browser, csrf)
    const res = await browser.fetch(`${PAGES}/${id}`, send('DELETE', csrf, { slug: 'home' }))
    expect(res.status).toBe(403)
    expect((await errorOf(res)).code).toBe('owner_required')
    expect((await browser.fetch(`${PAGES}/${id}`)).status).toBe(200)
    // An admin may unpublish and copy.
    expect((await browser.fetch(`${PAGES}/${id}/unpublish`, send('POST', csrf))).status).toBe(200)
  })
})

describe('/api/builder/leads (synthwerk#105)', () => {
  async function confirmedLead(email: string) {
    const store = new BuilderStore(db)
    const page = await store.createPage(
      ORG_ID,
      { actor: 'user:x', identityOrgId: ORG_UUID },
      {
        slug: `p${Math.random().toString(36).slice(2, 8)}`,
        locale: 'en',
        title: 'J'
      }
    )
    const r = await store.leads.submit({
      orgId: ORG_ID,
      page: { id: page.id, slug: page.slug, locale: 'en', version: 1 },
      sectionId: 'l1',
      email,
      name: '=HYPERLINK("x")',
      consentText: 'I agree, "really".'
    })
    if (r.mail) await store.leads.confirm(r.token)
  }

  it('lists confirmed leads of the session org; member gets 403', async () => {
    await confirmedLead('ada@example.com')
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/builder/leads')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.map((l: { email: string }) => l.email)).toEqual(['ada@example.com'])
    expect(body.next).toBeNull()
  })

  it('CSV export: attachment, header, quoted cells, formula guard', async () => {
    await confirmedLead('ada@example.com')
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/builder/leads/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="leads.csv"')
    const lines = (await res.text()).split('\r\n')
    expect(lines[0]).toBe(
      'email,name,page,locale,page_version,consent_text,created_at,confirmed_at'
    )
    expect(lines[1]).toContain('"ada@example.com","\'=HYPERLINK(""x"")"')
    expect(lines[1]).toContain('"I agree, ""really""."')
  })

  it('delete a lead: CSRF needed, 204, then 404', async () => {
    await confirmedLead('ada@example.com')
    const { browser, csrf } = await signedIn()
    const id = (await (await browser.fetch('/api/builder/leads')).json()).items[0].id
    expect((await browser.fetch(`/api/builder/leads/${id}`, send('DELETE', ''))).status).toBe(403)
    expect((await browser.fetch(`/api/builder/leads/${id}`, send('DELETE', csrf))).status).toBe(204)
    const again = await browser.fetch(`/api/builder/leads/${id}`, send('DELETE', csrf))
    expect(again.status).toBe(404)
    expect((await errorOf(again)).code).toBe('lead_not_found')
    expect(
      (await browser.fetch('/api/builder/leads/not-a-uuid', send('DELETE', csrf))).status
    ).toBe(404)
  })

  it('member role: 403 on the list and the export', async () => {
    provider.options = {
      accessClaims: { [ROLES_CLAIM]: { member: { [ORG_ID]: 'demo.auth.localhost' } } }
    }
    const { browser } = await signedIn()
    expect((await browser.fetch('/api/builder/leads')).status).toBe(403)
    expect((await browser.fetch('/api/builder/leads/export')).status).toBe(403)
  })
})

describe('csvCell', () => {
  it.each([
    ['plain', '"plain"'],
    ['=1+1', '"\'=1+1"'],
    ['+1', '"\'+1"'],
    ['-1', '"\'-1"'],
    ['@x', '"\'@x"'],
    ['\tx', '"\'\tx"'],
    ['a"b', '"a""b"'],
    [3, '"3"']
  ])('%j -> %s', (value, expected) => {
    expect(csvCell(value)).toBe(expected)
  })
})
