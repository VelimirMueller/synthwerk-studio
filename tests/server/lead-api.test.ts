// The public lead routes (synthwerk#105) on an h3 app with the builder store on PGlite, a fake
// mailer and a fake clock for the rate limits. No session anywhere.
import { createApp, createRouter, eventHandler, toWebHandler } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BuilderConfigError } from '../../server/lib/builder-config'
import { BuilderStore } from '../../server/lib/builder-store'
import {
  confirmMail,
  IP_LIMIT,
  LeadApi,
  type LeadApiDeps,
  MAX_LEAD_BODY_BYTES,
  PAGE_LIMIT
} from '../../server/lib/lead-api'
import { type Mail, MailError, type Mailer } from '../../server/lib/mail'
import { RateLimiter } from '../../server/lib/rate-limit'
import { readSiteConfig, SiteConfigError } from '../../server/lib/site-config'
import { newSection, type PageContent } from '../../shared/sections'
import { type TestDb, testDb } from '../support/pglite'

const ORG = 'site-org'
const ADA = 'user:ada'
const AUTHOR = { actor: ADA, identityOrgId: '0199f3a0-5b6c-7d8e-9f0a-1b2c3d4e5f60' }
const SITE = 'https://synthwerk.example'

let db: TestDb
let store: BuilderStore
let logs: string[]
let sent: Mail[]
let mailFails: boolean
let pending: Promise<void>[]
let now: number

class FakeMailer implements Mailer {
  readonly provider = 'smtp'
  async send(mail: Mail) {
    if (mailFails) throw new MailError('smtp refused (550)')
    sent.push(mail)
  }
}

beforeEach(async () => {
  db = await testDb()
  store = new BuilderStore(db)
  logs = []
  sent = []
  mailFails = false
  pending = []
  now = Date.parse('2026-10-30T10:00:00Z')
})
afterEach(() => db.close())

function lead(content: PageContent): PageContent {
  return content
}

const withName = (nameField: boolean): PageContent => {
  const form = newSection('lead', 'l1')
  if (form.type === 'lead') form.nameField = nameField
  return lead({ title: 'Join', sections: [newSection('hero', 'h1'), form] })
}

async function publish(content: PageContent = withName(false), slug = 'join') {
  const page = await store.createPage(ORG, AUTHOR, { slug, locale: 'en', title: 'Join' })
  await store.saveDraft(ORG, page.id, ADA, 1, content)
  await store.publish(ORG, page.id, AUTHOR, 2)
  return page.id
}

function app(deps: Partial<LeadApiDeps> = {}, site = { orgId: ORG, origin: SITE } as object) {
  const api = new LeadApi({
    site: readSiteConfig({ site: site as { orgId: string } }),
    store: async () => store,
    mailer: new FakeMailer(),
    limiter: new RateLimiter(100, () => now),
    defer: (p) => pending.push(p),
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...deps
  })
  const a = createApp()
  a.use(
    createRouter()
      .post(
        '/api/site/leads',
        eventHandler((e) => api.submit(e))
      )
      .post(
        '/api/site/leads/confirm',
        eventHandler((e) => api.confirm(e))
      )
  )
  const web = toWebHandler(a)
  return (path: string, body: unknown, headers: Record<string, string> = {}) =>
    web(
      new Request(`http://studio.internal${path}`, {
        method: 'POST',
        headers: { origin: SITE, 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      })
    )
}

const FORM = {
  locale: 'en',
  slug: 'join',
  sectionId: 'l1',
  email: 'ada@example.com',
  consent: true,
  website: ''
}

const code = async (res: Response) =>
  ((await res.json()) as { data?: { code?: string } }).data?.code

const settle = () => Promise.all(pending)

/** The token of the last confirm mail. */
function tokenOf(mail: Mail | undefined): string {
  const m = /#token=([A-Za-z0-9_-]{43})$/m.exec(mail?.text ?? '')
  if (!m?.[1]) throw new Error('no token in the mail')
  return m[1]
}

describe('POST /api/site/leads', () => {
  it('202, one plain-text confirm mail with the site link; no lead before the confirm', async () => {
    await publish()
    const res = await app()('/api/site/leads', FORM)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'pending' })
    await settle()
    expect(sent).toHaveLength(1)
    const mail = sent[0]
    expect(mail?.to).toBe('ada@example.com')
    expect(mail?.subject).toBe('Please confirm your email address')
    expect(mail?.text).toContain(`${SITE}/en/confirm#token=`)
    expect(mail?.text).not.toMatch(/<img|<a |https?:\/\/(?!synthwerk\.example)/)
    expect(mail?.idempotencyKey).toMatch(/^lead-[0-9a-f]{32}$/)
    expect(mail?.idempotencyKey).not.toContain(tokenOf(mail))
    expect((await store.leads.list(ORG)).items).toEqual([])
  })

  it('the confirm link makes the lead; the second click is 410', async () => {
    await publish()
    const call = app()
    await call('/api/site/leads', FORM)
    await settle()
    const token = tokenOf(sent[0])
    const ok = await call('/api/site/leads/confirm', { token })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ status: 'confirmed' })
    expect((await store.leads.list(ORG)).items.map((l) => l.email)).toEqual(['ada@example.com'])
    const again = await call('/api/site/leads/confirm', { token })
    expect(again.status).toBe(410)
    expect(await code(again)).toBe('link_invalid')
    expect((await call('/api/site/leads/confirm', { token: 'short' })).status).toBe(410)
  })

  it('German page: German mail', async () => {
    const page = await store.createPage(ORG, AUTHOR, { slug: 'join', locale: 'de', title: 'x' })
    await store.saveDraft(ORG, page.id, ADA, 1, withName(false))
    await store.publish(ORG, page.id, AUTHOR, 2)
    await app()('/api/site/leads', { ...FORM, locale: 'de' })
    await settle()
    expect(sent[0]?.subject).toBe('Bitte bestätigen Sie Ihre E-Mail-Adresse')
    expect(sent[0]?.text).toContain(`${SITE}/de/confirm#token=`)
  })

  it('stores the name only when the form asks for it, and the consent text of the page', async () => {
    await publish(withName(false))
    await publish(withName(true), 'named')
    const call = app()
    await call('/api/site/leads', { ...FORM, name: 'Ada' })
    await call('/api/site/leads', { ...FORM, slug: 'named', email: 'b@example.com', name: 'Bob' })
    await settle()
    const { rows } = await db.query<{ email: string; name: string; consent_text: string }>(
      'select email, name, consent_text from builder_leads order by email'
    )
    expect(rows.map((r) => [r.email, r.name])).toEqual([
      ['ada@example.com', ''],
      ['b@example.com', 'Bob']
    ])
    const form = withName(false).sections[1]
    expect(rows[0]?.consent_text).toBe(form?.type === 'lead' ? form.consent : '')
    // The mail never holds the name.
    expect(sent.map((m) => m.text).join()).not.toContain('Bob')
  })

  it('same answer for a known address; no second mail', async () => {
    await publish()
    const call = app()
    await call('/api/site/leads', FORM)
    await settle()
    await call('/api/site/leads/confirm', { token: tokenOf(sent[0]) })
    const res = await call('/api/site/leads', FORM)
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'pending' })
    await settle()
    expect(sent).toHaveLength(1)
  })

  it('honeypot filled: 202, nothing stored, no mail', async () => {
    await publish()
    const res = await app()('/api/site/leads', { ...FORM, website: 'https://spam.example' })
    expect(res.status).toBe(202)
    await settle()
    expect(sent).toHaveLength(0)
    expect((await db.query('select 1 from builder_leads')).rows).toHaveLength(0)
  })

  it.each([
    [{ ...FORM, email: 'not-an-email' }, 400, 'invalid_email'],
    [{ ...FORM, email: 'a@b.c\r\nBcc: x@y.z' }, 400, 'invalid_email'],
    [{ ...FORM, consent: 'yes' }, 400, 'consent_required'],
    [{ ...FORM, consent: undefined }, 400, 'consent_required'],
    [{ ...FORM, name: 'x'.repeat(121) }, 400, 'invalid_request'],
    [{ ...FORM, locale: 'fr' }, 400, 'invalid_request'],
    [{ ...FORM, slug: '../x' }, 400, 'invalid_request'],
    [{ ...FORM, sectionId: 'L-1' }, 400, 'invalid_request'],
    [{ ...FORM, sectionId: 'h1' }, 404, 'form_not_found'],
    [{ ...FORM, slug: 'nope' }, 404, 'form_not_found'],
    [[FORM], 400, 'invalid_request'],
    ['{bad json', 400, 'invalid_request']
  ])('refuses %j with %i %s, nothing stored', async (body, status, expected) => {
    await publish()
    const res = await app()('/api/site/leads', body)
    expect(res.status).toBe(status)
    expect(await code(res)).toBe(expected)
    await settle()
    expect(sent).toHaveLength(0)
    expect((await db.query('select 1 from builder_leads')).rows).toHaveLength(0)
  })

  it('an unpublished page takes no lead', async () => {
    const id = await publish()
    await store.unpublish(ORG, id, AUTHOR)
    expect((await app()('/api/site/leads', FORM)).status).toBe(404)
  })

  it('body over the cap: 413', async () => {
    await publish()
    const res = await app()('/api/site/leads', { ...FORM, name: 'x'.repeat(MAX_LEAD_BODY_BYTES) })
    expect(res.status).toBe(413)
  })

  it.each([
    [{}, 'no Origin'],
    [{ origin: 'https://evil.example' }, 'another origin'],
    [{ origin: `${SITE}.evil.example` }, 'a look-alike origin'],
    [{ origin: 'null' }, 'the null origin']
  ])('403 origin_refused for %j (%s)', async (headers, _why) => {
    await publish()
    const call = app()
    const init = { origin: '', ...headers }
    const res = await call('/api/site/leads', FORM, init)
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('origin_refused')
    expect((await call('/api/site/leads/confirm', { token: 'x' }, init)).status).toBe(403)
  })

  it('rate limit per client address, then the window resets', async () => {
    await publish()
    const call = app({}, { orgId: ORG, origin: SITE, trustForwardedFor: true })
    const from = (ip: string, i: number) =>
      call(
        '/api/site/leads',
        { ...FORM, email: `u${i}-${ip}@example.com` },
        {
          'x-forwarded-for': `203.0.113.9, ${ip}`
        }
      )
    for (let i = 0; i < IP_LIMIT.max; i++) expect((await from('198.51.100.1', i)).status).toBe(202)
    const over = await from('198.51.100.1', 99)
    expect(over.status).toBe(429)
    expect(await code(over)).toBe('too_many_requests')
    // The first X-Forwarded-For entry is the client's own claim: it does not count.
    expect((await from('198.51.100.2', 0)).status).toBe(202)
    now += IP_LIMIT.windowMs
    expect((await from('198.51.100.1', 100)).status).toBe(202)
  })

  it('rate limit per page across addresses', async () => {
    await publish()
    const call = app({}, { orgId: ORG, origin: SITE, trustForwardedFor: true })
    let last = 0
    for (let i = 0; i <= PAGE_LIMIT.max; i++) {
      const res = await call(
        '/api/site/leads',
        { ...FORM, email: `p${i}@example.com` },
        {
          'x-forwarded-for': `10.0.${Math.floor(i / 200)}.${i % 200}`
        }
      )
      last = res.status
      if (i < PAGE_LIMIT.max) expect(res.status).toBe(202)
    }
    expect(last).toBe(429)
  })

  it('without trust in X-Forwarded-For the header is ignored', async () => {
    await publish()
    const call = app()
    for (let i = 0; i < IP_LIMIT.max; i++) {
      await call(
        '/api/site/leads',
        { ...FORM, email: `x${i}@example.com` },
        {
          'x-forwarded-for': `10.0.0.${i}`
        }
      )
    }
    const res = await call('/api/site/leads', FORM, { 'x-forwarded-for': '10.0.0.99' })
    expect(res.status).toBe(429)
  })

  it('mail failure: the pending lead is deleted again and a log line names no address', async () => {
    await publish()
    mailFails = true
    const res = await app()('/api/site/leads', FORM)
    expect(res.status).toBe(202)
    await settle()
    expect((await db.query('select 1 from builder_leads')).rows).toHaveLength(0)
    expect(logs).toEqual(['warn: confirm mail failed: smtp refused (550)'])
    expect(logs.join()).not.toContain('ada@')
  })

  it.each([
    ['no mail provider', { mailer: null }, { orgId: ORG, origin: SITE }],
    ['no site origin', {}, { orgId: ORG }],
    ['no database', { store: new BuilderConfigError('x') }, { orgId: ORG, origin: SITE }]
  ])('503 leads_not_configured: %s', async (_why, deps, site) => {
    const res = await app(deps as Partial<LeadApiDeps>, site)('/api/site/leads', FORM)
    expect(res.status).toBe(503)
    expect(await code(res)).toBe('leads_not_configured')
  })

  it('503 without a site org; 503 leads_unavailable on a database failure', async () => {
    const api = new LeadApi({
      site: new SiteConfigError('x'),
      store: async () => store,
      mailer: new FakeMailer(),
      limiter: new RateLimiter()
    })
    const a = createApp()
    a.use(
      createRouter().post(
        '/l',
        eventHandler((e) => api.submit(e))
      )
    )
    const res = await toWebHandler(a)(
      new Request('http://x/l', { method: 'POST', headers: { origin: SITE }, body: '{}' })
    )
    expect(res.status).toBe(503)

    await publish()
    db.failNext = Object.assign(new Error('boom ada@example.com'), { code: '57P01' })
    const down = await app()('/api/site/leads', FORM)
    expect(down.status).toBe(503)
    expect(await code(down)).toBe('leads_unavailable')
    expect(logs).toEqual(['warn: database call failed (57P01)'])
  })
})

describe('confirmMail', () => {
  it('names the host, the link and the expiry; no HTML', () => {
    for (const locale of ['de', 'en'] as const) {
      const mail = confirmMail(locale, 'https://s.example/x#token=t', 's.example')
      expect(mail.text).toContain('https://s.example/x#token=t')
      expect(mail.text).toContain('s.example')
      expect(mail.text).toContain('72')
      expect(mail.text).not.toContain('<')
    }
  })
})

describe('rate limit keys (security review)', () => {
  it('bad, bot and cross-origin forms create no rate limit key', async () => {
    await publish()
    const limiter = new RateLimiter(100, () => now)
    const call = app({ limiter })
    await call('/api/site/leads', { ...FORM, email: 'bad' })
    await call('/api/site/leads', { ...FORM, consent: false })
    await call('/api/site/leads', { ...FORM, website: 'spam' })
    await call('/api/site/leads', '{bad')
    await call('/api/site/leads', FORM, { origin: 'https://evil.example' })
    await call('/api/site/leads/confirm', { token: 'short' })
    expect(limiter.size).toBe(0)
    await call('/api/site/leads', FORM)
    expect(limiter.size).toBe(2)
  })

  it('a full limiter fails closed: 429, nothing stored', async () => {
    await publish()
    const limiter = new RateLimiter(1, () => now)
    limiter.hit('someone-else', { max: 1, windowMs: 60_000 })
    const res = await app({ limiter })('/api/site/leads', FORM)
    expect(res.status).toBe(429)
    await settle()
    expect((await db.query('select 1 from builder_leads')).rows).toHaveLength(0)
  })

  it('IPv6 clients of one /64 share the limit', async () => {
    await publish()
    const call = app({}, { orgId: ORG, origin: SITE, trustForwardedFor: true })
    for (let i = 0; i < IP_LIMIT.max; i++) {
      const res = await call(
        '/api/site/leads',
        { ...FORM, email: `v${i}@example.com` },
        {
          'x-forwarded-for': `2001:db8:1:2::${i + 1}`
        }
      )
      expect(res.status).toBe(202)
    }
    const res = await call(
      '/api/site/leads',
      { ...FORM, email: 'v9@example.com' },
      {
        'x-forwarded-for': '2001:db8:1:2:abcd::99'
      }
    )
    expect(res.status).toBe(429)
  })
})
