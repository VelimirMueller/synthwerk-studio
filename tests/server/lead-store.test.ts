// The lead store on PGlite (synthwerk#105): double opt-in, single-use tokens, expiry, the list
// and the deletes. The real SQL and migrations.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BuilderStore } from '../../server/lib/builder-store'
import {
  hashToken,
  LEAD_LIST_LIMIT,
  type LeadInput,
  LeadStoreError,
  MAX_PENDING_PER_ORG,
  RESEND_AFTER_MS
} from '../../server/lib/lead-store'
import { PENDING_TTL_HOURS, TOKEN_PATTERN } from '../../shared/leads'
import { newSection, type PageContent } from '../../shared/sections'
import { type TestDb, testDb } from '../support/pglite'

const ORG = 'org-1'
const OTHER = 'org-2'
const ADA = 'user:ada'
const AUTHOR = { actor: ADA, identityOrgId: '0199f3a0-5b6c-7d8e-9f0a-1b2c3d4e5f60' }
const HOUR = 3600 * 1000

let db: TestDb
let store: BuilderStore
let clock: number

beforeEach(async () => {
  db = await testDb()
  clock = Date.parse('2026-10-30T10:00:00Z')
  store = new BuilderStore(db, () => new Date(clock))
})
afterEach(() => db.close())

const content: PageContent = { title: 'Join', sections: [newSection('lead', 'l1')] }

async function livePage(org = ORG, slug = 'join') {
  const page = await store.createPage(org, AUTHOR, { slug, locale: 'en', title: 'Join' })
  await store.saveDraft(org, page.id, ADA, 1, content)
  await store.publish(org, page.id, AUTHOR, 2)
  return page.id
}

function input(pageId: string, email = 'ada@example.com', org = ORG): LeadInput {
  return {
    orgId: org,
    page: { id: pageId, slug: 'join', locale: 'en', version: 1 },
    sectionId: 'l1',
    email,
    name: '',
    consentText: 'I agree.'
  }
}

const refused = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    if (err instanceof LeadStoreError) return `${err.status} ${err.code}`
    throw err
  }
  return 'resolved'
}

async function submitted(pageId: string, email?: string) {
  const r = await store.leads.submit(input(pageId, email))
  if (!r.mail) throw new Error('expected a mail')
  return r
}

describe('leads - double opt-in', () => {
  it('livePage finds the live version of the org only', async () => {
    const id = await livePage()
    const live = await store.leads.livePage(ORG, 'join', 'en')
    expect(live).toEqual({ pageId: id, version: 1, content })
    expect(await store.leads.livePage(OTHER, 'join', 'en')).toBeNull()
    expect(await store.leads.livePage(ORG, 'join', 'de')).toBeNull()
    await store.unpublish(ORG, id, AUTHOR)
    expect(await store.leads.livePage(ORG, 'join', 'en')).toBeNull()
  })

  it('submit stores a pending lead with the token hash only, and it is not listed', async () => {
    const id = await livePage()
    const r = await submitted(id)
    expect(r.token).toMatch(TOKEN_PATTERN)
    const { rows } = await db.query<{ status: string; token_hash: string; expires_at: Date }>(
      'select status, token_hash, expires_at from builder_leads'
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('pending')
    expect(rows[0]?.token_hash).toBe(hashToken(r.token))
    expect(JSON.stringify(rows)).not.toContain(r.token)
    expect(new Date(rows[0]?.expires_at ?? 0).getTime()).toBe(clock + PENDING_TTL_HOURS * HOUR)
    expect((await store.leads.list(ORG)).items).toEqual([])
  })

  it('confirm makes it a lead; the link works once', async () => {
    const id = await livePage()
    const r = await submitted(id)
    await store.leads.confirm(r.token)
    const page = await store.leads.list(ORG)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      email: 'ada@example.com',
      name: '',
      slug: 'join',
      locale: 'en',
      pageVersion: 1,
      consentText: 'I agree.'
    })
    expect(await refused(store.leads.confirm(r.token))).toBe('410 link_invalid')
    expect(await refused(store.leads.confirm('x'.repeat(43)))).toBe('410 link_invalid')
  })

  it('an expired link is refused and the purge deletes the row', async () => {
    const id = await livePage()
    const r = await submitted(id)
    await submitted(id, 'bob@example.com')
    clock += PENDING_TTL_HOURS * HOUR
    expect(await refused(store.leads.confirm(r.token))).toBe('410 link_invalid')
    expect(await store.leads.purgeExpired()).toBe(2)
    expect(await store.leads.purgeExpired()).toBe(0)
  })

  it('the purge keeps confirmed and still valid rows', async () => {
    const id = await livePage()
    const a = await submitted(id)
    await store.leads.confirm(a.token)
    clock += HOUR
    await submitted(id, 'bob@example.com')
    clock += PENDING_TTL_HOURS * HOUR - 2 * HOUR
    expect(await store.leads.purgeExpired()).toBe(0)
    expect((await db.query('select 1 from builder_leads')).rows).toHaveLength(2)
  })

  it('a confirmed address gets no new mail, in any letter case', async () => {
    const id = await livePage()
    const r = await submitted(id)
    await store.leads.confirm(r.token)
    expect(await store.leads.submit(input(id, 'ADA@Example.com'))).toEqual({ mail: false })
    expect((await db.query('select 1 from builder_leads')).rows).toHaveLength(1)
  })

  it('a pending address gets a new mail only after the cool-down; the old link stops', async () => {
    const id = await livePage()
    const first = await submitted(id)
    clock += RESEND_AFTER_MS - 1000
    expect(await store.leads.submit(input(id))).toEqual({ mail: false })
    clock += 2000
    const second = await submitted(id)
    expect(second.leadId).toBe(first.leadId)
    expect(await refused(store.leads.confirm(first.token))).toBe('410 link_invalid')
    await store.leads.confirm(second.token)
    expect((await store.leads.list(ORG)).items).toHaveLength(1)
  })

  it('an expired pending row is renewed by a new form', async () => {
    const id = await livePage()
    await submitted(id)
    clock += PENDING_TTL_HOURS * HOUR + 1000
    const again = await submitted(id)
    await store.leads.confirm(again.token)
    expect((await store.leads.list(ORG)).items).toHaveLength(1)
  })

  it('caps the pending rows of an org', async () => {
    const id = await livePage()
    await db.query(
      `insert into builder_leads (id, org_id, page_id, slug, locale, section_id, page_version,
         email, name, consent_text, status, token_hash, created_at, expires_at)
       select gen_random_uuid(), $1, $2, 'join', 'en', 'l1', 1, 'p' || g || '@example.com', '',
              'x', 'pending', md5(g::text), $3, $4
         from generate_series(1, $5) g`,
      [ORG, id, new Date(clock), new Date(clock + HOUR), MAX_PENDING_PER_ORG]
    )
    expect(await refused(store.leads.submit(input(id, 'new@example.com')))).toBe(
      '429 too_many_requests'
    )
    // Another org has its own cap.
    const other = await livePage(OTHER)
    expect((await store.leads.submit(input(other, 'new@example.com', OTHER))).mail).toBe(true)
  })

  it('dropPending deletes a pending row only', async () => {
    const id = await livePage()
    const a = await submitted(id)
    const b = await submitted(id, 'bob@example.com')
    await store.leads.confirm(b.token)
    await store.leads.dropPending(a.leadId)
    await store.leads.dropPending(b.leadId)
    expect((await store.leads.list(ORG)).items.map((l) => l.email)).toEqual(['bob@example.com'])
  })
})

describe('leads - list, export and delete', () => {
  async function confirmed(pageId: string, n: number) {
    for (let i = 0; i < n; i++) {
      const r = await submitted(pageId, `u${i}@example.com`)
      await store.leads.confirm(r.token)
    }
  }

  it('lists newest first in pages with a cursor; other orgs never show', async () => {
    const id = await livePage()
    await confirmed(id, LEAD_LIST_LIMIT + 2)
    const other = await livePage(OTHER)
    const o = await store.leads.submit(input(other, 'x@example.com', OTHER))
    if (o.mail) await store.leads.confirm(o.token)
    const first = await store.leads.list(ORG)
    expect(first.items).toHaveLength(LEAD_LIST_LIMIT)
    expect(first.items[0]?.email).toBe(`u${LEAD_LIST_LIMIT + 1}@example.com`)
    expect(first.next).not.toBeNull()
    const second = await store.leads.list(ORG, first.next ?? '')
    expect(second.items.map((l) => l.email)).toEqual(['u1@example.com', 'u0@example.com'])
    expect(second.next).toBeNull()
    // A bad cursor reads from the start.
    expect((await store.leads.list(ORG, '1; drop table x')).items).toHaveLength(LEAD_LIST_LIMIT)
    expect(await store.leads.exportAll(ORG)).toHaveLength(LEAD_LIST_LIMIT + 2)
  })

  it('remove deletes a lead of the org; another org gets 404', async () => {
    const id = await livePage()
    await confirmed(id, 1)
    const lead = (await store.leads.list(ORG)).items[0]
    if (!lead) throw new Error('no lead')
    expect(await refused(store.leads.remove(OTHER, lead.id))).toBe('404 lead_not_found')
    await store.leads.remove(ORG, lead.id)
    expect(await refused(store.leads.remove(ORG, lead.id))).toBe('404 lead_not_found')
  })

  it('removeOrgs deletes every lead of the orgs only', async () => {
    const id = await livePage()
    await confirmed(id, 2)
    await submitted(id, 'pending@example.com')
    const other = await livePage(OTHER)
    await store.leads.submit(input(other, 'x@example.com', OTHER))
    expect(await store.leads.removeOrgs([])).toBe(0)
    expect(await store.leads.removeOrgs([ORG])).toBe(3)
    expect((await db.query('select org_id from builder_leads')).rows).toEqual([{ org_id: OTHER }])
  })

  it('a deleted page keeps its confirmed leads and drops the pending ones', async () => {
    const id = await livePage()
    await confirmed(id, 1)
    await submitted(id, 'pending@example.com')
    await store.deletePage(ORG, id, AUTHOR, 'join')
    const leads = await store.leads.list(ORG)
    expect(leads.items).toHaveLength(1)
    expect(leads.items[0]?.slug).toBe('join')
    expect((await db.query('select page_id from builder_leads')).rows).toEqual([{ page_id: null }])
  })
})
