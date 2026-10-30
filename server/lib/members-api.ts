// The /api/org BFF routes for members and the audit list. Each route takes the session's access
// token (refreshed by AuthService) and calls identity. The browser never sees the token.
import {
  createError,
  getQuery,
  getRouterParam,
  type H3Event,
  readBody,
  setResponseHeader,
  setResponseStatus
} from 'h3'
import type { AuthService } from './auth'
import { type IdentityConfig, IdentityConfigError } from './identity-config'
import { MembersClient, MembersError } from './members'

export interface MembersApiDeps {
  auth: Pick<AuthService, 'current' | 'assertCsrfToken'>
  /** The identity settings, or the error that says why they are missing. */
  identity: IdentityConfig | IdentityConfigError
  fetch?: typeof fetch
  log?: (level: 'warn' | 'error', message: string) => void
}

/** Short text per status. Identity's `detail` never reaches the browser. */
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  502: 'Bad Gateway'
}

export class MembersApi {
  constructor(private readonly deps: MembersApiDeps) {}

  /** GET /api/org/members?cursor= */
  listMembers(event: H3Event) {
    return this.run(event, false, (client) => client.listMembers(getQuery(event).cursor))
  }

  /** POST /api/org/members { email, role } -> 202 with the pending invitation */
  invite(event: H3Event) {
    return this.run(event, true, async (client) => {
      const body = await readJson(event)
      const invitation = await client.invite(body.email, body.role)
      setResponseStatus(event, 202)
      return invitation
    })
  }

  /** GET /api/org/invitations?cursor= */
  listInvitations(event: H3Event) {
    return this.run(event, false, (client) => client.listInvitations(getQuery(event).cursor))
  }

  /** DELETE /api/org/invitations/:invitationId -> 204 */
  revokeInvitation(event: H3Event) {
    return this.run(event, true, async (client) => {
      await client.revokeInvitation(getRouterParam(event, 'invitationId'))
      setResponseStatus(event, 204)
      return null
    })
  }

  /** PATCH /api/org/members/:userId { role } */
  changeRole(event: H3Event) {
    return this.run(event, true, async (client) => {
      const body = await readJson(event)
      return client.changeRole(getRouterParam(event, 'userId'), body.role)
    })
  }

  /** POST /api/org/members/:userId/deactivate */
  deactivate(event: H3Event) {
    return this.run(event, true, (client) => client.deactivate(getRouterParam(event, 'userId')))
  }

  /** POST /api/org/members/:userId/reactivate */
  reactivate(event: H3Event) {
    return this.run(event, true, (client) => client.reactivate(getRouterParam(event, 'userId')))
  }

  /** GET /api/org/audit-events?cursor= */
  listAuditEvents(event: H3Event) {
    return this.run(event, false, (client) => client.listAuditEvents(getQuery(event).cursor))
  }

  /**
   * Session first (401), then the CSRF token on unsafe calls (403), then the identity settings
   * (503). Identity errors pass as status and code only.
   */
  private async run<T>(
    event: H3Event,
    unsafe: boolean,
    action: (client: MembersClient) => Promise<T>
  ): Promise<T> {
    const record = await this.deps.auth.current(event)
    if (!record) throw fail(401, 'unauthenticated')
    if (unsafe) this.deps.auth.assertCsrfToken(event, record)
    const identity = this.deps.identity
    if (identity instanceof IdentityConfigError) {
      throw createError({
        statusCode: 503,
        statusMessage: 'Service Unavailable',
        message: identity.message,
        data: { code: 'identity_not_configured', message: identity.message }
      })
    }
    const client = new MembersClient({
      baseUrl: identity.baseUrl,
      accessToken: record.tokens.accessToken,
      fetch: this.deps.fetch
    })
    try {
      return await action(client)
    } catch (err) {
      if (!(err instanceof MembersError)) throw err
      if (err.status >= 500) this.deps.log?.('warn', `identity call failed: ${err.message}`)
      if (err.retryAfter !== undefined) {
        setResponseHeader(event, 'retry-after', err.retryAfter)
      }
      throw fail(err.status, err.code)
    }
  }
}

function fail(status: number, code: string) {
  const text = STATUS_TEXT[status] ?? 'Error'
  return createError({ statusCode: status, statusMessage: text, message: text, data: { code } })
}

/** The JSON body as an object. Anything else counts as an empty body (the client refuses it). */
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
