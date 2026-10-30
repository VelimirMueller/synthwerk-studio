// The Postgres access of the page builder (synthwerk#46). The studio server owns this database:
// pages, their published versions and the builder events. No other service reads it; the public
// site (#45) reads published pages through the studio server.
// `Db` is the small part of a client the store needs, so the tests run the same SQL on PGlite.
import pg from 'pg'

export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>
  /** Runs `fn` in one transaction: COMMIT when it resolves, ROLLBACK when it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}

/**
 * The schema: one entry per version, one statement per item. Never change an applied entry:
 * add a new one.
 * builder_events is the audit trail of the builder and the outbox of its bus events: the relay
 * (builder-relay.ts) publishes each row to EVT_STUDIO and sets `relayed_at` (synthwerk#106).
 */
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `create table builder_pages (
      id uuid primary key,
      org_id text not null,
      slug text not null,
      locale text not null,
      draft jsonb not null,
      draft_revision integer not null,
      draft_updated_at timestamptz not null,
      draft_updated_by text not null,
      live_version integer,
      created_at timestamptz not null,
      created_by text not null,
      unique (org_id, slug, locale)
    )`,
    `create table builder_page_versions (
      page_id uuid not null references builder_pages (id) on delete cascade,
      version integer not null,
      content jsonb not null,
      published_at timestamptz not null,
      published_by text not null,
      primary key (page_id, version)
    )`,
    `create table builder_events (
      seq bigint generated always as identity primary key,
      id uuid not null unique,
      org_id text not null,
      type text not null,
      subject text not null,
      actor text not null,
      time timestamptz not null,
      data jsonb not null,
      relayed_at timestamptz
    )`,
    'create index builder_events_org_subject_seq on builder_events (org_id, subject, seq desc)'
  ],
  // 2 (synthwerk#106): the relay to EVT_STUDIO. identity_org_id is the identity org UUID of the
  // event (orgid on the bus). Rows from before the relay have none and a UUIDv4 id: they can never
  // be valid events, so they are closed with a reason. They stay in the page history.
  [
    'alter table builder_events add column identity_org_id uuid',
    'alter table builder_events add column relay_error text',
    `update builder_events set relayed_at = now(),
       relay_error = 'written before the relay: no identity org id'
     where relayed_at is null`,
    `alter table builder_events add constraint builder_events_relayable
       check (identity_org_id is not null or relay_error is not null)`,
    'create index builder_events_unrelayed on builder_events (seq) where relayed_at is null'
  ],
  // 3 (synthwerk#105): leads with double opt-in. One row per org and address. A pending row has
  // the sha256 of its confirm token and an expiry; the confirm clears both. The page link goes
  // to null when the page is deleted: slug, locale and version stay for the owner.
  [
    `create table builder_leads (
      id uuid primary key,
      seq bigint generated always as identity unique,
      org_id text not null,
      page_id uuid references builder_pages (id) on delete set null,
      slug text not null,
      locale text not null,
      section_id text not null,
      page_version integer not null,
      email text not null,
      name text not null,
      consent_text text not null,
      status text not null check (status in ('pending', 'confirmed')),
      token_hash text unique,
      created_at timestamptz not null,
      expires_at timestamptz,
      confirmed_at timestamptz,
      constraint builder_leads_pending check (
        (status = 'pending' and token_hash is not null and expires_at is not null
          and confirmed_at is null)
        or (status = 'confirmed' and token_hash is null and expires_at is null
          and confirmed_at is not null)
      )
    )`,
    'create unique index builder_leads_org_email on builder_leads (org_id, lower(email))',
    "create index builder_leads_expiry on builder_leads (expires_at) where status = 'pending'",
    'create index builder_leads_org_seq on builder_leads (org_id, seq desc)'
  ]
]

/** Any number; it only keeps two studio processes from migrating at the same time. */
const MIGRATION_LOCK = 4_604_601

/** Applies the missing migrations in one transaction. Safe to run on every start. */
export async function migrate(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK])
    await tx.query(
      'create table if not exists builder_schema (version integer primary key, applied_at timestamptz not null)'
    )
    const { rows } = await tx.query<{ v: number | null }>(
      'select max(version) as v from builder_schema'
    )
    const current = rows[0]?.v ?? 0
    for (let v = current + 1; v <= MIGRATIONS.length; v++) {
      for (const statement of MIGRATIONS[v - 1] ?? []) await tx.query(statement)
      await tx.query('insert into builder_schema (version, applied_at) values ($1, now())', [v])
    }
    return MIGRATIONS.length
  })
}

/** A `Db` over a pg pool. One pool per server process. */
export class PoolDb implements Db {
  constructor(private readonly pool: pg.Pool) {}

  static connect(connectionString: string): PoolDb {
    const pool = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 })
    // An idle client can fail (server restart). Without this handler the process stops.
    pool.on('error', () => {})
    return new PoolDb(pool)
  }

  async query<R>(sql: string, params: unknown[] = []): Promise<{ rows: R[] }> {
    const res = await this.pool.query(sql, params)
    return { rows: res.rows as R[] }
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    const tx: Db = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        const res = await client.query(sql, params)
        return { rows: res.rows as R[] }
      },
      transaction: (inner) => inner(tx)
    }
    try {
      await client.query('begin')
      const result = await fn(tx)
      await client.query('commit')
      return result
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
}
