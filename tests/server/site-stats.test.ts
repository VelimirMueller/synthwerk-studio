// The public numbers of the site (synthwerk#47): pulse /v1/public-stats through the BFF, a 60 s
// cache, the field whitelist and 503 stats_unavailable when pulse is down.
import { createApp, createRouter, eventHandler, toWebHandler } from 'h3'
import { beforeEach, describe, expect, it } from 'vitest'
import { LIVE_CACHE_CONTROL } from '../../server/lib/site-api'
import { pickStats, StatsService } from '../../server/lib/site-stats'

const PULSE = 'http://pulse.test:8080'
const STATS = {
  generated_at: '2026-11-16T10:00:00Z',
  window_days: 30,
  uptime_ratio: 0.9993,
  p95_ms: 412.5,
  answered_chats: 1234
}

let calls: string[]
let state: { down: boolean; status: number; body: unknown }
let now: number

const fakePulse: typeof fetch = async (input) => {
  calls.push(String(input))
  if (state.down) throw new TypeError('fetch failed')
  return new Response(JSON.stringify(state.body), {
    status: state.status,
    headers: { 'content-type': 'application/json' }
  })
}

function setup(baseUrl = PULSE) {
  const stats = new StatsService({ baseUrl, fetch: fakePulse, now: () => now })
  const router = createRouter().get(
    '/api/site/stats',
    eventHandler((e) => stats.handle(e))
  )
  const handle = toWebHandler(createApp().use(router))
  return async () => {
    const res = await handle(new Request('http://localhost:3000/api/site/stats'))
    return { status: res.status, body: await res.json(), res }
  }
}

beforeEach(() => {
  calls = []
  state = { down: false, status: 200, body: { ...STATS, org_id: 'secret-org', extra: [1] } }
  now = Date.UTC(2026, 10, 16, 10, 0, 0)
})

describe('GET /api/site/stats', () => {
  it('pulse up - the five fields only, public cache header', async () => {
    const get = setup()
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body).toEqual(STATS)
    expect(r.res.headers.get('cache-control')).toBe(LIVE_CACHE_CONTROL)
    expect(calls).toEqual([`${PULSE}/v1/public-stats`])
  })

  it('many calls within 60 s - one pulse call; after 60 s - a new one', async () => {
    const get = setup()
    await Promise.all([get(), get(), get()])
    now += 59_000
    await get()
    expect(calls).toHaveLength(1)
    now += 2000
    await get()
    expect(calls).toHaveLength(2)
  })

  it('pulse down or failing - 503 stats_unavailable, no-store; recovers later', async () => {
    const get = setup()
    state.down = true
    let r = await get()
    expect(r.status).toBe(503)
    expect(r.body.data).toEqual({ code: 'stats_unavailable' })
    expect(r.res.headers.get('cache-control')).toBe('no-store')
    // A failure is kept 10 s: no new pulse call in that time.
    state.down = false
    expect((await get()).status).toBe(503)
    expect(calls).toHaveLength(1)
    now += 10_000
    state.status = 500
    expect((await get()).status).toBe(503)
    expect(calls).toHaveLength(2)
    now += 10_000
    state.status = 200
    r = await get()
    expect(r.status).toBe(200)
  })

  it('pulse not configured - 503 without a call', async () => {
    const get = setup('')
    expect((await get()).status).toBe(503)
    expect(calls).toEqual([])
  })

  it('pulse answers nulls - nulls pass through', async () => {
    state.body = {
      generated_at: STATS.generated_at,
      window_days: 30,
      uptime_ratio: null,
      p95_ms: null,
      answered_chats: null
    }
    const get = setup()
    expect((await get()).body).toEqual({
      ...STATS,
      uptime_ratio: null,
      p95_ms: null,
      answered_chats: null
    })
  })
})

describe('pickStats', () => {
  it('pickStats - bad shapes - null or null fields', () => {
    expect(pickStats(null)).toBeNull()
    expect(pickStats([])).toBeNull()
    expect(pickStats({ uptime_ratio: 'x', p95_ms: Number.NaN })).toEqual({
      generated_at: null,
      window_days: null,
      uptime_ratio: null,
      p95_ms: null,
      answered_chats: null
    })
  })
})
