// Public numbers of the site (synthwerk#47, docs/features/site-demo.md): GET /api/site/stats.
// No session. The BFF reads pulse GET /v1/public-stats inside the network (NUXT_PULSE_BASE_URL)
// and keeps the answer 60 s in memory, so pulse sees at most one call per minute per process.
// Only the whitelisted aggregate fields pass through.
import { createError, type H3Event, setResponseHeader } from 'h3'
import { LIVE_CACHE_CONTROL } from './site-api'

export interface PublicStats {
  generated_at: string | null
  window_days: number | null
  uptime_ratio: number | null
  p95_ms: number | null
  answered_chats: number | null
}

export const STATS_TTL_MS = 60_000
/** After a failed pulse call, the 503 is kept this long: a flood cannot hammer a down pulse. */
export const STATS_FAIL_TTL_MS = 10_000
const TIMEOUT_MS = 5000

export interface StatsDeps {
  baseUrl: string
  fetch?: typeof fetch
  now?: () => number
  log?: (level: 'warn' | 'error', message: string) => void
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The whitelist: unknown fields of pulse never reach the browser. */
export function pickStats(raw: unknown): PublicStats | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  return {
    generated_at: typeof v.generated_at === 'string' ? v.generated_at : null,
    window_days: num(v.window_days),
    uptime_ratio: num(v.uptime_ratio),
    p95_ms: num(v.p95_ms),
    answered_chats: num(v.answered_chats)
  }
}

export class StatsService {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private cached: { stats: PublicStats; at: number } | null = null
  private failedAt: number | null = null
  /** One pulse call at a time: callers in the same moment share it. */
  private pending: Promise<PublicStats | null> | null = null

  constructor(private readonly deps: StatsDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  private async load(): Promise<PublicStats | null> {
    const base = this.deps.baseUrl.replace(/\/+$/, '')
    if (!base) return null
    try {
      const res = await this.fetch(`${base}/v1/public-stats`, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!res.ok) {
        void res.body?.cancel().catch(() => {})
        this.deps.log?.('warn', `pulse /v1/public-stats answered ${res.status}`)
        return null
      }
      return pickStats(await res.json())
    } catch (err) {
      this.deps.log?.(
        'warn',
        `pulse /v1/public-stats failed: ${err instanceof Error ? err.name : 'error'}`
      )
      return null
    }
  }

  /** The numbers, from the cache when younger than 60 s; null when pulse is not readable. */
  async get(): Promise<PublicStats | null> {
    if (this.cached && this.now() - this.cached.at < STATS_TTL_MS) return this.cached.stats
    if (this.failedAt !== null && this.now() - this.failedAt < STATS_FAIL_TTL_MS) return null
    if (!this.pending) {
      this.pending = this.load().finally(() => {
        this.pending = null
      })
    }
    const stats = await this.pending
    if (stats) {
      this.cached = { stats, at: this.now() }
      this.failedAt = null
    } else {
      this.failedAt = this.now()
    }
    return stats
  }

  /** GET /api/site/stats. */
  async handle(event: H3Event): Promise<PublicStats> {
    const stats = await this.get()
    if (!stats) {
      setResponseHeader(event, 'cache-control', 'no-store')
      throw createError({
        statusCode: 503,
        statusMessage: 'Service Unavailable',
        data: { code: 'stats_unavailable' }
      })
    }
    setResponseHeader(event, 'cache-control', LIVE_CACHE_CONTROL)
    return stats
  }
}
