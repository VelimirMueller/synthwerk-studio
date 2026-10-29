// OIDC client of the BFF: discovery, PKCE, code and refresh grants, token checks.
// The client is confidential (client_secret_basic) and uses PKCE S256 as well.
import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose'
import type { AuthConfig } from './config'

export interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri: string
  end_session_endpoint?: string
  revocation_endpoint?: string
}

export interface TokenSet {
  accessToken: string
  idToken?: string
  refreshToken?: string
  /** Unix seconds. */
  expiresAt: number
}

/** A refusal from the provider or a failed check. `code` is safe to show; it holds no token. */
export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')

export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url')

const DISCOVERY_TTL_MS = 10 * 60 * 1000

export class OidcClient {
  private discovery?: { value: Promise<Discovery>; at: number }
  private jwks?: { uri: string; set: ReturnType<typeof createRemoteJWKSet> }

  constructor(
    private readonly config: AuthConfig,
    private readonly now: () => number = Date.now
  ) {}

  /** Reads /.well-known/openid-configuration and keeps it for ten minutes. */
  async discover(): Promise<Discovery> {
    const cached = this.discovery
    if (cached && this.now() - cached.at < DISCOVERY_TTL_MS) return cached.value
    const value = this.loadDiscovery()
    this.discovery = { value, at: this.now() }
    value.catch(() => {
      if (this.discovery?.value === value) this.discovery = undefined
    })
    return value
  }

  private async loadDiscovery(): Promise<Discovery> {
    const res = await fetch(`${this.config.issuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' }
    })
    if (!res.ok) throw new OidcError('provider_unavailable', `discovery: status ${res.status}`)
    const doc = (await res.json()) as Discovery
    if (doc.issuer !== this.config.issuer) {
      throw new OidcError(
        'provider_unavailable',
        `discovery: issuer ${doc.issuer} is not ${this.config.issuer}`
      )
    }
    return doc
  }

  private async keys(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    const { jwks_uri } = await this.discover()
    if (this.jwks?.uri !== jwks_uri) {
      this.jwks = { uri: jwks_uri, set: createRemoteJWKSet(new URL(jwks_uri)) }
    }
    return this.jwks.set
  }

  async authorizeUrl(input: { state: string; nonce: string; verifier: string; scope: string }) {
    const { authorization_endpoint } = await this.discover()
    const url = new URL(authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: input.scope,
      state: input.state,
      nonce: input.nonce,
      code_challenge: pkceChallenge(input.verifier),
      code_challenge_method: 'S256'
    }).toString()
    return url.toString()
  }

  exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: verifier
    })
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  /** Revokes a token. Best effort: a failure changes nothing for the user. */
  async revoke(token: string, hint: 'refresh_token' | 'access_token'): Promise<void> {
    try {
      const { revocation_endpoint } = await this.discover()
      if (!revocation_endpoint) return
      await fetch(revocation_endpoint, {
        method: 'POST',
        headers: this.clientHeaders(),
        body: new URLSearchParams({ token, token_type_hint: hint })
      })
    } catch {
      // The session is gone on our side already.
    }
  }

  private clientHeaders(): Record<string, string> {
    // RFC 6749 section 2.3.1: id and secret are form-encoded before Basic auth.
    const id = encodeURIComponent(this.config.clientId)
    const secret = encodeURIComponent(this.config.clientSecret)
    return {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    }
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenSet> {
    const { token_endpoint } = await this.discover()
    const res = await fetch(token_endpoint, {
      method: 'POST',
      headers: this.clientHeaders(),
      body: new URLSearchParams(form)
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      // An OAuth error body (error, error_description) holds no token.
      const code = typeof body.error === 'string' ? body.error : 'token_error'
      throw new OidcError(code, `token endpoint: status ${res.status}, ${code}`)
    }
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new OidcError('token_error', 'token endpoint: no access_token')
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 300
    return {
      accessToken: body.access_token,
      ...(typeof body.id_token === 'string' ? { idToken: body.id_token } : {}),
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
      expiresAt: Math.floor(this.now() / 1000) + expiresIn
    }
  }

  /** Checks signature, issuer, audience, expiry and nonce of the ID token. */
  async verifyIdToken(idToken: string, nonce: string): Promise<JWTPayload> {
    const { payload } = await this.verify(idToken, 'id_token')
    if (payload.nonce !== nonce) throw new OidcError('invalid_token', 'id_token: nonce mismatch')
    return payload
  }

  /**
   * Checks the access token like a synthwerk service does (kit/auth): a JWT signed by the
   * issuer, for this client. Its claims hold org, roles and `amr`.
   */
  async verifyAccessToken(accessToken: string): Promise<JWTPayload> {
    return (await this.verify(accessToken, 'access_token')).payload
  }

  private async verify(token: string, kind: string) {
    try {
      return await jwtVerify(token, await this.keys(), {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        currentDate: new Date(this.now()),
        clockTolerance: 30
      })
    } catch (err) {
      if (err instanceof OidcError) throw err
      const reason = err instanceof Error ? err.message : 'invalid'
      throw new OidcError('invalid_token', `${kind}: ${reason}`)
    }
  }

  async userinfo(accessToken: string): Promise<Record<string, unknown>> {
    const { userinfo_endpoint } = await this.discover()
    if (!userinfo_endpoint) return {}
    const res = await fetch(userinfo_endpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
    })
    if (!res.ok) throw new OidcError('provider_unavailable', `userinfo: status ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }

  /**
   * Ends the Zitadel session from the server: end_session with `id_token_hint`, without
   * following the redirect. Zitadel then deletes the session and answers with a redirect to
   * the post-logout URI. The ID token never goes to the browser. Returns false when Zitadel
   * did not confirm (no endpoint, error, or a redirect to its logout page).
   */
  async endSession(idToken: string): Promise<boolean> {
    try {
      const { end_session_endpoint } = await this.discover()
      if (!end_session_endpoint) return false
      const url = new URL(end_session_endpoint)
      url.search = new URLSearchParams({
        id_token_hint: idToken,
        client_id: this.config.clientId,
        post_logout_redirect_uri: this.config.postLogoutRedirectUri
      }).toString()
      const res = await fetch(url, { redirect: 'manual' })
      if (res.status < 300 || res.status >= 400) return false
      // Exact target: same origin and path as the post-logout URI (Zitadel may add ?state).
      const target = new URL(res.headers.get('location') ?? '', end_session_endpoint)
      const expected = new URL(this.config.postLogoutRedirectUri)
      return target.origin === expected.origin && target.pathname === expected.pathname
    } catch {
      return false
    }
  }

  /**
   * Browser logout URL, the fallback when endSession could not end the session. It names the
   * client, not the ID token: an `id_token_hint` here would hand the ID token to the browser.
   */
  async endSessionUrl(state: string): Promise<string> {
    const { end_session_endpoint } = await this.discover()
    if (!end_session_endpoint) return this.config.postLogoutRedirectUri
    const url = new URL(end_session_endpoint)
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      post_logout_redirect_uri: this.config.postLogoutRedirectUri,
      state
    }).toString()
    return url.toString()
  }
}
