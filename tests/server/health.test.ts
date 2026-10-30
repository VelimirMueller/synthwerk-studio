// Scope test per role for the health view BFF (synthwerk#40): the browser reaches pulse only
// through these routes, and an org admin never gets the numbers of another org.
import { createApp, createRouter, eventHandler, getRequestHeader, toWebHandler } from 'h3'
import { beforeEach, describe, expect, it } from 'vitest'
import type { StudioIdentity, StudioRole } from '../../server/lib/claims'
import { HealthService, healthScope } from '../../server/lib/health'
import type { SessionRecord } from '../../server/lib/session'

const PULSE = 'http://pulse.test:8080'
const NOW = Date.UTC(2026, 9, 30, 8, 0, 0)

function identity(org: string, roles: StudioRole[]): StudioIdentity {
  return {
    user: { sub: `user-${org}`, name: 'Test', username: 'test', email: 't@example.test' },
    org: { id: org, name: org, domain: `${org}.test` },
    roles,
    amr: []
  }
}

const sessions: Record<string, StudioIdentity> = {
  member: identity('org-a', [{ role: 'member', orgIds: ['org-a'] }]),
  admin: identity('org-a', [{ role: 'admin', orgIds: ['org-a'] }]),
  owner: identity('org-a', [{ role: 'owner', orgIds: ['org-a'] }]),
  // Admin by grant in org-b, but the session acts in org-a.
  crossAdmin: identity('org-a', [
    { role: 'admin', orgIds: ['org-b'] },
    { role: 'member', orgIds: ['org-a'] }
  ]),
  operator: identity('org-platform', [{ role: 'operator', orgIds: ['org-platform'] }]),
  // Operator grant outside the platform org: pulse refuses /v1/metrics.
  fakeOperator: identity('org-a', [{ role: 'operator', orgIds: ['org-a'] }]),
  fakeOperatorAdmin: identity('org-a', [
    { role: 'operator', orgIds: ['org-a'] },
    { role: 'admin', orgIds: ['org-a'] }
  ])
}

const record = (who: string): SessionRecord => ({
  identity: sessions[who] as StudioIdentity,
  tokens: { accessToken: `token-${who}`, expiresAt: NOW / 1000 + 600 },
  csrf: 'csrf',
  createdAt: NOW / 1000,
  expiresAt: NOW / 1000 + 3600
})

interface PulseCall {
  path: string
  authorization: string
}

/** A fake pulse with the same rules as synthwerk-pulse internal/app.API. */
function fakePulse(calls: PulseCall[], state: { down: boolean }): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    const authorization = new Headers(init?.headers).get('authorization') ?? ''
    calls.push({ path: url.pathname, authorization })
    if (state.down) throw new TypeError('fetch failed')
    const who = authorization.replace('Bearer token-', '')
    const id = sessions[who]
    if (!id) return new Response('{}', { status: 401 })
    const has = (role: string, org: string) =>
      id.roles.some((r) => r.role === role && r.orgIds.includes(org))
    const operator = has('operator', 'org-platform')
    const orgAdmin = (org: string) => org === id.org.id && (has('owner', org) || has('admin', org))
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    const forbidden = () => new Response('{"code":"forbidden"}', { status: 403 })

    if (url.pathname === '/v1/health' || url.pathname === '/v1/health/stream') {
      if (!operator && !orgAdmin(id.org.id)) return forbidden()
      if (url.pathname === '/v1/health') return json({ targets: [{ target: 'llm', status: 'ok' }] })
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'retry: 3000\n\nid: 0\nevent: snapshot\ndata: {"targets":[]}\n\n'
            )
          )
          c.close()
        }
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.pathname === '/v1/metrics') {
      return operator ? json({ window_seconds: 300, host: {}, ai: { answers: 9 } }) : forbidden()
    }
    const m = url.pathname.match(/^\/v1\/orgs\/([^/]+)\/metrics$/)
    if (m) {
      const org = decodeURIComponent(m[1] ?? '')
      if (!operator && !orgAdmin(org)) return forbidden()
      return json({ org_id: org, ai: { answers: org === 'org-a' ? 1 : 7 } })
    }
    return new Response('not found', { status: 404 })
  }
}

let calls: PulseCall[]
let state: { down: boolean }
let baseUrl: string

function handler() {
  const health = new HealthService(
    {
      // The test session comes from a header; the real one from the session cookie.
      current: async (event) => {
        const who = getRequestHeader(event, 'x-test-session')
        return who && sessions[who] ? record(who) : null
      }
    },
    { baseUrl, fetch: fakePulse(calls, state), now: () => NOW }
  )
  const router = createRouter()
    .get(
      '/api/health/status',
      eventHandler((e) => health.status(e))
    )
    .get(
      '/api/health/metrics',
      eventHandler((e) => health.metrics(e))
    )
    .get(
      '/api/health/stream',
      eventHandler((e) => health.stream(e))
    )
  return toWebHandler(createApp().use(router))
}

async function get(path: string, who?: string) {
  const headers = new Headers()
  if (who) headers.set('x-test-session', who)
  const res = await handler()(new Request(`http://localhost:3000${path}`, { headers }))
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text)
  } catch {}
  return { status: res.status, body, text, res }
}

beforeEach(() => {
  calls = []
  state = { down: false }
  baseUrl = PULSE
})

describe('healthScope', () => {
  it('healthScope - each role - platform, org or none', () => {
    expect(healthScope(sessions.operator as StudioIdentity)).toBe('platform')
    expect(healthScope(sessions.admin as StudioIdentity)).toBe('org')
    expect(healthScope(sessions.owner as StudioIdentity)).toBe('org')
    expect(healthScope(sessions.member as StudioIdentity)).toBeNull()
    expect(healthScope(sessions.crossAdmin as StudioIdentity)).toBeNull()
  })
})

describe('scope per role', () => {
  it('GET /api/health/status - no session - 401, pulse not called', async () => {
    const { status, body } = await get('/api/health/status')
    expect(status).toBe(401)
    expect(body.data).toEqual({ code: 'unauthenticated' })
    expect(calls).toEqual([])
  })

  it('GET /api/health/status - member - 403, pulse not called', async () => {
    const { status, body } = await get('/api/health/status', 'member')
    expect(status).toBe(403)
    expect(body.data).toEqual({ code: 'forbidden' })
    expect(calls).toEqual([])
  })

  it('GET /api/health/status - admin grant in another org only - 403', async () => {
    expect((await get('/api/health/status', 'crossAdmin')).status).toBe(403)
    expect(calls).toEqual([])
  })

  it('GET /api/health/status - org admin - status with the session token', async () => {
    const { status, body } = await get('/api/health/status', 'admin')
    expect(status).toBe(200)
    expect(body).toEqual({ targets: [{ target: 'llm', status: 'ok' }] })
    expect(calls).toEqual([{ path: '/v1/health', authorization: 'Bearer token-admin' }])
  })

  it('GET /api/health/metrics - org admin - own org only, never the platform numbers', async () => {
    const { status, body, text } = await get('/api/health/metrics?org=org-b', 'admin')
    expect(status).toBe(200)
    expect(body).toEqual({ scope: 'org', metrics: { org_id: 'org-a', ai: { answers: 1 } } })
    expect(calls.map((c) => c.path)).toEqual(['/v1/orgs/org-a/metrics'])
    expect(text).not.toContain('token-')
  })

  it('GET /api/health/metrics - org owner - own org', async () => {
    const { body } = await get('/api/health/metrics', 'owner')
    expect(body.scope).toBe('org')
    expect(calls.map((c) => c.path)).toEqual(['/v1/orgs/org-a/metrics'])
  })

  it('GET /api/health/metrics - operator - platform numbers', async () => {
    const { status, body } = await get('/api/health/metrics', 'operator')
    expect(status).toBe(200)
    expect(body.scope).toBe('platform')
    expect(calls.map((c) => c.path)).toEqual(['/v1/metrics'])
  })

  it('GET /api/health/metrics - operator grant outside the platform org - 403', async () => {
    const { status } = await get('/api/health/metrics', 'fakeOperator')
    expect(status).toBe(403)
    expect(calls.map((c) => c.path)).toEqual(['/v1/metrics'])
  })

  it('GET /api/health/metrics - false operator who is org admin - falls back to the own org', async () => {
    const { status, body } = await get('/api/health/metrics', 'fakeOperatorAdmin')
    expect(status).toBe(200)
    expect(body).toEqual({ scope: 'org', metrics: { org_id: 'org-a', ai: { answers: 1 } } })
    expect(calls.map((c) => c.path)).toEqual(['/v1/metrics', '/v1/orgs/org-a/metrics'])
  })

  it('GET /api/health/metrics - member - 403, pulse not called', async () => {
    expect((await get('/api/health/metrics', 'member')).status).toBe(403)
    expect(calls).toEqual([])
  })
})

describe('stream', () => {
  it('GET /api/health/stream - org admin - pulse events passed through as SSE', async () => {
    const { status, text, res } = await get('/api/health/stream', 'admin')
    expect(status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(text).toContain('event: snapshot')
    expect(calls).toEqual([{ path: '/v1/health/stream', authorization: 'Bearer token-admin' }])
  })

  it('GET /api/health/stream - member - 403, pulse not called', async () => {
    expect((await get('/api/health/stream', 'member')).status).toBe(403)
    expect(calls).toEqual([])
  })

  it('GET /api/health/stream - pulse down - 502', async () => {
    state.down = true
    const { status, body } = await get('/api/health/stream', 'operator')
    expect(status).toBe(502)
    expect(body.data).toEqual({ code: 'pulse_unavailable' })
  })
})

describe('pulse errors', () => {
  it('GET /api/health/status - pulse down - 502 pulse_unavailable', async () => {
    state.down = true
    const { status, body } = await get('/api/health/status', 'operator')
    expect(status).toBe(502)
    expect(body.data).toEqual({ code: 'pulse_unavailable' })
  })

  it('GET /api/health/status - no pulse URL - 503 pulse_not_configured', async () => {
    baseUrl = ''
    const { status, body } = await get('/api/health/status', 'operator')
    expect(status).toBe(503)
    expect(body.data).toEqual({ code: 'pulse_not_configured' })
    expect(calls).toEqual([])
  })

  it('GET /api/health/status - pulse answers 500 - 502', async () => {
    const health = new HealthService(
      { current: async () => record('operator') },
      { baseUrl, fetch: async () => new Response('boom', { status: 500 }) }
    )
    const app = createApp().use(
      createRouter().get(
        '/s',
        eventHandler((e) => health.status(e))
      )
    )
    const res = await toWebHandler(app)(new Request('http://localhost:3000/s'))
    expect(res.status).toBe(502)
    expect((await res.json()).data).toEqual({ code: 'pulse_unavailable' })
  })
})
