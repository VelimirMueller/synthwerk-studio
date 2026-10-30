// DELETE /api/me: the user deletes the own account (synthwerk#41). The BFF calls identity
// DELETE /v1/me with the access token and, as proof of the fresh sign-in, the ID token of the
// step-up sign-in (header X-Synthwerk-Id-Token). Both tokens stay on the server.
import { createError, type H3Event } from 'h3'
import type { AuthService } from './auth'
import { type IdentityConfig, IdentityConfigError } from './identity-config'

/** The header that carries the ID token to identity (contracts openapi/identity 0.7.0). */
export const ID_TOKEN_HEADER = 'x-synthwerk-id-token'

export interface AccountApiDeps {
  auth: Pick<AuthService, 'takeStepUp' | 'endAfterDelete'>
  /** The identity settings, or the error that says why they are missing. */
  identity: IdentityConfig | IdentityConfigError
  fetch?: typeof fetch
  log?: (level: 'warn' | 'error', message: string) => void
}

/** What the page gets after a delete. */
export interface DeleteAccountResult {
  status: 'accepted'
  deletedOrgIds: string[]
}

/** Identity answers the BFF passes on as status and code. Identity's detail never passes. */
const PASSED: Record<number, { text: string; codes: string[] }> = {
  401: { text: 'Unauthorized', codes: ['unauthenticated'] },
  403: { text: 'Forbidden', codes: ['recent_mfa_required', 'forbidden'] },
  409: { text: 'Conflict', codes: ['last_owner'] }
}

export class AccountApi {
  constructor(private readonly deps: AccountApiDeps) {}

  /**
   * DELETE /api/me. Needs the session (401), the CSRF token (403 csrf_failed) and a step-up
   * sign-in for delete_account at most STEP_UP_TTL_SECONDS old (403 step_up_required). The
   * step-up is used up by this call, whatever identity answers. On 202 the session ends.
   */
  async deleteAccount(event: H3Event): Promise<DeleteAccountResult> {
    const identity = this.deps.identity
    if (identity instanceof IdentityConfigError) {
      throw createError({
        statusCode: 503,
        statusMessage: 'Service Unavailable',
        message: identity.message,
        data: { code: 'identity_not_configured', message: identity.message }
      })
    }
    const record = await this.deps.auth.takeStepUp(event, 'delete_account')
    const idToken = record.tokens.idToken
    if (!idToken) throw fail(403, 'Forbidden', 'step_up_required')

    let res: Response
    try {
      res = await (this.deps.fetch ?? fetch)(`${identity.baseUrl}/v1/me`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${record.tokens.accessToken}`,
          [ID_TOKEN_HEADER]: idToken,
          accept: 'application/json'
        },
        redirect: 'error'
      })
    } catch (err) {
      this.deps.log?.(
        'warn',
        `identity delete failed: ${err instanceof Error ? err.name : 'error'}`
      )
      throw fail(502, 'Bad Gateway', 'upstream_unavailable')
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (res.status === 202) {
      await this.deps.auth.endAfterDelete(event, record)
      const ids = Array.isArray(body.deleted_org_ids)
        ? body.deleted_org_ids.filter((v): v is string => typeof v === 'string')
        : []
      return { status: 'accepted', deletedOrgIds: ids }
    }
    const passed = PASSED[res.status]
    const code = typeof body.code === 'string' ? body.code : ''
    if (passed?.codes.includes(code)) throw fail(res.status, passed.text, code)
    this.deps.log?.('warn', `identity delete: status ${res.status}`)
    throw fail(502, 'Bad Gateway', 'upstream_unavailable')
  }
}

function fail(status: number, text: string, code: string) {
  return createError({ statusCode: status, statusMessage: text, message: text, data: { code } })
}
