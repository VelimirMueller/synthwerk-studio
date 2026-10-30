// Apps of the signed-in user's org, through identity (synthwerk#38). The BFF calls identity
// with the session's access token; the browser never sees a token. Identity checks roles,
// origins, settings and the apps-per-org limit again; the checks here only keep junk out.
import { createError, type H3Event, readBody } from 'h3'
import { readSettings, settingsFromIdentity, type WidgetSettings } from '../../shared/widget'
import type { SessionRecord } from './session'

export interface StudioApp {
  id: string
  name: string
  allowedOrigins: string[]
  widgetSettings: WidgetSettings
  createdAt: string
  updatedAt: string
}

export interface AppChange {
  name?: string
  allowedOrigins?: string[]
  widgetSettings?: WidgetSettings
}

/** Limits of contracts CreateAppRequest. */
export const MAX_NAME = 128
export const MAX_ORIGINS = 20
export const MAX_ORIGIN_LENGTH = 256
/** Pages of 100 the list follows: the apps_per_org maximum of the contract is 10000. */
export const MAX_PAGES = 100

/** A refusal of identity. `code` is the problem code (contracts Problem); `detail` holds no secret. */
export class IdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail = ''
  ) {
    super(`identity: ${status} ${code}`)
  }
}

export type Fetch = typeof fetch

/** The part of AuthService the app routes need. */
export interface SessionSource {
  current(event: H3Event): Promise<SessionRecord | null>
  assertCsrfToken(event: H3Event, record: SessionRecord): void
}

/** Identity app routes, called as the signed-in user. */
export class AppsApi {
  private readonly base: string

  constructor(
    baseUrl: string,
    private readonly fetcher: Fetch = fetch
  ) {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  private async call<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.fetcher(`${this.base}${path}`, {
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
      throw new IdentityError(502, 'upstream_unavailable')
    }
    if (res.status === 204) return undefined as T
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok) {
      const code = typeof json?.code === 'string' ? json.code : 'upstream_error'
      const detail = typeof json?.detail === 'string' ? json.detail.slice(0, 512) : ''
      throw new IdentityError(res.status, code, detail)
    }
    if (!json) throw new IdentityError(502, 'upstream_error')
    return json as T
  }

  /** The identity org id of the token's org (GET /v1/me). The session holds the Zitadel id. */
  async orgId(token: string): Promise<string> {
    const me = await this.call<{ org?: { id?: unknown } }>(token, 'GET', '/v1/me')
    if (typeof me.org?.id !== 'string' || me.org.id === '') {
      throw new IdentityError(502, 'upstream_error')
    }
    return me.org.id
  }

  /** Every app of the org: follows next_cursor, MAX_PAGES pages of 100 at most. */
  async list(token: string, orgId: string): Promise<StudioApp[]> {
    const apps: StudioApp[] = []
    let cursor: string | undefined
    for (let n = 0; n < MAX_PAGES; n++) {
      const query = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const page = await this.call<{ items?: unknown[]; next_cursor?: unknown }>(
        token,
        'GET',
        `/v1/orgs/${seg(orgId)}/apps?${query}`
      )
      apps.push(...(page.items ?? []).map(toApp))
      if (typeof page.next_cursor !== 'string' || page.next_cursor === '') return apps
      cursor = page.next_cursor
    }
    return apps
  }

  async get(token: string, orgId: string, appId: string): Promise<StudioApp> {
    return toApp(await this.call(token, 'GET', `/v1/orgs/${seg(orgId)}/apps/${seg(appId)}`))
  }

  async create(token: string, orgId: string, name: string, origins: string[]) {
    const body = { name, allowed_origins: origins }
    return toApp(await this.call(token, 'POST', `/v1/orgs/${seg(orgId)}/apps`, body))
  }

  async update(token: string, orgId: string, appId: string, change: AppChange) {
    const body = {
      ...(change.name === undefined ? {} : { name: change.name }),
      ...(change.allowedOrigins === undefined ? {} : { allowed_origins: change.allowedOrigins }),
      ...(change.widgetSettings === undefined ? {} : { widget_settings: change.widgetSettings })
    }
    return toApp(await this.call(token, 'PATCH', `/v1/orgs/${seg(orgId)}/apps/${seg(appId)}`, body))
  }

  async remove(token: string, orgId: string, appId: string): Promise<void> {
    await this.call(token, 'DELETE', `/v1/orgs/${seg(orgId)}/apps/${seg(appId)}`)
  }
}

/** Ids are UUIDs. Anything else never reaches identity. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function seg(id: string): string {
  if (!UUID.test(id)) throw new IdentityError(404, 'not_found')
  return id.toLowerCase()
}

function toApp(raw: unknown): StudioApp {
  const a = (raw ?? {}) as Record<string, unknown>
  if (typeof a.id !== 'string' || typeof a.name !== 'string' || !Array.isArray(a.allowed_origins)) {
    throw new IdentityError(502, 'upstream_error')
  }
  return {
    id: a.id,
    name: a.name,
    allowedOrigins: a.allowed_origins.filter((o): o is string => typeof o === 'string'),
    widgetSettings: settingsFromIdentity(a.widget_settings),
    createdAt: String(a.created_at ?? ''),
    updatedAt: String(a.updated_at ?? '')
  }
}

const bad = (detail: string) =>
  createError({
    statusCode: 400,
    statusMessage: 'Bad Request',
    data: { code: 'invalid_request', detail }
  })

function readName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '' || [...name].length > MAX_NAME) throw bad('Name: 1 to 128 characters.')
  return name
}

function readOrigins(value: unknown): string[] {
  const origins = Array.isArray(value)
    ? value.map((o) => (typeof o === 'string' ? o.trim() : ''))
    : []
  if (
    origins.length < 1 ||
    origins.length > MAX_ORIGINS ||
    !origins.every((o) => o !== '' && o.length <= MAX_ORIGIN_LENGTH)
  ) {
    throw bad('Origins: 1 to 20, one per line, like https://shop.example.')
  }
  return origins
}

/** Body of POST /api/apps: name and allowed origins. */
export function readCreate(body: unknown): { name: string; allowedOrigins: string[] } {
  const b = (body ?? {}) as Record<string, unknown>
  return { name: readName(b.name), allowedOrigins: readOrigins(b.allowedOrigins) }
}

/** Body of PATCH /api/apps/:id: any of name, allowed origins, widget settings. */
export function readChange(body: unknown): AppChange {
  const b = (body ?? {}) as Record<string, unknown>
  const change: AppChange = {}
  if (b.name !== undefined) change.name = readName(b.name)
  if (b.allowedOrigins !== undefined) change.allowedOrigins = readOrigins(b.allowedOrigins)
  if (b.widgetSettings !== undefined) {
    const s = readSettings(b.widgetSettings)
    if (!s) throw bad('Widget settings: a value is not allowed, or the greeting is too long.')
    change.widgetSettings = s
  }
  if (Object.keys(change).length === 0) throw bad('Nothing to change.')
  return change
}

/** Maps an identity refusal to the studio answer. Unknown failures become 502. */
export function toHttpError(err: unknown) {
  if (err instanceof IdentityError) {
    const status = err.status === 401 ? 401 : err.status >= 500 ? 502 : err.status
    return createError({
      statusCode: status,
      statusMessage: status === 502 ? 'Bad Gateway' : 'Refused',
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

/**
 * Runs one app route as the signed-in user: needs a session (401), and for a write the CSRF
 * token of the session (403). Resolves the identity org id, then runs `fn`.
 */
export async function asMember<T>(
  event: H3Event,
  deps: { auth: SessionSource; api: AppsApi },
  write: boolean,
  fn: (ctx: { token: string; orgId: string; body: unknown }) => Promise<T>
): Promise<T> {
  const record = await deps.auth.current(event)
  if (!record) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      data: { code: 'unauthenticated' }
    })
  }
  if (write) deps.auth.assertCsrfToken(event, record)
  const body = write && event.method !== 'DELETE' ? await readBody(event) : undefined
  try {
    const token = record.tokens.accessToken
    const orgId = await deps.api.orgId(token)
    return await fn({ token, orgId, body })
  } catch (err) {
    throw toHttpError(err)
  }
}

type Ctx = { token: string; orgId: string; body: unknown; appId: string }

/** The app routes: method, whether it writes (CSRF), and what it calls. server/api/apps uses them. */
export const appRoutes = {
  list: { write: false, run: (api: AppsApi, c: Ctx) => api.list(c.token, c.orgId) },
  create: {
    write: true,
    run: (api: AppsApi, c: Ctx) => {
      const input = readCreate(c.body)
      return api.create(c.token, c.orgId, input.name, input.allowedOrigins)
    }
  },
  get: { write: false, run: (api: AppsApi, c: Ctx) => api.get(c.token, c.orgId, c.appId) },
  update: {
    write: true,
    run: (api: AppsApi, c: Ctx) => api.update(c.token, c.orgId, c.appId, readChange(c.body))
  },
  remove: {
    write: true,
    run: (api: AppsApi, c: Ctx) => api.remove(c.token, c.orgId, c.appId)
  }
} as const

/** Runs one entry of appRoutes for the request. */
export function runAppRoute<K extends keyof typeof appRoutes>(
  event: H3Event,
  deps: { auth: SessionSource; api: AppsApi },
  name: K
): Promise<Awaited<ReturnType<(typeof appRoutes)[K]['run']>>> {
  const route = appRoutes[name]
  const appId = event.context.params?.appId ?? ''
  return asMember(event, deps, route.write, (c) =>
    (route.run as (api: AppsApi, c: Ctx) => Promise<never>)(deps.api, { ...c, appId })
  )
}
