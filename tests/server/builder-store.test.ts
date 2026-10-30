// The builder store on PGlite: the real SQL and migrations, without a Postgres server.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate, PoolDb } from '../../server/lib/builder-db'
import {
  BuilderStore,
  BuilderStoreError,
  EVENT_TYPES,
  MAX_PAGES_PER_ORG
} from '../../server/lib/builder-store'
import { newSection, type PageContent } from '../../shared/sections'
import { type TestDb, testDb } from '../support/pglite'

const ORG = 'org-1'
const OTHER = 'org-2'
const ADA = 'user:ada'

let db: TestDb
let store: BuilderStore
let clock: number

beforeEach(async () => {
  db = await testDb()
  clock = Date.parse('2026-10-30T10:00:00Z')
  store = new BuilderStore(db, () => {
    clock += 1000
    return new Date(clock)
  })
})
afterEach(() => db.close())

const v1: PageContent = { title: 'Home', sections: [newSection('hero', 'h1')] }
const v2: PageContent = {
  title: 'Home 2',
  sections: [newSection('hero', 'h1'), newSection('faq', 'f1')]
}

const refused = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    if (err instanceof BuilderStoreError) return `${err.status} ${err.code}`
    throw err
  }
  return 'resolved'
}

async function created(slug = 'home') {
  return store.createPage(ORG, ADA, { slug, locale: 'en', title: 'Home' })
}

describe('migrate', () => {
  it('runs once; a second run changes nothing', async () => {
    expect(await migrate(db)).toBe(MIGRATIONS.length)
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from builder_schema')
    expect(rows[0]?.n).toBe(MIGRATIONS.length)
  })
})

describe('pages', () => {
  it('create gives an unpublished page with an empty draft and a created event', async () => {
    const page = await created()
    expect(page).toMatchObject({
      slug: 'home',
      locale: 'en',
      title: 'Home',
      liveVersion: null,
      draftRevision: 1,
      draftUpdatedBy: ADA,
      changed: true
    })
    const detail = await store.getPage(ORG, page.id)
    expect(detail.draft).toEqual({ title: 'Home', sections: [] })
    expect(detail.versions).toEqual([])
    expect(await store.listPages(ORG)).toEqual([expect.objectContaining({ id: page.id })])
    const events = await store.listEvents(ORG, page.id)
    expect(events).toEqual([
      expect.objectContaining({
        type: EVENT_TYPES.created,
        actor: ADA,
        subject: page.id,
        data: { page_id: page.id, slug: 'home', locale: 'en' }
      })
    ])
  })

  it('the same slug and locale twice - 409 slug_taken; another locale is fine', async () => {
    await created()
    expect(await refused(created())).toBe('409 slug_taken')
    await store.createPage(ORG, ADA, { slug: 'home', locale: 'de', title: 'Start' })
    await store.createPage(OTHER, ADA, { slug: 'home', locale: 'en', title: 'Home' })
  })

  it('page limit per org - 409 page_limit_reached', async () => {
    for (let i = 0; i < MAX_PAGES_PER_ORG; i++) await created(`p${i}`)
    expect(await refused(created('one-more'))).toBe('409 page_limit_reached')
  })

  it('another org sees no page - 404 page_not_found everywhere', async () => {
    const page = await created()
    expect(await store.listPages(OTHER)).toEqual([])
    expect(await refused(store.getPage(OTHER, page.id))).toBe('404 page_not_found')
    expect(await refused(store.saveDraft(OTHER, page.id, ADA, 1, v1))).toBe('404 page_not_found')
    expect(await refused(store.publish(OTHER, page.id, ADA, 1))).toBe('404 page_not_found')
    expect(await refused(store.rollback(OTHER, page.id, ADA, 1))).toBe('404 page_not_found')
    expect(await refused(store.getVersion(OTHER, page.id, 1))).toBe('404 page_not_found')
    expect(await refused(store.listEvents(OTHER, page.id))).toBe('404 page_not_found')
  })
})

describe('draft, publish, roll back', () => {
  it('save needs the current revision - else 409 draft_conflict', async () => {
    const page = await created()
    const saved = await store.saveDraft(ORG, page.id, 'user:bob', 1, v1)
    expect(saved).toMatchObject({ draftRevision: 2, title: 'Home', draftUpdatedBy: 'user:bob' })
    expect(await refused(store.saveDraft(ORG, page.id, ADA, 1, v2))).toBe('409 draft_conflict')
    expect((await store.getPage(ORG, page.id)).draft).toEqual(v1)
  })

  it('publish, change, publish, roll back: the old version is live again', async () => {
    const page = await created()
    await store.saveDraft(ORG, page.id, ADA, 1, v1)
    expect(await refused(store.publish(ORG, page.id, ADA, 1))).toBe('409 draft_conflict')
    const first = await store.publish(ORG, page.id, ADA, 2)
    expect(first).toMatchObject({ liveVersion: 1, changed: false })
    expect(await refused(store.publish(ORG, page.id, ADA, 2))).toBe('409 no_changes')

    await store.saveDraft(ORG, page.id, ADA, 2, v2)
    expect((await store.getPage(ORG, page.id)).changed).toBe(true)
    await store.publish(ORG, page.id, ADA, 3)
    expect((await store.getLive(ORG, 'home', 'en'))?.content).toEqual(v2)

    const back = await store.rollback(ORG, page.id, ADA, 1)
    expect(back).toMatchObject({ liveVersion: 1, changed: true })
    const live = await store.getLive(ORG, 'home', 'en')
    expect(live).toMatchObject({ version: 1, title: 'Home', publishedBy: ADA })
    expect(live?.content).toEqual(v1)
    // The draft keeps the newer text.
    const detail = await store.getPage(ORG, page.id)
    expect(detail.draft).toEqual(v2)
    expect(detail.versions.map((v) => [v.version, v.title])).toEqual([
      [2, 'Home 2'],
      [1, 'Home']
    ])

    expect(await refused(store.rollback(ORG, page.id, ADA, 1))).toBe('409 already_live')
    expect(await refused(store.rollback(ORG, page.id, ADA, 9))).toBe('404 version_not_found')
    expect(await refused(store.getVersion(ORG, page.id, 9))).toBe('404 version_not_found')

    // Roll forward again: no draft change needed.
    expect(await store.rollback(ORG, page.id, ADA, 2)).toMatchObject({
      liveVersion: 2,
      changed: false
    })

    const events = await store.listEvents(ORG, page.id)
    expect(
      events.map((e) => [e.type, e.data.version ?? null, e.data.previous_version ?? null])
    ).toEqual([
      [EVENT_TYPES.rolledBack, 2, 1],
      [EVENT_TYPES.rolledBack, 1, 2],
      [EVENT_TYPES.published, 2, 1],
      [EVENT_TYPES.published, 1, null],
      [EVENT_TYPES.created, null, null]
    ])
  })

  it('getLive - no page or nothing published gives null', async () => {
    expect(await store.getLive(ORG, 'home', 'en')).toBeNull()
    await created()
    expect(await store.getLive(ORG, 'home', 'en')).toBeNull()
  })

  it('a failed statement in publish rolls the whole transaction back', async () => {
    const page = await created()
    await store.saveDraft(ORG, page.id, ADA, 1, v1)
    // Break the event insert: the version insert before it must not stay.
    await db.query(
      'alter table builder_events add constraint no_publish check (type <> $$' +
        EVENT_TYPES.published +
        '$$)'
    )
    await expect(store.publish(ORG, page.id, ADA, 2)).rejects.toThrow()
    const detail = await store.getPage(ORG, page.id)
    expect(detail.liveVersion).toBeNull()
    expect(detail.versions).toEqual([])
  })
})

describe('PoolDb', () => {
  function fakePool() {
    const log: string[] = []
    const client = {
      query: async (sql: string) => {
        log.push(sql)
        if (sql === 'fail') throw new Error('boom')
        return { rows: [{ sql }] }
      },
      release: () => log.push('release')
    }
    const pool = {
      query: async (sql: string) => ({ rows: [{ sql }] }),
      connect: async () => client
    }
    return { log, db: new PoolDb(pool as unknown as ConstructorParameters<typeof PoolDb>[0]) }
  }

  it('query passes through; a transaction commits and releases the client', async () => {
    const { log, db } = fakePool()
    expect(await db.query('select 1')).toEqual({ rows: [{ sql: 'select 1' }] })
    const rows = await db.transaction(
      async (tx) => (await tx.transaction((inner) => inner.query('x'))).rows
    )
    expect(rows).toEqual([{ sql: 'x' }])
    expect(log).toEqual(['begin', 'x', 'commit', 'release'])
  })

  it('a failed transaction rolls back, releases the client and throws', async () => {
    const { log, db } = fakePool()
    await expect(db.transaction((tx) => tx.query('fail'))).rejects.toThrow('boom')
    expect(log).toEqual(['begin', 'fail', 'rollback', 'release'])
  })

  it('connect builds a pool without opening a connection', () => {
    expect(PoolDb.connect('postgres://u:p@127.0.0.1:1/x')).toBeInstanceOf(PoolDb)
  })
})
