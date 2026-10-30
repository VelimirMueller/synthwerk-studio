// The health view BFF (synthwerk#40, docs/features/health-view.md). The browser never
// talks to pulse: these handlers check the session and the role, then call pulse with
// the access token of the session. Pulse checks the token and the org again.
import { createError, type H3Event, sendStream, setResponseHeaders } from 'h3'
import type { AuthService } from './auth'
import type { StudioIdentity } from './claims'
import type { SessionRecord } from './session'

/** platform = operator (every number), org = owner or admin (own org only). */
export type HealthScope = 'platform' | 'org'

const ORG_ADMIN_ROLES = new Set(['owner', 'admin'])

/** True when the identity is owner or admin in the org of its token. */
export function isOrgAdmin(identity: StudioIdentity): boolean {
  const org = identity.org.id
  return (
    org !== '' && identity.roles.some((r) => ORG_ADMIN_ROLES.has(r.role) && r.orgIds.includes(org))
  )
}

/**
 * The widest scope the identity may ask for, or null. An operator grant in any org
 * asks for platform; pulse accepts it only when the grant is in the platform org.
 */
export function healthScope(identity: StudioIdentity): HealthScope | null {
  if (identity.roles.some((r) => r.role === 'operator' && r.orgIds.length > 0)) return 'platform'
  return isOrgAdmin(identity) ? 'org' : null
}

/** Longest time the BFF keeps one stream open. The browser then reconnects. */
export const STREAM_MAX_SECONDS = 3600
/** Shortest stream: below this the BFF refreshes the token first (AuthService.current). */
const STREAM_MIN_SECONDS = 30

export interface PulseDeps {
  /** Base URL of pulse inside the network, for example http://pulse:8080. Empty: not set. */
  baseUrl: string
  fetch?: typeof fetch
  now?: () => number
  log?: (level: 'warn' | 'error', message: string) => void
}

type Fail = 'unauthenticated' | 'forbidden' | 'pulse_unavailable' | 'pulse_not_configured'

const STATUS: Record<Fail, number> = {
  unauthenticated: 401,
  forbidden: 403,
  pulse_unavailable: 502,
  pulse_not_configured: 503
}

function fail(code: Fail) {
  const statusCode = STATUS[code]
  return createError({
    statusCode,
    statusMessage:
      statusCode === 401 ? 'Unauthorized' : statusCode === 403 ? 'Forbidden' : 'Bad Gateway',
    data: { code }
  })
}

export class HealthService {
  private readonly fetch: typeof fetch
  private readonly now: () => number

  constructor(
    private readonly auth: Pick<AuthService, 'current'>,
    private readonly deps: PulseDeps
  ) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  /** The session and its scope. 401 without a session, 403 without a health role. */
  private async access(event: H3Event): Promise<{ record: SessionRecord; scope: HealthScope }> {
    const record = await this.auth.current(event)
    if (!record) throw fail('unauthenticated')
    const scope = healthScope(record.identity)
    if (!scope) throw fail('forbidden')
    if (!this.deps.baseUrl) throw fail('pulse_not_configured')
    return { record, scope }
  }

  private async call(
    path: string,
    record: SessionRecord,
    accept = 'application/json',
    signal?: AbortSignal
  ): Promise<Response> {
    const url = `${this.deps.baseUrl.replace(/\/+$/, '')}${path}`
    try {
      return await this.fetch(url, {
        headers: { authorization: `Bearer ${record.tokens.accessToken}`, accept },
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(5000)
      })
    } catch (err) {
      this.deps.log?.('warn', `pulse ${path.split('/').slice(0, 3).join('/')} failed: ${name(err)}`)
      throw fail('pulse_unavailable')
    }
  }

  /** Maps a pulse refusal: 401 and 403 become 403 (the token does not allow it), the rest 502. */
  private refused(res: Response, path: string): never {
    void res.body?.cancel()
    if (res.status === 401 || res.status === 403) throw fail('forbidden')
    this.deps.log?.('warn', `pulse ${path} answered ${res.status}`)
    throw fail('pulse_unavailable')
  }

  /** GET /api/health/status: the live status of every target, once. */
  async status(event: H3Event) {
    const { record } = await this.access(event)
    const res = await this.call('/v1/health', record)
    if (!res.ok) this.refused(res, '/v1/health')
    return (await res.json()) as unknown
  }

  /**
   * GET /api/health/metrics. Operators get the platform numbers. Owners and admins get the
   * numbers of the org of their session; the org id never comes from the request.
   */
  async metrics(event: H3Event) {
    const { record, scope } = await this.access(event)
    if (scope === 'platform') {
      const res = await this.call('/v1/metrics', record)
      if (res.ok) return { scope: 'platform' as const, metrics: (await res.json()) as unknown }
      // An operator grant outside the platform org: fall back to the own org when allowed.
      if (res.status !== 403 || !isOrgAdmin(record.identity)) this.refused(res, '/v1/metrics')
      void res.body?.cancel()
    }
    const path = `/v1/orgs/${encodeURIComponent(record.identity.org.id)}/metrics`
    const res = await this.call(path, record)
    if (!res.ok) this.refused(res, '/v1/orgs/{org}/metrics')
    return { scope: 'org' as const, metrics: (await res.json()) as unknown }
  }

  /**
   * GET /api/health/stream: passes the pulse SSE stream through. The stream ends when the
   * access token ends (at most STREAM_MAX_SECONDS); the browser reconnects and this route
   * checks the session again.
   */
  async stream(event: H3Event) {
    const { record } = await this.access(event)
    const tokenLeft = record.tokens.expiresAt - Math.floor(this.now() / 1000)
    if (tokenLeft <= 0) throw fail('unauthenticated')
    const seconds = Math.min(STREAM_MAX_SECONDS, Math.max(STREAM_MIN_SECONDS, tokenLeft))
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), seconds * 1000)
    const stop = () => {
      clearTimeout(timer)
      abort.abort()
    }
    event.node?.req?.once?.('close', stop)
    // Pulse sends a full snapshot first on every connect: Last-Event-ID needs no replay.
    let res: Response
    try {
      // The connect has the same 5 s limit as the other calls; the body then runs on.
      // A fetch signal also covers the body, so the limit is a timer cleared on the headers.
      const connect = setTimeout(() => abort.abort(), 5000)
      try {
        res = await this.call('/v1/health/stream', record, 'text/event-stream', abort.signal)
      } finally {
        clearTimeout(connect)
      }
    } catch (err) {
      stop()
      throw err
    }
    if (!res.ok || !res.body) {
      stop()
      this.refused(res, '/v1/health/stream')
    }
    setResponseHeaders(event, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no'
    })
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({ flush: () => clearTimeout(timer) })
    )
    return sendStream(event, body)
  }
}

const name = (err: unknown): string => (err instanceof Error ? err.name : 'unknown error')
