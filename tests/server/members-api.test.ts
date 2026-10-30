// The /api/org routes on an h3 app: same wiring as server/api/org and server/middleware/csrf.ts,
// with the real AuthService (mock OIDC provider) and a fake identity.
import { createApp, createRouter, eventHandler, toWebHandler } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { IdentityConfigError, readIdentityConfig } from '../../server/lib/identity-config'
import { MembersApi, type MembersApiDeps } from '../../server/lib/members-api'
import { SESSION_COOKIE, type SessionRecord, sessionKey } from '../../server/lib/session'
import { Browser, buildApp, type Harness, ORIGIN, signIn } from '../support/app'
import { FakeIdentity, IDENTITY_URL, INVITATION_ID, ORG_UUID, problem } from '../support/identity'
import { MockProvider } from '../support/provider'

const provider = new MockProvider()
const ORG = `/v1/orgs/${ORG_UUID}`

let harness: Harness
let identity: FakeIdentity
let logs: string[]

beforeAll(async () => {
  await provider.start()
})
afterAll(() => provider.stop())

beforeEach(() => {
  provider.options = {}
  harness = buildApp(provider)
  identity = new FakeIdentity()
  logs = []
})

/** A browser with the org routes and the auth routes on one origin. */
function orgBrowser(identityConfig: MembersApiDeps['identity'] = config()) {
  const api = new MembersApi({
    auth: harness.service,
    identity: identityConfig,
    fetch: identity.fetch,
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
      '/api/org/members',
      eventHandler((e) => api.listMembers(e))
    )
    .post(
      '/api/org/members',
      eventHandler((e) => api.invite(e))
    )
    .patch(
      '/api/org/members/:userId',
      eventHandler((e) => api.changeRole(e))
    )
    .post(
      '/api/org/members/:userId/deactivate',
      eventHandler((e) => api.deactivate(e))
    )
    .post(
      '/api/org/members/:userId/reactivate',
      eventHandler((e) => api.reactivate(e))
    )
    .get(
      '/api/org/invitations',
      eventHandler((e) => api.listInvitations(e))
    )
    .delete(
      '/api/org/invitations/:invitationId',
      eventHandler((e) => api.revokeInvitation(e))
    )
    .get(
      '/api/org/audit-events',
      eventHandler((e) => api.listAuditEvents(e))
    )
  app.use(router)
  const web = toWebHandler(app)
  return new Browser({ ...harness, handle: (request) => web(request) })
}

const config = () => readIdentityConfig({ identity: { url: IDENTITY_URL } })

/** Signs in on the auth harness and gives an org browser with that session and its CSRF token. */
async function signedIn(identityConfig?: MembersApiDeps['identity']) {
  const auth = new Browser(harness)
  await signIn(auth, provider)
  const browser = orgBrowser(identityConfig)
  for (const [k, v] of auth.cookies) browser.cookies.set(k, v)
  const session = await (await browser.fetch('/api/auth/session')).json()
  const id = browser.cookies.get(SESSION_COOKIE) ?? ''
  const record = harness.store.data.get(sessionKey(id)) as SessionRecord
  identity.token = record.tokens.accessToken
  return { browser, csrf: session.csrfToken as string }
}

const json = (csrf: string, body?: unknown, extra: Record<string, string> = {}) => ({
  headers: {
    origin: ORIGIN,
    'content-type': 'application/json',
    'x-csrf-token': csrf,
    ...extra
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
})

const code = async (res: Response) =>
  ((await res.json()) as { data?: { code?: string } }).data?.code

describe('/api/org - session and CSRF', () => {
  it('GET members - no session - 401 unauthenticated, identity not called', async () => {
    const res = await orgBrowser().fetch('/api/org/members')
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('unauthenticated')
    expect(identity.calls).toHaveLength(0)
  })

  it('POST members - no session - 401 before the CSRF check', async () => {
    const res = await orgBrowser().fetch('/api/org/members', {
      method: 'POST',
      ...json('', { email: 'ada@example.com', role: 'member' })
    })
    expect(res.status).toBe(401)
  })

  it('POST members - no x-csrf-token - 403 csrf_failed, identity not called', async () => {
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/org/members', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', role: 'member' })
    })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('csrf_failed')
    expect(identity.calls).toHaveLength(0)
  })

  it('PATCH member - wrong x-csrf-token - 403', async () => {
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/org/members/user-2', {
      method: 'PATCH',
      ...json('wrong', { role: 'admin' })
    })
    expect(res.status).toBe(403)
    expect(identity.calls).toHaveLength(0)
  })

  it('POST deactivate - other origin - 403 from the same-origin guard', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/org/members/user-2/deactivate', {
      method: 'POST',
      ...json(csrf, undefined, { origin: 'https://evil.test' })
    })
    expect(res.status).toBe(403)
    expect(identity.calls).toHaveLength(0)
  })
})

describe('/api/org - happy paths', () => {
  it('GET members - passes the page and the cursor, with the session access token', async () => {
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/org/members?cursor=MTI')
    expect(res.status).toBe(200)
    const page = await res.json()
    expect(page.items).toHaveLength(2)
    expect(page.next_cursor).toBe('MTI')
    expect(identity.work[0]).toMatchObject({
      method: 'GET',
      path: `${ORG}/members`,
      search: '?cursor=MTI',
      authorization: `Bearer ${identity.token}`
    })
  })

  it('POST members - invite - 202 with the pending invitation, identity got email and role', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/org/members', {
      method: 'POST',
      ...json(csrf, { email: 'ada@example.com', role: 'member' })
    })
    expect(res.status).toBe(202)
    expect((await res.json()).id).toBe(INVITATION_ID)
    expect(identity.work).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: `${ORG}/members`,
        body: { email: 'ada@example.com', role: 'member' }
      })
    ])
  })

  it('GET invitations - the page passes, cursor forwarded', async () => {
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/org/invitations?cursor=MTE')
    expect(res.status).toBe(200)
    const page = await res.json()
    expect(page.items[0].email).toBe('ada@example.com')
    expect(identity.work).toEqual([
      expect.objectContaining({ method: 'GET', path: `${ORG}/invitations`, search: '?cursor=MTE' })
    ])
  })

  it('DELETE invitation - revoke - 204, identity got the DELETE', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch(`/api/org/invitations/${INVITATION_ID}`, {
      method: 'DELETE',
      ...json(csrf)
    })
    expect(res.status).toBe(204)
    expect(identity.work).toEqual([
      expect.objectContaining({ method: 'DELETE', path: `${ORG}/invitations/${INVITATION_ID}` })
    ])
  })

  it('DELETE invitation - no CSRF token - 403, identity not called', async () => {
    const { browser } = await signedIn()
    const res = await browser.fetch(`/api/org/invitations/${INVITATION_ID}`, {
      method: 'DELETE',
      ...json('')
    })
    expect(res.status).toBe(403)
    expect(identity.work).toEqual([])
  })

  it('POST members - identity says 429 - 429 rate_limited with Retry-After', async () => {
    identity.answers.set(`POST ${ORG}/members`, {
      ...problem(429, 'rate_limited'),
      headers: { 'retry-after': '120' }
    })
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/org/members', {
      method: 'POST',
      ...json(csrf, { email: 'ada@example.com', role: 'member' })
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('120')
    expect(await code(res)).toBe('rate_limited')
  })

  it('PATCH member - role change - identity got the role', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/org/members/user-2', {
      method: 'PATCH',
      ...json(csrf, { role: 'admin' })
    })
    expect(res.status).toBe(200)
    expect((await res.json()).role).toBe('admin')
    expect(identity.work[0]).toMatchObject({
      method: 'PATCH',
      path: `${ORG}/members/user-2`,
      body: { role: 'admin' }
    })
  })

  it('POST deactivate and reactivate - call the colon actions', async () => {
    const { browser, csrf } = await signedIn()
    const off = await browser.fetch('/api/org/members/user-2/deactivate', {
      method: 'POST',
      ...json(csrf)
    })
    expect((await off.json()).status).toBe('deactivated')
    const on = await browser.fetch('/api/org/members/user-2/reactivate', {
      method: 'POST',
      ...json(csrf)
    })
    expect((await on.json()).status).toBe('active')
    expect(identity.work.map((c) => c.path)).toEqual([
      `${ORG}/members/user-2:deactivate`,
      `${ORG}/members/user-2:reactivate`
    ])
  })

  it('GET audit-events - passes the page', async () => {
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/org/audit-events')
    expect(res.status).toBe(200)
    const page = await res.json()
    expect(page.items[0].type).toBe('dev.synthwerk.identity.member.role_changed.v1')
    expect(page.next_cursor).toBeUndefined()
  })
})

describe('/api/org - errors', () => {
  it('identity 409 last_owner - passes status and code, no upstream detail, no token', async () => {
    identity.answers.set(`POST ${ORG}/members/user-1:deactivate`, problem(409, 'last_owner'))
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/org/members/user-1/deactivate', {
      method: 'POST',
      ...json(csrf)
    })
    expect(res.status).toBe(409)
    const text = await res.text()
    expect(JSON.parse(text).data).toEqual({ code: 'last_owner' })
    expect(text).not.toContain('secret upstream detail')
    expect(text).not.toContain(identity.token)
  })

  it('identity 403 - passes forbidden', async () => {
    identity.answers.set(`GET ${ORG}/audit-events`, problem(403, 'forbidden'))
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/org/audit-events')
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('forbidden')
  })

  it('identity down - 502 upstream_unavailable and a log line without the token', async () => {
    identity.down = true
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/org/members')
    expect(res.status).toBe(502)
    expect(await code(res)).toBe('upstream_unavailable')
    expect(logs).toEqual(['warn: identity call failed: identity is not reachable'])
    expect(logs.join()).not.toContain(identity.token)
  })

  it('invite with a bad email - 400 invalid_request, identity not called, email not logged', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/org/members', {
      method: 'POST',
      ...json(csrf, { email: 'nope', role: 'member' })
    })
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('invalid_request')
    expect(identity.calls).toHaveLength(0)
    expect(logs).toEqual([])
  })

  it('invite with a non-object body - 400', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/org/members', {
      method: 'POST',
      ...json(csrf, ['ada@example.com'])
    })
    expect(res.status).toBe(400)
  })

  it('invite with broken JSON - 400 invalid_request', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/org/members', {
      method: 'POST',
      headers: json(csrf).headers,
      body: '{"email":'
    })
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('invalid_request')
  })

  it('PATCH with role operator - 400, identity not called', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/org/members/user-2', {
      method: 'PATCH',
      ...json(csrf, { role: 'operator' })
    })
    expect(res.status).toBe(400)
    expect(identity.calls).toHaveLength(0)
  })

  it('identity not configured - signed in - 503 identity_not_configured with the variable name', async () => {
    const missing = (() => {
      try {
        return readIdentityConfig({})
      } catch (err) {
        return err as IdentityConfigError
      }
    })()
    expect(missing).toBeInstanceOf(IdentityConfigError)
    const { browser } = await signedIn(missing)
    const res = await browser.fetch('/api/org/members')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.data.code).toBe('identity_not_configured')
    expect(body.data.message).toContain('NUXT_IDENTITY_URL')
    // Sign-in keeps working.
    expect((await browser.fetch('/api/auth/session')).status).toBe(200)
  })

  it('other errors - are not swallowed', async () => {
    const api = new MembersApi({
      auth: {
        current: async () => {
          throw new Error('store down')
        },
        assertCsrfToken: () => undefined
      },
      identity: config()
    })
    const app = createApp()
    app.use(
      '/x',
      eventHandler((e) => api.listMembers(e))
    )
    const res = await toWebHandler(app)(new Request(`${ORIGIN}/x`))
    expect(res.status).toBe(500)
  })
})
