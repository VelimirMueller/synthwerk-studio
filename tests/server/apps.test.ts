// The app routes of the BFF (synthwerk#38): session and CSRF gate, the org lookup, the calls
// to identity with the session token, and how identity refusals reach the page.

import { readFileSync } from 'node:fs'
import { createApp, createError, createRouter, eventHandler, type H3Event, toWebHandler } from 'h3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AppsApi,
  appRoutes,
  type Fetch,
  IdentityError,
  readChange,
  runAppRoute,
  type SessionSource,
  toHttpError
} from '../../server/lib/apps'
import type { SessionRecord } from '../../server/lib/session'
import { defaultSettings } from '../../shared/widget'

const IDENTITY = 'http://identity.test'
const ORG = '0199f3a0-5b6c-7d8e-9f0a-1b2c3d4e5f60'
const APP = '019a3b10-7c2d-7e4f-8a5b-6c7d8e9f0a1b'
const TOKEN = 'access-token-of-the-session'
const CSRF = 'csrf-of-the-session'

const appBody = (over: Record<string, unknown> = {}) => ({
  id: APP,
  org_id: ORG,
  name: 'Shop',
  allowed_origins: ['https://shop.example'],
  widget_settings: defaultSettings(),
  created_at: '2026-10-29T10:00:00Z',
  updated_at: '2026-10-29T10:00:00Z',
  ...over
})

interface Call {
  method: string
  url: string
  auth: string | null
  body: unknown
}

/** A fake identity: records every call and answers from `answer`. */
function fakeIdentity(answer: (c: Call) => Response): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    if (call.url === `${IDENTITY}/v1/me`) return Response.json({ org: { id: ORG } })
    return answer(call)
  }) as Fetch
  return { fetch, calls }
}

const problem = (status: number, code: string, detail?: string) =>
  Response.json(
    { type: `x/${code}`, title: code, status, code, ...(detail ? { detail } : {}) },
    { status }
  )

function record(): SessionRecord {
  return {
    identity: {
      user: { sub: 'u1', name: 'U', username: 'u', email: '' },
      org: { id: 'z1', name: 'Acme', domain: '' },
      roles: [{ role: 'owner', orgIds: ['z1'] }],
      amr: []
    },
    tokens: { accessToken: TOKEN, expiresAt: 9e9 },
    csrf: CSRF,
    createdAt: 0,
    expiresAt: 9e9
  }
}

/** The routes of server/api/apps on an h3 app, with a fake session source. */
function harness(identity: ReturnType<typeof fakeIdentity>, signedIn = true) {
  const auth: SessionSource = {
    current: async () => (signedIn ? record() : null),
    assertCsrfToken(event: H3Event, r: SessionRecord) {
      if (event.headers.get('x-csrf-token') !== r.csrf) {
        throw createError({ statusCode: 403, data: { code: 'csrf_failed' } })
      }
    }
  }
  const api = new AppsApi(`${IDENTITY}/`, identity.fetch)
  const deps = { auth, api }
  // Same method, path and route name as the files in server/api/apps (checked below).
  const route = (name: keyof typeof appRoutes) => eventHandler((e) => runAppRoute(e, deps, name))
  const router = createRouter()
    .get('/api/apps', route('list'))
    .post('/api/apps', route('create'))
    .get('/api/apps/:appId', route('get'))
    .patch('/api/apps/:appId', route('update'))
    .delete(
      '/api/apps/:appId',
      eventHandler(async (e) => {
        await runAppRoute(e, deps, 'remove')
        return { deleted: true }
      })
    )
  const web = toWebHandler(createApp().use(router))
  return (path: string, init: RequestInit = {}) =>
    web(new Request(`http://localhost:3000${path}`, init))
}

const write = (method: string, body?: unknown, csrf = CSRF): RequestInit => ({
  method,
  headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
})

const codeOf = async (res: Response) =>
  ((await res.json()) as { data?: { code?: string } }).data?.code

let identity: ReturnType<typeof fakeIdentity>

beforeEach(() => {
  identity = fakeIdentity((c) => {
    if (c.method === 'GET' && c.url.includes('/apps?limit=100'))
      return Response.json({ items: [appBody()] })
    if (c.method === 'POST') return Response.json(appBody({ name: 'New' }), { status: 201 })
    if (c.method === 'DELETE') return new Response(null, { status: 204 })
    if (c.method === 'PATCH') {
      const b = c.body as { widget_settings?: unknown }
      return Response.json(appBody(b.widget_settings ? { widget_settings: b.widget_settings } : {}))
    }
    return Response.json(appBody())
  })
})

describe('session gate', () => {
  it('GET /api/apps - no session - 401 unauthenticated, identity not called', async () => {
    const res = await harness(identity, false)('/api/apps')
    expect(res.status).toBe(401)
    expect(await codeOf(res)).toBe('unauthenticated')
    expect(identity.calls).toHaveLength(0)
  })

  it('POST /api/apps - wrong CSRF token - 403 csrf_failed, identity not called', async () => {
    const res = await harness(identity)(
      '/api/apps',
      write('POST', { name: 'X', allowedOrigins: ['https://x.example'] }, 'forged')
    )
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('csrf_failed')
    expect(identity.calls).toHaveLength(0)
  })

  it('DELETE /api/apps/:id - no CSRF header - 403, nothing deleted', async () => {
    const res = await harness(identity)(`/api/apps/${APP}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect(identity.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
})

describe('calls to identity', () => {
  it('GET /api/apps - signed in - looks up the org with /v1/me, lists its apps with the session token', async () => {
    const res = await harness(identity)('/api/apps')
    expect(res.status).toBe(200)
    const apps = (await res.json()) as { id: string; allowedOrigins: string[] }[]
    expect(apps).toEqual([
      expect.objectContaining({ id: APP, allowedOrigins: ['https://shop.example'] })
    ])
    expect(identity.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${IDENTITY}/v1/me`,
      `GET ${IDENTITY}/v1/orgs/${ORG}/apps?limit=100`
    ])
    expect(identity.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true)
  })

  it('answers - never carry the access token', async () => {
    const res = await harness(identity)('/api/apps')
    expect(await res.text()).not.toContain(TOKEN)
  })

  it('POST /api/apps - name and origins - sent in the contract shape, name trimmed', async () => {
    const res = await harness(identity)(
      '/api/apps',
      write('POST', { name: '  New  ', allowedOrigins: [' https://new.example '] })
    )
    expect(res.status).toBe(200)
    const post = identity.calls.find((c) => c.method === 'POST')
    expect(post?.url).toBe(`${IDENTITY}/v1/orgs/${ORG}/apps`)
    expect(post?.body).toEqual({ name: 'New', allowed_origins: ['https://new.example'] })
  })

  it('PATCH /api/apps/:id - widget settings only - sends only widget_settings', async () => {
    const settings = {
      ...defaultSettings(),
      position: 'bottom-left',
      accent: 'lab',
      greeting: 'Hi'
    }
    const res = await harness(identity)(
      `/api/apps/${APP}`,
      write('PATCH', { widgetSettings: settings })
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { widgetSettings: unknown }).widgetSettings).toEqual(settings)
    const patch = identity.calls.find((c) => c.method === 'PATCH')
    expect(patch?.url).toBe(`${IDENTITY}/v1/orgs/${ORG}/apps/${APP}`)
    expect(patch?.body).toEqual({ widget_settings: settings })
  })

  it('DELETE /api/apps/:id - with CSRF - identity DELETE with the session token', async () => {
    const res = await harness(identity)(`/api/apps/${APP}`, write('DELETE'))
    expect(res.status).toBe(200)
    expect(identity.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${IDENTITY}/v1/orgs/${ORG}/apps/${APP}`,
      auth: `Bearer ${TOKEN}`
    })
  })

  it('GET /api/apps/:id - id is not a UUID - 404, no path reaches identity', async () => {
    const res = await harness(identity)('/api/apps/..%2F..%2Fv1%2Fme')
    expect(res.status).toBe(404)
    expect(identity.calls.map((c) => c.url)).toEqual([`${IDENTITY}/v1/me`])
  })
})

describe('refusals', () => {
  it.each([
    ['empty name', { name: ' ', allowedOrigins: ['https://x.example'] }],
    ['no origins', { name: 'X', allowedOrigins: [] }],
    ['21 origins', { name: 'X', allowedOrigins: Array(21).fill('https://x.example') }],
    ['origin not a string', { name: 'X', allowedOrigins: [3] }],
    ['blank origin line', { name: 'X', allowedOrigins: ['https://x.example', '   '] }]
  ])('POST /api/apps - %s - 400 invalid_request, identity gets no POST', async (_n, body) => {
    const res = await harness(identity)('/api/apps', write('POST', body))
    expect(res.status).toBe(400)
    expect(await codeOf(res)).toBe('invalid_request')
    expect(identity.calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it.each([
    ['empty body', {}],
    ['free colour', { widgetSettings: { ...defaultSettings(), accent: '#f0f' } }],
    ['long greeting', { widgetSettings: { ...defaultSettings(), greeting: 'a'.repeat(281) } }]
  ])('PATCH /api/apps/:id - %s - 400 invalid_request', async (_n, body) => {
    const res = await harness(identity)(`/api/apps/${APP}`, write('PATCH', body))
    expect(res.status).toBe(400)
    expect(identity.calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('POST /api/apps - identity says app_limit_reached - 403 with the code and the detail', async () => {
    const id = fakeIdentity(() =>
      problem(403, 'app_limit_reached', 'The plan of this org allows 3 apps.')
    )
    const res = await harness(id)(
      '/api/apps',
      write('POST', { name: 'X', allowedOrigins: ['https://x.example'] })
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { data: { code: string; detail: string } }
    expect(body.data).toEqual({
      code: 'app_limit_reached',
      detail: 'The plan of this org allows 3 apps.'
    })
  })

  it('identity 500 - 502 upstream code, no identity body', async () => {
    const id = fakeIdentity(() => new Response('stack trace', { status: 500 }))
    const res = await harness(id)('/api/apps')
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('stack trace')
  })

  it('identity down - 502 upstream_unavailable', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as Fetch
    const res = await harness({ fetch: down, calls: [] })('/api/apps')
    expect(res.status).toBe(502)
    expect(await codeOf(res)).toBe('upstream_unavailable')
  })

  it('identity answers an app without an id - 502, never passed through', async () => {
    const id = fakeIdentity(() => Response.json({ items: [appBody({ id: 3 })] }))
    const res = await harness(id)('/api/apps')
    expect(res.status).toBe(502)
  })

  it('identity sends an unknown setting value - read as its default, the app stays readable', async () => {
    const id = fakeIdentity(() =>
      Response.json({ items: [appBody({ widget_settings: { accent: 'neon', mode: 'dark' } })] })
    )
    const res = await harness(id)('/api/apps')
    const [app] = (await res.json()) as { widgetSettings: Record<string, string> }[]
    expect(app?.widgetSettings).toEqual({ ...defaultSettings(), mode: 'dark' })
  })

  it('/v1/me without an org - 502', async () => {
    const fetch = (async () => Response.json({ org: {} })) as Fetch
    await expect(new AppsApi(IDENTITY, fetch).orgId(TOKEN)).rejects.toBeInstanceOf(IdentityError)
  })

  it('toHttpError - identity 401 stays 401, unknown error becomes 502', () => {
    expect(toHttpError(new IdentityError(401, 'unauthenticated')).statusCode).toBe(401)
    expect(toHttpError(new Error('boom')).statusCode).toBe(502)
  })

  it('readChange - name and origins - both read', () => {
    expect(readChange({ name: ' A ', allowedOrigins: ['https://a.example'] })).toEqual({
      name: 'A',
      allowedOrigins: ['https://a.example']
    })
  })
})

describe('list paging', () => {
  it('GET /api/apps - two identity pages - follows next_cursor, returns both pages', async () => {
    const second = '019a3b10-7c2d-7e4f-8a5b-6c7d8e9f0a1c'
    const id = fakeIdentity((c) =>
      c.url.includes('cursor=c1')
        ? Response.json({ items: [appBody({ id: second })] })
        : Response.json({ items: [appBody()], next_cursor: 'c1' })
    )
    const res = await harness(id)('/api/apps')
    const apps = (await res.json()) as { id: string }[]
    expect(apps.map((a) => a.id)).toEqual([APP, second])
    expect(id.calls.at(-1)?.url).toBe(`${IDENTITY}/v1/orgs/${ORG}/apps?limit=100&cursor=c1`)
  })
})

describe('route files', () => {
  it.each([
    ['index.get.ts', 'list'],
    ['index.post.ts', 'create'],
    ['[appId].get.ts', 'get'],
    ['[appId].patch.ts', 'update'],
    ['[appId].delete.ts', 'remove']
  ])('server/api/apps/%s - runs appRoutes.%s, the route this harness tests', (file, name) => {
    const src = readFileSync(new URL(`../../server/api/apps/${file}`, import.meta.url), 'utf8')
    expect(src).toContain(`appRoute(event, '${name}')`)
  })

  it('appRoutes - every write route needs the CSRF token, reads do not', () => {
    expect(Object.entries(appRoutes).map(([k, r]) => [k, r.write])).toEqual([
      ['list', false],
      ['create', true],
      ['get', false],
      ['update', true],
      ['remove', true]
    ])
  })
})
