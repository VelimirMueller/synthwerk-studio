import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readAuthConfig } from '../../server/lib/config'
import { OidcClient, OidcError, pkceChallenge } from '../../server/lib/oidc'
import { CLIENT_ID, CLIENT_SECRET, MockProvider, REDIRECT_URI } from '../support/provider'

const provider = new MockProvider()
beforeAll(() => provider.start())
afterAll(() => provider.stop())

const client = (issuer = provider.issuer, extra: Record<string, unknown> = {}) =>
  new OidcClient(
    readAuthConfig({
      oidc: {
        issuer,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        ...extra
      }
    })
  )

describe('OidcClient', () => {
  it('pkceChallenge - S256 - 43 base64url characters, one per verifier', () => {
    const a = pkceChallenge('a'.repeat(64))
    expect(a).toMatch(/^[\w-]{43}$/)
    expect(pkceChallenge('a'.repeat(64))).toBe(a)
    expect(pkceChallenge('b'.repeat(64))).not.toBe(a)
  })

  it('discover - issuer in the document differs - rejects and does not cache the failure', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ issuer: 'http://other' }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const c = client(issuer)
    await expect(c.discover()).rejects.toThrow(OidcError)
    await expect(c.discover()).rejects.toThrow('is not')
    server.close()
  })

  it('discover - provider down - rejects with provider_unavailable', async () => {
    const c = client(`${provider.issuer}/missing`)
    await expect(c.discover()).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it('discover - second call - uses the cached document', async () => {
    const c = client()
    const first = await c.discover()
    expect(await c.discover()).toBe(first)
  })

  it('token request - wrong client secret - throws invalid_client', async () => {
    const c = client(provider.issuer, { clientSecret: 'wrong' })
    await expect(c.refresh('x')).rejects.toMatchObject({ code: 'invalid_client' })
  })

  it('verifyIdToken - nonce differs - throws invalid_token', async () => {
    const token = await provider.sign({ sub: 'u', aud: CLIENT_ID, nonce: 'a' })
    await expect(client().verifyIdToken(token, 'b')).rejects.toMatchObject({
      code: 'invalid_token'
    })
  })

  it('verifyAccessToken - other audience - throws invalid_token', async () => {
    const token = await provider.sign({ sub: 'u', aud: 'someone-else' })
    await expect(client().verifyAccessToken(token)).rejects.toMatchObject({ code: 'invalid_token' })
  })

  it('userinfo - 401 - throws provider_unavailable', async () => {
    const c = client()
    await c.discover()
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response('', { status: 401 })
    try {
      await expect(c.userinfo('t')).rejects.toMatchObject({ code: 'provider_unavailable' })
    } finally {
      globalThis.fetch = original
    }
  })

  it('revoke - provider down - does not throw', async () => {
    await expect(
      client(`${provider.issuer}/missing`).revoke('t', 'refresh_token')
    ).resolves.toBeUndefined()
  })
})

describe('OidcClient.endSession', () => {
  it('provider down - returns false', async () => {
    await expect(client(`${provider.issuer}/missing`).endSession('t')).resolves.toBe(false)
  })

  it('no end_session_endpoint - returns false, and the browser URL is the post-logout URI', async () => {
    const c = client()
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      Response.json({
        issuer: provider.issuer,
        authorization_endpoint: 'x',
        token_endpoint: 'x',
        jwks_uri: 'x'
      })
    try {
      expect(await c.endSession('t')).toBe(false)
      expect(await c.endSessionUrl('s')).toBe('http://localhost:3000/')
    } finally {
      globalThis.fetch = original
    }
  })
})
