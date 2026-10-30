// The outbox relay of the page builder (synthwerk#106, docs/features/page-builder.md).
// builder_events is the outbox: the store writes each row in the transaction of the change.
// The relay reads the rows with `relayed_at` null, publishes each one as a CloudEvent to
// NATS JetStream (stream EVT_STUDIO) and sets `relayed_at` in the same database transaction.
//
// Delivery: at least once. A stop after the publish and before the commit publishes the row
// again on the next run. JetStream drops the copy inside the duplicate window (Nats-Msg-Id = the
// event id); identity drops a later copy by its event id. Same rules as the Go kit outbox.
// Several studio processes can run the relay: each locks its rows with FOR UPDATE SKIP LOCKED.
import type { Db } from './builder-db'
import { EVENT_TYPES } from './builder-store'
import { UUIDV7_PATTERN } from './uuidv7'

export const STREAM_NAME = 'EVT_STUDIO'
export const STREAM_SUBJECTS = ['evt.studio.>']
export const CONTENT_TYPE = 'application/cloudevents+json'
const TYPE_PREFIX = 'dev.synthwerk.'
const SCHEMA_BASE = 'https://schemas.synthwerk.dev/events/'
const KNOWN_TYPES: readonly string[] = Object.values(EVENT_TYPES)
const ACTOR_PATTERN = /^user:[A-Za-z0-9_-]{1,128}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ENVS = ['local', 'dev', 'stg', 'prd'] as const
const MAX_ERROR = 200

/** The bus as the relay needs it. builder-nats.ts implements it with the `nats` client. */
export interface RelayBus {
  /** Publishes one message and waits for the JetStream ack. Throws on a failure. */
  publish(subject: string, payload: string, msgId: string): Promise<{ duplicate: boolean }>
}

export interface CloudEvent {
  specversion: '1.0'
  id: string
  source: string
  type: string
  subject: string
  time: string
  datacontenttype: 'application/json'
  dataschema: string
  orgid: string
  actor: string
  data: Record<string, unknown>
}

export interface RelayRow {
  seq: string | number
  id: string
  identity_org_id: string | null
  type: string
  subject: string
  actor: string
  time: Date | string
  data: unknown
}

/** A row that can never be a valid event. The relay closes it with this reason. */
export class UnrelayableError extends Error {}

/** The bus refused or did not ack a publish. The message names the error class only. */
export class RelayPublishError extends Error {}

/** `/synthwerk/studio/<env>`. CI runs publish as `local`, like the Go kit. */
export function eventSource(env: string): string {
  const e = env === 'ci' ? 'local' : env
  if (!(ENVS as readonly string[]).includes(e)) {
    throw new Error('builder relay: platform env must be local, dev, stg, prd or ci')
  }
  return `/synthwerk/studio/${e}`
}

/** The NATS subject of a type: `evt.` + the type without `dev.synthwerk.`. */
export function natsSubject(type: string): string {
  return `evt.${type.slice(TYPE_PREFIX.length)}`
}

/**
 * The CloudEvent of one row (contracts events/studio). `data` gets `org_id` (the identity org);
 * the row holds page id, slug, locale and the versions, never page content. Throws
 * UnrelayableError when the row breaks the envelope rules.
 */
export function toCloudEvent(row: RelayRow, source: string): CloudEvent {
  if (!KNOWN_TYPES.includes(row.type)) throw new UnrelayableError('unknown type')
  if (!UUIDV7_PATTERN.test(row.id)) throw new UnrelayableError('id is not a UUIDv7')
  const org = row.identity_org_id
  if (!org || !UUID_PATTERN.test(org)) throw new UnrelayableError('no identity org id')
  if (!ACTOR_PATTERN.test(row.actor)) throw new UnrelayableError('actor is not user:<sub>')
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new UnrelayableError('data is not an object')
  }
  const time = row.time instanceof Date ? row.time : new Date(row.time)
  if (Number.isNaN(time.getTime())) throw new UnrelayableError('bad time')
  const name = row.type.slice(TYPE_PREFIX.length).split('.').slice(1).join('.')
  return {
    specversion: '1.0',
    id: row.id,
    source,
    type: row.type,
    subject: row.subject,
    time: time.toISOString(),
    datacontenttype: 'application/json',
    dataschema: `${SCHEMA_BASE}studio/${name}.json`,
    orgid: org,
    actor: row.actor,
    data: { ...(data as Record<string, unknown>), org_id: org }
  }
}

export interface RelayOptions {
  db: Db
  bus: RelayBus
  /** eventSource(env). */
  source: string
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * Max rows per transaction. Default 20. The publishes run inside the transaction that holds the
   * row locks: with the 5 s publish timeout a slow bus keeps it open 100 s at most.
   */
  batchSize?: number
}

export class BuilderRelay {
  private readonly batchSize: number

  constructor(private readonly opts: RelayOptions) {
    this.batchSize = opts.batchSize ?? 20
  }

  /**
   * Publishes one batch in one transaction and returns the number of rows it closed. A publish
   * error stops the batch: the rows before it stay marked, the rest waits. Then it throws.
   */
  async runOnce(): Promise<number> {
    let failure: unknown
    const done = await this.opts.db.transaction(async (tx) => {
      const { rows } = await tx.query<RelayRow>(
        `select seq, id, identity_org_id, type, subject, actor, time, data from builder_events
          where relayed_at is null order by seq limit $1 for update skip locked`,
        [this.batchSize]
      )
      let n = 0
      for (const row of rows) {
        let event: CloudEvent
        try {
          event = toCloudEvent(row, this.opts.source)
        } catch (err) {
          const reason = err instanceof UnrelayableError ? err.message : 'data is not JSON'
          await tx.query(
            'update builder_events set relayed_at = now(), relay_error = $2 where seq = $1',
            [row.seq, reason.slice(0, MAX_ERROR)]
          )
          this.opts.log?.('error', `event ${row.id} not relayable: ${reason}`)
          n++
          continue
        }
        try {
          await this.opts.bus.publish(natsSubject(event.type), JSON.stringify(event), event.id)
        } catch (err) {
          failure = err
          break
        }
        await tx.query('update builder_events set relayed_at = now() where seq = $1', [row.seq])
        n++
      }
      return n
    })
    if (failure !== undefined) {
      const name = failure instanceof Error ? failure.name : 'error'
      throw new RelayPublishError(`publish failed (${name})`)
    }
    return done
  }

  /**
   * Runs until `signal` aborts. Idle: waits `intervalMs`. A failed batch: logs WARN and waits
   * with backoff, `intervalMs` doubled up to `maxBackoffMs`.
   */
  async run(signal: AbortSignal, intervalMs = 500, maxBackoffMs = 30_000): Promise<void> {
    let wait = intervalMs
    while (!signal.aborted) {
      try {
        const n = await this.runOnce()
        wait = intervalMs
        if (n > 0) this.opts.log?.('info', `relayed ${n} builder events`)
        if (n === this.batchSize) continue
      } catch (err) {
        // The message names the error class only: no URL, no SQL, no content.
        const code = (err as { code?: unknown } | null)?.code
        const what =
          err instanceof RelayPublishError
            ? err.message
            : typeof code === 'string'
              ? `database (${code})`
              : `database (${err instanceof Error ? err.name : 'error'})`
        this.opts.log?.('warn', `relay batch failed: ${what}`)
        wait = Math.min(wait * 2, maxBackoffMs)
      }
      await sleep(wait, signal)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export interface SuperviseOptions {
  signal: AbortSignal
  db: Db
  source: string
  /** Applies the builder migrations (builder-db.ts migrate). */
  migrate: () => Promise<unknown>
  /** Connects to the bus and makes sure the stream exists. */
  openBus: () => Promise<RelayBus & { close?: () => Promise<void> }>
  log?: RelayOptions['log']
  retryMs?: number
  maxRetryMs?: number
  intervalMs?: number
}

/**
 * Starts the relay: migrations, then the bus, each tried again with backoff until it works (the
 * database or NATS can start later than studio). Then runs the relay until `signal` aborts and
 * closes the bus. Never throws: the rest of studio keeps running without the relay.
 */
export async function superviseRelay(o: SuperviseOptions): Promise<void> {
  const retry = o.retryMs ?? 1_000
  const maxRetry = o.maxRetryMs ?? 30_000
  let wait = retry
  let bus: (RelayBus & { close?: () => Promise<void> }) | undefined
  while (!o.signal.aborted && !bus) {
    try {
      await o.migrate()
      bus = await o.openBus()
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      const name = err instanceof Error ? err.name : 'error'
      o.log?.(
        'warn',
        `relay not started (${typeof code === 'string' ? code : name}), retry in ${wait} ms`
      )
      await sleep(wait, o.signal)
      wait = Math.min(wait * 2, maxRetry)
    }
  }
  if (!bus) return
  o.log?.('info', `relay started: builder events go to ${STREAM_NAME}`)
  try {
    await new BuilderRelay({ db: o.db, bus, source: o.source, log: o.log }).run(
      o.signal,
      o.intervalMs
    )
  } finally {
    await bus.close?.().catch(() => {})
  }
}
