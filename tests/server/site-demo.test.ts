// The live demo BFF (synthwerk#47) on an h3 app with fake llm, identity and vision. The load
// tests prove that a flood over the limits gets 429 before any model call: the model load stays
// flat. The session comes from a test header; the real one from the session cookie.
import {
  createApp,
  createError,
  createRouter,
  eventHandler,
  getRequestHeader,
  toWebHandler
} from 'h3'
import { beforeEach, describe, expect, it } from 'vitest'
import type { StudioIdentity } from '../../server/lib/claims'
import { RateLimiter } from '../../server/lib/rate-limit'
import type { SessionRecord } from '../../server/lib/session'
import {
  DEFAULT_DEMO_LIMITS,
  type DemoConfig,
  DemoConfigError,
  DemoService,
  guarded,
  MAX_DEMO_IMAGE_BYTES,
  pickClassification,
  readDemoConfig
} from '../../server/lib/site-demo'

const LLM = 'http://llm.test:8080'
const IDENTITY = 'http://identity.test:8080'
const VISION = 'http://vision.test:8080'
const SITE = 'https://synthwerk.example'
const APP = '0199f3a0-5b6c-7d8e-9f0a-1b2c3d4e5f61'
const CONV = '0199f3b0-1a2c-7c3d-8e4f-5a6b7c8d9e10'
const NOW = Date.UTC(2026, 10, 16, 10, 0, 0)

const record = (who: string): SessionRecord => ({
  identity: {
    user: { sub: `sub-${who}`, name: who, username: who, email: `${who}@example.test` },
    org: { id: 'org-demo', name: 'Demo', domain: 'demo.test' },
    roles: [{ role: 'member', orgIds: ['org-demo'] }],
    amr: []
  } satisfies StudioIdentity,
  tokens: { accessToken: `token-${who}`, expiresAt: NOW / 1000 + 600 },
  csrf: `csrf-${who}`,
  createdAt: NOW / 1000,
  expiresAt: NOW / 1000 + 3600
})

interface Call {
  url: string
  method: string
  authorization: string
  origin: string
}

interface World {
  calls: Call[]
  /** Answer streams open now, and the most at the same time. */
  open: number
  peak: number
  /** llm answers with this status for the message call (200 = stream). */
  llmStatus: number
  createStatus: number
  identityStatus: number
  visionStatus: number
  down: boolean
  /** Keeps every answer stream open until release() is called. */
  hold: boolean
  holds: (() => void)[]
  tokensIssued: number
}

let world: World
let now: number

function sse(text: string) {
  return new TextEncoder().encode(text)
}

function fakeFetch(w: World): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    w.calls.push({
      url: url.origin + url.pathname,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? '',
      origin: headers.get('origin') ?? ''
    })
    if (w.down) throw new TypeError('fetch failed')
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    if (url.origin === LLM && url.pathname === '/v1/conversations') {
      if (w.createStatus !== 201) return json({ code: 'x' }, w.createStatus)
      return json({ id: CONV }, 201)
    }
    if (url.origin === LLM && url.pathname.endsWith('/messages')) {
      if (w.llmStatus === 429) {
        return new Response('{"code":"quota_exhausted"}', {
          status: 429,
          headers: { 'retry-after': '120' }
        })
      }
      if (w.llmStatus !== 200) return json({ code: 'x' }, w.llmStatus)
      w.open++
      w.peak = Math.max(w.peak, w.open)
      let closed = false
      const close = () => {
        if (!closed) {
          closed = true
          w.open--
        }
      }
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(sse('id: m:1\nevent: delta\ndata: {"text":"Hallo"}\n\n'))
          const end = () => {
            c.enqueue(
              sse('id: m:2\nevent: done\ndata: {"message_id":"m","finish_reason":"stop"}\n\n')
            )
            close()
            c.close()
          }
          if (w.hold) w.holds.push(end)
          else end()
        },
        cancel: close
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.origin === IDENTITY && url.pathname === `/v1/apps/${APP}/widget-tokens`) {
      if (w.identityStatus !== 201) return json({ code: 'forbidden' }, w.identityStatus)
      w.tokensIssued++
      return json({ access_token: `widget-${w.tokensIssued}`, expires_in: 300 }, 201)
    }
    if (url.origin === VISION && url.pathname === '/v1/classifications') {
      if (w.visionStatus !== 200) return json({ code: 'x' }, w.visionStatus)
      const form = init?.body as FormData
      const image = form.get('image') as File
      return json({
        request_id: 'r1',
        image: { width: 1, height: 1, bytes: image.size },
        model: { id: 'm' },
        primary: { id: 'n1', label: 'beagle', score: 0.81, topic: 'dog', path: [] },
        labels: [
          { id: 'n1', label: 'beagle', score: 0.81, topic: 'dog', path: [] },
          { id: 'n2', label: 'basset', score: 0.1, topic: 'dog', path: [] }
        ],
        topics: [],
        uncertain: false,
        timings_ms: { total: 12 }
      })
    }
    return new Response('not found', { status: 404 })
  }
}

const config = (
  over: Partial<DemoConfig> = {},
  limits: Partial<DemoConfig['limits']> = {}
): DemoConfig => ({
  llmUrl: LLM,
  visionUrl: VISION,
  identityUrl: IDENTITY,
  appId: APP,
  siteOrigin: SITE,
  limits: { ...DEFAULT_DEMO_LIMITS, ...limits },
  ...over
})

function setup(cfg: DemoConfig = config()) {
  const demo = new DemoService(
    {
      current: async (event) => {
        const who = getRequestHeader(event, 'x-test-session')
        return who ? record(who) : null
      },
      assertCsrfToken: (event, rec) => {
        if (getRequestHeader(event, 'x-csrf-token') !== rec.csrf) {
          throw createError({ statusCode: 403, data: { code: 'csrf_failed' } })
        }
      }
    },
    {
      config: cfg,
      limiter: new RateLimiter(50_000, () => now),
      fetch: fakeFetch(world),
      now: () => now
    }
  )
  const router = createRouter()
    .post(
      '/api/site/demo/chat',
      eventHandler((e) => demo.chat(e))
    )
    .post(
      '/api/site/demo/vision',
      eventHandler((e) => demo.vision(e))
    )
  const handle = toWebHandler(createApp().use(router))
  return { demo, handle }
}

type Handle = ReturnType<typeof setup>['handle']

async function chat(handle: Handle, who: string | null, body: unknown = { message: 'Hallo' }) {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (who) {
    headers.set('x-test-session', who)
    headers.set('x-csrf-token', `csrf-${who}`)
  }
  const res = await handle(
    new Request('http://localhost:3000/api/site/demo/chat', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  )
  const text = await res.text()
  let json: { data?: { code?: string } } = {}
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, code: json.data?.code, text, res }
}

async function vision(
  handle: Handle,
  who: string | null,
  file: Blob | null = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' })
) {
  const form = new FormData()
  if (file) form.set('image', file, 'photo.jpg')
  const headers = new Headers()
  if (who) {
    headers.set('x-test-session', who)
    headers.set('x-csrf-token', `csrf-${who}`)
  }
  const req = new Request('http://localhost:3000/api/site/demo/vision', {
    method: 'POST',
    headers,
    body: form
  })
  const res = await handle(req)
  const text = await res.text()
  let json: Record<string, unknown> & { data?: { code?: string } } = {}
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, code: json.data?.code, json, res }
}

const llmMessages = () => world.calls.filter((c) => c.url.endsWith('/messages'))
const modelCalls = () =>
  world.calls.filter((c) => c.url.startsWith(LLM) || c.url.startsWith(VISION))

beforeEach(() => {
  now = NOW
  world = {
    calls: [],
    open: 0,
    peak: 0,
    llmStatus: 200,
    createStatus: 201,
    identityStatus: 201,
    visionStatus: 200,
    down: false,
    hold: false,
    holds: [],
    tokensIssued: 0
  }
})

describe('readDemoConfig', () => {
  it('readDemoConfig - empty - strict defaults, demo parts off', () => {
    expect(readDemoConfig({})).toEqual({
      llmUrl: null,
      visionUrl: null,
      identityUrl: null,
      appId: null,
      siteOrigin: null,
      limits: { userPerMinute: 5, userPerDay: 30, globalPerMinute: 30, maxInFlight: 2 }
    })
  })

  it('readDemoConfig - all set - values as numbers, URLs without slash', () => {
    const c = readDemoConfig({
      llm: { url: 'http://llm:8080/' },
      vision: { url: 'http://vision:8080' },
      identity: { url: 'http://identity:8080' },
      site: {
        origin: SITE,
        demo: {
          appId: APP,
          userPerMinute: '3',
          userPerDay: 10,
          globalPerMinute: '20',
          maxInFlight: 1
        }
      }
    })
    expect(c.llmUrl).toBe('http://llm:8080')
    expect(c.appId).toBe(APP)
    expect(c.siteOrigin).toBe(SITE)
    expect(c.limits).toEqual({
      userPerMinute: 3,
      userPerDay: 10,
      globalPerMinute: 20,
      maxInFlight: 1
    })
  })

  it('readDemoConfig - bad values - error names the variable only', () => {
    expect(() => readDemoConfig({ site: { demo: { appId: 'nope' } } })).toThrow(
      'NUXT_SITE_DEMO_APP_ID must be an app id (UUID)'
    )
    expect(() => readDemoConfig({ site: { demo: { maxInFlight: '0' } } })).toThrow(DemoConfigError)
    expect(() => readDemoConfig({ site: { demo: { userPerDay: 'many' } } })).toThrow(
      'NUXT_SITE_DEMO_USER_PER_DAY'
    )
    expect(() => readDemoConfig({ llm: { url: 'ftp://llm' } })).toThrow('NUXT_LLM_URL')
    expect(() => readDemoConfig({ llm: { url: 'http://u:p@llm' } })).toThrow('NUXT_LLM_URL')
    expect(() => readDemoConfig({ site: { origin: 'nope' } })).toThrow('NUXT_SITE_ORIGIN')
  })
})

describe('access order', () => {
  it('POST chat - no session - 401 sign_in_required, no upstream call', async () => {
    const { handle } = setup()
    const r = await chat(handle, null)
    expect(r.status).toBe(401)
    expect(r.code).toBe('sign_in_required')
    expect(r.res.headers.get('cache-control')).toBe('no-store')
    expect(world.calls).toEqual([])
  })

  it('POST chat - wrong CSRF token - 403, no upstream call, no limit used', async () => {
    const { handle } = setup()
    const res = await handle(
      new Request('http://localhost:3000/api/site/demo/chat', {
        method: 'POST',
        headers: {
          'x-test-session': 'ada',
          'x-csrf-token': 'wrong',
          'content-type': 'application/json'
        },
        body: '{"message":"Hallo"}'
      })
    )
    expect(res.status).toBe(403)
    expect(world.calls).toEqual([])
    for (let i = 0; i < 5; i++) expect((await chat(handle, 'ada')).status).toBe(200)
  })

  it('POST chat - invalid bodies - 400 invalid_request, no upstream call', async () => {
    const { handle } = setup()
    for (const body of [
      {},
      { message: '' },
      { message: '   ' },
      { message: 42 },
      { message: 'x'.repeat(2001) },
      { message: 'hi', conversation_id: 'nope' },
      { message: 'hi', conversation_id: 7 },
      []
    ]) {
      const r = await chat(handle, 'ada', body)
      expect(r.status, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(r.code).toBe('invalid_request')
    }
    expect((await chat(handle, 'ada', 'not json')).status).toBe(400)
    expect(world.calls).toEqual([])
  })

  it('POST chat - 2000 characters - accepted', async () => {
    const { handle } = setup()
    expect((await chat(handle, 'ada', { message: 'ä'.repeat(2000) })).status).toBe(200)
  })
})

describe('chat', () => {
  it('POST chat - new chat - creates a conversation, streams the answer, id in a header', async () => {
    const { handle, demo } = setup()
    const r = await chat(handle, 'ada')
    expect(r.status).toBe(200)
    expect(r.res.headers.get('content-type')).toBe('text/event-stream')
    expect(r.res.headers.get('cache-control')).toBe('no-store')
    expect(r.res.headers.get('x-demo-conversation-id')).toBe(CONV)
    expect(r.text).toContain('event: delta\ndata: {"text":"Hallo"}')
    expect(r.text).toContain('event: done')
    expect(world.calls.map((c) => [c.method, c.url, c.authorization])).toEqual([
      ['POST', `${LLM}/v1/conversations`, 'Bearer token-ada'],
      ['POST', `${LLM}/v1/conversations/${CONV}/messages`, 'Bearer token-ada']
    ])
    expect(demo.running).toBe(0)
  })

  it('POST chat - known conversation - no new conversation', async () => {
    const { handle } = setup()
    const r = await chat(handle, 'ada', { message: 'Weiter', conversation_id: CONV })
    expect(r.status).toBe(200)
    expect(world.calls.map((c) => c.url)).toEqual([`${LLM}/v1/conversations/${CONV}/messages`])
  })

  it('POST chat - llm quota exhausted - 429 demo_quota_exhausted with Retry-After', async () => {
    world.llmStatus = 429
    const { handle, demo } = setup()
    const r = await chat(handle, 'ada')
    expect(r.status).toBe(429)
    expect(r.code).toBe('demo_quota_exhausted')
    expect(r.res.headers.get('retry-after')).toBe('120')
    expect(r.text).not.toContain('quota_exhausted"}')
    expect(demo.running).toBe(0)
  })

  it('POST chat - llm errors - 502 demo_unavailable; unknown conversation - 400', async () => {
    const { handle, demo } = setup()
    world.llmStatus = 503
    expect((await chat(handle, 'ada')).code).toBe('demo_unavailable')
    world.llmStatus = 404
    expect((await chat(handle, 'ada', { message: 'x', conversation_id: CONV })).code).toBe(
      'invalid_request'
    )
    world.llmStatus = 200
    world.createStatus = 500
    expect((await chat(handle, 'ada')).status).toBe(502)
    world.createStatus = 201
    world.down = true
    expect((await chat(handle, 'ada')).code).toBe('demo_unavailable')
    expect(demo.running).toBe(0)
  })

  it('POST chat - llm not configured - 503 demo_not_configured', async () => {
    const { handle } = setup(config({ llmUrl: null }))
    const r = await chat(handle, 'ada')
    expect(r.status).toBe(503)
    expect(r.code).toBe('demo_not_configured')
  })
})

describe('rate limits', () => {
  it('per user - 5 per minute, then 429 demo_rate_limited with Retry-After; next minute free', async () => {
    const { handle } = setup()
    for (let i = 0; i < 5; i++) expect((await chat(handle, 'ada')).status).toBe(200)
    const r = await chat(handle, 'ada')
    expect(r.status).toBe(429)
    expect(r.code).toBe('demo_rate_limited')
    expect(Number(r.res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(llmMessages()).toHaveLength(5)
    // Another user is not affected.
    expect((await chat(handle, 'bob')).status).toBe(200)
    now += 61_000
    expect((await chat(handle, 'ada')).status).toBe(200)
  })

  it('per user - 30 per UTC day, chat and vision together; the next UTC day is free', async () => {
    const { handle } = setup()
    let ok = 0
    for (let minute = 0; minute < 7; minute++) {
      for (let i = 0; i < 5; i++) {
        const r = i % 2 ? await vision(handle, 'ada') : await chat(handle, 'ada')
        if (r.status === 200) ok++
        else expect(r.code).toBe('demo_rate_limited')
      }
      now += 61_000
    }
    expect(ok).toBe(30)
    const r = await chat(handle, 'ada')
    expect(r.code).toBe('demo_rate_limited')
    // Retry-After points to the next UTC midnight.
    expect(Number(r.res.headers.get('retry-after'))).toBeLessThanOrEqual(14 * 3600)
    now = Date.UTC(2026, 10, 17, 0, 0, 1)
    expect((await chat(handle, 'ada')).status).toBe(200)
  })

  it('global - 30 per minute over all users', async () => {
    const { handle } = setup()
    for (let i = 0; i < 30; i++) expect((await chat(handle, `u${i}`)).status).toBe(200)
    const r = await chat(handle, 'late')
    expect(r.status).toBe(429)
    expect(r.code).toBe('demo_rate_limited')
  })
})

describe('concurrency gate', () => {
  it('third concurrent model call - 429 demo_busy, Retry-After 5; free again after an answer', async () => {
    world.hold = true
    const { handle, demo } = setup()
    const first = chat(handle, 'ada')
    const second = chat(handle, 'bob')
    // Wait until both answer streams are open at llm.
    for (let i = 0; i < 50 && world.open < 2; i++) await new Promise((r) => setTimeout(r, 1))
    expect(demo.running).toBe(2)
    const third = await chat(handle, 'cyd')
    expect(third.status).toBe(429)
    expect(third.code).toBe('demo_busy')
    expect(third.res.headers.get('retry-after')).toBe('5')
    expect(llmMessages()).toHaveLength(2)
    for (const end of world.holds) end()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(demo.running).toBe(0)
    world.hold = false
    expect((await chat(handle, 'cyd')).status).toBe(200)
  })

  it('a cancelled answer stream frees its slot', async () => {
    world.hold = true
    const { handle, demo } = setup()
    const res = await handle(
      new Request('http://localhost:3000/api/site/demo/chat', {
        method: 'POST',
        headers: {
          'x-test-session': 'ada',
          'x-csrf-token': 'csrf-ada',
          'content-type': 'application/json'
        },
        body: '{"message":"Hallo"}'
      })
    )
    expect(demo.running).toBe(1)
    await res.body?.cancel()
    expect(demo.running).toBe(0)
    expect(world.open).toBe(0)
  })

  it('guarded - stream error - done called once', async () => {
    let calls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error('boom'))
      }
    })
    const g = guarded(body, () => calls++)
    await expect(g.getReader().read()).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })
})

describe('load test', () => {
  it('one user, 50 concurrent chats - exactly 5 reach llm, 45 get 429 demo_rate_limited', async () => {
    // Gate wide open: this test isolates the per-user limit.
    const { handle } = setup(config({}, { maxInFlight: 50 }))
    const results = await Promise.all(Array.from({ length: 50 }, () => chat(handle, 'ada')))
    expect(results.filter((r) => r.status === 200)).toHaveLength(5)
    const refused = results.filter((r) => r.status === 429)
    expect(refused).toHaveLength(45)
    expect(refused.every((r) => r.code === 'demo_rate_limited')).toBe(true)
    expect(llmMessages()).toHaveLength(5)
  })

  it('one user, 50 concurrent chats, default gate - never more than 5 llm calls, 2 at a time', async () => {
    world.hold = true
    const { handle, demo } = setup()
    const pending = Array.from({ length: 50 }, () => chat(handle, 'ada'))
    for (let i = 0; i < 50 && world.open < 2; i++) await new Promise((r) => setTimeout(r, 1))
    for (const end of world.holds) end()
    world.hold = false
    const results = await Promise.all(pending)
    expect(results.every((r) => r.status === 200 || r.status === 429)).toBe(true)
    expect(llmMessages().length).toBeLessThanOrEqual(5)
    expect(world.peak).toBeLessThanOrEqual(2)
    expect(demo.running).toBe(0)
  })

  it('50 users x 1 concurrent chat - exactly 30 reach llm (global limit)', async () => {
    const { handle } = setup(config({}, { maxInFlight: 50 }))
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => chat(handle, `u${i}`)))
    expect(results.filter((r) => r.status === 200)).toHaveLength(30)
    expect(results.filter((r) => r.code === 'demo_rate_limited')).toHaveLength(20)
    expect(llmMessages()).toHaveLength(30)
  })

  it('50 users x 1 chat, default gate - 30 reach llm, never more than 2 in flight', async () => {
    const { handle } = setup()
    // Waves of 2: every wave fits the gate, so only the global limit refuses.
    const results = []
    for (let i = 0; i < 50; i += 2) {
      results.push(...(await Promise.all([chat(handle, `u${i}`), chat(handle, `u${i + 1}`)])))
    }
    expect(results.filter((r) => r.status === 200)).toHaveLength(30)
    expect(llmMessages()).toHaveLength(30)
    expect(world.peak).toBeLessThanOrEqual(2)
  })

  it('50 users x 1 concurrent chat, default gate, slow llm - at most 2 reach llm', async () => {
    world.hold = true
    const { handle } = setup()
    const pending = Array.from({ length: 50 }, (_, i) => chat(handle, `u${i}`))
    for (let i = 0; i < 50 && world.open < 2; i++) await new Promise((r) => setTimeout(r, 1))
    await new Promise((r) => setTimeout(r, 10))
    expect(world.open).toBeLessThanOrEqual(2)
    for (const end of world.holds) end()
    const results = await Promise.all(pending)
    expect(llmMessages()).toHaveLength(2)
    expect(world.peak).toBe(2)
    const codes = results.filter((r) => r.status === 429).map((r) => r.code)
    expect(codes).toHaveLength(48)
    expect(new Set(codes)).toEqual(new Set(['demo_busy', 'demo_rate_limited']))
  })
})

describe('vision', () => {
  it('POST vision - image - widget token with the site origin, labels only', async () => {
    const { handle, demo } = setup()
    const r = await vision(handle, 'ada')
    expect(r.status).toBe(200)
    expect(r.res.headers.get('cache-control')).toBe('no-store')
    expect(r.json).toEqual({
      primary: { label: 'beagle', score: 0.81 },
      labels: [
        { label: 'beagle', score: 0.81 },
        { label: 'basset', score: 0.1 }
      ],
      uncertain: false
    })
    expect(world.calls.map((c) => [c.url, c.authorization, c.origin])).toEqual([
      [`${IDENTITY}/v1/apps/${APP}/widget-tokens`, 'Bearer token-ada', SITE],
      [`${VISION}/v1/classifications`, 'Bearer widget-1', SITE]
    ])
    expect(demo.running).toBe(0)
  })

  it('POST vision - widget token cached per session until 30 s before expiry', async () => {
    const { handle } = setup()
    await vision(handle, 'ada')
    now += 200_000
    await vision(handle, 'ada')
    expect(world.tokensIssued).toBe(1)
    now += 75_000 // 275 s of 300: inside the 30 s margin
    await vision(handle, 'ada')
    expect(world.tokensIssued).toBe(2)
    await vision(handle, 'bob')
    expect(world.tokensIssued).toBe(3)
  })

  it('POST vision - no session - 401, nothing called', async () => {
    const { handle } = setup()
    const r = await vision(handle, null)
    expect(r.status).toBe(401)
    expect(r.code).toBe('sign_in_required')
    expect(world.calls).toEqual([])
  })

  it('POST vision - no app id - 503 demo_not_configured, nothing called', async () => {
    const { handle } = setup(config({ appId: null }))
    const r = await vision(handle, 'ada')
    expect(r.status).toBe(503)
    expect(r.code).toBe('demo_not_configured')
    expect(world.calls).toEqual([])
  })

  it('POST vision - user not in the demo org - 403 demo_not_member', async () => {
    const { handle } = setup()
    for (const status of [403, 404]) {
      world.identityStatus = status
      const r = await vision(handle, 'ada')
      expect(r.status).toBe(403)
      expect(r.code).toBe('demo_not_member')
    }
    expect(modelCalls()).toEqual([])
  })

  it('POST vision - vision fails - 502; 401 drops the cached token', async () => {
    const { handle } = setup()
    world.visionStatus = 401
    expect((await vision(handle, 'ada')).code).toBe('demo_unavailable')
    world.visionStatus = 200
    expect((await vision(handle, 'ada')).status).toBe(200)
    expect(world.tokensIssued).toBe(2)
    world.visionStatus = 429
    expect((await vision(handle, 'ada')).code).toBe('demo_quota_exhausted')
  })

  it('POST vision - wrong type, empty, missing, too large - refused before vision', async () => {
    const { handle } = setup(
      config({}, { userPerMinute: 100, userPerDay: 100, globalPerMinute: 100 })
    )
    expect((await vision(handle, 'ada', new Blob(['gif'], { type: 'image/gif' }))).code).toBe(
      'unsupported_media_type'
    )
    expect((await vision(handle, 'ada', new Blob([], { type: 'image/png' }))).code).toBe(
      'invalid_request'
    )
    expect((await vision(handle, 'ada', null)).code).toBe('invalid_request')
    const big = new Blob([new Uint8Array(MAX_DEMO_IMAGE_BYTES + 1)], { type: 'image/png' })
    const r = await vision(handle, 'ada', big)
    expect(r.status).toBe(413)
    expect(r.code).toBe('payload_too_large')
    const json = await handle(
      new Request('http://localhost:3000/api/site/demo/vision', {
        method: 'POST',
        headers: {
          'x-test-session': 'ada',
          'x-csrf-token': 'csrf-ada',
          'content-type': 'application/json'
        },
        body: '{}'
      })
    )
    expect(json.status).toBe(415)
    expect(modelCalls()).toEqual([])
  })

  it('pickClassification - bad shapes - null', () => {
    expect(pickClassification(null)).toBeNull()
    expect(pickClassification({ primary: { label: 1 } })).toBeNull()
    expect(pickClassification({ primary: { label: 'a', score: 0.5 }, labels: 'x' })).toEqual({
      primary: { label: 'a', score: 0.5 },
      labels: [],
      uncertain: false
    })
  })
})
