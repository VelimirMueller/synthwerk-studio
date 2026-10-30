// Client for the members and audit operations of synthwerk-identity (contracts openapi/identity,
// synthwerk#37). It calls identity with the user's access token. It never logs the token or an email.

export const ORG_ROLES = ['owner', 'admin', 'member'] as const
export type OrgRole = (typeof ORG_ROLES)[number]
export type MemberStatus = 'active' | 'deactivated'

export interface Member {
  user_id: string
  role: OrgRole
  status: MemberStatus
  updated_at: string
}

export interface MemberPage {
  items: Member[]
  next_cursor?: string
}

/** A pending invitation. It never says whether the email has an account. */
export interface Invitation {
  id: string
  email: string
  role: OrgRole
  invited_by: string
  created_at: string
}

export interface InvitationPage {
  items: Invitation[]
  next_cursor?: string
}

export interface AuditEvent {
  id: string
  type: string
  time: string
  actor: string
  subject?: string
  data: Record<string, unknown>
}

export interface AuditEventPage {
  items: AuditEvent[]
  next_cursor?: string
}

/** Problem codes of the identity contract that the BFF passes to the browser. */
export const PASSED_STATUSES = new Set([400, 401, 403, 404, 409, 429, 502])

const DEFAULT_CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
  502: 'upstream_unavailable'
}

/** An identity call failed, or the input was refused before the call. */
export class MembersError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds from identity's Retry-After on a 429. */
    readonly retryAfter?: number
  ) {
    super(message)
    this.name = 'MembersError'
  }
}

export const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
/** One @, no spaces, a dot in the domain. Identity and Zitadel check the address again. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
const UUID_PATTERN = /^[0-9a-fA-F-]{1,36}$/
const INVITATION_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
export const MAX_EMAIL_LENGTH = 254
export const MAX_CURSOR_LENGTH = 256
const TIMEOUT_MS = 10_000

const invalid = (message: string) => new MembersError(400, 'invalid_request', message)

export const isOrgRole = (value: unknown): value is OrgRole =>
  typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value)

function checkUserId(value: unknown): string {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) {
    throw invalid('user id is not valid')
  }
  return value
}

function checkInvitationId(value: unknown): string {
  if (typeof value !== 'string' || !INVITATION_ID_PATTERN.test(value)) {
    throw invalid('invitation id is not valid')
  }
  return value
}

function checkRole(value: unknown): OrgRole {
  if (!isOrgRole(value)) throw invalid('role must be owner, admin or member')
  return value
}

function checkEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim() : ''
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw invalid('email is not valid')
  }
  return email
}

function checkCursor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > MAX_CURSOR_LENGTH) {
    throw invalid('cursor is not valid')
  }
  return value
}

export interface MembersClientOptions {
  baseUrl: string
  accessToken: string
  fetch?: typeof fetch
}

export class MembersClient {
  private readonly fetch: typeof fetch
  private orgId?: Promise<string>

  constructor(private readonly options: MembersClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
  }

  /** The identity org UUID of the caller (GET /v1/me). Read once per client. */
  org(): Promise<string> {
    this.orgId ??= this.call('GET', '/v1/me').then((me) => {
      const id = (me as { org?: { id?: unknown } } | null)?.org?.id
      if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
        throw new MembersError(502, 'upstream_unavailable', 'identity gave no org')
      }
      return id
    })
    return this.orgId
  }

  /** `limit` (1 to 100) asks identity for a smaller page; absent = identity default. */
  async listMembers(cursor?: unknown, limit?: number): Promise<MemberPage> {
    const next = checkCursor(cursor)
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw invalid('limit must be 1 to 100')
    }
    const org = await this.org()
    const page = await this.call('GET', `${orgPath(org)}/members${query(next, limit)}`)
    return readPage(page, readMember)
  }

  /** 202 with the pending invitation. The same answer for every email outside the org. */
  async invite(email: unknown, role: unknown): Promise<Invitation> {
    const body = { email: checkEmail(email), role: checkRole(role) }
    const org = await this.org()
    return readInvitation(await this.call('POST', `${orgPath(org)}/members`, body))
  }

  async listInvitations(cursor?: unknown): Promise<InvitationPage> {
    const next = checkCursor(cursor)
    const org = await this.org()
    const page = await this.call('GET', `${orgPath(org)}/invitations${query(next)}`)
    return readPage(page, readInvitation)
  }

  /** 204: the invitation is revoked. */
  async revokeInvitation(invitationId: unknown): Promise<void> {
    const id = checkInvitationId(invitationId)
    const org = await this.org()
    await this.call('DELETE', `${orgPath(org)}/invitations/${id}`)
  }

  async changeRole(userId: unknown, role: unknown): Promise<Member> {
    const id = checkUserId(userId)
    const body = { role: checkRole(role) }
    const org = await this.org()
    return readMember(await this.call('PATCH', `${orgPath(org)}/members/${id}`, body))
  }

  async deactivate(userId: unknown): Promise<Member> {
    const id = checkUserId(userId)
    const org = await this.org()
    return readMember(await this.call('POST', `${orgPath(org)}/members/${id}:deactivate`))
  }

  async reactivate(userId: unknown): Promise<Member> {
    const id = checkUserId(userId)
    const org = await this.org()
    return readMember(await this.call('POST', `${orgPath(org)}/members/${id}:reactivate`))
  }

  async listAuditEvents(cursor?: unknown): Promise<AuditEventPage> {
    const next = checkCursor(cursor)
    const org = await this.org()
    const page = await this.call('GET', `${orgPath(org)}/audit-events${query(next)}`)
    return readPage(page, readAuditEvent)
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: 'application/json, application/problem+json',
      authorization: `Bearer ${this.options.accessToken}`
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Response
    try {
      res = await this.fetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch {
      throw new MembersError(502, 'upstream_unavailable', 'identity is not reachable')
    }
    if (res.status === 204) return null
    if (res.ok) {
      try {
        return await res.json()
      } catch {
        throw new MembersError(502, 'upstream_unavailable', 'identity gave a bad answer')
      }
    }
    throw await toError(res)
  }
}

const orgPath = (orgId: string) => `/v1/orgs/${encodeURIComponent(orgId)}`

function query(cursor?: string, limit?: number): string {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  if (limit !== undefined) params.set('limit', String(limit))
  const text = params.toString()
  return text ? `?${text}` : ''
}

/**
 * Maps an identity error answer to a MembersError. Only the status and a well-formed `code`
 * pass; `detail` and `title` stay here. Statuses outside the contract become 502.
 */
async function toError(res: Response): Promise<MembersError> {
  if (!PASSED_STATUSES.has(res.status)) {
    return new MembersError(502, 'upstream_unavailable', `identity answered ${res.status}`)
  }
  let code = ''
  try {
    const problem = (await res.json()) as { code?: unknown } | null
    if (typeof problem?.code === 'string' && CODE_PATTERN.test(problem.code)) code = problem.code
  } catch {
    // Not JSON: the status decides the code.
  }
  return new MembersError(
    res.status,
    code || (DEFAULT_CODES[res.status] as string),
    `identity answered ${res.status}`,
    res.status === 429 ? retryAfter(res.headers.get('retry-after')) : undefined
  )
}

/** Retry-After in seconds (1 to 3600), or 60 when absent or not a number of seconds. */
function retryAfter(value: string | null): number {
  const n = value && /^[0-9]{1,5}$/.test(value) ? Number(value) : 60
  return Math.min(Math.max(n, 1), 3600)
}

function readPage<T>(
  value: unknown,
  item: (v: unknown) => T
): { items: T[]; next_cursor?: string } {
  const page = value as { items?: unknown; next_cursor?: unknown } | null
  if (!page || !Array.isArray(page.items)) {
    throw new MembersError(502, 'upstream_unavailable', 'identity gave a bad page')
  }
  const items = page.items.map(item)
  return typeof page.next_cursor === 'string' && page.next_cursor !== ''
    ? { items, next_cursor: page.next_cursor }
    : { items }
}

const bad = () => new MembersError(502, 'upstream_unavailable', 'identity gave a bad item')

/** Keeps only the contract fields of a member. */
function readMember(value: unknown): Member {
  const m = value as Record<string, unknown> | null
  if (
    !m ||
    typeof m.user_id !== 'string' ||
    !isOrgRole(m.role) ||
    (m.status !== 'active' && m.status !== 'deactivated') ||
    typeof m.updated_at !== 'string'
  ) {
    throw bad()
  }
  return { user_id: m.user_id, role: m.role, status: m.status, updated_at: m.updated_at }
}

/** Keeps only the contract fields of an invitation. */
function readInvitation(value: unknown): Invitation {
  const i = value as Record<string, unknown> | null
  if (
    !i ||
    typeof i.id !== 'string' ||
    typeof i.email !== 'string' ||
    !isOrgRole(i.role) ||
    typeof i.invited_by !== 'string' ||
    typeof i.created_at !== 'string'
  ) {
    throw bad()
  }
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    invited_by: i.invited_by,
    created_at: i.created_at
  }
}

/** Keeps only the contract fields of an audit event. */
function readAuditEvent(value: unknown): AuditEvent {
  const e = value as Record<string, unknown> | null
  if (
    !e ||
    typeof e.id !== 'string' ||
    typeof e.type !== 'string' ||
    typeof e.time !== 'string' ||
    typeof e.actor !== 'string'
  ) {
    throw bad()
  }
  const data =
    e.data && typeof e.data === 'object' && !Array.isArray(e.data)
      ? (e.data as Record<string, unknown>)
      : {}
  return {
    id: e.id,
    type: e.type,
    time: e.time,
    actor: e.actor,
    ...(typeof e.subject === 'string' ? { subject: e.subject } : {}),
    data
  }
}
