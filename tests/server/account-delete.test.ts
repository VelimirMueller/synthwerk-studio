// Delete account (synthwerk#41): step-up sign-in (prompt=login, max_age=0), then DELETE /api/me,
// which calls identity with the access token and the fresh ID token. Real AuthService against
// the mock provider, identity as a fetch stub.
import { createApp, createRouter, eventHandler, toWebHandler } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountApi, ID_TOKEN_HEADER } from '../../server/lib/account-api'
import { IdentityConfigError, readIdentityConfig } from '../../server/lib/identity-config'
import { SESSION_COOKIE, type SessionRecord, sessionKey } from '../../server/lib/session'
import { Browser, buildApp, type Harness, ORIGIN, signIn } from '../support/app'
import { IDENTITY_URL } from '../support/identity'
import { MockProvider } from '../support/provider'

const provider = new MockProvider()
let harness: Harness
let calls: { method: string; url: string; authorization: string; idToken: string }[]
let answer: { status: number; body?: unknown } | 'down'

beforeAll(async () => {
  await provider.start()
})
afterAll(() => provider.stop())
beforeEach(() => {
  provider.options = {}
  provider.ended.length = 0
  provider.revoked.length = 0
  harness = buildApp(provider)
  calls = []
  answer = {
    status: 202,
    body: {
      user_id: 'user-1',
      status: 'accepted',
      requested_at: '2026-10-30T10:00:00Z',
      deleted_org_ids: ['019a3c20-1a2b-7c3d-8e4f-5a6b7c8d9e0f']
    }
  }
})

const identityFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  calls.push({
    method: init.method ?? 'GET',
    url: String(input),
    authorization: headers.get('authorization') ?? '',
    idToken: headers.get(ID_TOKEN_HEADER) ?? ''
  })
  if (answer === 'down') throw new TypeError('fetch failed')
  return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'content-type': 'application/json' }
  })
}

type Deps = ConstructorParameters<typeof AccountApi>[0]

function browser(identity: Deps['identity'] = config(), extra: Partial<Deps> = {}) {
  const api = new AccountApi({ auth: harness.service, identity, fetch: identityFetch, ...extra })
  const app = createApp()
  app.use(
    eventHandler((event) => {
      if (event.path.startsWith('/api/')) harness.service.assertSameOrigin(event)
    })
  )
  app.use(
    createRouter()
      .get(
        '/api/auth/login',
        eventHandler((e) => harness.service.login(e))
      )
      .get(
        '/api/auth/reauth',
        eventHandler((e) => harness.service.reauth(e))
      )
      .get(
        '/api/auth/callback',
        eventHandler((e) => harness.service.callback(e))
      )
      .get(
        '/api/auth/session',
        eventHandler((e) => harness.service.session(e))
      )
      .delete(
        '/api/me',
        eventHandler((e) => api.deleteAccount(e))
      )
  )
  const web = toWebHandler(app)
  return new Browser({ ...harness, handle: (r) => web(r) })
}

const config = () => readIdentityConfig({ identity: { url: IDENTITY_URL } })

async function sessionBody(b: Browser) {
  return (await b.fetch('/api/auth/session')).json()
}

/** Sign in, then the step-up sign-in as `sub`. Returns the step-up callback response. */
async function stepUp(b: Browser, sub = 'user-1') {
  await signIn(b, provider)
  const reauth = await b.fetch('/api/auth/reauth?purpose=delete_account')
  const authorize = reauth.headers.get('location') ?? ''
  const { code, state } = provider.issueCode(authorize, sub)
  const callback = await b.fetch(`/api/auth/callback?code=${code}&state=${state}`)
  return { reauth, authorize, callback, code }
}

async function del(b: Browser, csrf?: string) {
  const token = csrf ?? (await sessionBody(b)).csrfToken
  return b.fetch('/api/me', {
    method: 'DELETE',
    headers: { origin: ORIGIN, 'x-csrf-token': token }
  })
}

function record(b: Browser): SessionRecord {
  return harness.store.data.get(sessionKey(b.cookies.get(SESSION_COOKIE) ?? '')) as SessionRecord
}

describe('step-up sign-in', () => {
  it('GET /api/auth/reauth - signed in - authorize with prompt=login and max_age=0', async () => {
    const b = browser()
    const { reauth, code } = await stepUp(b)
    expect(reauth.status).toBe(302)
    const q = new URL(reauth.headers.get('location') ?? '').searchParams
    expect(q.get('prompt')).toBe('login')
    expect(q.get('max_age')).toBe('0')
    expect(code).toBeTruthy()
  })

  it('GET /api/auth/login - normal sign-in - no prompt and no max_age', async () => {
    const b = browser()
    const res = await b.fetch('/api/auth/login')
    const q = new URL(res.headers.get('location') ?? '').searchParams
    expect(q.has('prompt')).toBe(false)
    expect(q.has('max_age')).toBe(false)
  })

  it('GET /api/auth/reauth - no session - back to the start page with login_expired', async () => {
    const res = await browser().fetch('/api/auth/reauth?purpose=delete_account')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?error=login_expired')
  })

  it('GET /api/auth/reauth - unknown purpose - 400', async () => {
    const b = browser()
    await signIn(b, provider)
    const res = await b.fetch('/api/auth/reauth?purpose=transfer_money')
    expect(res.status).toBe(400)
  })

  it('callback - fresh auth_time, same user - /me?delete=confirm and the session shows the step-up', async () => {
    const b = browser()
    const { callback } = await stepUp(b)
    expect(callback.headers.get('location')).toBe('/me?delete=confirm')
    const s = await sessionBody(b)
    expect(s.stepUp.purpose).toBe('delete_account')
    expect(Date.parse(s.stepUp.until) - harness.clock.now).toBeGreaterThan(290_000)
    expect(JSON.stringify(s)).not.toMatch(/eyJ/)
  })

  for (const [name, authTime, sub] of [
    ['ID token without auth_time', null, 'user-1'],
    ['auth_time from before this sign-in (old provider session)', 1_000, 'user-1'],
    ['another user signed in', undefined, 'user-2']
  ] as const) {
    it(`callback - ${name} - /me?delete=retry, no step-up`, async () => {
      const b = browser()
      await signIn(b, provider)
      provider.options = authTime === undefined ? {} : { authTime }
      const reauth = await b.fetch('/api/auth/reauth?purpose=delete_account')
      const { code, state } = provider.issueCode(reauth.headers.get('location') ?? '', sub)
      const callback = await b.fetch(`/api/auth/callback?code=${code}&state=${state}`)
      expect(callback.headers.get('location')).toBe('/me?delete=retry')
      expect((await sessionBody(b)).stepUp).toBeUndefined()
      expect(harness.logs.some((l) => l.startsWith('warn: step-up refused'))).toBe(true)
    })
  }
})

describe('DELETE /api/me', () => {
  it('step-up done - identity gets access token and ID token, 202, session ended at Zitadel', async () => {
    const b = browser()
    await stepUp(b)
    const { tokens } = record(b)
    const res = await del(b)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'accepted',
      deletedOrgIds: ['019a3c20-1a2b-7c3d-8e4f-5a6b7c8d9e0f']
    })
    expect(calls).toEqual([
      {
        method: 'DELETE',
        url: `${IDENTITY_URL}/v1/me`,
        authorization: `Bearer ${tokens.accessToken}`,
        idToken: tokens.idToken
      }
    ])
    expect(provider.ended).toEqual([tokens.idToken])
    expect(provider.revoked).toContain(tokens.refreshToken)
    expect(b.cookies.has(SESSION_COOKIE)).toBe(false)
    expect(harness.store.data.size).toBe(0)
  })

  it('no step-up - 403 step_up_required, identity not called', async () => {
    const b = browser()
    await signIn(b, provider)
    const res = await del(b)
    expect(res.status).toBe(403)
    expect((await res.json()).data.code).toBe('step_up_required')
    expect(calls).toHaveLength(0)
  })

  it('step-up older than 5 min - 403 step_up_required', async () => {
    const b = browser()
    await stepUp(b)
    const csrf = (await sessionBody(b)).csrfToken
    harness.clock.now += 301_000
    const res = await del(b, csrf)
    expect(res.status).toBe(403)
    expect((await res.json()).data.code).toBe('step_up_required')
    expect(calls).toHaveLength(0)
  })

  it('wrong CSRF token - 403 csrf_failed, step-up kept', async () => {
    const b = browser()
    await stepUp(b)
    const res = await del(b, 'wrong')
    expect(res.status).toBe(403)
    expect((await res.json()).data.code).toBe('csrf_failed')
    expect(record(b).stepUp?.purpose).toBe('delete_account')
  })

  it('no session - 401 unauthenticated', async () => {
    const res = await browser().fetch('/api/me', {
      method: 'DELETE',
      headers: { origin: ORIGIN, 'x-csrf-token': 'x' }
    })
    expect(res.status).toBe(401)
  })

  it('identity refuses with recent_mfa_required - 403 with that code; the step-up is used up', async () => {
    const b = browser()
    await stepUp(b)
    answer = { status: 403, body: { code: 'recent_mfa_required', detail: 'upstream detail' } }
    const res = await del(b)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.data.code).toBe('recent_mfa_required')
    expect(JSON.stringify(body)).not.toMatch(/upstream detail/)
    expect(record(b).stepUp).toBeUndefined()
    const again = await del(b)
    expect((await again.json()).data.code).toBe('step_up_required')
    expect(calls).toHaveLength(1)
    expect(b.cookies.has(SESSION_COOKIE)).toBe(true)
  })

  it('identity answers 409 last_owner - 409 last_owner, session kept', async () => {
    const b = browser()
    await stepUp(b)
    answer = { status: 409, body: { code: 'last_owner' } }
    const res = await del(b)
    expect(res.status).toBe(409)
    expect((await res.json()).data.code).toBe('last_owner')
    expect(b.cookies.has(SESSION_COOKIE)).toBe(true)
  })

  it('identity down or 500 - 502 upstream_unavailable', async () => {
    for (const a of ['down', { status: 500, body: { code: 'internal_error' } }] as const) {
      const b = browser()
      await stepUp(b)
      answer = a
      const res = await del(b)
      expect(res.status).toBe(502)
      expect((await res.json()).data.code).toBe('upstream_unavailable')
    }
  })

  it('identity not configured - 503 identity_not_configured', async () => {
    const b = browser(new IdentityConfigError('identity is not configured: set NUXT_IDENTITY_URL'))
    await stepUp(b)
    const res = await del(b)
    expect(res.status).toBe(503)
    expect((await res.json()).data.code).toBe('identity_not_configured')
  })

  it('refresh between step-up and delete - step-up and ID token kept', async () => {
    provider.options = { expiresIn: 30 }
    const b = browser()
    await stepUp(b)
    const before = record(b)
    provider.tokenCalls.length = 0
    harness.clock.now += 31_000
    await sessionBody(b)
    expect(provider.tokenCalls.map((c) => c.grant_type)).toContain('refresh_token')
    const after = record(b)
    expect(after.tokens.accessToken).not.toBe(before.tokens.accessToken)
    expect(after.stepUp).toEqual(before.stepUp)
    const res = await del(b)
    expect(res.status).toBe(200)
    expect(calls[0]?.idToken).toBe(before.tokens.idToken)
    expect(calls[0]?.authorization).not.toBe(`Bearer ${before.tokens.accessToken}`)
  })
})

describe('DELETE /api/me - studio data of closed orgs (synthwerk#105)', () => {
  const CLOSED = '019a3c20-1a2b-7c3d-8e4f-5a6b7c8d9e0f'

  function withMe(meOrg: string | 'down') {
    const removed: string[][] = []
    const logs: string[] = []
    const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'GET' && String(input).endsWith('/v1/me')) {
        calls.push({ method: 'GET', url: String(input), authorization: '', idToken: '' })
        if (meOrg === 'down') throw new TypeError('fetch failed')
        return new Response(JSON.stringify({ subject: 'user-1', org: { id: meOrg }, roles: [] }), {
          status: 200
        })
      }
      return identityFetch(input, init)
    }
    const b = browser(config(), {
      fetch: fetchImpl as typeof fetch,
      log: (level, message) => logs.push(`${level}: ${message}`),
      removeOrgData: async (ids) => {
        removed.push(ids)
      }
    })
    return { b, removed, logs }
  }

  it('the session org closed: its leads are deleted by the session org key', async () => {
    const { b, removed } = withMe(CLOSED)
    await stepUp(b)
    const orgKey = record(b).identity.org.id
    expect((await del(b)).status).toBe(200)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${IDENTITY_URL}/v1/me`,
      `DELETE ${IDENTITY_URL}/v1/me`
    ])
    expect(removed).toEqual([[orgKey]])
  })

  it('the session org stays (other members): nothing is deleted', async () => {
    const { b, removed } = withMe('0199f3a0-5b6c-7d8e-9f0a-1b2c3d4e5f60')
    await stepUp(b)
    expect((await del(b)).status).toBe(200)
    expect(removed).toEqual([])
  })

  it('identity me fails: the account delete still runs; a log line says the cleanup was skipped', async () => {
    const { b, removed, logs } = withMe('down')
    await stepUp(b)
    expect((await del(b)).status).toBe(200)
    expect(removed).toEqual([])
    expect(logs).toEqual(['warn: identity me failed (TypeError); org data delete skipped'])
  })

  it('a failed cleanup does not fail the answer and is logged', async () => {
    const logs: string[] = []
    const b = browser(config(), {
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) =>
        (init.method ?? 'GET') === 'GET'
          ? new Response(JSON.stringify({ org: { id: CLOSED } }), { status: 200 })
          : identityFetch(input, init)) as typeof fetch,
      log: (level, message) => logs.push(`${level}: ${message}`),
      removeOrgData: async () => {
        throw new Error('db down')
      }
    })
    await stepUp(b)
    expect((await del(b)).status).toBe(200)
    expect(logs).toEqual(['error: org data delete failed (Error): leads of a closed org remain'])
  })
})
