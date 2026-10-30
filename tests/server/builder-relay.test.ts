// The builder relay (synthwerk#106) on PGlite with a fake bus: outbox semantics, the CloudEvent
// shape of contracts events/studio, and the relay settings.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BuilderConfigError, readRelayConfig } from '../../server/lib/builder-config'
import type { Db } from '../../server/lib/builder-db'
import { isStreamNotFound, STREAM_CONFIG } from '../../server/lib/builder-nats'
import {
  BuilderRelay,
  eventSource,
  natsSubject,
  type RelayBus,
  superviseRelay,
  toCloudEvent
} from '../../server/lib/builder-relay'
import { BuilderStore, EVENT_TYPES } from '../../server/lib/builder-store'
import { UUIDV7_PATTERN, uuidv7 } from '../../server/lib/uuidv7'
import { newSection } from '../../shared/sections'
import { type TestDb, testDb } from '../support/pglite'

const ORG = '300000000000000001'
const IORG = '0199f3a0-5b6c-7d8e-9f0a-1b2c3d4e5f60'
const AUTHOR = { actor: 'user:283746192837461928', identityOrgId: IORG }
const SOURCE = '/synthwerk/studio/local'

class FakeBus implements RelayBus {
  sent: { subject: string; event: Record<string, unknown>; msgId: string }[] = []
  failAt = -1
  async publish(subject: string, payload: string, msgId: string) {
    if (this.sent.length === this.failAt) {
      this.failAt = -1
      throw new Error('nats: timeout to nats://user:secret@bus:4222')
    }
    this.sent.push({ subject, event: JSON.parse(payload), msgId })
    return { duplicate: false }
  }
}

let db: TestDb
let store: BuilderStore
let bus: FakeBus
let logs: string[]

const relay = (batchSize?: number) =>
  new BuilderRelay({
    db,
    bus,
    source: SOURCE,
    batchSize,
    log: (level, m) => logs.push(`${level} ${m}`)
  })

beforeEach(async () => {
  db = await testDb()
  store = new BuilderStore(db)
  bus = new FakeBus()
  logs = []
})
afterEach(() => db.close())

async function publishFlow() {
  const page = await store.createPage(ORG, AUTHOR, {
    slug: 'pricing',
    locale: 'de',
    title: 'Preise'
  })
  await store.saveDraft(ORG, page.id, AUTHOR.actor, 1, {
    title: 'Preise',
    sections: [newSection('hero', 'h1')]
  })
  await store.publish(ORG, page.id, AUTHOR, 2)
  await store.saveDraft(ORG, page.id, AUTHOR.actor, 2, {
    title: 'Preise 2',
    sections: [newSection('faq', 'f1')]
  })
  await store.publish(ORG, page.id, AUTHOR, 3)
  await store.rollback(ORG, page.id, AUTHOR, 1)
  return page
}

const unrelayed = async () =>
  (
    await db.query<{ n: number }>(
      'select count(*)::int as n from builder_events where relayed_at is null'
    )
  ).rows[0]?.n

describe('BuilderRelay', () => {
  it('runOnce - create, publish, publish, roll back - each row sent once in order, then marked', async () => {
    const page = await publishFlow()
    expect(await relay().runOnce()).toBe(4)
    expect(bus.sent.map((s) => s.subject)).toEqual([
      'evt.studio.page.created.v1',
      'evt.studio.page.published.v1',
      'evt.studio.page.published.v1',
      'evt.studio.page.rolled_back.v1'
    ])
    const back = bus.sent[3]?.event
    expect(back).toMatchObject({
      specversion: '1.0',
      source: SOURCE,
      type: EVENT_TYPES.rolledBack,
      subject: page.id,
      orgid: IORG,
      actor: AUTHOR.actor,
      datacontenttype: 'application/json',
      dataschema: 'https://schemas.synthwerk.dev/events/studio/page.rolled_back.v1.json',
      data: {
        org_id: IORG,
        page_id: page.id,
        slug: 'pricing',
        locale: 'de',
        version: 1,
        previous_version: 2
      }
    })
    expect(Object.keys(bus.sent[0]?.event.data as object).sort()).toEqual([
      'locale',
      'org_id',
      'page_id',
      'slug'
    ])
    for (const s of bus.sent) {
      expect(s.msgId).toBe(s.event.id)
      expect(s.event.id).toMatch(UUIDV7_PATTERN)
      // No page content on the bus.
      expect(JSON.stringify(s.event)).not.toContain('Preise')
    }
    expect(await unrelayed()).toBe(0)
    expect(await relay().runOnce()).toBe(0)
    expect(bus.sent).toHaveLength(4)
  })

  it('runOnce - publish fails on the 2nd row - 1st stays marked, rest waits; next run sends the rest once', async () => {
    await publishFlow()
    bus.failAt = 1
    await expect(relay().runOnce()).rejects.toThrow('publish failed (Error)')
    expect(bus.sent).toHaveLength(1)
    expect(await unrelayed()).toBe(3)
    expect(await relay().runOnce()).toBe(3)
    expect(new Set(bus.sent.map((s) => s.msgId)).size).toBe(4)
  })

  it('runOnce - a crash after the publish and before the commit - the row is sent again with the same id', async () => {
    await publishFlow()
    const failing = {
      ...db,
      transaction: async <T>(fn: (tx: Db) => Promise<T>) =>
        db.transaction(async (tx) => {
          await fn(tx)
          throw new Error('crash before commit')
        })
    } as TestDb
    await expect(
      new BuilderRelay({ db: failing, bus, source: SOURCE, batchSize: 1 }).runOnce()
    ).rejects.toThrow('crash')
    expect(await unrelayed()).toBe(4)
    await relay(1).runOnce()
    expect(bus.sent).toHaveLength(2)
    expect(bus.sent[0]?.msgId).toBe(bus.sent[1]?.msgId)
  })

  it('runOnce - batch size - at most that many rows per run', async () => {
    await publishFlow()
    expect(await relay(3).runOnce()).toBe(3)
    expect(await relay(3).runOnce()).toBe(1)
  })

  it('runOnce - a row that can never be an event - closed with a reason, not sent, queue moves on', async () => {
    await publishFlow()
    await db.query("update builder_events set actor = 'bob' where seq = 1")
    expect(await relay().runOnce()).toBe(4)
    expect(bus.sent).toHaveLength(3)
    const { rows } = await db.query<{ relay_error: string | null; relayed_at: unknown }>(
      'select relay_error, relayed_at from builder_events where seq = 1'
    )
    expect(rows[0]?.relay_error).toBe('actor is not user:<sub>')
    expect(rows[0]?.relayed_at).not.toBeNull()
    expect(logs.some((l) => l.startsWith('error ') && l.includes('not relayable'))).toBe(true)
  })

  it('migration 2 - rows from before the relay - closed with a reason; new rows need an identity org', async () => {
    const old = await testDb(false)
    const { MIGRATIONS } = await import('../../server/lib/builder-db')
    for (const sql of MIGRATIONS[0] ?? []) await old.query(sql)
    await old.query(
      `insert into builder_events (id, org_id, type, subject, actor, time, data)
       values ('6f1c2a9e-1b2c-4d3e-8f4a-5b6c7d8e9f00', $1, $2, 'p', 'user:ada', now(), '{}')`,
      [ORG, EVENT_TYPES.created]
    )
    for (const sql of MIGRATIONS[1] ?? []) await old.query(sql)
    const { rows } = await old.query<{ relay_error: string; relayed_at: unknown }>(
      'select relay_error, relayed_at from builder_events'
    )
    expect(rows[0]?.relay_error).toContain('before the relay')
    expect(rows[0]?.relayed_at).not.toBeNull()
    await expect(
      old.query(
        `insert into builder_events (id, org_id, type, subject, actor, time, data)
         values ($1, $2, $3, 'p', 'user:ada', now(), '{}')`,
        [uuidv7(), ORG, EVENT_TYPES.created]
      )
    ).rejects.toThrow()
    await old.close()
  })

  it('run - a failing batch - WARN without the error text, backoff, stops on abort', async () => {
    await publishFlow()
    bus.failAt = 0
    const stop = new AbortController()
    const done = relay().run(stop.signal, 5, 20)
    await new Promise((r) => setTimeout(r, 60))
    stop.abort()
    await done
    expect(bus.sent).toHaveLength(4)
    expect(logs).toContain('warn relay batch failed: publish failed (Error)')
    expect(logs.join('\n')).not.toContain('secret')
    expect(logs).toContain('info relayed 4 builder events')
  })

  it('run - the database fails - WARN names the class only', async () => {
    db.failNext = Object.assign(new Error('password authentication failed for user x'), {
      code: '28P01'
    })
    const stop = new AbortController()
    const done = relay().run(stop.signal, 5, 10)
    await new Promise((r) => setTimeout(r, 30))
    stop.abort()
    await done
    expect(logs).toContain('warn relay batch failed: database (28P01)')
    expect(logs.join('\n')).not.toContain('password')
  })
})

describe('superviseRelay', () => {
  it('migrate and bus fail first - retries with backoff, then relays and closes the bus on abort', async () => {
    await publishFlow()
    let tries = 0
    let closed = false
    const stop = new AbortController()
    const done = superviseRelay({
      signal: stop.signal,
      db,
      source: SOURCE,
      migrate: async () => {
        tries++
        if (tries < 3) throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' })
      },
      openBus: async () =>
        Object.assign(bus, {
          close: async () => {
            closed = true
          }
        }),
      log: (level, m) => logs.push(`${level} ${m}`),
      retryMs: 2,
      maxRetryMs: 4,
      intervalMs: 5
    })
    await new Promise((r) => setTimeout(r, 60))
    stop.abort()
    await done
    expect(tries).toBe(3)
    expect(bus.sent).toHaveLength(4)
    expect(closed).toBe(true)
    expect(logs.filter((l) => l.includes('relay not started (ECONNREFUSED)'))).toHaveLength(2)
  })

  it('aborted before the bus opens - returns without relaying', async () => {
    const stop = new AbortController()
    stop.abort()
    await superviseRelay({
      signal: stop.signal,
      db,
      source: SOURCE,
      migrate: async () => {},
      openBus: async () => bus
    })
    expect(bus.sent).toHaveLength(0)
  })
})

describe('toCloudEvent', () => {
  const row = {
    seq: 1,
    id: uuidv7(Date.parse('2026-10-30T12:00:00Z')),
    identity_org_id: IORG,
    type: EVENT_TYPES.published,
    subject: 'p1',
    actor: 'user:ada',
    time: '2026-10-30T12:00:00Z',
    data: '{"page_id":"p1","org_id":"forged"}'
  }
  it('data as text - parsed; org_id always the identity org', () => {
    expect(toCloudEvent(row, SOURCE).data).toEqual({ page_id: 'p1', org_id: IORG })
    expect(toCloudEvent(row, SOURCE).time).toBe('2026-10-30T12:00:00.000Z')
  })
  it.each([
    ['unknown type', { type: 'dev.synthwerk.studio.page.archived.v1' }],
    ['id is not a UUIDv7', { id: '6f1c2a9e-1b2c-4d3e-8f4a-5b6c7d8e9f00' }],
    ['no identity org id', { identity_org_id: null }],
    ['no identity org id', { identity_org_id: 'org-1' }],
    ['actor is not user:<sub>', { actor: 'system' }],
    ['data is not an object', { data: [1] }],
    ['bad time', { time: 'never' }]
  ])('%s - refused', (reason, change) => {
    expect(() => toCloudEvent({ ...row, ...change }, SOURCE)).toThrow(reason)
  })
})

describe('names and ids', () => {
  it('natsSubject and eventSource', () => {
    expect(natsSubject(EVENT_TYPES.rolledBack)).toBe('evt.studio.page.rolled_back.v1')
    expect(eventSource('ci')).toBe('/synthwerk/studio/local')
    expect(eventSource('prd')).toBe('/synthwerk/studio/prd')
    expect(() => eventSource('qa')).toThrow()
  })
  it('uuidv7 - version 7, variant, time first, sorted by time', () => {
    const a = uuidv7(1_000)
    const b = uuidv7(2_000)
    expect(a).toMatch(UUIDV7_PATTERN)
    expect(a < b).toBe(true)
    expect(a.slice(0, 13)).toBe('00000000-03e8')
    expect(() => uuidv7(-1)).toThrow()
  })
  it('stream config - EVT_STUDIO limits; stream-not-found detection', () => {
    expect(STREAM_CONFIG.subjects).toEqual(['evt.studio.>'])
    expect(STREAM_CONFIG.duplicate_window).toBe(120_000_000_000)
    expect(isStreamNotFound({ api_error: { err_code: 10059 } })).toBe(true)
    expect(isStreamNotFound(new Error('stream not found'))).toBe(true)
    expect(isStreamNotFound(new Error('timeout'))).toBe(false)
  })
})

describe('readRelayConfig', () => {
  it('empty URL - null (relay off)', () => {
    expect(readRelayConfig({})).toBeNull()
    expect(readRelayConfig({ builder: { natsUrl: '  ' } })).toBeNull()
  })
  it('URL, user, password, env', () => {
    expect(
      readRelayConfig({
        builder: {
          natsUrl: 'nats://bus:4222',
          natsUser: 'studio',
          natsPassword: 'pw',
          platformEnv: 'dev'
        }
      })
    ).toEqual({ natsUrl: 'nats://bus:4222', user: 'studio', password: 'pw', platformEnv: 'dev' })
    expect(readRelayConfig({ builder: { natsUrl: 'nats://bus:4222' } })).toEqual({
      natsUrl: 'nats://bus:4222',
      platformEnv: 'local'
    })
  })
  it.each([
    [{ natsUrl: 'http://bus:4222' }, 'nats://'],
    [{ natsUrl: 'not a url' }, 'nats://'],
    [{ natsUrl: 'nats://u:secret@bus:4222' }, 'must not hold credentials'],
    [{ natsUrl: 'nats://bus:4222', natsUser: 'studio' }, 'or neither'],
    [{ natsUrl: 'nats://bus:4222', platformEnv: 'qa' }, 'NUXT_BUILDER_PLATFORM_ENV']
  ])('%o - refused, names the variable, never the value', (builder, text) => {
    let err: unknown
    try {
      readRelayConfig({ builder })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BuilderConfigError)
    expect((err as Error).message).toContain(text)
    expect((err as Error).message).not.toContain('secret')
  })
})
