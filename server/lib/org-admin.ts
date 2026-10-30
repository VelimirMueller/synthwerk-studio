// Confirms in identity that the session user is an active stored owner or admin of the org.
// Token claims can be stale after a demotion or a deactivation. Identity answers a one-item
// members page only to an active stored owner or admin, so that call confirms the role.
// Used by the BFF routes that call a service with a service credential (labels, builder).
// It returns the identity org UUID of the caller (GET /v1/me, read for the members call anyway):
// the builder writes it into its bus events (synthwerk#106).
import { type IdentityConfig, IdentityConfigError } from './identity-config'
import { MembersClient, MembersError } from './members'
import type { SessionRecord } from './session'

/** Why the role could not be confirmed. `status` and `code` go to the browser. */
export class OrgAdminError extends Error {
  constructor(
    readonly status: 401 | 403 | 502 | 503,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'OrgAdminError'
  }
}

export async function confirmOrgAdmin(
  identity: IdentityConfig | IdentityConfigError,
  record: SessionRecord,
  fetchImpl?: typeof fetch
): Promise<string> {
  if (identity instanceof IdentityConfigError) {
    throw new OrgAdminError(503, 'identity_not_configured', identity.message)
  }
  const members = new MembersClient({
    baseUrl: identity.baseUrl,
    accessToken: record.tokens.accessToken,
    fetch: fetchImpl
  })
  try {
    await members.listMembers(undefined, 1)
    // Cached by the client: listMembers read it first, so this makes no second call.
    return await members.org()
  } catch (err) {
    if (!(err instanceof MembersError)) throw err
    if (err.status === 401) throw new OrgAdminError(401, 'unauthenticated', 'identity refused')
    if (err.status === 403 || err.status === 404) {
      throw new OrgAdminError(403, 'forbidden', 'not an active owner or admin')
    }
    throw new OrgAdminError(502, 'upstream_unavailable', `identity check failed: ${err.message}`)
  }
}
