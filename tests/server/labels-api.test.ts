// The /api/labels routes on an h3 app: same wiring as server/api/labels and server/middleware/csrf.ts,
// with the real AuthService (mock OIDC provider), a fake identity and a fake vision.
import { createApp, createRouter, eventHandler, toWebHandler } from 'h3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ROLES_CLAIM } from '../../server/lib/claims'
import { type IdentityConfigError, readIdentityConfig } from '../../server/lib/identity-config'
import { LabelsApi, type LabelsApiDeps } from '../../server/lib/labels-api'
import { SESSION_COOKIE, type SessionRecord, sessionKey } from '../../server/lib/session'
import { readVisionConfig, VisionConfigError } from '../../server/lib/vision-config'
import { Browser, buildApp, type Harness, ORIGIN, signIn } from '../support/app'
import { FakeIdentity, IDENTITY_URL, ORG_UUID, problem } from '../support/identity'
import { MockProvider, ORG_ID } from '../support/provider'
import {
  ADMIN_TOKEN,
  detail,
  FakeVision,
  LABEL,
  LABEL_SET,
  routeFetch,
  VISION_URL
} from '../support/vision'

const provider = new MockProvider()
const LABELS = `/v1/orgs/${ORG_ID}/labels`
const MEMBERS = `/v1/orgs/${ORG_UUID}/members`

let harness: Harness
let identity: FakeIdentity
let vision: FakeVision
let logs: string[]

beforeAll(async () => {
  await provider.start()
})
afterAll(() => provider.stop())

beforeEach(() => {
  provider.options = {}
  harness = buildApp(provider)
  identity = new FakeIdentity()
  vision = new FakeVision()
  logs = []
})

const identityConfig = () => readIdentityConfig({ identity: { url: IDENTITY_URL } })
const visionConfig = () =>
  readVisionConfig({ vision: { url: VISION_URL, adminToken: ADMIN_TOKEN } })

type Configs = Partial<Pick<LabelsApiDeps, 'identity' | 'vision'>>

/** A browser with the label routes and the auth routes on one origin. */
function labelsBrowser(configs: Configs = {}) {
  const api = new LabelsApi({
    auth: harness.service,
    identity: configs.identity ?? identityConfig(),
    vision: configs.vision ?? visionConfig(),
    fetch: routeFetch({
      [new URL(IDENTITY_URL).origin]: identity.fetch,
      [VISION_URL]: vision.fetch
    }),
    log: (level, message) => logs.push(`${level}: ${message}`)
  })
  const app = createApp()
  app.use(
    eventHandler((event) => {
      if (event.path.startsWith('/api/')) harness.service.assertSameOrigin(event)
    })
  )
  const router = createRouter()
    .get(
      '/api/auth/session',
      eventHandler((e) => harness.service.session(e))
    )
    .get(
      '/api/labels',
      eventHandler((e) => api.list(e))
    )
    .post(
      '/api/labels',
      eventHandler((e) => api.add(e))
    )
    .delete(
      '/api/labels/:labelId',
      eventHandler((e) => api.remove(e))
    )
  app.use(router)
  const web = toWebHandler(app)
  return new Browser({ ...harness, handle: (request) => web(request) })
}

/** Signs in and gives a labels browser with that session and its CSRF token. */
async function signedIn(configs?: Configs) {
  const auth = new Browser(harness)
  await signIn(auth, provider)
  const browser = labelsBrowser(configs)
  for (const [k, v] of auth.cookies) browser.cookies.set(k, v)
  const session = await (await browser.fetch('/api/auth/session')).json()
  const id = browser.cookies.get(SESSION_COOKIE) ?? ''
  const record = harness.store.data.get(sessionKey(id)) as SessionRecord
  identity.token = record.tokens.accessToken
  return { browser, csrf: session.csrfToken as string }
}

const json = (csrf: string, body?: unknown) => ({
  headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-csrf-token': csrf },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
})

const code = async (res: Response) =>
  ((await res.json()) as { data?: { code?: string } }).data?.code

const NEW_LABEL = { name: 'red barn', topic: 'building', prompt: 'a photo of a red barn' }

describe('/api/labels - authorization', () => {
  it('GET - no session - 401 unauthenticated, nothing called', async () => {
    const res = await labelsBrowser().fetch('/api/labels')
    expect(res.status).toBe(401)
    expect(await code(res)).toBe('unauthenticated')
    expect(identity.calls).toHaveLength(0)
    expect(vision.calls).toHaveLength(0)
  })

  it('POST - no x-csrf-token - 403 csrf_failed, nothing called', async () => {
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/labels', { method: 'POST', ...json('', NEW_LABEL) })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('csrf_failed')
    expect(identity.calls).toHaveLength(0)
    expect(vision.calls).toHaveLength(0)
  })

  it('token role member - 403 forbidden, identity and vision not called', async () => {
    provider.options = {
      accessClaims: { [ROLES_CLAIM]: { member: { [ORG_ID]: 'demo.auth.localhost' } } }
    }
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('forbidden')
    expect(identity.calls).toHaveLength(0)
    expect(vision.calls).toHaveLength(0)
  })

  it('token says owner, stored membership refused (403) - 403 forbidden, vision not called', async () => {
    identity.answers.set(`GET ${MEMBERS}`, problem(403, 'forbidden'))
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/labels', { method: 'POST', ...json(csrf, NEW_LABEL) })
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('forbidden')
    expect(vision.calls).toHaveLength(0)
  })

  it('identity refuses the token (401) - 401 unauthenticated', async () => {
    identity.answers.set(`GET ${MEMBERS}`, problem(401, 'unauthenticated'))
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(401)
    expect(vision.calls).toHaveLength(0)
  })

  it('identity down - 502 upstream_unavailable, a log line, vision not called', async () => {
    identity.down = true
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(502)
    expect(await code(res)).toBe('upstream_unavailable')
    expect(logs).toEqual(['warn: identity check failed: identity is not reachable'])
    expect(vision.calls).toHaveLength(0)
  })

  it('org id outside the vision pattern - 403 forbidden, nothing called', async () => {
    const bad = 'org/../x'
    provider.options = {
      accessClaims: {
        'urn:zitadel:iam:user:resourceowner:id': bad,
        [ROLES_CLAIM]: { owner: { [bad]: 'demo.auth.localhost' } }
      }
    }
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(403)
    expect(identity.calls).toHaveLength(0)
    expect(vision.calls).toHaveLength(0)
  })
})

describe('/api/labels - happy paths', () => {
  it('GET - confirms the membership, then passes the contract fields of the set', async () => {
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(LABEL_SET)
    expect(identity.work).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: MEMBERS,
        search: '?limit=1',
        authorization: `Bearer ${identity.token}`
      })
    ])
    expect(vision.calls).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: LABELS,
        authorization: `Bearer ${ADMIN_TOKEN}`
      })
    ])
  })

  it('POST - 201 with the label, vision got the snake_case body and the service token', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/labels', {
      method: 'POST',
      ...json(csrf, {
        name: ' red barn ',
        topic: 'barns',
        prompt: '',
        newTopic: true,
        topicParent: 'building'
      })
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual(LABEL)
    expect(vision.calls).toEqual([
      {
        method: 'POST',
        path: LABELS,
        authorization: `Bearer ${ADMIN_TOKEN}`,
        contentType: 'application/json',
        body: {
          name: 'red barn',
          topic: 'barns',
          prompt: null,
          new_topic: true,
          topic_parent: 'building'
        }
      }
    ])
  })

  it('POST - defaults: new_topic false, topic_parent null', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/labels', { method: 'POST', ...json(csrf, NEW_LABEL) })
    expect(res.status).toBe(201)
    expect(vision.calls[0]?.body).toEqual({ ...NEW_LABEL, new_topic: false, topic_parent: null })
  })

  it('DELETE - 204, vision got the DELETE with the label id', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch(`/api/labels/${LABEL.id}`, { method: 'DELETE', ...json(csrf) })
    expect(res.status).toBe(204)
    expect(vision.calls).toEqual([
      expect.objectContaining({ method: 'DELETE', path: `${LABELS}/${LABEL.id}` })
    ])
  })
})

describe('/api/labels - input', () => {
  it('DELETE - packaged label id - 400 invalid_request, vision not called', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/labels/dog', { method: 'DELETE', ...json(csrf) })
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('invalid_request')
    expect(vision.calls).toHaveLength(0)
  })

  it.each([
    ['empty name', { ...NEW_LABEL, name: '  ' }],
    ['long name', { ...NEW_LABEL, name: 'x'.repeat(81) }],
    ['no topic', { name: 'red barn' }],
    ['long prompt', { ...NEW_LABEL, prompt: 'x'.repeat(201) }],
    ['newTopic not a boolean', { ...NEW_LABEL, newTopic: 'yes' }],
    ['topicParent not a text', { ...NEW_LABEL, topicParent: 5 }],
    ['not an object', ['red barn']]
  ])('POST - %s - 400 invalid_request, vision not called', async (_, body) => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/labels', { method: 'POST', ...json(csrf, body) })
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('invalid_request')
    expect(vision.calls).toHaveLength(0)
  })

  it('POST - broken JSON - 400 invalid_request', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/labels', {
      method: 'POST',
      headers: json(csrf).headers,
      body: '{"name":'
    })
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('invalid_request')
  })
})

describe('/api/labels - vision errors', () => {
  it('vision 409 - 409 label_conflict, no vision detail', async () => {
    vision.answers.set(`POST ${LABELS}`, detail(409))
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/labels', { method: 'POST', ...json(csrf, NEW_LABEL) })
    expect(res.status).toBe(409)
    const text = await res.text()
    expect(JSON.parse(text).data).toEqual({ code: 'label_conflict' })
    expect(text).not.toContain('secret vision detail')
  })

  it('vision 422 - 400 invalid_request', async () => {
    vision.answers.set(`POST ${LABELS}`, detail(422))
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/labels', { method: 'POST', ...json(csrf, NEW_LABEL) })
    expect(res.status).toBe(400)
    expect(await code(res)).toBe('invalid_request')
  })

  it('vision 404 on DELETE - 404 not_found', async () => {
    const { browser, csrf } = await signedIn()
    const res = await browser.fetch('/api/labels/runtime:gone', {
      method: 'DELETE',
      ...json(csrf)
    })
    expect(res.status).toBe(404)
    expect(await code(res)).toBe('not_found')
  })

  it('vision 401 (wrong token) - 502 vision_unavailable and a log line without the token', async () => {
    const { browser } = await signedIn({
      vision: readVisionConfig({ vision: { url: VISION_URL, adminToken: 'wrong-token' } })
    })
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(JSON.parse(text).data).toEqual({ code: 'vision_unavailable' })
    expect(text).not.toContain('wrong-token')
    expect(logs).toEqual(['warn: vision call failed: vision refused the admin token (401)'])
    expect(logs.join()).not.toContain('wrong-token')
    expect(logs.join()).not.toContain(ADMIN_TOKEN)
  })

  it('vision 404 on GET (admin off) - 502 vision_unavailable and a log line', async () => {
    vision.answers.set(`GET ${LABELS}`, detail(404))
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(502)
    expect(logs).toEqual(['warn: vision call failed: vision admin routes are off (404)'])
  })

  it('vision 503 - 503 vision_unavailable', async () => {
    vision.answers.set(`GET ${LABELS}`, detail(503))
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(503)
    expect(await code(res)).toBe('vision_unavailable')
  })

  it.each([
    ['down', () => (vision.down = true)],
    ['bad JSON', () => vision.answers.set(`GET ${LABELS}`, { status: 200, text: '<html>' })],
    ['bad shape', () => vision.answers.set(`GET ${LABELS}`, { status: 200, body: { labels: 1 } })],
    ['500', () => vision.answers.set(`GET ${LABELS}`, detail(500))]
  ])('vision %s - 502 vision_unavailable', async (_, setUp) => {
    setUp()
    const { browser } = await signedIn()
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(502)
    expect(await code(res)).toBe('vision_unavailable')
  })
})

describe('/api/labels - configuration', () => {
  const missing = <E>(read: () => unknown): E => {
    try {
      read()
    } catch (err) {
      return err as E
    }
    throw new Error('expected a config error')
  }

  it('vision not configured - 503 vision_not_configured, sign-in keeps working', async () => {
    const err = missing<VisionConfigError>(() => readVisionConfig({}))
    expect(err).toBeInstanceOf(VisionConfigError)
    const { browser } = await signedIn({ vision: err })
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.data.code).toBe('vision_not_configured')
    expect(body.data.message).toContain('NUXT_VISION_URL')
    expect(identity.calls).toHaveLength(0)
    expect((await browser.fetch('/api/auth/session')).status).toBe(200)
  })

  it('identity not configured - 503 identity_not_configured, vision not called', async () => {
    const err = missing<IdentityConfigError>(() => readIdentityConfig({}))
    const { browser } = await signedIn({ identity: err })
    const res = await browser.fetch('/api/labels')
    expect(res.status).toBe(503)
    expect(await code(res)).toBe('identity_not_configured')
    expect(vision.calls).toHaveLength(0)
  })

  it('other errors - are not swallowed', async () => {
    const api = new LabelsApi({
      auth: {
        current: async () => {
          throw new Error('store down')
        },
        assertCsrfToken: () => undefined
      },
      identity: identityConfig(),
      vision: visionConfig()
    })
    const app = createApp()
    app.use(
      '/x',
      eventHandler((e) => api.list(e))
    )
    const res = await toWebHandler(app)(new Request(`${ORIGIN}/x`))
    expect(res.status).toBe(500)
  })
})
