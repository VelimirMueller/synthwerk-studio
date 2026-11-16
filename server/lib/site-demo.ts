// The live demo of the public site (synthwerk#47, docs/features/site-demo.md). Signed-in visitors
// chat with llm and classify an image with vision. The browser talks to the studio only.
// - POST /api/site/demo/chat { message, conversation_id? }: llm answer stream (SSE) passed
//   through. llm gets the access token of the session: its user and org quotas apply.
// - POST /api/site/demo/vision (multipart, field `image`): vision classification. vision takes
//   widget tokens only, so the BFF trades the session token at identity for a widget token of the
//   demo app (NUXT_SITE_DEMO_APP_ID), with the site origin as `Origin`.
// Order: session -> CSRF token -> body -> rate limits -> concurrency gate -> upstream. A refused
// request never reaches llm, identity or vision, so the model load stays flat under a flood.
// The limits live in memory: they hold per studio process (one process today).
import { createError, getRequestHeader, type H3Event, sendStream, setResponseHeaders } from 'h3'
import type { AuthService } from './auth'
import { readJsonBody, readRawBodyCapped } from './body'
import type { Limit, RateLimiter } from './rate-limit'
import type { SessionRecord } from './session'

/** Strict defaults. Every value can be set with NUXT_SITE_DEMO_* (nuxt.config.ts). */
export interface DemoLimits {
  /** Requests per user (session `sub`) per minute, chat and vision together. */
  userPerMinute: number
  /** Requests per user per UTC day. */
  userPerDay: number
  /** Requests of all users together per minute. */
  globalPerMinute: number
  /** Model calls at the same time (open answer streams and classifications). */
  maxInFlight: number
}

export const DEFAULT_DEMO_LIMITS: DemoLimits = {
  userPerMinute: 5,
  userPerDay: 30,
  globalPerMinute: 30,
  maxInFlight: 2
}

export const MAX_DEMO_MESSAGE = 2000
export const MAX_DEMO_IMAGE_BYTES = 5 * 1024 * 1024
/** Room for the multipart boundary and part headers around the image. */
const MULTIPART_OVERHEAD = 16 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MINUTE = 60_000
/** Retry-After of demo_busy: an answer stream usually ends within seconds. */
const BUSY_RETRY_SECONDS = 5
/** Longest answer stream. The fetch is aborted then, and the slot is free. */
const MAX_STREAM_MS = 120_000

export interface DemoConfig {
  llmUrl: string | null
  visionUrl: string | null
  identityUrl: string | null
  /** The demo app in the demo org. Null: the vision demo answers 503 demo_not_configured. */
  appId: string | null
  /** The public site origin (NUXT_SITE_ORIGIN): the `Origin` of the widget token and vision call. */
  siteOrigin: string | null
  limits: DemoLimits
}

export interface RawDemoConfig {
  llm?: { url?: unknown }
  vision?: { url?: unknown }
  identity?: { url?: unknown }
  site?: {
    origin?: unknown
    demo?: {
      appId?: unknown
      userPerMinute?: unknown
      userPerDay?: unknown
      globalPerMinute?: unknown
      maxInFlight?: unknown
    }
  }
}

export class DemoConfigError extends Error {}

/** An absolute http(s) base URL without user info, query or fragment; null when empty. */
function baseUrl(value: unknown, name: string): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DemoConfigError(`${name} must be an absolute http(s) URL`)
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DemoConfigError(`${name} must be an absolute http(s) URL`)
  }
  return url.toString().replace(/\/+$/, '')
}

function positive(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(n) || n < 1 || n > 100_000) {
    throw new DemoConfigError(`${name} must be a whole number from 1 to 100000`)
  }
  return n
}

/** Reads the demo settings. The messages name the variable only, never a value. */
export function readDemoConfig(raw: RawDemoConfig): DemoConfig {
  const demo = raw.site?.demo ?? {}
  const appId = typeof demo.appId === 'string' ? demo.appId.trim() : ''
  if (appId !== '' && !UUID.test(appId)) {
    throw new DemoConfigError('NUXT_SITE_DEMO_APP_ID must be an app id (UUID)')
  }
  const origin = typeof raw.site?.origin === 'string' ? raw.site.origin.trim() : ''
  let siteOrigin: string | null = null
  if (origin !== '') {
    try {
      siteOrigin = new URL(origin).origin
    } catch {
      throw new DemoConfigError('NUXT_SITE_ORIGIN must be an origin like https://synthwerk.dev')
    }
  }
  const d = DEFAULT_DEMO_LIMITS
  return {
    llmUrl: baseUrl(raw.llm?.url, 'NUXT_LLM_URL'),
    visionUrl: baseUrl(raw.vision?.url, 'NUXT_VISION_URL'),
    identityUrl: baseUrl(raw.identity?.url, 'NUXT_IDENTITY_URL'),
    appId: appId || null,
    siteOrigin,
    limits: {
      userPerMinute: positive(
        demo.userPerMinute,
        d.userPerMinute,
        'NUXT_SITE_DEMO_USER_PER_MINUTE'
      ),
      userPerDay: positive(demo.userPerDay, d.userPerDay, 'NUXT_SITE_DEMO_USER_PER_DAY'),
      globalPerMinute: positive(
        demo.globalPerMinute,
        d.globalPerMinute,
        'NUXT_SITE_DEMO_GLOBAL_PER_MINUTE'
      ),
      maxInFlight: positive(demo.maxInFlight, d.maxInFlight, 'NUXT_SITE_DEMO_MAX_IN_FLIGHT')
    }
  }
}

export type DemoCode =
  | 'sign_in_required'
  | 'invalid_request'
  | 'demo_rate_limited'
  | 'demo_busy'
  | 'demo_quota_exhausted'
  | 'demo_not_member'
  | 'demo_unavailable'
  | 'demo_not_configured'
  | 'payload_too_large'
  | 'unsupported_media_type'

const STATUS: Record<DemoCode, [number, string]> = {
  sign_in_required: [401, 'Unauthorized'],
  invalid_request: [400, 'Bad Request'],
  demo_rate_limited: [429, 'Too Many Requests'],
  demo_busy: [429, 'Too Many Requests'],
  demo_quota_exhausted: [429, 'Too Many Requests'],
  demo_not_member: [403, 'Forbidden'],
  demo_unavailable: [502, 'Bad Gateway'],
  demo_not_configured: [503, 'Service Unavailable'],
  payload_too_large: [413, 'Content Too Large'],
  unsupported_media_type: [415, 'Unsupported Media Type']
}

function fail(event: H3Event, code: DemoCode, retryAfter?: number) {
  const [statusCode, statusMessage] = STATUS[code]
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  if (retryAfter !== undefined) headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfter)))
  setResponseHeaders(event, headers)
  return createError({ statusCode, statusMessage, message: statusMessage, data: { code } })
}

/**
 * Passes `body` through and calls `done` once when it ends, fails or the reader cancels.
 * sendStream may return before the body is sent, so its promise cannot free the slot.
 */
export function guarded(body: ReadableStream<Uint8Array>, done: () => void) {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read()
        if (end) {
          done()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (err) {
        done()
        controller.error(err)
      }
    },
    cancel(reason) {
      done()
      return reader.cancel(reason)
    }
  })
}

export interface DemoLabel {
  label: string
  score: number
}

export interface DemoClassification {
  primary: DemoLabel
  /** The best labels, at most five, best first. */
  labels: DemoLabel[]
  uncertain: boolean
}

const scored = (v: unknown): DemoLabel | null => {
  if (!v || typeof v !== 'object') return null
  const { label, score } = v as Record<string, unknown>
  return typeof label === 'string' && typeof score === 'number' && Number.isFinite(score)
    ? { label, score }
    : null
}

/** The page shows the labels only: request id, model and timings stay on the server. */
export function pickClassification(raw: unknown): DemoClassification | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const primary = scored(v.primary)
  if (!primary) return null
  const labels = (Array.isArray(v.labels) ? v.labels : [])
    .map(scored)
    .filter((l): l is DemoLabel => l !== null)
    .slice(0, 5)
  return { primary, labels, uncertain: v.uncertain === true }
}

export interface DemoDeps {
  config: DemoConfig
  limiter: RateLimiter
  fetch?: typeof fetch
  now?: () => number
  log?: (level: 'warn' | 'error', message: string) => void
}

interface CachedToken {
  token: string
  /** Epoch ms. */
  expiresAt: number
}

/** Widget tokens kept per session access token. Small: one entry per active demo visitor. */
const MAX_CACHED_TOKENS = 1000
/** A cached widget token is reused until 30 s before it expires. */
const TOKEN_MARGIN_MS = 30_000

export class DemoService {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private inFlight = 0
  private readonly widgetTokens = new Map<string, CachedToken>()

  constructor(
    private readonly auth: Pick<AuthService, 'current' | 'assertCsrfToken'>,
    private readonly deps: DemoDeps
  ) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  /** Open model calls now. Tests read it to prove the gate. */
  get running(): number {
    return this.inFlight
  }

  private async session(event: H3Event): Promise<SessionRecord> {
    const record = await this.auth.current(event)
    if (!record) throw fail(event, 'sign_in_required')
    this.auth.assertCsrfToken(event, record)
    return record
  }

  /** The three limits in order. A refused hit still counts: a flood cannot reset its window. */
  private limit(event: H3Event, sub: string) {
    const { limits } = this.deps.config
    const now = this.now()
    const day = new Date(now).toISOString().slice(0, 10)
    const midnight = Date.parse(`${day}T00:00:00Z`) + 24 * 60 * MINUTE
    const checks: [string, Limit, number][] = [
      [`demo-user-min:${sub}`, { max: limits.userPerMinute, windowMs: MINUTE }, 60],
      [
        `demo-user-day:${sub}:${day}`,
        { max: limits.userPerDay, windowMs: midnight - now },
        (midnight - now) / 1000
      ],
      ['demo-global-min', { max: limits.globalPerMinute, windowMs: MINUTE }, 60]
    ]
    for (const [key, limit, retry] of checks) {
      if (!this.deps.limiter.hit(key, limit)) throw fail(event, 'demo_rate_limited', retry)
    }
  }

  /** Takes one model slot, or 429 demo_busy. The returned function frees it once. */
  private acquire(event: H3Event): () => void {
    if (this.inFlight >= this.deps.config.limits.maxInFlight) {
      throw fail(event, 'demo_busy', BUSY_RETRY_SECONDS)
    }
    this.inFlight++
    let freed = false
    return () => {
      if (freed) return
      freed = true
      this.inFlight--
    }
  }

  private async call(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, redirect: 'error' })
    } catch (err) {
      this.deps.log?.('warn', `demo ${what} failed: ${err instanceof Error ? err.name : 'error'}`)
      return new Response(null, { status: 599 })
    }
  }

  /** Maps an upstream refusal to the demo codes. The upstream body never reaches the browser. */
  private refused(
    event: H3Event,
    res: Response,
    what: string,
    service: 'llm' | 'identity' | 'vision'
  ): never {
    void res.body?.cancel().catch(() => {})
    if (res.status === 429 && service !== 'identity') {
      const retry = Number(res.headers.get('retry-after') ?? '')
      throw fail(event, 'demo_quota_exhausted', Number.isFinite(retry) && retry > 0 ? retry : 60)
    }
    // identity: the user is not in the org of the demo app.
    if (service === 'identity' && (res.status === 403 || res.status === 404)) {
      throw fail(event, 'demo_not_member')
    }
    // llm: the conversation is gone or belongs to another user. The page starts a new one.
    if (service === 'llm' && res.status === 404 && what === 'message') {
      throw fail(event, 'invalid_request')
    }
    if (res.status !== 599) this.deps.log?.('warn', `demo ${what} answered ${res.status}`)
    throw fail(event, 'demo_unavailable')
  }

  /** POST /api/site/demo/chat: the llm answer stream of one message. */
  async chat(event: H3Event) {
    const record = await this.session(event)
    const llm = this.deps.config.llmUrl
    if (!llm) throw fail(event, 'demo_not_configured')
    const body = await readJsonBody(event, 8 * 1024)
    const v = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<
      string,
      unknown
    >
    const message = typeof v.message === 'string' ? v.message.trim() : ''
    const conversation = v.conversation_id
    if (
      message === '' ||
      [...message].length > MAX_DEMO_MESSAGE ||
      (conversation !== undefined && (typeof conversation !== 'string' || !UUID.test(conversation)))
    ) {
      throw fail(event, 'invalid_request')
    }
    this.limit(event, record.identity.user.sub)
    const release = this.acquire(event)
    try {
      const auth = { authorization: `Bearer ${record.tokens.accessToken}` }
      let id = conversation as string | undefined
      if (!id) {
        const res = await this.call(
          `${llm}/v1/conversations`,
          {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
            signal: AbortSignal.timeout(5000)
          },
          'conversation'
        )
        if (!res.ok) this.refused(event, res, 'conversation', 'llm')
        const created = (await res.json().catch(() => null)) as { id?: unknown } | null
        if (typeof created?.id !== 'string' || !UUID.test(created.id)) {
          throw fail(event, 'demo_unavailable')
        }
        id = created.id
      }
      const abort = new AbortController()
      event.node?.res?.once?.('close', () => abort.abort())
      const connect = setTimeout(() => abort.abort(), 15_000)
      let res: Response
      try {
        res = await this.call(
          `${llm}/v1/conversations/${encodeURIComponent(id)}/messages`,
          {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify({ content: message }),
            signal: abort.signal
          },
          'message'
        )
      } finally {
        clearTimeout(connect)
      }
      if (!res.ok || !res.body) this.refused(event, res, 'message', 'llm')
      setResponseHeaders(event, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        'x-demo-conversation-id': id
      })
      // The slot stays taken until the stream ends, fails or the visitor leaves, and never
      // longer than MAX_STREAM_MS: a hung answer cannot hold the gate.
      const limit = setTimeout(() => abort.abort(), MAX_STREAM_MS)
      const done = () => {
        clearTimeout(limit)
        release()
      }
      event.node?.res?.once?.('close', done)
      return sendStream(event, guarded(res.body, done))
    } catch (err) {
      release()
      throw err
    }
  }

  /** A widget token of the demo app for this session, from the cache or from identity. */
  private async widgetToken(event: H3Event, record: SessionRecord): Promise<string> {
    const { identityUrl, appId, siteOrigin } = this.deps.config
    const key = record.tokens.accessToken
    const cached = this.widgetTokens.get(key)
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.now()) return cached.token
    const res = await this.call(
      `${identityUrl}/v1/apps/${encodeURIComponent(appId ?? '')}/widget-tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          origin: siteOrigin ?? '',
          accept: 'application/json'
        },
        signal: AbortSignal.timeout(5000)
      },
      'widget token'
    )
    if (!res.ok) this.refused(event, res, 'widget token', 'identity')
    const body = (await res.json().catch(() => null)) as {
      access_token?: unknown
      expires_in?: unknown
    } | null
    if (typeof body?.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw fail(event, 'demo_unavailable')
    }
    // Drop ended tokens on every insert (the map is small), so it shrinks without the cap.
    const now = this.now()
    for (const [k, v] of this.widgetTokens) if (v.expiresAt <= now) this.widgetTokens.delete(k)
    if (this.widgetTokens.size >= MAX_CACHED_TOKENS) this.widgetTokens.clear()
    const token = body.access_token
    this.widgetTokens.set(key, { token, expiresAt: this.now() + body.expires_in * 1000 })
    return token
  }

  /** POST /api/site/demo/vision: classify one image (multipart field `image`). */
  async vision(event: H3Event) {
    const record = await this.session(event)
    const { visionUrl, identityUrl, appId, siteOrigin } = this.deps.config
    if (!visionUrl || !identityUrl || !appId || !siteOrigin) {
      throw fail(event, 'demo_not_configured')
    }
    const type = getRequestHeader(event, 'content-type') ?? ''
    if (!type.toLowerCase().startsWith('multipart/form-data')) {
      throw fail(event, 'unsupported_media_type')
    }
    // Size first, from the header; then the limits; the body is read only for a counted request.
    const length = Number(getRequestHeader(event, 'content-length') ?? '')
    if (Number.isFinite(length) && length > MAX_DEMO_IMAGE_BYTES + MULTIPART_OVERHEAD) {
      throw fail(event, 'payload_too_large')
    }
    this.limit(event, record.identity.user.sub)
    const raw = await readRawBodyCapped(event, MAX_DEMO_IMAGE_BYTES + MULTIPART_OVERHEAD)
    let image: File | null = null
    try {
      const form = await new Request('http://studio.invalid/', {
        method: 'POST',
        headers: { 'content-type': type },
        body: new Uint8Array(raw)
      }).formData()
      const part = form.get('image')
      image = part instanceof File ? part : null
    } catch {
      image = null
    }
    if (!image || image.size === 0) throw fail(event, 'invalid_request')
    if (!IMAGE_TYPES.has(image.type)) throw fail(event, 'unsupported_media_type')
    if (image.size > MAX_DEMO_IMAGE_BYTES) throw fail(event, 'payload_too_large')

    // The slot covers the identity call too: a refused request reaches no service (#47 design).
    const release = this.acquire(event)
    try {
      const token = await this.widgetToken(event, record)
      const form = new FormData()
      form.set('image', image, image.name || 'image')
      const res = await this.call(
        `${visionUrl}/v1/classifications`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            origin: siteOrigin,
            accept: 'application/json'
          },
          body: form,
          signal: AbortSignal.timeout(30_000)
        },
        'classification'
      )
      if (!res.ok) {
        // An expired or revoked widget token: the next call trades a new one.
        if (res.status === 401) this.widgetTokens.delete(record.tokens.accessToken)
        this.refused(event, res, 'classification', 'vision')
      }
      setResponseHeaders(event, { 'cache-control': 'no-store' })
      const result = pickClassification(await res.json().catch(() => null))
      if (!result) throw fail(event, 'demo_unavailable')
      return result
    } finally {
      release()
    }
  }
}
