// A small OIDC provider for tests, shaped like Zitadel: discovery, JWKS, token (code with PKCE
// and refresh), userinfo, revocation and end_session. It runs on 127.0.0.1 on a free port.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'

export const CLIENT_ID = 'studio-client'
export const CLIENT_SECRET = 'test-secret'
export const REDIRECT_URI = 'http://localhost:3000/api/auth/callback'
export const ORG_ID = 'org-demo'

export interface IssuedCode {
  sub: string
  nonce: string
  challenge: string
  redirectUri: string
  prompt: string
  maxAge: string
}

export interface ProviderOptions {
  /** Extra or replaced access token claims. */
  accessClaims?: Record<string, unknown>
  /** Seconds until the access token ends. */
  expiresIn?: number
  /** Return this status and OAuth error on the next refresh. */
  refreshError?: string
  /** ID token auth_time (Unix seconds). Default: the time of the token call. null: none. */
  authTime?: number | null
}

export class MockProvider {
  readonly codes = new Map<string, IssuedCode>()
  readonly refreshTokens = new Map<string, string>()
  readonly revoked: string[] = []
  /** ID tokens that ended a session through end_session. */
  readonly ended: string[] = []
  /** end_session ignores the id_token_hint (answers like a hint-less call) when true. */
  endSessionBroken = false
  readonly tokenCalls: Record<string, string>[] = []
  options: ProviderOptions = {}
  issuer = ''
  private server?: Server
  private key?: { privateKey: CryptoKey; jwk: JWK }
  /** Signs with a key that is not in the JWKS when true. */
  foreignKey = false

  async start(): Promise<string> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    this.key = {
      privateKey,
      jwk: { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
    }
    this.server = createServer((req, res) => {
      this.handle(req).then(
        ({ status, body, location }) => {
          res.writeHead(status, {
            'content-type': 'application/json',
            ...(location ? { location } : {})
          })
          res.end(JSON.stringify(body))
        },
        () => {
          res.writeHead(500)
          res.end()
        }
      )
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.issuer
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }

  /** What the login UI does: a user signs in and the provider issues a code for the request. */
  issueCode(authorizeUrl: string, sub = 'user-1'): { code: string; state: string } {
    const url = new URL(authorizeUrl)
    const code = randomBytes(16).toString('hex')
    this.codes.set(code, {
      sub,
      nonce: url.searchParams.get('nonce') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
      prompt: url.searchParams.get('prompt') ?? '',
      maxAge: url.searchParams.get('max_age') ?? ''
    })
    return { code, state: url.searchParams.get('state') ?? '' }
  }

  async sign(claims: Record<string, unknown>, ttl = 300): Promise<string> {
    const key = this.foreignKey
      ? (await generateKeyPair('RS256')).privateKey
      : (this.key?.privateKey as CryptoKey)
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(this.issuer)
      .setIssuedAt()
      .setJti(randomBytes(8).toString('hex'))
      .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
      .sign(key)
  }

  private accessClaims(sub: string): Record<string, unknown> {
    return {
      sub,
      aud: [CLIENT_ID, 'project-1'],
      'urn:zitadel:iam:user:resourceowner:id': ORG_ID,
      'urn:zitadel:iam:user:resourceowner:name': 'demo',
      'urn:zitadel:iam:user:resourceowner:primary_domain': 'demo.auth.localhost',
      'urn:zitadel:iam:org:project:roles': { owner: { [ORG_ID]: 'demo.auth.localhost' } },
      amr: ['user', 'mfa'],
      ...this.options.accessClaims
    }
  }

  private authTimeClaim(): { auth_time?: number } {
    const at = this.options.authTime
    if (at === null) return {}
    return { auth_time: at ?? Math.floor(Date.now() / 1000) }
  }

  private async tokens(sub: string, nonce?: string) {
    const refresh = randomBytes(16).toString('hex')
    this.refreshTokens.set(refresh, sub)
    const ttl = this.options.expiresIn ?? 300
    return {
      access_token: await this.sign(this.accessClaims(sub), ttl),
      id_token: await this.sign({
        sub,
        aud: CLIENT_ID,
        ...(nonce ? { nonce } : {}),
        ...this.authTimeClaim(),
        amr: ['user', 'mfa']
      }),
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: ttl
    }
  }

  private async handle(
    req: IncomingMessage
  ): Promise<{ status: number; body: unknown; location?: string }> {
    const url = new URL(req.url ?? '/', this.issuer)
    const form = new URLSearchParams(await readBody(req))
    switch (url.pathname) {
      case '/.well-known/openid-configuration':
        return {
          status: 200,
          body: {
            issuer: this.issuer,
            authorization_endpoint: `${this.issuer}/oauth/v2/authorize`,
            token_endpoint: `${this.issuer}/oauth/v2/token`,
            userinfo_endpoint: `${this.issuer}/oidc/v1/userinfo`,
            jwks_uri: `${this.issuer}/oauth/v2/keys`,
            end_session_endpoint: `${this.issuer}/oidc/v1/end_session`,
            revocation_endpoint: `${this.issuer}/oauth/v2/revoke`
          }
        }
      case '/oauth/v2/keys':
        return { status: 200, body: { keys: [this.key?.jwk] } }
      case '/oauth/v2/token':
        return this.token(req, form)
      case '/oauth/v2/revoke':
        if (!clientOk(req)) return { status: 401, body: { error: 'invalid_client' } }
        this.revoked.push(form.get('token') ?? '')
        return { status: 200, body: {} }
      case '/oidc/v1/end_session': {
        const hint = url.searchParams.get('id_token_hint')
        const back = url.searchParams.get('post_logout_redirect_uri') ?? ''
        if (hint && !this.endSessionBroken) {
          this.ended.push(hint)
          return { status: 302, body: {}, location: back }
        }
        return { status: 302, body: {}, location: `${this.issuer}/ui/v2/login/logout?x=1` }
      }
      case '/oidc/v1/userinfo': {
        // The subject of the bearer token, like a real userinfo endpoint (signature not checked).
        const sub = subjectOf((req.headers.authorization ?? '').replace(/^Bearer /, ''))
        if (!sub) return { status: 401, body: {} }
        return {
          status: 200,
          body: {
            sub,
            name: 'Owner Demo',
            preferred_username: 'owner.demo',
            email: 'owner@demo.test'
          }
        }
      }
      default:
        return { status: 404, body: {} }
    }
  }

  private async token(req: IncomingMessage, form: URLSearchParams) {
    this.tokenCalls.push(Object.fromEntries(form))
    if (!clientOk(req)) return { status: 401, body: { error: 'invalid_client' } }
    if (form.get('grant_type') === 'authorization_code') {
      const issued = this.codes.get(form.get('code') ?? '')
      this.codes.delete(form.get('code') ?? '')
      const verifier = form.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (
        !issued ||
        issued.challenge !== challenge ||
        issued.redirectUri !== form.get('redirect_uri')
      ) {
        return { status: 400, body: { error: 'invalid_grant' } }
      }
      return { status: 200, body: await this.tokens(issued.sub, issued.nonce) }
    }
    if (form.get('grant_type') === 'refresh_token') {
      if (this.options.refreshError)
        return { status: 400, body: { error: this.options.refreshError } }
      const sub = this.refreshTokens.get(form.get('refresh_token') ?? '')
      if (!sub) return { status: 400, body: { error: 'invalid_grant' } }
      const { id_token: _id, ...rest } = await this.tokens(sub)
      return { status: 200, body: rest }
    }
    return { status: 400, body: { error: 'unsupported_grant_type' } }
  }
}

function subjectOf(jwt: string): string {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString())
    return typeof payload.sub === 'string' ? payload.sub : ''
  } catch {
    return ''
  }
}

function clientOk(req: IncomingMessage): boolean {
  const expected = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')
  return req.headers.authorization === `Basic ${expected}`
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
  })
}
