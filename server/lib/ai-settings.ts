// AI settings of the signed-in user's org, through synthwerk-llm (synthwerk#39). The BFF calls
// llm with the session's access token; the browser never sees a token. llm acts in the token's
// org and checks the role (owner or admin), the bounds and the version again. The checks here
// only keep junk out.
import { createError, type H3Event } from 'h3'
import type { SessionSource } from './apps'
import { readJsonBody } from './body'
import { LlmConfigError, type RawLlmConfig, readLlmConfig } from './llm-config'

export interface AiSettingsBounds {
  models: string[]
  maxInputChars: number
  /** Tokens per user per UTC day of the org's plan. 0 = no limit. */
  userTokensPerDay: number
  systemPromptMaxChars: number
  temperatureMax: number
}

export interface AiSettings {
  model: string
  allowedModels: string[]
  systemPrompt: string
  maxInputChars: number
  /** 0 = the plan limit only. */
  userTokensPerDay: number
  /** null = the model default. */
  temperature: number | null
  /** 0 = the org never saved settings. */
  version: number
  updatedAt: string | null
  bounds: AiSettingsBounds
}

/** Body of PUT /api/ai-settings: every setting, and the version the page read. */
export interface AiSettingsUpdate {
  version: number
  model: string
  allowedModels: string[]
  systemPrompt: string
  maxInputChars: number
  userTokensPerDay: number
  temperature: number | null
}

/** Limits of contracts UpdateAiSettingsRequest (llm spec). llm checks the org bounds. */
export const MAX_SYSTEM_PROMPT = 4000
export const MAX_INPUT_CHARS = 8000
export const MAX_USER_TOKENS_PER_DAY = 1_000_000_000_000
export const MAX_MODELS = 32
export const MAX_TEMPERATURE = 2
/** Max characters of an llm problem detail the page gets. */
export const MAX_DETAIL = 512

/** contracts ModelAlias: lower case, at most 64 characters. */
const ALIAS = /^[a-z][a-z0-9_-]{0,63}$/
/** Control characters other than tab, line feed and carriage return (C0, DEL, C1). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
/** A problem code we pass on. Anything else becomes upstream_error. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/

/** A refusal of llm. `code` is the problem code (contracts Problem); `detail` holds no secret. */
export class LlmError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail = ''
  ) {
    super(`llm: ${status} ${code}`)
  }
}

export type Fetch = typeof fetch

/** llm `/v1/ai-settings`, called as the signed-in user. */
export class AiSettingsApi {
  private readonly base: string

  constructor(
    baseUrl: string,
    private readonly fetcher: Fetch = fetch
  ) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  private async call(token: string, method: 'GET' | 'PUT', body?: unknown): Promise<AiSettings> {
    let res: Response
    try {
      res = await this.fetcher(`${this.base}/v1/ai-settings`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error'
      })
    } catch {
      throw new LlmError(502, 'upstream_unavailable')
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok) {
      const code = typeof json?.code === 'string' && CODE.test(json.code) ? json.code : ''
      const detail = typeof json?.detail === 'string' ? json.detail.slice(0, MAX_DETAIL) : ''
      throw new LlmError(res.status, code || 'upstream_error', detail)
    }
    return toSettings(json)
  }

  get(token: string): Promise<AiSettings> {
    return this.call(token, 'GET')
  }

  /** Full replace. Absent temperature = the model default. */
  update(token: string, s: AiSettingsUpdate): Promise<AiSettings> {
    return this.call(token, 'PUT', {
      version: s.version,
      model: s.model,
      allowed_models: s.allowedModels,
      system_prompt: s.systemPrompt,
      max_input_chars: s.maxInputChars,
      user_tokens_per_day: s.userTokensPerDay,
      ...(s.temperature === null ? {} : { temperature: s.temperature })
    })
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const aliases = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((a) => typeof a === 'string') ? (v as string[]) : null

/** Reads an llm AiSettings. A missing or wrong field is 502: never passed through. */
function toSettings(raw: unknown): AiSettings {
  const s = (raw ?? {}) as Record<string, unknown>
  const b = (s.bounds ?? {}) as Record<string, unknown>
  const allowed = aliases(s.allowed_models)
  const models = aliases(b.models)
  if (
    typeof s.model !== 'string' ||
    !allowed ||
    typeof s.system_prompt !== 'string' ||
    !isInt(s.max_input_chars) ||
    !isInt(s.user_tokens_per_day) ||
    !isInt(s.version) ||
    !models ||
    !isInt(b.max_input_chars) ||
    !isInt(b.user_tokens_per_day) ||
    !isInt(b.system_prompt_max_chars) ||
    !isNum(b.temperature_max)
  ) {
    throw new LlmError(502, 'upstream_error')
  }
  return {
    model: s.model,
    allowedModels: allowed,
    systemPrompt: s.system_prompt,
    maxInputChars: s.max_input_chars,
    userTokensPerDay: s.user_tokens_per_day,
    temperature: isNum(s.temperature) ? s.temperature : null,
    version: s.version,
    updatedAt: typeof s.updated_at === 'string' ? s.updated_at : null,
    bounds: {
      models,
      maxInputChars: b.max_input_chars,
      userTokensPerDay: b.user_tokens_per_day,
      systemPromptMaxChars: b.system_prompt_max_chars,
      temperatureMax: b.temperature_max
    }
  }
}

const bad = (detail: string) =>
  createError({
    statusCode: 400,
    statusMessage: 'Bad Request',
    data: { code: 'invalid_request', detail }
  })

function readInt(value: unknown, min: number, max: number, detail: string): number {
  if (!isInt(value) || value < min || value > max) throw bad(detail)
  return value
}

function readAlias(value: unknown, detail: string): string {
  if (typeof value !== 'string' || !ALIAS.test(value)) throw bad(detail)
  return value
}

/**
 * Body of PUT /api/ai-settings. Strict: every field must be there and in range. Unknown keys
 * are dropped. llm checks the org bounds (aliases of the service, plan limit) again.
 */
export function readUpdate(body: unknown): AiSettingsUpdate {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const version = readInt(b.version, 0, Number.MAX_SAFE_INTEGER, 'version: an integer, 0 or more.')
  const model = readAlias(b.model, 'model: a model alias, like default.')
  if (!Array.isArray(b.allowedModels) || b.allowedModels.length < 1) {
    throw bad('allowed_models: 1 to 32 model aliases.')
  }
  if (b.allowedModels.length > MAX_MODELS) throw bad('allowed_models: 1 to 32 model aliases.')
  const allowedModels = b.allowedModels.map((a) =>
    readAlias(a, 'allowed_models: 1 to 32 model aliases.')
  )
  if (new Set(allowedModels).size !== allowedModels.length) {
    throw bad('allowed_models: each alias once.')
  }
  if (!allowedModels.includes(model)) throw bad('allowed_models: must hold the default model.')
  if (typeof b.systemPrompt !== 'string') throw bad('system_prompt: plain text.')
  if ([...b.systemPrompt].length > MAX_SYSTEM_PROMPT) {
    throw bad('system_prompt: 4000 characters or less.')
  }
  if (CONTROL.test(b.systemPrompt)) {
    throw bad('system_prompt: plain text. Line breaks and tabs only, no other control characters.')
  }
  const maxInputChars = readInt(
    b.maxInputChars,
    1,
    MAX_INPUT_CHARS,
    'max_input_chars: an integer from 1 to 8000.'
  )
  const userTokensPerDay = readInt(
    b.userTokensPerDay,
    0,
    MAX_USER_TOKENS_PER_DAY,
    'user_tokens_per_day: an integer, 0 or more.'
  )
  let temperature: number | null = null
  if (b.temperature !== undefined && b.temperature !== null) {
    if (!isNum(b.temperature) || b.temperature < 0 || b.temperature > MAX_TEMPERATURE) {
      throw bad('temperature: a number from 0 to 2, or empty for the model default.')
    }
    temperature = b.temperature
  }
  return {
    version,
    model,
    allowedModels,
    systemPrompt: b.systemPrompt,
    maxInputChars,
    userTokensPerDay,
    temperature
  }
}

/**
 * Maps an llm refusal to the studio answer. A 4xx keeps its code and the cut detail. llm 503
 * `settings_unavailable` stays 503. Any other 5xx becomes 502 without the llm body.
 */
export function toHttpError(err: unknown) {
  if (err instanceof LlmError) {
    if (err.status >= 500) {
      const unavailable = err.status === 503 && err.code === 'settings_unavailable'
      const status = unavailable ? 503 : 502
      const code = unavailable || err.code === 'upstream_unavailable' ? err.code : 'upstream_error'
      return createError({
        statusCode: status,
        statusMessage: unavailable ? 'Service Unavailable' : 'Bad Gateway',
        data: { code }
      })
    }
    return createError({
      statusCode: err.status,
      statusMessage: 'Refused',
      data: { code: err.code, ...(err.detail ? { detail: err.detail } : {}) }
    })
  }
  if (err && typeof err === 'object' && 'statusCode' in err) return err
  return createError({
    statusCode: 502,
    statusMessage: 'Bad Gateway',
    data: { code: 'upstream_error' }
  })
}

/** The llm client from the runtime config. Unset or bad NUXT_LLM_URL: 503 `not_configured`. */
export function aiSettingsApiFrom(raw: RawLlmConfig, fetcher?: Fetch): AiSettingsApi {
  try {
    return new AiSettingsApi(readLlmConfig(raw).baseUrl, fetcher)
  } catch (err) {
    if (!(err instanceof LlmConfigError)) throw err
    console.error(`[ai-settings] ${err.message}`)
    throw createError({
      statusCode: 503,
      statusMessage: 'Service Unavailable',
      data: { code: 'not_configured' }
    })
  }
}

type Ctx = { token: string; body: unknown }

/** The AI settings routes: whether it writes (CSRF), and what it calls. */
export const aiSettingsRoutes = {
  get: { write: false, run: (api: AiSettingsApi, c: Ctx) => api.get(c.token) },
  update: {
    write: true,
    run: (api: AiSettingsApi, c: Ctx) => api.update(c.token, readUpdate(c.body))
  }
} as const

/**
 * Runs one AI settings route as the signed-in user: needs a session (401), and for a write the
 * CSRF token of the session (403). `api` is read only after these checks.
 */
export async function runAiSettingsRoute(
  event: H3Event,
  deps: { auth: SessionSource; api: () => AiSettingsApi },
  name: keyof typeof aiSettingsRoutes
): Promise<AiSettings> {
  const route = aiSettingsRoutes[name]
  const record = await deps.auth.current(event)
  if (!record) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      data: { code: 'unauthenticated' }
    })
  }
  if (route.write) deps.auth.assertCsrfToken(event, record)
  const body = route.write ? await readJsonBody(event) : undefined
  try {
    return await route.run(deps.api(), { token: record.tokens.accessToken, body })
  } catch (err) {
    throw toHttpError(err)
  }
}
