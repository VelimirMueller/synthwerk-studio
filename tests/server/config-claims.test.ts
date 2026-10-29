import { describe, expect, it } from 'vitest'
import { hasMfa, readAmr, readRoles, toIdentity } from '../../server/lib/claims'
import { AuthConfigError, readAuthConfig, studioScope } from '../../server/lib/config'
import { safeEqual, safeReturnTo } from '../../server/lib/session'

const SECRET = 'test-session-secret-0123456789abcdef'
const session = { secret: SECRET }

const base = {
  issuer: 'http://auth.localhost:8080/',
  clientId: 'c',
  clientSecret: 's',
  redirectUri: 'http://localhost:3000/api/auth/callback'
}

describe('readAuthConfig', () => {
  it('missing settings - throws and names the env variables', () => {
    expect(() => readAuthConfig({ oidc: { issuer: 'x' } })).toThrow(AuthConfigError)
    expect(() => readAuthConfig({ oidc: { issuer: 'x' } })).toThrow(
      'set NUXT_OIDC_CLIENT_ID, NUXT_OIDC_CLIENT_SECRET, NUXT_OIDC_REDIRECT_URI'
    )
    expect(() => readAuthConfig({})).toThrow('NUXT_OIDC_ISSUER')
  })

  it('defaults - derives origin and logout URI, trims the issuer, MFA off, 8 h', () => {
    const config = readAuthConfig({ oidc: base, session })
    expect(config.issuer).toBe('http://auth.localhost:8080')
    expect(config.appOrigin).toBe('http://localhost:3000')
    expect(config.postLogoutRedirectUri).toBe('http://localhost:3000/')
    expect(config.requireMfa).toBe(false)
    expect(config.sessionMaxAgeSeconds).toBe(28800)
  })

  it.each([
    [true, true],
    ['true', true],
    ['1', true],
    ['false', false],
    [undefined, false]
  ])('requireMfa %j - gives %j', (value, expected) => {
    expect(readAuthConfig({ oidc: { ...base, requireMfa: value }, session }).requireMfa).toBe(
      expected
    )
  })

  it('bad session lifetime - throws and names the variable', () => {
    for (const bad of ['x', '8h', 0, -5, 1.5]) {
      expect(() =>
        readAuthConfig({ oidc: base, session: { ...session, maxAgeSeconds: bad } })
      ).toThrow('NUXT_SESSION_MAX_AGE_SECONDS')
    }
    expect(
      readAuthConfig({ oidc: base, session: { ...session, maxAgeSeconds: '' } })
        .sessionMaxAgeSeconds
    ).toBe(28800)
    expect(
      readAuthConfig({ oidc: base, session: { ...session, maxAgeSeconds: 600 } })
        .sessionMaxAgeSeconds
    ).toBe(600)
  })

  it('session secret - missing or short - throws and names the variable', () => {
    expect(() => readAuthConfig({ oidc: base })).toThrow('NUXT_SESSION_SECRET')
    expect(() => readAuthConfig({ oidc: base, session: { secret: 'short' } })).toThrow(
      'NUXT_SESSION_SECRET'
    )
  })

  it('studioScope - no project id - leaves out the audience scope', () => {
    expect(studioScope({ projectId: '' })).not.toContain(':aud')
  })
})

describe('claims', () => {
  it('readRoles - bad shapes - give no role', () => {
    expect(readRoles({})).toEqual([])
    expect(readRoles({ 'urn:zitadel:iam:org:project:roles': [] })).toEqual([])
    expect(
      readRoles({ 'urn:zitadel:iam:org:project:roles': { owner: 'x', admin: { b: 'd', a: 'd' } } })
    ).toEqual([{ role: 'admin', orgIds: ['a', 'b'] }])
  })

  it('readAmr and hasMfa - keep strings only, need mfa', () => {
    expect(readAmr({ amr: ['pwd', 3, 'mfa'] })).toEqual(['pwd', 'mfa'])
    expect(readAmr({ amr: 'mfa' })).toEqual([])
    expect(hasMfa(['user', 'mfa'])).toBe(true)
    expect(hasMfa(['pwd'])).toBe(false)
  })

  it('toIdentity - access token without org or roles - falls back to userinfo', () => {
    const identity = toIdentity(
      { sub: 'u' },
      {},
      {
        'urn:zitadel:iam:user:resourceowner:name': 'demo',
        'urn:zitadel:iam:org:project:roles': { member: { o: 'd' } }
      }
    )
    expect(identity.user.sub).toBe('u')
    expect(identity.org.name).toBe('demo')
    expect(identity.roles).toEqual([{ role: 'member', orgIds: ['o'] }])
    expect(identity.amr).toEqual([])
  })
})

describe('session helpers', () => {
  it('safeEqual - compares in constant time, length first', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'ab')).toBe(false)
  })

  it('safeReturnTo - non-strings and long values - give the fallback', () => {
    expect(safeReturnTo(undefined)).toBe('/me')
    expect(safeReturnTo(['/a'])).toBe('/me')
    expect(safeReturnTo(`/${'a'.repeat(600)}`)).toBe('/me')
    expect(safeReturnTo('/org/settings?x=1#y')).toBe('/org/settings?x=1#y')
  })
})
