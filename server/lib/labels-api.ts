// The /api/labels BFF routes (synthwerk#44, docs/features/label-admin.md). Vision trusts the org
// id in the path and takes only the service token, so this class is the authorization point:
// session, CSRF, token role, then the stored membership in identity. The browser never sees a token.
import { createError, getRouterParam, type H3Event, readBody, setResponseStatus } from 'h3'
import type { AuthService } from './auth'
import { isOrgAdmin } from './health'
import type { IdentityConfig, IdentityConfigError } from './identity-config'
import {
  checkLabelId,
  checkLabelInput,
  checkVisionOrg,
  LabelsError,
  VisionLabelsClient
} from './labels'
import { confirmOrgAdmin, OrgAdminError } from './org-admin'
import type { SessionRecord } from './session'
import { type VisionConfig, VisionConfigError } from './vision-config'

export interface LabelsApiDeps {
  auth: Pick<AuthService, 'current' | 'assertCsrfToken'>
  /** The identity settings, or the error that says why they are missing. */
  identity: IdentityConfig | IdentityConfigError
  /** The vision settings, or the error that says why they are missing. */
  vision: VisionConfig | VisionConfigError
  fetch?: typeof fetch
  log?: (level: 'warn' | 'error', message: string) => void
}

/** Short text per status. Vision's `detail` never reaches the browser. */
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  502: 'Bad Gateway',
  503: 'Service Unavailable'
}

interface Access {
  client: VisionLabelsClient
  orgId: string
}

export class LabelsApi {
  constructor(private readonly deps: LabelsApiDeps) {}

  /** GET /api/labels -> the label set of the session org */
  list(event: H3Event) {
    return this.run(event, false, ({ client, orgId }) => client.getLabelSet(orgId))
  }

  /** POST /api/labels { name, topic, prompt?, newTopic?, topicParent? } -> 201 with the label */
  add(event: H3Event) {
    return this.run(event, true, async ({ client, orgId }) => {
      const input = checkLabelInput(await readJson(event))
      const label = await client.addLabel(orgId, input)
      setResponseStatus(event, 201)
      return label
    })
  }

  /** DELETE /api/labels/:labelId -> 204 */
  remove(event: H3Event) {
    return this.run(event, true, async ({ client, orgId }) => {
      await client.deleteLabel(orgId, checkLabelId(getRouterParam(event, 'labelId')))
      setResponseStatus(event, 204)
      return null
    })
  }

  /**
   * Session (401), CSRF on unsafe calls (403), vision settings (503), token role (403), org key
   * (403), stored membership in identity (401, 403, 502, 503). Then the action. Errors pass as
   * status and code only.
   */
  private async run<T>(
    event: H3Event,
    unsafe: boolean,
    action: (access: Access) => Promise<T>
  ): Promise<T> {
    const record = await this.deps.auth.current(event)
    if (!record) throw fail(401, 'unauthenticated')
    if (unsafe) this.deps.auth.assertCsrfToken(event, record)
    const vision = this.deps.vision
    if (vision instanceof VisionConfigError) throw notConfigured('vision_not_configured', vision)
    if (!isOrgAdmin(record.identity)) throw fail(403, 'forbidden')
    try {
      const orgId = checkVisionOrg(record.identity.org.id)
      await this.confirmAdmin(record)
      const client = new VisionLabelsClient({
        baseUrl: vision.baseUrl,
        adminToken: vision.adminToken,
        fetch: this.deps.fetch
      })
      return await action({ client, orgId })
    } catch (err) {
      if (!(err instanceof LabelsError)) throw err
      if (err.status >= 500) this.deps.log?.('warn', `vision call failed: ${err.message}`)
      throw fail(err.status, err.code)
    }
  }

  /** The stored membership in identity (lib/org-admin.ts). */
  private async confirmAdmin(record: SessionRecord): Promise<void> {
    try {
      await confirmOrgAdmin(this.deps.identity, record, this.deps.fetch)
    } catch (err) {
      if (!(err instanceof OrgAdminError)) throw err
      if (err.status === 503) throw notConfigured(err.code, err)
      if (err.status === 502) this.deps.log?.('warn', err.message)
      throw fail(err.status, err.code)
    }
  }
}

function fail(status: number, code: string) {
  const text = STATUS_TEXT[status] ?? 'Error'
  return createError({ statusCode: status, statusMessage: text, message: text, data: { code } })
}

function notConfigured(code: string, err: Error) {
  return createError({
    statusCode: 503,
    statusMessage: 'Service Unavailable',
    message: err.message,
    data: { code, message: err.message }
  })
}

/** The JSON body as an object. Anything else counts as an empty body (the check refuses it). */
async function readJson(event: H3Event): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await readBody(event)
  } catch {
    throw fail(400, 'invalid_request')
  }
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}
