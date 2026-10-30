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

/** The stored role identity confirmed, with the identity org UUID. */
export interface ConfirmedRole {
  identityOrgId: string
  role: 'owner' | 'admin'
}

/** Pages of 100 members read to find the caller. An org this large is far beyond the demo. */
export const MAX_ROLE_PAGES = 10

/**
 * Like confirmOrgAdmin, and also returns the stored role of the caller: it reads the members
 * pages until it finds the caller's own row (synthwerk#108: delete is for owners only, and a
 * token claim can be stale after a demotion). Caller not found, not active, or a member: 403.
 */
export async function confirmOrgRole(
  identity: IdentityConfig | IdentityConfigError,
  record: SessionRecord,
  fetchImpl?: typeof fetch
): Promise<ConfirmedRole> {
  if (identity instanceof IdentityConfigError) {
    throw new OrgAdminError(503, 'identity_not_configured', identity.message)
  }
  const members = new MembersClient({
    baseUrl: identity.baseUrl,
    accessToken: record.tokens.accessToken,
    fetch: fetchImpl
  })
  const sub = record.identity.user.sub
  try {
    let cursor: string | undefined
    for (let i = 0; i < MAX_ROLE_PAGES; i++) {
      const page = await members.listMembers(cursor, 100)
      const self = page.items.find((m) => m.user_id === sub)
      if (self) {
        if (self.status !== 'active' || (self.role !== 'owner' && self.role !== 'admin')) break
        return { identityOrgId: await members.org(), role: self.role }
      }
      if (!page.next_cursor || page.next_cursor === cursor) break
      cursor = page.next_cursor
    }
  } catch (err) {
    throw toOrgAdminError(err)
  }
  throw new OrgAdminError(403, 'forbidden', 'not an active owner or admin')
}

function toOrgAdminError(err: unknown): unknown {
  if (!(err instanceof MembersError)) return err
  if (err.status === 401) return new OrgAdminError(401, 'unauthenticated', 'identity refused')
  if (err.status === 403 || err.status === 404) {
    return new OrgAdminError(403, 'forbidden', 'not an active owner or admin')
  }
  return new OrgAdminError(502, 'upstream_unavailable', `identity check failed: ${err.message}`)
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
    throw toOrgAdminError(err)
  }
}
