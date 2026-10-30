import { beforeEach, describe, expect, it } from 'vitest'
import { IdentityConfigError, readIdentityConfig } from '../../server/lib/identity-config'
import { MembersClient, MembersError } from '../../server/lib/members'
import { FakeIdentity, IDENTITY_URL, INVITATION_ID, ORG_UUID, problem } from '../support/identity'

const TOKEN = 'access-token-1'
const ORG = `/v1/orgs/${ORG_UUID}`

let identity: FakeIdentity
let client: MembersClient

beforeEach(() => {
  identity = new FakeIdentity()
  identity.token = TOKEN
  client = new MembersClient({ baseUrl: IDENTITY_URL, accessToken: TOKEN, fetch: identity.fetch })
})

/** Runs the call and gives the MembersError it throws. */
async function failure(call: Promise<unknown>): Promise<MembersError> {
  const err = await call.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(MembersError)
  return err as MembersError
}

describe('readIdentityConfig', () => {
  it('missing or empty - throws and names NUXT_IDENTITY_URL', () => {
    for (const raw of [
      {},
      { identity: {} },
      { identity: { url: '  ' } },
      { identity: { url: 5 } }
    ]) {
      expect(() => readIdentityConfig(raw)).toThrow(IdentityConfigError)
      expect(() => readIdentityConfig(raw)).toThrow('NUXT_IDENTITY_URL')
    }
  })

  it.each([
    'identity.local',
    '/identity',
    'ftp://identity.local',
    'javascript:alert(1)',
    'http://user:pw@identity.local',
    'http://identity.local/?x=1',
    'http://identity.local/#x'
  ])('not an absolute http(s) URL %j - throws', (baseUrl) => {
    expect(() => readIdentityConfig({ identity: { url: baseUrl } })).toThrow(IdentityConfigError)
  })

  it('valid URL - trims spaces and trailing slashes, keeps a path', () => {
    expect(readIdentityConfig({ identity: { url: ' https://api.synthwerk.dev/ ' } })).toEqual({
      baseUrl: 'https://api.synthwerk.dev'
    })
    expect(
      readIdentityConfig({ identity: { url: 'http://localhost:8080/identity//' } }).baseUrl
    ).toBe('http://localhost:8080/identity')
  })
})

describe('MembersClient - calls', () => {
  it('org - reads the identity org UUID from GET /v1/me once per client', async () => {
    expect(await client.org()).toBe(ORG_UUID)
    await client.listMembers()
    await client.listAuditEvents()
    expect(identity.calls.filter((c) => c.path === '/v1/me')).toHaveLength(1)
    expect(identity.calls[0]).toMatchObject({ method: 'GET', authorization: `Bearer ${TOKEN}` })
  })

  it('listMembers - GET members with the bearer token and the cursor', async () => {
    const page = await client.listMembers('MTI')
    expect(page.next_cursor).toBe('MTI')
    expect(page.items.map((m) => [m.user_id, m.role, m.status])).toEqual([
      ['user-1', 'owner', 'active'],
      ['user-2', 'member', 'deactivated']
    ])
    expect(identity.work).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: `${ORG}/members`,
        search: '?cursor=MTI',
        authorization: `Bearer ${TOKEN}`,
        body: undefined
      })
    ])
  })

  it('listMembers - no cursor - sends no query', async () => {
    await client.listMembers('')
    expect(identity.work[0]?.search).toBe('')
  })

  it('listMembers - limit and cursor - both in the query', async () => {
    await client.listMembers('MTI', 1)
    expect(identity.work[0]?.search).toBe('?cursor=MTI&limit=1')
  })

  it('invite - POST members with email and role as JSON - the pending invitation', async () => {
    const inv = await client.invite(' ada@example.com ', 'admin')
    expect(inv).toEqual({
      id: INVITATION_ID,
      email: 'ada@example.com',
      role: 'member',
      invited_by: 'user-1',
      created_at: '2026-10-30T09:00:00Z'
    })
    expect(identity.work).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: `${ORG}/members`,
        contentType: 'application/json',
        authorization: `Bearer ${TOKEN}`,
        body: { email: 'ada@example.com', role: 'admin' }
      })
    ])
  })

  it('listInvitations - GET invitations with the cursor', async () => {
    const page = await client.listInvitations('MTE')
    expect(page.items[0]?.id).toBe(INVITATION_ID)
    expect(page.next_cursor).toBe('MTE')
    expect(identity.work).toEqual([
      expect.objectContaining({ method: 'GET', path: `${ORG}/invitations`, search: '?cursor=MTE' })
    ])
  })

  it('revokeInvitation - DELETE the invitation - 204, no body read', async () => {
    await expect(client.revokeInvitation(INVITATION_ID)).resolves.toBeUndefined()
    expect(identity.work).toEqual([
      expect.objectContaining({ method: 'DELETE', path: `${ORG}/invitations/${INVITATION_ID}` })
    ])
  })

  it('listInvitations - item without email - 502 upstream_unavailable', async () => {
    identity.answers.set(`GET ${ORG}/invitations`, {
      status: 200,
      body: { items: [{ id: INVITATION_ID, role: 'member' }] }
    })
    const err = await failure(client.listInvitations())
    expect([err.status, err.code]).toEqual([502, 'upstream_unavailable'])
  })

  it('changeRole - PATCH the member with the role', async () => {
    const member = await client.changeRole('user-2', 'admin')
    expect(member).toEqual({
      user_id: 'user-2',
      role: 'admin',
      status: 'active',
      updated_at: '2026-10-30T09:00:00Z'
    })
    expect(identity.work).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        path: `${ORG}/members/user-2`,
        body: { role: 'admin' }
      })
    ])
  })

  it('deactivate and reactivate - POST the colon actions without a body', async () => {
    expect((await client.deactivate('user-2')).status).toBe('deactivated')
    expect((await client.reactivate('user-2')).status).toBe('active')
    expect(identity.work.map((c) => [c.method, c.path, c.body, c.contentType])).toEqual([
      ['POST', `${ORG}/members/user-2:deactivate`, undefined, ''],
      ['POST', `${ORG}/members/user-2:reactivate`, undefined, '']
    ])
  })

  it('listAuditEvents - GET audit events, keeps the contract fields only', async () => {
    identity.answers.set(`GET ${ORG}/audit-events`, {
      status: 200,
      body: {
        items: [
          {
            id: 'e1',
            type: 'dev.synthwerk.identity.org.created.v1',
            time: '2026-10-30T09:00:00Z',
            actor: 'system',
            data: { name: 'demo' },
            extra: 'dropped'
          },
          { id: 'e2', type: 'x', time: 't', actor: 'system', data: ['not', 'an', 'object'] }
        ],
        next_cursor: ''
      }
    })
    const page = await client.listAuditEvents('abc')
    expect(page).toEqual({
      items: [
        {
          id: 'e1',
          type: 'dev.synthwerk.identity.org.created.v1',
          time: '2026-10-30T09:00:00Z',
          actor: 'system',
          data: { name: 'demo' }
        },
        { id: 'e2', type: 'x', time: 't', actor: 'system', data: {} }
      ]
    })
    expect(identity.work[0]).toMatchObject({ path: `${ORG}/audit-events`, search: '?cursor=abc' })
  })

  it('base URL with a path - keeps the path prefix', async () => {
    await client.listMembers()
    // The fake strips /identity only: a call without the prefix would answer 404.
    expect(identity.work[0]?.path).toBe(`${ORG}/members`)
  })
})

describe('MembersClient - input checks (no identity call)', () => {
  it.each([
    ['bad user id', () => client.changeRole('../admin', 'admin')],
    ['user id with a colon', () => client.deactivate('user-2:reactivate')],
    ['long user id', () => client.reactivate('a'.repeat(129))],
    ['user id not a string', () => client.deactivate(undefined)],
    ['role operator', () => client.changeRole('user-2', 'operator')],
    ['role missing', () => client.invite('ada@example.com', undefined)],
    ['bad email', () => client.invite('not-an-email', 'member')],
    ['email with a space', () => client.invite('a b@example.com', 'member')],
    ['long email', () => client.invite(`${'a'.repeat(250)}@x.de`, 'member')],
    ['email not a string', () => client.invite({ email: 'a@b.c' }, 'member')],
    ['long cursor', () => client.listMembers('c'.repeat(257))],
    ['limit 0', () => client.listMembers(undefined, 0)],
    ['limit over 100', () => client.listMembers(undefined, 101)],
    ['invitation id not a uuid', () => client.revokeInvitation('../members/user-2')],
    ['invitation id missing', () => client.revokeInvitation(undefined)],
    ['cursor not a string', () => client.listAuditEvents(['a', 'b'])]
  ])('%s - 400 invalid_request', async (_name, call) => {
    const err = await failure(call())
    expect(err.status).toBe(400)
    expect(err.code).toBe('invalid_request')
    expect(identity.calls).toHaveLength(0)
  })
})

describe('MembersClient - errors', () => {
  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'last_owner'],
    [409, 'own_role'],
    [409, 'own_membership'],
    [409, 'member_exists'],
    [502, 'upstream_unavailable'],
    [401, 'unauthenticated']
  ])('problem %i %s - passes status and code, not the detail', async (status, code) => {
    identity.answers.set(`PATCH ${ORG}/members/user-2`, problem(status, code))
    const err = await failure(client.changeRole('user-2', 'owner'))
    expect([err.status, err.code]).toEqual([status, code])
    expect(err.message).not.toContain('secret')
  })

  it.each([
    ['120', 120],
    [null, 60],
    ['Wed, 21 Oct 2026 07:28:00 GMT', 60],
    ['99999', 3600]
  ])('429 rate_limited, Retry-After %s - retryAfter %i', async (header, want) => {
    identity.answers.set(`POST ${ORG}/members`, {
      ...problem(429, 'rate_limited'),
      ...(header === null ? {} : { headers: { 'retry-after': header } })
    })
    const err = await failure(client.invite('ada@example.com', 'member'))
    expect([err.status, err.code, err.retryAfter]).toEqual([429, 'rate_limited', want])
  })

  it('wrong token - identity answers 401 unauthenticated', async () => {
    const other = new MembersClient({
      baseUrl: IDENTITY_URL,
      accessToken: 'x',
      fetch: identity.fetch
    })
    const err = await failure(other.listMembers())
    expect([err.status, err.code]).toEqual([401, 'unauthenticated'])
  })

  it.each([
    [403, 'forbidden'],
    [409, 'conflict'],
    [400, 'invalid_request']
  ])('non-JSON error %i - the status decides the code (%s)', async (status, code) => {
    identity.answers.set(`POST ${ORG}/members`, { status, text: '<html>nope</html>' })
    const err = await failure(client.invite('ada@example.com', 'member'))
    expect([err.status, err.code]).toEqual([status, code])
  })

  it('problem with a bad code - falls back to the status code', async () => {
    identity.answers.set(`POST ${ORG}/members`, {
      status: 409,
      body: { code: 'Bad Code <script>' }
    })
    const err = await failure(client.invite('ada@example.com', 'member'))
    expect(err.code).toBe('conflict')
  })

  it.each([500, 503, 418])(
    'status %i outside the contract - 502 upstream_unavailable',
    async (status) => {
      identity.answers.set(`GET ${ORG}/members`, { status, text: 'oops' })
      const err = await failure(client.listMembers())
      expect([err.status, err.code]).toEqual([502, 'upstream_unavailable'])
    }
  )

  it('identity down - 502 upstream_unavailable', async () => {
    identity.down = true
    const err = await failure(client.listMembers())
    expect([err.status, err.code]).toEqual([502, 'upstream_unavailable'])
  })

  it('/v1/me fails - the error passes and nothing else is called', async () => {
    identity.answers.set('GET /v1/me', problem(401, 'unauthenticated'))
    const err = await failure(client.listMembers())
    expect(err.status).toBe(401)
    expect(identity.work).toHaveLength(0)
  })

  it.each([
    ['no org', { subject: 's', roles: [] }],
    ['org id not a UUID', { subject: 's', org: { id: '../x' }, roles: [] }],
    ['null', null]
  ])('/v1/me with %s - 502', async (_name, body) => {
    identity.answers.set('GET /v1/me', { status: 200, body })
    const err = await failure(client.listMembers())
    expect([err.status, err.code]).toEqual([502, 'upstream_unavailable'])
  })

  it.each([
    ['not JSON', { status: 200, text: 'hello' }],
    ['no items', { status: 200, body: { next_cursor: 'x' } }],
    ['bad member', { status: 200, body: { items: [{ user_id: 'u', role: 'operator' }] } }]
  ])('member page %s - 502', async (_name, answer) => {
    identity.answers.set(`GET ${ORG}/members`, answer)
    const err = await failure(client.listMembers())
    expect([err.status, err.code]).toEqual([502, 'upstream_unavailable'])
  })

  it('bad audit event - 502', async () => {
    identity.answers.set(`GET ${ORG}/audit-events`, {
      status: 200,
      body: { items: [{ id: 'e', type: 't' }] }
    })
    const err = await failure(client.listAuditEvents())
    expect(err.status).toBe(502)
  })
})
