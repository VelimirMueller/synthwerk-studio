import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LOGIN_COOKIE, SESSION_COOKIE, sessionKey } from '../../server/lib/session'
import { Browser, buildApp, type Harness, ORIGIN, signIn } from '../support/app'
import { CLIENT_ID, MockProvider, ORG_ID, REDIRECT_URI } from '../support/provider'

const provider = new MockProvider()
let harness: Harness
let browser: Browser

beforeAll(async () => {
  await provider.start()
})
afterAll(() => provider.stop())
beforeEach(() => {
  provider.options = {}
  provider.foreignKey = false
  provider.revoked.length = 0
  provider.ended.length = 0
  provider.endSessionBroken = false
  provider.tokenCalls.length = 0
  harness = buildApp(provider)
  browser = new Browser(harness)
})

const sameOrigin = { origin: ORIGIN }

async function session(b = browser) {
  return b.fetch('/api/auth/session')
}

describe('login', () => {
  it('GET /api/auth/login - new browser - redirects to authorize with PKCE S256, state, nonce and the studio scope', async () => {
    const res = await browser.fetch('/api/auth/login?returnTo=%2Fme')
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location') ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(`${provider.issuer}/oauth/v2/authorize`)
    const q = url.searchParams
    expect(q.get('client_id')).toBe(CLIENT_ID)
    expect(q.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(q.get('state')).toMatch(/^[\w-]{43}$/)
    expect(q.get('nonce')).toMatch(/^[\w-]{43}$/)
    expect(q.get('scope')?.split(' ')).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'urn:zitadel:iam:org:project:id:project-1:aud',
      'urn:zitadel:iam:org:projects:roles',
      'urn:zitadel:iam:user:resourceowner'
    ])
    const cookie = browser.setCookies.find((c) => c.startsWith(`${LOGIN_COOKIE}=`)) ?? ''
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/Secure/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Path=\//)
    expect(cookie).toMatch(/Max-Age=600/)
  })
})

describe('callback', () => {
  it('code flow - valid code and state - opens a session and redirects to returnTo', async () => {
    const { callback } = await signIn(browser, provider, '/me?tab=roles')
    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/me?tab=roles')
    const cookie = browser.setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? ''
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/Secure/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Max-Age=3600/)
    expect(browser.cookies.has(LOGIN_COOKIE)).toBe(false)
    expect(provider.tokenCalls[0]).toMatchObject({
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI
    })
    expect(provider.tokenCalls[0]?.code_verifier).toMatch(/^[\w-]{64}$/)
  })

  it('GET /api/auth/session - signed in - shows user, org, roles and amr, and no token', async () => {
    await signIn(browser, provider)
    const res = await session()
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.user).toEqual({
      sub: 'user-1',
      name: 'Owner Demo',
      username: 'owner.demo',
      email: 'owner@demo.test'
    })
    expect(body.org).toEqual({ id: ORG_ID, name: 'demo', domain: 'demo.auth.localhost' })
    expect(body.roles).toEqual([{ role: 'owner', orgIds: [ORG_ID] }])
    expect(body.amr).toEqual(['user', 'mfa'])
    expect(body.csrfToken).toMatch(/^[\w-]{43}$/)
    // No JWT, no refresh token, and no token in any cookie.
    expect(text).not.toMatch(/eyJ[\w-]+\.[\w-]+\./)
    for (const refresh of provider.refreshTokens.keys()) expect(text).not.toContain(refresh)
    for (const line of browser.setCookies) expect(line).not.toMatch(/eyJ/)
  })

  it('session store - after sign-in - is keyed by a hash of the cookie, not the cookie', async () => {
    await signIn(browser, provider)
    const id = browser.cookies.get(SESSION_COOKIE) ?? ''
    expect(harness.store.data.has(sessionKey(id))).toBe(true)
    for (const key of harness.store.data.keys()) expect(key).not.toContain(id)
  })

  it('callback - state does not match - refuses with login_expired and opens no session', async () => {
    await browser.fetch('/api/auth/login')
    const res = await browser.fetch('/api/auth/callback?code=x&state=wrong')
    expect(res.headers.get('location')).toBe('/?error=login_expired')
    expect((await session()).status).toBe(401)
  })

  it('callback - replayed - the second call finds no login and refuses', async () => {
    const { code, state } = await signIn(browser, provider)
    const other = new Browser(harness)
    const replay = await other.fetch(`/api/auth/callback?code=${code}&state=${state}`)
    expect(replay.headers.get('location')).toBe('/?error=login_expired')
  })

  it('callback - login cookie present but the transaction is gone - refuses', async () => {
    const login = await browser.fetch('/api/auth/login')
    const { code, state } = provider.issueCode(login.headers.get('location') ?? '')
    harness.store.data.clear()
    const res = await browser.fetch(`/api/auth/callback?code=${code}&state=${state}`)
    expect(res.headers.get('location')).toBe('/?error=login_expired')
  })

  it('callback - login older than ten minutes - refuses with login_expired', async () => {
    const login = await browser.fetch('/api/auth/login')
    const { code, state } = provider.issueCode(login.headers.get('location') ?? '')
    harness.clock.now += 601_000
    const res = await browser.fetch(`/api/auth/callback?code=${code}&state=${state}`)
    expect(res.headers.get('location')).toBe('/?error=login_expired')
  })

  it.each([
    ['access_denied', 'access_denied'],
    ['mfa_required', 'mfa_required'],
    ['server_error', 'login_failed']
  ])('callback - provider error %s - redirects with %s', async (error, code) => {
    const login = await browser.fetch('/api/auth/login')
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state')
    const res = await browser.fetch(`/api/auth/callback?error=${error}&state=${state}`)
    expect(res.headers.get('location')).toBe(`/?error=${code}`)
  })

  it('callback - no code - refuses with login_failed', async () => {
    const login = await browser.fetch('/api/auth/login')
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state')
    const res = await browser.fetch(`/api/auth/callback?state=${state}`)
    expect(res.headers.get('location')).toBe('/?error=login_failed')
  })

  it('callback - code swap fails (PKCE verifier wrong) - refuses with login_failed', async () => {
    const login = await browser.fetch('/api/auth/login')
    const authorize = new URL(login.headers.get('location') ?? '')
    authorize.searchParams.set('code_challenge', 'not-the-challenge')
    const { code, state } = provider.issueCode(authorize.toString())
    const res = await browser.fetch(`/api/auth/callback?code=${code}&state=${state}`)
    expect(res.headers.get('location')).toBe('/?error=login_failed')
    expect(harness.logs.join('\n')).toContain('invalid_grant')
  })

  it('callback - tokens signed by an unknown key - refuses and revokes the refresh token', async () => {
    provider.foreignKey = true
    const { callback } = await signIn(browser, provider)
    expect(callback.headers.get('location')).toBe('/?error=login_failed')
    expect(provider.revoked).toHaveLength(1)
    expect((await session()).status).toBe(401)
  })

  it.each([
    ['//evil.example/x'],
    ['https://evil.example/'],
    ['/\\evil.example'],
    ['me'],
    ['/me\nx']
  ])('login - returnTo %j - falls back to /me', async (returnTo) => {
    const { callback } = await signIn(browser, provider, returnTo)
    expect(callback.headers.get('location')).toBe('/me')
  })

  it('callback - a session cookie from before the sign-in - is replaced and the old session deleted', async () => {
    await signIn(browser, provider)
    const before = browser.cookies.get(SESSION_COOKIE) ?? ''
    await signIn(browser, provider)
    const after = browser.cookies.get(SESSION_COOKIE) ?? ''
    expect(after).not.toBe(before)
    expect(harness.store.data.has(sessionKey(before))).toBe(false)
  })
})

describe('MFA flag', () => {
  it('requireMfa on - access token amr without mfa - refuses with mfa_required', async () => {
    harness = buildApp(provider, { requireMfa: 'true' })
    browser = new Browser(harness)
    provider.options = { accessClaims: { amr: ['pwd'] } }
    const { callback } = await signIn(browser, provider)
    expect(callback.headers.get('location')).toBe('/?error=mfa_required')
    expect(provider.revoked).toHaveLength(1)
    expect((await session()).status).toBe(401)
  })

  it('requireMfa on - access token without amr - refuses (fail closed)', async () => {
    harness = buildApp(provider, { requireMfa: true })
    browser = new Browser(harness)
    provider.options = { accessClaims: { amr: undefined } }
    const { callback } = await signIn(browser, provider)
    expect(callback.headers.get('location')).toBe('/?error=mfa_required')
  })

  it('requireMfa on - amr has mfa - signs in', async () => {
    harness = buildApp(provider, { requireMfa: true })
    browser = new Browser(harness)
    const { callback } = await signIn(browser, provider)
    expect(callback.headers.get('location')).toBe('/me')
  })

  it('requireMfa off - amr without mfa - signs in', async () => {
    provider.options = { accessClaims: { amr: ['pwd'] } }
    const { callback } = await signIn(browser, provider)
    expect(callback.headers.get('location')).toBe('/me')
  })

  it('requireMfa on - refreshed token loses mfa - ends the session', async () => {
    harness = buildApp(provider, { requireMfa: true })
    browser = new Browser(harness)
    await signIn(browser, provider)
    provider.options = { accessClaims: { amr: ['pwd'] } }
    harness.clock.now += 290_000
    expect((await session()).status).toBe(401)
  })
})

describe('refresh', () => {
  it('session - access token ends within a minute - refreshes once for parallel requests', async () => {
    await signIn(browser, provider)
    const before = [...harness.store.data.values()][0] as { tokens: { accessToken: string } }
    harness.clock.now += 250_000
    const results = await Promise.all([session(), session(), session()])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(provider.tokenCalls.filter((c) => c.grant_type === 'refresh_token')).toHaveLength(1)
    const after = harness.store.data.get(sessionKey(browser.cookies.get(SESSION_COOKIE) ?? '')) as {
      tokens: { accessToken: string; refreshToken: string; idToken: string }
    }
    expect(after.tokens.accessToken).not.toBe(before.tokens.accessToken)
    expect(after.tokens.idToken).toBeTruthy()
  })

  it('session - refresh refused (invalid_grant) - answers 401 and deletes the session', async () => {
    await signIn(browser, provider)
    provider.options = { refreshError: 'invalid_grant' }
    harness.clock.now += 290_000
    const res = await session()
    expect(res.status).toBe(401)
    expect(harness.store.data.size).toBe(0)
    expect(harness.logs.join('\n')).toContain('session refresh failed: invalid_grant')
  })

  it('session - past the absolute lifetime - answers 401 and revokes the refresh token', async () => {
    provider.options = { expiresIn: 7200 }
    await signIn(browser, provider)
    harness.clock.now += 3_601_000
    expect((await session()).status).toBe(401)
    expect(provider.revoked).toHaveLength(1)
  })

  it('session - unknown session cookie - answers 401 with code unauthenticated', async () => {
    browser.cookies.set(SESSION_COOKIE, 'forged')
    const res = await session()
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ data: { code: 'unauthenticated' } })
  })
})

describe('logout and CSRF', () => {
  async function signedIn() {
    await signIn(browser, provider)
    return (await (await session()).json()).csrfToken as string
  }

  it('POST /api/auth/logout - no Origin and no Sec-Fetch-Site - answers 403 and keeps the session', async () => {
    const csrf = await signedIn()
    const res = await browser.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf }
    })
    expect(res.status).toBe(403)
    expect((await session()).status).toBe(200)
  })

  it('POST /api/auth/logout - other Origin - answers 403', async () => {
    const csrf = await signedIn()
    const res = await browser.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'x-csrf-token': csrf }
    })
    expect(res.status).toBe(403)
    expect((await session()).status).toBe(200)
  })

  it('POST /api/auth/logout - same origin, wrong CSRF token - answers 403 and keeps the session', async () => {
    await signedIn()
    const res = await browser.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { ...sameOrigin, 'x-csrf-token': 'nope' }
    })
    expect(res.status).toBe(403)
    expect((await session()).status).toBe(200)
  })

  it('POST /api/auth/logout - valid - ends the Zitadel session from the server, revokes, deletes', async () => {
    const csrf = await signedIn()
    const res = await browser.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrf }
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ redirectTo: `${ORIGIN}/` })
    expect(text).not.toMatch(/eyJ/)
    expect(provider.ended).toHaveLength(1)
    expect(provider.revoked).toHaveLength(1)
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false)
    expect(harness.store.data.size).toBe(0)
    expect((await session()).status).toBe(401)
  })

  it('POST /api/auth/logout - Zitadel does not confirm - falls back to the browser end_session URL without a token', async () => {
    const csrf = await signedIn()
    provider.endSessionBroken = true
    const res = await browser.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { ...sameOrigin, 'x-csrf-token': csrf }
    })
    const url = new URL((await res.json()).redirectTo)
    expect(`${url.origin}${url.pathname}`).toBe(`${provider.issuer}/oidc/v1/end_session`)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/`)
    expect(url.searchParams.has('id_token_hint')).toBe(false)
    expect(harness.logs.join('\n')).toContain('end_session not confirmed')
    expect((await session()).status).toBe(401)
  })

  it('POST /api/auth/logout - no session - still returns the end_session URL', async () => {
    const res = await browser.fetch('/api/auth/logout', { method: 'POST', headers: sameOrigin })
    expect(res.status).toBe(200)
    expect((await res.json()).redirectTo).toContain('/oidc/v1/end_session')
  })

  it('GET requests - any origin - pass the origin guard', async () => {
    const res = await browser.fetch('/api/auth/session', {
      headers: { origin: 'https://evil.example' }
    })
    expect(res.status).toBe(401)
  })
})
