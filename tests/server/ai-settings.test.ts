// The AI settings routes of the BFF (synthwerk#39): session and CSRF gate, the calls to llm
// with the session token, the strict body check, and how llm refusals reach the page.

import { readFileSync } from 'node:fs'
import { createApp, createError, createRouter, eventHandler, type H3Event, toWebHandler } from 'h3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AiSettingsApi,
  aiSettingsApiFrom,
  aiSettingsRoutes,
  type Fetch,
  LlmError,
  readUpdate,
  runAiSettingsRoute,
  toHttpError
} from '../../server/lib/ai-settings'
import type { SessionSource } from '../../server/lib/apps'
import { LlmConfigError, readLlmConfig } from '../../server/lib/llm-config'
import type { SessionRecord } from '../../server/lib/session'

const LLM = 'http://llm.test'
const TOKEN = 'access-token-of-the-session'
const CSRF = 'csrf-of-the-session'

const llmSettings = (over: Record<string, unknown> = {}) => ({
  model: 'default',
  allowed_models: ['default', 'small'],
  system_prompt: 'You answer questions about the shop.',
  max_input_chars: 2000,
  user_tokens_per_day: 20000,
  temperature: 0.3,
  version: 3,
  updated_at: '2026-10-30T10:00:00Z',
  bounds: {
    models: ['default', 'small'],
    max_input_chars: 8000,
    user_tokens_per_day: 50000,
    system_prompt_max_chars: 4000,
    temperature_max: 2
  },
  ...over
})

/** A valid PUT /api/ai-settings body (studio shape). */
const update = (over: Record<string, unknown> = {}) => ({
  version: 3,
  model: 'small',
  allowedModels: ['default', 'small'],
  systemPrompt: 'Answer briefly.\nBe kind.\tThanks.',
  maxInputChars: 1500,
  userTokensPerDay: 0,
  temperature: 0.7,
  ...over
})

interface Call {
  method: string
  url: string
  auth: string | null
  body: unknown
}

/** A fake llm: records every call and answers from `answer`. */
function fakeLlm(answer: (c: Call) => Response = () => Response.json(llmSettings())) {
  const calls: Call[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    }
    calls.push(call)
    return answer(call)
  }) as Fetch
  return { fetch, calls }
}

const problem = (status: number, code: string, detail?: string) =>
  Response.json(
    { type: `x/${code}`, title: code, status, code, ...(detail ? { detail } : {}) },
    { status }
  )

function record(): SessionRecord {
  return {
    identity: {
      user: { sub: 'u1', name: 'U', username: 'u', email: '' },
      org: { id: 'z1', name: 'Acme', domain: '' },
      roles: [{ role: 'owner', orgIds: ['z1'] }],
      amr: []
    },
    tokens: { accessToken: TOKEN, expiresAt: 9e9 },
    csrf: CSRF,
    createdAt: 0,
    expiresAt: 9e9
  }
}

/** The routes of server/api/ai-settings on an h3 app, with a fake session source. */
function harness(
  llm: ReturnType<typeof fakeLlm>,
  opts: { signedIn?: boolean; config?: Record<string, unknown> } = {}
) {
  const auth: SessionSource = {
    current: async () => (opts.signedIn === false ? null : record()),
    assertCsrfToken(event: H3Event, r: SessionRecord) {
      if (event.headers.get('x-csrf-token') !== r.csrf) {
        throw createError({ statusCode: 403, data: { code: 'csrf_failed' } })
      }
    }
  }
  const config = opts.config ?? { llm: { url: `${LLM}/` } }
  const deps = { auth, api: () => aiSettingsApiFrom(config, llm.fetch) }
  // Same method, path and route name as the files in server/api/ai-settings (checked below).
  const route = (name: keyof typeof aiSettingsRoutes) =>
    eventHandler((e) => runAiSettingsRoute(e, deps, name))
  const router = createRouter()
    .get('/api/ai-settings', route('get'))
    .put('/api/ai-settings', route('update'))
  const web = toWebHandler(createApp().use(router))
  return (path: string, init: RequestInit = {}) =>
    web(new Request(`http://localhost:3000${path}`, init))
}

const put = (body: unknown, csrf = CSRF): RequestInit => ({
  method: 'PUT',
  headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

const dataOf = async (res: Response) =>
  ((await res.json()) as { data?: { code?: string; detail?: string } }).data ?? {}

let llm: ReturnType<typeof fakeLlm>

beforeEach(() => {
  llm = fakeLlm((c) =>
    c.method === 'PUT'
      ? Response.json(llmSettings({ ...(c.body as object), version: 4 }))
      : Response.json(llmSettings())
  )
})

describe('session gate', () => {
  it('GET /api/ai-settings - no session - 401 unauthenticated, llm not called', async () => {
    const res = await harness(llm, { signedIn: false })('/api/ai-settings')
    expect(res.status).toBe(401)
    expect((await dataOf(res)).code).toBe('unauthenticated')
    expect(llm.calls).toHaveLength(0)
  })

  it('PUT /api/ai-settings - wrong CSRF token - 403 csrf_failed, llm not called', async () => {
    const res = await harness(llm)('/api/ai-settings', put(update(), 'forged'))
    expect(res.status).toBe(403)
    expect((await dataOf(res)).code).toBe('csrf_failed')
    expect(llm.calls).toHaveLength(0)
  })
})

describe('calls to llm', () => {
  it('GET /api/ai-settings - signed in - calls llm with the session token, returns the settings', async () => {
    const res = await harness(llm)('/api/ai-settings')
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(TOKEN)
    expect(JSON.parse(text)).toEqual({
      model: 'default',
      allowedModels: ['default', 'small'],
      systemPrompt: 'You answer questions about the shop.',
      maxInputChars: 2000,
      userTokensPerDay: 20000,
      temperature: 0.3,
      version: 3,
      updatedAt: '2026-10-30T10:00:00Z',
      bounds: {
        models: ['default', 'small'],
        maxInputChars: 8000,
        userTokensPerDay: 50000,
        systemPromptMaxChars: 4000,
        temperatureMax: 2
      }
    })
    expect(llm.calls).toEqual([
      { method: 'GET', url: `${LLM}/v1/ai-settings`, auth: `Bearer ${TOKEN}`, body: undefined }
    ])
  })

  it('GET /api/ai-settings - defaults of version 0 - no temperature, no updated_at read as null', async () => {
    const { temperature: _t, updated_at: _u, ...defaults } = llmSettings({ version: 0 })
    const res = await harness(fakeLlm(() => Response.json(defaults)))('/api/ai-settings')
    const body = (await res.json()) as { temperature: unknown; updatedAt: unknown; version: number }
    expect(body).toMatchObject({ temperature: null, updatedAt: null, version: 0 })
  })

  it('PUT /api/ai-settings - valid body - sends exactly the validated body in the contract shape', async () => {
    const res = await harness(llm)(
      '/api/ai-settings',
      put({ ...update(), extra: 'dropped', orgId: 'other-org' })
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { version: number }).version).toBe(4)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]).toMatchObject({
      method: 'PUT',
      url: `${LLM}/v1/ai-settings`,
      auth: `Bearer ${TOKEN}`
    })
    expect(llm.calls[0]?.body).toEqual({
      version: 3,
      model: 'small',
      allowed_models: ['default', 'small'],
      system_prompt: 'Answer briefly.\nBe kind.\tThanks.',
      max_input_chars: 1500,
      user_tokens_per_day: 0,
      temperature: 0.7
    })
  })

  it('PUT /api/ai-settings - temperature null or absent - no temperature key, the model default', async () => {
    for (const body of [update({ temperature: null }), update({ temperature: undefined })]) {
      const id = fakeLlm(() => Response.json(llmSettings()))
      const res = await harness(id)('/api/ai-settings', put(body))
      expect(res.status).toBe(200)
      expect(id.calls[0]?.body).not.toHaveProperty('temperature')
    }
  })
})

describe('refusals', () => {
  it.each([
    ['empty body', {}],
    ['version missing', update({ version: undefined })],
    ['negative version', update({ version: -1 })],
    ['version not an integer', update({ version: 1.5 })],
    ['model with upper case', update({ model: 'GPT-4' })],
    ['model not a string', update({ model: 3 })],
    ['alias of 65 characters', update({ model: `a${'b'.repeat(64)}` })],
    ['no allowed models', update({ allowedModels: [] })],
    ['allowed models not a list', update({ allowedModels: 'default' })],
    ['33 allowed models', update({ allowedModels: Array.from({ length: 33 }, (_, i) => `m${i}`) })],
    ['allowed model twice', update({ allowedModels: ['small', 'small'] })],
    ['default model not allowed', update({ allowedModels: ['default'] })],
    ['system prompt not a string', update({ systemPrompt: null })],
    ['system prompt of 4001 characters', update({ systemPrompt: 'a'.repeat(4001) })],
    ['NUL in the prompt', update({ systemPrompt: 'a\u0000b' })],
    ['escape in the prompt', update({ systemPrompt: 'a\u001b[31mb' })],
    ['DEL in the prompt', update({ systemPrompt: 'a\u007fb' })],
    ['C1 control in the prompt', update({ systemPrompt: 'a\u0085b' })],
    ['max input 0', update({ maxInputChars: 0 })],
    ['max input 8001', update({ maxInputChars: 8001 })],
    ['max input as text', update({ maxInputChars: '2000' })],
    ['negative token cap', update({ userTokensPerDay: -1 })],
    ['token cap above the contract', update({ userTokensPerDay: 1_000_000_000_001 })],
    ['temperature 2.1', update({ temperature: 2.1 })],
    ['negative temperature', update({ temperature: -0.1 })],
    ['temperature as text', update({ temperature: '0.5' })]
  ])('PUT /api/ai-settings - %s - 400 invalid_request before llm', async (_n, body) => {
    const res = await harness(llm)('/api/ai-settings', put(body))
    expect(res.status).toBe(400)
    const data = await dataOf(res)
    expect(data.code).toBe('invalid_request')
    expect(data.detail).toBeTruthy()
    expect(llm.calls).toHaveLength(0)
  })

  it('readUpdate - 4000 characters of emoji and a CRLF prompt - accepted', () => {
    expect(readUpdate(update({ systemPrompt: '😀'.repeat(4000) })).systemPrompt).toHaveLength(8000)
    expect(readUpdate(update({ systemPrompt: 'a\r\nb' })).systemPrompt).toBe('a\r\nb')
  })

  it('PUT /api/ai-settings - llm says version_conflict - 409 with the code and the detail', async () => {
    const id = fakeLlm(() =>
      problem(409, 'version_conflict', 'The settings changed since version 3. Read them again.')
    )
    const res = await harness(id)('/api/ai-settings', put(update()))
    expect(res.status).toBe(409)
    expect(await dataOf(res)).toEqual({
      code: 'version_conflict',
      detail: 'The settings changed since version 3. Read them again.'
    })
  })

  it.each([
    [400, 'invalid_request', 'max_input_chars: at most 4000 for this org.'],
    [403, 'forbidden', 'Only owners and admins can change the AI settings.']
  ])('llm %i %s - same status, code and detail', async (status, code, detail) => {
    const res = await harness(fakeLlm(() => problem(status, code, detail)))(
      '/api/ai-settings',
      put(update())
    )
    expect(res.status).toBe(status)
    expect(await dataOf(res)).toEqual({ code, detail })
  })

  it('llm detail of 2000 characters - cut to 512', async () => {
    const res = await harness(fakeLlm(() => problem(400, 'invalid_request', 'x'.repeat(2000))))(
      '/api/ai-settings',
      put(update())
    )
    expect((await dataOf(res)).detail).toHaveLength(512)
  })

  it('llm 503 settings_unavailable - 503 with the code, no llm detail', async () => {
    const res = await harness(
      fakeLlm(() => problem(503, 'settings_unavailable', 'identity at http://identity:8080 down'))
    )('/api/ai-settings')
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).not.toContain('identity:8080')
    expect(JSON.parse(text).data).toEqual({ code: 'settings_unavailable' })
  })

  it('llm 500 - 502 upstream_error, no llm body', async () => {
    const res = await harness(fakeLlm(() => new Response('panic: stack trace', { status: 500 })))(
      '/api/ai-settings'
    )
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain('stack trace')
    expect(JSON.parse(text).data).toEqual({ code: 'upstream_error' })
  })

  it('llm 502 with a problem body - 502 upstream_error, the detail is dropped', async () => {
    const res = await harness(fakeLlm(() => problem(502, 'internal', 'db at 10.0.0.3')))(
      '/api/ai-settings'
    )
    expect(res.status).toBe(502)
    expect(await dataOf(res)).toEqual({ code: 'upstream_error' })
  })

  it('llm down - 502 upstream_unavailable', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as Fetch
    const res = await harness({ fetch: down, calls: [] })('/api/ai-settings')
    expect(res.status).toBe(502)
    expect((await dataOf(res)).code).toBe('upstream_unavailable')
  })

  it('llm problem with an odd code - passed on as upstream_error', async () => {
    const res = await harness(fakeLlm(() => problem(404, '<script>', 'x')))('/api/ai-settings')
    expect(res.status).toBe(404)
    expect((await dataOf(res)).code).toBe('upstream_error')
  })

  it('llm answers settings without bounds - 502, never passed through', async () => {
    const res = await harness(fakeLlm(() => Response.json(llmSettings({ bounds: null }))))(
      '/api/ai-settings'
    )
    expect(res.status).toBe(502)
  })

  it('NUXT_LLM_URL unset - 503 not_configured, llm not called', async () => {
    const res = await harness(llm, { config: {} })('/api/ai-settings')
    expect(res.status).toBe(503)
    expect((await dataOf(res)).code).toBe('not_configured')
    expect(llm.calls).toHaveLength(0)
  })

  it('toHttpError - llm 401 stays 401, unknown error becomes 502', () => {
    expect(toHttpError(new LlmError(401, 'unauthenticated')).statusCode).toBe(401)
    expect(toHttpError(new Error('boom')).statusCode).toBe(502)
  })

  it('AiSettingsApi - trailing slashes of the base URL - one slash before /v1', async () => {
    const id = fakeLlm()
    await new AiSettingsApi(`${LLM}//`, id.fetch).get(TOKEN)
    expect(id.calls[0]?.url).toBe(`${LLM}/v1/ai-settings`)
  })
})

describe('readLlmConfig', () => {
  it('missing or empty - throws and names NUXT_LLM_URL', () => {
    for (const raw of [{}, { llm: {} }, { llm: { url: '  ' } }, { llm: { url: 5 } }]) {
      expect(() => readLlmConfig(raw)).toThrow(LlmConfigError)
      expect(() => readLlmConfig(raw)).toThrow('NUXT_LLM_URL')
    }
  })

  it.each([
    'llm.local',
    '/llm',
    'ftp://llm.local',
    'javascript:alert(1)',
    'http://user:pw@llm.local',
    'http://llm.local/?x=1',
    'http://llm.local/#x'
  ])('not an absolute http(s) URL %j - throws', (url) => {
    expect(() => readLlmConfig({ llm: { url } })).toThrow(LlmConfigError)
  })

  it('valid URL - trims spaces and trailing slashes, keeps a path', () => {
    expect(readLlmConfig({ llm: { url: ' http://localhost:8080/llm// ' } })).toEqual({
      baseUrl: 'http://localhost:8080/llm'
    })
  })
})

describe('route files', () => {
  it.each([
    ['index.get.ts', 'get'],
    ['index.put.ts', 'update']
  ])(
    'server/api/ai-settings/%s - runs aiSettingsRoutes.%s, the route this harness tests',
    (file, name) => {
      const src = readFileSync(
        new URL(`../../server/api/ai-settings/${file}`, import.meta.url),
        'utf8'
      )
      expect(src).toContain(`aiSettingsRoute(event, '${name}')`)
    }
  )

  it('aiSettingsRoutes - the write route needs the CSRF token, the read does not', () => {
    expect(Object.entries(aiSettingsRoutes).map(([k, r]) => [k, r.write])).toEqual([
      ['get', false],
      ['update', true]
    ])
  })

  it('nuxt.config.ts - /api/ai-settings answers with Cache-Control no-store', () => {
    const src = readFileSync(new URL('../../nuxt.config.ts', import.meta.url), 'utf8')
    expect(src).toContain("'/api/ai-settings/**': { headers: { 'cache-control': 'no-store' } }")
  })
})
