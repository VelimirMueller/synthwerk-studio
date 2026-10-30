// A fake synthwerk-identity for the members and audit routes, as a fetch stub. It records
// every call and answers like the contract (openapi/identity): members, audit, problem+json.

export const IDENTITY_URL = 'http://identity.test/identity'
export const ORG_UUID = '0199f3a0-5b6c-7d8e-9f0a-1b2c3d4e5f60'
export const INVITATION_ID = '019a3c1e-7a1b-7c2d-8e3f-4a5b6c7d8e9f'

export interface IdentityCall {
  method: string
  path: string
  search: string
  authorization: string
  contentType: string
  body: unknown
}

export interface FakeAnswer {
  status: number
  body?: unknown
  /** Raw text instead of JSON. */
  text?: string
  headers?: Record<string, string>
  contentType?: string
}

const problem = (status: number, code: string): FakeAnswer => ({
  status,
  contentType: 'application/problem+json',
  body: {
    type: `https://schemas.synthwerk.dev/problems/${code}`,
    title: code,
    status,
    code,
    detail: 'secret upstream detail'
  }
})

export class FakeIdentity {
  readonly calls: IdentityCall[] = []
  /** The bearer token identity accepts. Empty = any token. */
  token = ''
  /** Answers by `METHOD path` (path without the base URL). They win over the defaults. */
  readonly answers = new Map<string, FakeAnswer>()
  /** Throws like a network failure when set. */
  down = false

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    // Calls outside the base path keep the full path, so they match nothing (404).
    const base = new URL(IDENTITY_URL).pathname
    const path = url.pathname.startsWith(`${base}/`)
      ? url.pathname.slice(base.length)
      : url.pathname
    const headers = new Headers(init.headers)
    const method = init.method ?? 'GET'
    this.calls.push({
      method,
      path,
      search: url.search,
      authorization: headers.get('authorization') ?? '',
      contentType: headers.get('content-type') ?? '',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    })
    if (this.down) throw new TypeError('fetch failed')
    const answer = this.answer(method, path, headers.get('authorization') ?? '')
    if (answer.text !== undefined) {
      return new Response(answer.text, {
        status: answer.status,
        headers: { 'content-type': answer.contentType ?? 'text/html' }
      })
    }
    if (answer.status === 204) return new Response(null, { status: 204 })
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': answer.contentType ?? 'application/json', ...answer.headers }
    })
  }

  /** Calls other than the org lookup. */
  get work(): IdentityCall[] {
    return this.calls.filter((c) => c.path !== '/v1/me')
  }

  private answer(method: string, path: string, authorization: string): FakeAnswer {
    if (this.token && authorization !== `Bearer ${this.token}`)
      return problem(401, 'unauthenticated')
    const fixed = this.answers.get(`${method} ${path}`)
    if (fixed) return fixed
    const org = `/v1/orgs/${ORG_UUID}`
    const member = (user_id: string, role = 'member', status = 'active') => ({
      status: 200,
      body: { user_id, role, status, updated_at: '2026-10-30T09:00:00Z' }
    })
    if (method === 'GET' && path === '/v1/me') {
      return {
        status: 200,
        body: {
          subject: 'user-1',
          org: { id: ORG_UUID, name: 'demo', slug: 'demo', created_at: '2026-10-23T08:00:00Z' },
          roles: ['owner']
        }
      }
    }
    if (method === 'GET' && path === `${org}/members`) {
      return {
        status: 200,
        body: {
          items: [member('user-1', 'owner').body, member('user-2', 'member', 'deactivated').body],
          next_cursor: 'MTI'
        }
      }
    }
    const invitation = {
      id: INVITATION_ID,
      email: 'ada@example.com',
      role: 'member',
      invited_by: 'user-1',
      created_at: '2026-10-30T09:00:00Z'
    }
    if (method === 'POST' && path === `${org}/members`) {
      return { status: 202, body: invitation }
    }
    if (method === 'GET' && path === `${org}/invitations`) {
      return { status: 200, body: { items: [invitation], next_cursor: 'MTE' } }
    }
    if (method === 'DELETE' && path === `${org}/invitations/${INVITATION_ID}`) {
      return { status: 204 }
    }
    const match = path.match(new RegExp(`^${org}/members/([^/:]+)(:deactivate|:reactivate)?$`))
    if (match) {
      const [, id = '', action] = match
      if (method === 'PATCH' && !action) return member(id, 'admin')
      if (method === 'POST' && action === ':deactivate') return member(id, 'member', 'deactivated')
      if (method === 'POST' && action === ':reactivate') return member(id, 'member', 'active')
    }
    if (method === 'GET' && path === `${org}/audit-events`) {
      return {
        status: 200,
        body: {
          items: [
            {
              id: '019a3c20-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
              type: 'dev.synthwerk.identity.member.role_changed.v1',
              time: '2026-10-30T09:15:00Z',
              actor: 'user:user-1',
              subject: 'user-2',
              data: { org_id: ORG_UUID, user_sub: 'user-2', old_role: 'member', new_role: 'admin' }
            }
          ]
        }
      }
    }
    return problem(404, 'not_found')
  }
}

export { problem }
