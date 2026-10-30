// Calls to the /api/org BFF routes (members and audit). Unsafe calls carry the session CSRF token.

export type OrgRole = 'owner' | 'admin' | 'member'

export interface OrgMember {
  user_id: string
  role: OrgRole
  status: 'active' | 'deactivated'
  updated_at: string
}

/** A pending invitation. It never says whether the email has an account. */
export interface OrgInvitation {
  id: string
  email: string
  role: OrgRole
  invited_by: string
  created_at: string
}

export interface OrgAuditEvent {
  id: string
  type: string
  time: string
  actor: string
  subject?: string
  data: Record<string, unknown>
}

export interface OrgPage<T> {
  items: T[]
  next_cursor?: string
}

/** Status and code of a failed /api/org call. `status` 0 = no answer. */
export interface OrgApiError {
  status: number
  code: string
}

/** Reads the status and the `data.code` the BFF puts on an error. */
export function orgApiError(err: unknown): OrgApiError {
  const e = err as { statusCode?: unknown; data?: { data?: { code?: unknown } } } | null
  const status = typeof e?.statusCode === 'number' ? e.statusCode : 0
  const code = e?.data?.data?.code
  return { status, code: typeof code === 'string' ? code : '' }
}

export function useOrgApi() {
  const { session } = useAuthSession()

  const unsafe = <M extends 'POST' | 'PATCH' | 'DELETE'>(
    method: M,
    body?: Record<string, unknown>
  ) => ({
    method,
    body,
    headers: { 'x-csrf-token': session.value?.csrfToken ?? '' }
  })

  const cursorQuery = (cursor?: string) => (cursor ? { cursor } : {})

  return {
    listMembers: (cursor?: string) =>
      $fetch<OrgPage<OrgMember>>('/api/org/members', { query: cursorQuery(cursor) }),
    invite: (email: string, role: OrgRole) =>
      $fetch<OrgInvitation>('/api/org/members', unsafe('POST', { email, role })),
    listInvitations: (cursor?: string) =>
      $fetch<OrgPage<OrgInvitation>>('/api/org/invitations', { query: cursorQuery(cursor) }),
    revokeInvitation: (id: string) =>
      $fetch(`/api/org/invitations/${encodeURIComponent(id)}`, unsafe('DELETE')),
    changeRole: (userId: string, role: OrgRole) =>
      $fetch<OrgMember>(
        `/api/org/members/${encodeURIComponent(userId)}`,
        unsafe('PATCH', { role })
      ),
    deactivate: (userId: string) =>
      $fetch<OrgMember>(
        `/api/org/members/${encodeURIComponent(userId)}/deactivate`,
        unsafe('POST')
      ),
    reactivate: (userId: string) =>
      $fetch<OrgMember>(
        `/api/org/members/${encodeURIComponent(userId)}/reactivate`,
        unsafe('POST')
      ),
    listAuditEvents: (cursor?: string) =>
      $fetch<OrgPage<OrgAuditEvent>>('/api/org/audit-events', { query: cursorQuery(cursor) })
  }
}

/** Page text for a failed /api/org call. Clients branch on the code, never on the message. */
export function orgErrorText(error: OrgApiError): string {
  switch (error.code) {
    case 'forbidden':
      return 'Only owners and admins can see and change the users of this org.'
    case 'last_owner':
      return 'The org must keep at least one active owner. Make another user owner first.'
    case 'own_role':
      return 'You cannot change your own role. Ask another owner.'
    case 'own_membership':
      return 'You cannot deactivate yourself. Ask another owner or admin.'
    case 'member_exists':
      return 'A user with this email is in the org already.'
    case 'rate_limited':
      return 'Too many invites. Wait a while and try again.'
    case 'invalid_request':
      return 'The input is not valid. Check the email and the role.'
    case 'not_found':
      return 'The user, the invitation or the org was not found. Reload the page.'
    case 'upstream_unavailable':
      return 'The identity service could not finish the change. Nothing changed. Try again later.'
    case 'identity_not_configured':
      return 'The studio is not connected to the identity service (NUXT_IDENTITY_URL).'
    case 'csrf_failed':
      return 'The request was refused. Reload the page and try again.'
    case 'unauthenticated':
      return 'Your session ended. Sign in again.'
  }
  if (error.status === 429) return orgErrorText({ status: 429, code: 'rate_limited' })
  if (error.status === 403) return orgErrorText({ status: 403, code: 'forbidden' })
  if (error.status === 502) return orgErrorText({ status: 502, code: 'upstream_unavailable' })
  return 'Something went wrong. Try again.'
}
