// The /api/builder BFF routes (synthwerk#46, docs/features/page-builder.md). The studio server
// owns the builder data, so this class is the authorization point: session, CSRF on writes,
// database settings, token role, org key, then the stored membership in identity.
import { createError, getRouterParam, type H3Event, isError, setResponseStatus } from 'h3'
import {
  ContentError,
  checkContent,
  LIMITS,
  LOCALES,
  type Locale,
  SLUG_PATTERN
} from '../../shared/sections'
import type { AuthService } from './auth'
import { readJsonBody } from './body'
import { BuilderConfigError } from './builder-config'
import { type Author, type BuilderStore, BuilderStoreError } from './builder-store'
import { isOrgAdmin } from './health'
import type { IdentityConfig, IdentityConfigError } from './identity-config'
import { confirmOrgAdmin, OrgAdminError } from './org-admin'
import type { SessionRecord } from './session'

export interface BuilderApiDeps {
  auth: Pick<AuthService, 'current' | 'assertCsrfToken'>
  identity: IdentityConfig | IdentityConfigError
  /** Opens the store (migrations done), or the error that says why it is not configured. */
  store: (() => Promise<BuilderStore>) | BuilderConfigError
  fetch?: typeof fetch
  log?: (level: 'warn' | 'error', message: string) => void
}

/** Largest request body. A full page with every limit used is far below it. */
export const MAX_BODY_BYTES = 256 * 1024
export const ORG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const SUB_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_VERSION = 1_000_000

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  502: 'Bad Gateway',
  503: 'Service Unavailable'
}

interface Access {
  store: BuilderStore
  orgId: string
  /** `user:<sub>`, the audit actor. */
  actor: string
  /** The actor and the identity org UUID, for the writes that emit an event. */
  author: Author
}

/** A refused input. `field` names the bad field for the editor. */
class InputError extends Error {
  constructor(
    readonly code: string,
    readonly field?: string
  ) {
    super(code)
  }
}

export class BuilderApi {
  constructor(private readonly deps: BuilderApiDeps) {}

  /** GET /api/builder/pages */
  list(event: H3Event) {
    return this.run(event, false, ({ store, orgId }) => store.listPages(orgId))
  }

  /** POST /api/builder/pages { slug, locale, title } -> 201 */
  create(event: H3Event) {
    return this.run(event, true, async ({ store, orgId, author }) => {
      const body = await readJson(event)
      const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
      if (!SLUG_PATTERN.test(slug)) throw new InputError('invalid_request', 'slug')
      const locale = body.locale
      if (typeof locale !== 'string' || !LOCALES.includes(locale as Locale)) {
        throw new InputError('invalid_request', 'locale')
      }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (title.length < 1 || title.length > LIMITS.short || hasControl(title)) {
        throw new InputError('invalid_request', 'title')
      }
      const page = await store.createPage(orgId, author, { slug, locale: locale as Locale, title })
      setResponseStatus(event, 201)
      return page
    })
  }

  /** GET /api/builder/pages/:pageId -> page with draft and versions */
  get(event: H3Event) {
    return this.run(event, false, ({ store, orgId }) => store.getPage(orgId, pageId(event)))
  }

  /** PUT /api/builder/pages/:pageId/draft { revision, content: { title, sections } } */
  saveDraft(event: H3Event) {
    return this.run(event, true, async ({ store, orgId, actor }) => {
      const id = pageId(event)
      const body = await readJson(event)
      const revision = positiveInt(body.revision, 'revision')
      const content = checkContent(body.content)
      return store.saveDraft(orgId, id, actor, revision, content)
    })
  }

  /** POST /api/builder/pages/:pageId/publish { revision } -> 201 */
  publish(event: H3Event) {
    return this.run(event, true, async ({ store, orgId, author }) => {
      const id = pageId(event)
      const body = await readJson(event)
      const page = await store.publish(orgId, id, author, positiveInt(body.revision, 'revision'))
      setResponseStatus(event, 201)
      return page
    })
  }

  /** POST /api/builder/pages/:pageId/rollback { version } */
  rollback(event: H3Event) {
    return this.run(event, true, async ({ store, orgId, author }) => {
      const id = pageId(event)
      const body = await readJson(event)
      return store.rollback(orgId, id, author, positiveInt(body.version, 'version'))
    })
  }

  /** GET /api/builder/pages/:pageId/versions/:version */
  version(event: H3Event) {
    return this.run(event, false, ({ store, orgId }) => {
      const raw = getRouterParam(event, 'version') ?? ''
      if (!/^[1-9][0-9]{0,6}$/.test(raw) || Number(raw) > MAX_VERSION) {
        throw new BuilderStoreError(404, 'version_not_found')
      }
      return store.getVersion(orgId, pageId(event), Number(raw))
    })
  }

  /** GET /api/builder/pages/:pageId/events -> the newest builder events of the page */
  events(event: H3Event) {
    return this.run(event, false, async ({ store, orgId }) => ({
      items: await store.listEvents(orgId, pageId(event))
    }))
  }

  /**
   * Session (401), CSRF on writes (403), database settings (503), token role (403), org key and
   * subject (403), stored membership in identity (401, 403, 502, 503), database (503). Then the
   * action. Errors pass as status and code only (plus `field` for a bad input).
   */
  private async run<T>(
    event: H3Event,
    unsafe: boolean,
    action: (access: Access) => Promise<T> | T
  ): Promise<T> {
    const record = await this.deps.auth.current(event)
    if (!record) throw fail(401, 'unauthenticated')
    if (unsafe) this.deps.auth.assertCsrfToken(event, record)
    const open = this.deps.store
    if (open instanceof BuilderConfigError) {
      throw notConfigured('builder_not_configured', open.message)
    }
    if (!isOrgAdmin(record.identity)) throw fail(403, 'forbidden')
    const orgId = record.identity.org.id
    const sub = record.identity.user.sub
    if (!ORG_PATTERN.test(orgId) || !SUB_PATTERN.test(sub)) throw fail(403, 'forbidden')
    const identityOrgId = await this.confirmAdmin(record)
    let store: BuilderStore
    try {
      store = await open()
    } catch (err) {
      throw this.unavailable(err)
    }
    try {
      const actor = `user:${sub}`
      return await action({ store, orgId, actor, author: { actor, identityOrgId } })
    } catch (err) {
      if (err instanceof BuilderStoreError) throw fail(err.status, err.code)
      if (err instanceof ContentError) throw fail(400, 'invalid_content', err.path)
      if (err instanceof InputError) throw fail(400, err.code, err.field)
      if (isError(err)) throw err
      throw this.unavailable(err)
    }
  }

  /** The identity org UUID of the session org, once identity confirmed the stored role. */
  private async confirmAdmin(record: SessionRecord): Promise<string> {
    try {
      return await confirmOrgAdmin(this.deps.identity, record, this.deps.fetch)
    } catch (err) {
      if (!(err instanceof OrgAdminError)) throw err
      if (err.status === 503) throw notConfigured(err.code, err.message)
      if (err.status === 502) this.deps.log?.('warn', err.message)
      throw fail(err.status, err.code)
    }
  }

  /** A database failure. The log names the error code only: no URL, no SQL, no content. */
  private unavailable(err: unknown) {
    const code = (err as { code?: unknown } | null)?.code
    const name = err instanceof Error ? err.name : 'error'
    this.deps.log?.('warn', `database call failed (${typeof code === 'string' ? code : name})`)
    return fail(503, 'builder_unavailable')
  }
}

function pageId(event: H3Event): string {
  const id = (getRouterParam(event, 'pageId') ?? '').toLowerCase()
  if (!UUID_PATTERN.test(id)) throw new BuilderStoreError(404, 'page_not_found')
  return id
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the check refuses control characters
const hasControl = (text: string) => /[\u0000-\u001f\u007f]/.test(text)

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2 ** 31 - 1) {
    throw new InputError('invalid_request', field)
  }
  return value
}

function fail(status: number, code: string, field?: string) {
  const text = STATUS_TEXT[status] ?? 'Error'
  return createError({
    statusCode: status,
    statusMessage: text,
    message: text,
    data: field === undefined ? { code } : { code, field }
  })
}

function notConfigured(code: string, message: string) {
  return createError({
    statusCode: 503,
    statusMessage: 'Service Unavailable',
    message,
    data: { code, message }
  })
}

/** The JSON body as an object, capped at MAX_BODY_BYTES (lib/body.ts). Anything else is a bad request. */
async function readJson(event: H3Event): Promise<Record<string, unknown>> {
  const body = await readJsonBody(event, MAX_BODY_BYTES)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InputError('invalid_request')
  }
  return body as Record<string, unknown>
}
