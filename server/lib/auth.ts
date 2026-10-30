// The BFF sign-in flow: login, callback, session, logout and token refresh.
import {
  createError,
  deleteCookie,
  getCookie,
  getQuery,
  getRequestHeader,
  getRequestURL,
  type H3Event,
  sendRedirect,
  setCookie
} from 'h3'
import { hasMfa, toIdentity } from './claims'
import { type AuthConfig, studioScope } from './config'
import { type OidcClient, OidcError, randomToken, type TokenSet } from './oidc'
import { deriveKey, seal, unseal } from './seal'
import {
  type KeyValueStore,
  LOGIN_COOKIE,
  LOGIN_SEAL_PURPOSE,
  LOGIN_TTL_SECONDS,
  type LoginTransaction,
  publicSession,
  SESSION_COOKIE,
  SESSION_TTL_GRACE_SECONDS,
  type SessionRecord,
  STEP_UP_PURPOSES,
  STEP_UP_TTL_SECONDS,
  type StepUpPurpose,
  SWEEP_INTERVAL_SECONDS,
  safeEqual,
  safeReturnTo,
  sessionKey
} from './session'

/** Error codes the callback puts on `/?error=`. The page maps them to text. */
export const SIGN_IN_ERRORS = [
  'access_denied',
  'mfa_required',
  'login_expired',
  'login_failed'
] as const
export type SignInError = (typeof SIGN_IN_ERRORS)[number]

/** Refresh the access token when it ends within this many seconds. */
const REFRESH_LEEWAY_SECONDS = 60

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export interface AuthDeps {
  config: AuthConfig
  store: KeyValueStore
  oidc: OidcClient
  now?: () => number
  log?: (level: 'warn' | 'error', message: string) => void
}

export class AuthService {
  private readonly now: () => number
  private readonly loginKey: Buffer
  private readonly refreshing = new Map<string, Promise<SessionRecord | null>>()
  private lastSweep = Number.NEGATIVE_INFINITY
  private sweeping?: Promise<void>

  constructor(private readonly deps: AuthDeps) {
    this.now = deps.now ?? Date.now
    this.loginKey = deriveKey(deps.config.sessionSecret, LOGIN_SEAL_PURPOSE)
  }

  private get config() {
    return this.deps.config
  }

  private seconds(): number {
    return Math.floor(this.now() / 1000)
  }

  private cookie(event: H3Event, name: string, value: string, maxAge: number) {
    setCookie(event, name, value, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge
    })
  }

  private clear(event: H3Event, name: string) {
    deleteCookie(event, name, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' })
  }

  /** Store TTL for a session: its remaining life plus a grace for the revoke in the sweep. */
  private sessionTtl(record: SessionRecord): number {
    return Math.max(1, record.expiresAt - this.seconds()) + SESSION_TTL_GRACE_SECONDS
  }

  /**
   * GET /api/auth/login: starts the code flow with PKCE, state and nonce. The transaction
   * goes into a sealed cookie (AES-256-GCM), so this anonymous route writes nothing to the store.
   */
  async login(event: H3Event) {
    return this.startLogin(event, { returnTo: safeReturnTo(getQuery(event).returnTo) })
  }

  /**
   * GET /api/auth/reauth?purpose=delete_account: a step-up sign-in for one action. The provider
   * must authenticate the user again (`prompt=login`, `max_age=0`). The callback then marks the
   * session for that action for STEP_UP_TTL_SECONDS. Without a session it goes to the sign-in.
   */
  async reauth(event: H3Event) {
    const purpose = getQuery(event).purpose
    if (!isStepUpPurpose(purpose)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Bad Request',
        data: { code: 'invalid_request' }
      })
    }
    const record = await this.current(event)
    if (!record) return sendRedirect(event, '/?error=login_expired', 302)
    return this.startLogin(
      event,
      { returnTo: STEP_UP_RETURN[purpose].ok, purpose, sub: record.identity.user.sub },
      { prompt: 'login', maxAge: 0 }
    )
  }

  private async startLogin(
    event: H3Event,
    extra: Pick<LoginTransaction, 'returnTo' | 'purpose' | 'sub'>,
    fresh?: { prompt: 'login'; maxAge: number }
  ) {
    const tx: LoginTransaction = {
      state: randomToken(),
      nonce: randomToken(),
      verifier: randomToken(48),
      ...extra,
      expiresAt: this.seconds() + LOGIN_TTL_SECONDS
    }
    const url = await this.deps.oidc.authorizeUrl({
      ...tx,
      scope: studioScope(this.config),
      ...fresh
    })
    const sealed = seal(this.loginKey, tx, LOGIN_SEAL_PURPOSE)
    this.cookie(event, LOGIN_COOKIE, sealed, LOGIN_TTL_SECONDS)
    return sendRedirect(event, url, 302)
  }

  /** GET /api/auth/callback: checks state, swaps the code, checks the tokens, opens a session. */
  async callback(event: H3Event) {
    const query = getQuery(event)
    const sealed = getCookie(event, LOGIN_COOKIE)
    // One use: the cookie goes with this response. A replay of the code fails at Zitadel.
    this.clear(event, LOGIN_COOKIE)
    const tx = sealed ? readLogin(unseal(this.loginKey, sealed, LOGIN_SEAL_PURPOSE)) : null
    if (!tx || tx.expiresAt < this.seconds()) {
      return this.fail(event, 'login_expired', 'no valid login transaction')
    }
    if (typeof query.state !== 'string' || !safeEqual(query.state, tx.state)) {
      return this.fail(event, 'login_expired', 'state mismatch')
    }
    if (typeof query.error === 'string') {
      const code: SignInError =
        query.error === 'access_denied'
          ? 'access_denied'
          : query.error === 'mfa_required'
            ? 'mfa_required'
            : 'login_failed'
      return this.fail(event, code, `provider error ${query.error.slice(0, 64)}`)
    }
    if (typeof query.code !== 'string' || query.code === '')
      return this.fail(event, 'login_failed', 'no code')

    let tokens: TokenSet
    try {
      tokens = await this.deps.oidc.exchangeCode(query.code, tx.verifier)
    } catch (err) {
      return this.fail(event, 'login_failed', describe(err))
    }
    try {
      if (!tokens.idToken) throw new OidcError('invalid_token', 'no id_token')
      const id = await this.deps.oidc.verifyIdToken(tokens.idToken, tx.nonce)
      const access = await this.deps.oidc.verifyAccessToken(tokens.accessToken)
      if (access.sub !== id.sub)
        throw new OidcError('invalid_token', 'access and id token subjects differ')
      const userinfo = await this.deps.oidc.userinfo(tokens.accessToken)
      if (userinfo.sub !== undefined && userinfo.sub !== id.sub) {
        throw new OidcError('invalid_token', 'userinfo subject differs')
      }
      const identity = toIdentity(access, id, userinfo)
      if (this.config.requireMfa && !hasMfa(identity.amr)) {
        throw new OidcError('mfa_required', 'access token amr has no mfa')
      }
      const sessionId = randomToken()
      const createdAt = this.seconds()
      const stepUp = tx.purpose ? this.stepUp(tx, id, createdAt) : undefined
      const record: SessionRecord = {
        identity,
        tokens,
        csrf: randomToken(),
        createdAt,
        expiresAt: createdAt + this.config.sessionMaxAgeSeconds,
        ...(stepUp ? { stepUp } : {})
      }
      await this.deps.store.setItem(sessionKey(sessionId), record, { ttl: this.sessionTtl(record) })
      void this.sweep()
      // A fresh id on every sign-in: an id set before the sign-in never becomes a session.
      const old = getCookie(event, SESSION_COOKIE)
      if (old) await this.deps.store.removeItem(sessionKey(old))
      this.cookie(event, SESSION_COOKIE, sessionId, this.config.sessionMaxAgeSeconds)
      if (tx.purpose && !stepUp) return sendRedirect(event, STEP_UP_RETURN[tx.purpose].failed, 302)
      return sendRedirect(event, tx.returnTo, 302)
    } catch (err) {
      if (tokens.refreshToken) await this.deps.oidc.revoke(tokens.refreshToken, 'refresh_token')
      const code: SignInError =
        err instanceof OidcError && err.code === 'mfa_required' ? 'mfa_required' : 'login_failed'
      return this.fail(event, code, describe(err))
    }
  }

  /**
   * The step-up mark of a callback, or undefined (logged) when the sign-in does not prove a fresh
   * authentication of the same user: the ID token must name the user who started the step-up and
   * carry an `auth_time` from within this login (the provider checked `max_age`).
   */
  private stepUp(
    tx: LoginTransaction,
    id: Record<string, unknown>,
    now: number
  ): SessionRecord['stepUp'] {
    if (!tx.purpose) return undefined
    const startedAt = tx.expiresAt - LOGIN_TTL_SECONDS
    const authTime = id.auth_time
    let reason = ''
    if (typeof tx.sub !== 'string' || id.sub !== tx.sub) reason = 'another user signed in'
    else if (typeof authTime !== 'number') reason = 'id_token has no auth_time'
    else if (authTime < startedAt - CLOCK_SKEW_SECONDS || authTime > now + CLOCK_SKEW_SECONDS)
      reason = 'auth_time is not from this sign-in'
    if (reason) {
      this.deps.log?.('warn', `step-up refused: ${tx.purpose} (${reason})`)
      return undefined
    }
    return { purpose: tx.purpose, until: now + STEP_UP_TTL_SECONDS }
  }

  /**
   * Takes the step-up mark of the session for one action (single use). Checks the session (401),
   * the CSRF token (403 csrf_failed) and a valid mark for `purpose` (403 step_up_required). The
   * mark is gone from the store before the action runs. Returns the session with its tokens.
   */
  async takeStepUp(event: H3Event, purpose: StepUpPurpose): Promise<SessionRecord> {
    const id = getCookie(event, SESSION_COOKIE)
    const record = await this.current(event)
    if (!id || !record) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Unauthorized',
        data: { code: 'unauthenticated' }
      })
    }
    this.assertCsrfToken(event, record)
    const mark = record.stepUp
    if (!mark || mark.purpose !== purpose || mark.until <= this.seconds()) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: { code: 'step_up_required' }
      })
    }
    const { stepUp: _used, ...rest } = record
    await this.deps.store.setItem(sessionKey(id), rest, { ttl: this.sessionTtl(rest) })
    return record
  }

  /**
   * Ends the session after the account is gone: the Zitadel session (end_session with the ID
   * token, from the server), the refresh token and the store entry. Best effort; never throws.
   */
  async endAfterDelete(event: H3Event, record: SessionRecord): Promise<void> {
    const id = getCookie(event, SESSION_COOKIE)
    try {
      if (record.tokens.idToken) await this.deps.oidc.endSession(record.tokens.idToken)
      if (id) await this.end(sessionKey(id), record)
    } catch (err) {
      this.deps.log?.('warn', `session end after delete failed: ${describe(err)}`)
    } finally {
      this.clear(event, SESSION_COOKIE)
    }
  }

  /**
   * Ends sessions past their end: revokes the refresh token, then removes the entry. Runs at
   * most once per SWEEP_INTERVAL_SECONDS (after each new session) unless forced.
   */
  async sweep(force = false): Promise<void> {
    if (this.sweeping) return this.sweeping
    const now = this.seconds()
    if (!force && now - this.lastSweep < SWEEP_INTERVAL_SECONDS) return
    this.lastSweep = now
    this.sweeping = (async () => {
      for (const key of await this.deps.store.getKeys('session')) {
        const record = (await this.deps.store.getItem(key)) as SessionRecord | null
        if (!record || typeof record.expiresAt !== 'number') await this.deps.store.removeItem(key)
        else if (record.expiresAt <= now) await this.end(key, record)
      }
    })()
      .catch((err) => this.deps.log?.('warn', `session sweep failed: ${describe(err)}`))
      .finally(() => {
        this.sweeping = undefined
      })
    return this.sweeping
  }

  private fail(event: H3Event, code: SignInError, reason: string) {
    this.deps.log?.('warn', `sign-in refused: ${code} (${reason})`)
    return sendRedirect(event, `/?error=${code}`, 302)
  }

  /**
   * The session of the request, with a fresh access token. Returns null when there is no
   * session, it is past its end, or the refresh failed (the session is then deleted).
   */
  async current(event: H3Event): Promise<SessionRecord | null> {
    const id = getCookie(event, SESSION_COOKIE)
    if (!id) return null
    const key = sessionKey(id)
    const record = (await this.deps.store.getItem(key)) as SessionRecord | null
    if (!record) return null
    const now = this.seconds()
    if (record.expiresAt <= now) {
      await this.end(key, record)
      return null
    }
    if (record.tokens.expiresAt - REFRESH_LEEWAY_SECONDS > now) return record
    // One refresh per session at a time: parallel requests wait for the same result.
    let pending = this.refreshing.get(key)
    if (!pending) {
      pending = this.refresh(key, record).finally(() => this.refreshing.delete(key))
      this.refreshing.set(key, pending)
    }
    return pending
  }

  private async refresh(key: string, record: SessionRecord): Promise<SessionRecord | null> {
    if (!record.tokens.refreshToken) {
      await this.end(key, record)
      return null
    }
    try {
      const tokens = await this.deps.oidc.refresh(record.tokens.refreshToken)
      const access = await this.deps.oidc.verifyAccessToken(tokens.accessToken)
      if (access.sub !== record.identity.user.sub)
        throw new OidcError('invalid_token', 'subject changed')
      const fresh = toIdentity(access, {}, {})
      if (this.config.requireMfa && !hasMfa(fresh.amr))
        throw new OidcError('mfa_required', 'refreshed amr has no mfa')
      const next: SessionRecord = {
        ...record,
        identity: {
          ...record.identity,
          org: fresh.org.id ? fresh.org : record.identity.org,
          roles: fresh.roles,
          amr: fresh.amr
        },
        tokens: {
          ...tokens,
          // Zitadel may rotate the refresh token. Keep the old one when it does not.
          refreshToken: tokens.refreshToken ?? record.tokens.refreshToken,
          ...((tokens.idToken ?? record.tokens.idToken)
            ? { idToken: tokens.idToken ?? record.tokens.idToken }
            : {})
        }
      }
      await this.deps.store.setItem(key, next, { ttl: this.sessionTtl(next) })
      return next
    } catch (err) {
      this.deps.log?.('warn', `session refresh failed: ${describe(err)}`)
      await this.end(key, record)
      return null
    }
  }

  /** Revokes the refresh token (best effort), then removes the session, also when revoke fails. */
  private async end(key: string, record: SessionRecord) {
    try {
      if (record.tokens.refreshToken) {
        await this.deps.oidc.revoke(record.tokens.refreshToken, 'refresh_token')
      }
    } catch (err) {
      this.deps.log?.('warn', `revoke failed: ${describe(err)}`)
    } finally {
      await this.deps.store.removeItem(key)
    }
  }

  /** GET /api/auth/session: who is signed in. 401 without a session. */
  async session(event: H3Event) {
    const record = await this.current(event)
    if (!record) {
      this.clear(event, SESSION_COOKIE)
      throw createError({
        statusCode: 401,
        statusMessage: 'Unauthorized',
        data: { code: 'unauthenticated' }
      })
    }
    return publicSession(record, this.seconds())
  }

  /**
   * POST /api/auth/logout: needs the CSRF token of the session. Ends the Zitadel session from
   * the server (end_session with id_token_hint), revokes the refresh token and deletes the
   * session. Returns where the browser goes next: the post-logout URI, or the Zitadel logout
   * page when the server could not end the Zitadel session.
   */
  async logout(event: H3Event) {
    const id = getCookie(event, SESSION_COOKIE)
    let ended = false
    if (id) {
      const key = sessionKey(id)
      const record = (await this.deps.store.getItem(key)) as SessionRecord | null
      if (record) {
        // Check first: a refused request must not end the session or touch the cookie.
        this.assertCsrfToken(event, record)
        if (record.tokens.idToken) ended = await this.deps.oidc.endSession(record.tokens.idToken)
        if (!ended) this.deps.log?.('warn', 'end_session not confirmed: browser logout fallback')
        await this.end(key, record)
      }
    }
    this.clear(event, SESSION_COOKIE)
    const redirectTo = ended
      ? this.config.postLogoutRedirectUri
      : await this.deps.oidc.endSessionUrl(randomToken(16))
    return { redirectTo }
  }

  /** Throws 403 unless the x-csrf-token header matches the token of the session. */
  assertCsrfToken(event: H3Event, record: SessionRecord) {
    const token = getRequestHeader(event, 'x-csrf-token') ?? ''
    if (!safeEqual(token, record.csrf)) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: { code: 'csrf_failed' }
      })
    }
  }

  /**
   * CSRF guard for every unsafe /api request: the Origin header must be the studio origin.
   * Without Origin, Sec-Fetch-Site must be same-origin. Safe methods pass.
   */
  assertSameOrigin(event: H3Event) {
    if (!UNSAFE_METHODS.has(event.method)) return
    const origin = getRequestHeader(event, 'origin')
    const ok = origin
      ? origin === this.config.appOrigin
      : getRequestHeader(event, 'sec-fetch-site') === 'same-origin'
    if (!ok) {
      this.deps.log?.(
        'warn',
        `cross-origin ${event.method} ${getRequestURL(event).pathname} refused`
      )
      throw createError({
        statusCode: 403,
        statusMessage: 'Forbidden',
        data: { code: 'csrf_failed' }
      })
    }
  }
}

/** Where a step-up sign-in goes back to: on success, and when it proved nothing. */
const STEP_UP_RETURN: Record<StepUpPurpose, { ok: string; failed: string }> = {
  delete_account: { ok: '/me?delete=confirm', failed: '/me?delete=retry' }
}

/** Clock skew allowed between the provider's auth_time and the BFF clock. */
const CLOCK_SKEW_SECONDS = 30

function isStepUpPurpose(value: unknown): value is StepUpPurpose {
  return typeof value === 'string' && (STEP_UP_PURPOSES as readonly string[]).includes(value)
}

/** Checks the shape of an unsealed login transaction. */
function readLogin(value: unknown): LoginTransaction | null {
  if (!value || typeof value !== 'object') return null
  const tx = value as Record<string, unknown>
  const ok =
    ['state', 'nonce', 'verifier', 'returnTo'].every((k) => typeof tx[k] === 'string') &&
    typeof tx.expiresAt === 'number' &&
    (tx.purpose === undefined || (isStepUpPurpose(tx.purpose) && typeof tx.sub === 'string'))
  return ok ? (tx as unknown as LoginTransaction) : null
}

/** A log line without token material: the error class and its message only. */
function describe(err: unknown): string {
  if (err instanceof OidcError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.name : 'unknown error'
}
