// Leads with double opt-in (synthwerk#105, docs/features/leads.md). Same database as the builder.
//
// Model:
// - One row per org and address (case-insensitive). A new address is `pending`: it holds the
//   sha256 of a single-use confirm token and an expiry. The token itself is never stored.
// - Confirm turns the row `confirmed` and clears hash and expiry: the link works once.
// - A pending row expires after PENDING_TTL_HOURS. `purgeExpired` deletes it (a job runs it).
// - A confirmed address sends no new mail. A pending one sends again only after RESEND_AFTER_MS.
// - Only confirmed leads are listed. Pending rows are not leads yet.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { type Lead, type LeadPage, PENDING_TTL_HOURS } from '../../shared/leads'
import type { Locale, PageContent } from '../../shared/sections'
import type { Db } from './builder-db'

/** No second confirm mail to the same pending address before this time. */
export const RESEND_AFTER_MS = 10 * 60 * 1000
/** Pending rows per org. Above it the form answers 429: a cap on what a flood can store. */
export const MAX_PENDING_PER_ORG = 1000
export const LEAD_LIST_LIMIT = 100
/** Rows in one CSV export. */
export const EXPORT_LIMIT = 10_000

export class LeadStoreError extends Error {
  constructor(
    readonly status: 404 | 410 | 429,
    readonly code: string
  ) {
    super(code)
    this.name = 'LeadStoreError'
  }
}

/** The live page a form belongs to. */
export interface LiveLeadPage {
  pageId: string
  version: number
  content: PageContent
}

export interface LeadInput {
  orgId: string
  page: { id: string; slug: string; locale: Locale; version: number }
  sectionId: string
  email: string
  name: string
  consentText: string
}

/** What `submit` did. `token` is set only when a confirm mail must go out. */
export type SubmitResult = { mail: false } | { mail: true; leadId: string; token: string }

interface LeadRow {
  id: string
  seq: string | number
  email: string
  name: string
  slug: string
  locale: string
  page_version: number
  consent_text: string
  created_at: Date | string
  confirmed_at: Date | string
}

const iso = (value: Date | string) => new Date(value).toISOString()
const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T

/** sha256 of the token, hex. The database keeps only this. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

function toLead(row: LeadRow): Lead {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    slug: row.slug,
    locale: row.locale,
    pageVersion: row.page_version,
    consentText: row.consent_text,
    createdAt: iso(row.created_at),
    confirmedAt: iso(row.confirmed_at)
  }
}

const LEAD_COLUMNS =
  'id, seq, email, name, slug, locale, page_version, consent_text, created_at, confirmed_at'

export class LeadStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** The live version of a page of the org, with its page id. Null: not live. */
  async livePage(orgId: string, slug: string, locale: Locale): Promise<LiveLeadPage | null> {
    const { rows } = await this.db.query<{ id: string; version: number; content: unknown }>(
      `select p.id, v.version, v.content
         from builder_pages p
         join builder_page_versions v on v.page_id = p.id and v.version = p.live_version
        where p.org_id = $1 and p.slug = $2 and p.locale = $3`,
      [orgId, slug, locale]
    )
    const row = rows[0]
    if (!row) return null
    return { pageId: row.id, version: row.version, content: json<PageContent>(row.content) }
  }

  /**
   * Stores a pending lead, or does nothing for an address that is confirmed or got a mail a
   * short time ago. The answer to the visitor is the same in every case.
   */
  async submit(input: LeadInput): Promise<SubmitResult> {
    const at = this.now()
    const expires = new Date(at.getTime() + PENDING_TTL_HOURS * 3600 * 1000)
    return this.db.transaction(async (tx) => {
      // Serializes the writes of one org: the pending cap and the address check hold.
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`leads:${input.orgId}`])
      const found = await tx.query<{
        id: string
        status: string
        created_at: Date | string
        expires_at: Date | string | null
      }>(
        `select id, status, created_at, expires_at from builder_leads
          where org_id = $1 and lower(email) = lower($2) for update`,
        [input.orgId, input.email]
      )
      const row = found.rows[0]
      if (row?.status === 'confirmed') return { mail: false }
      const live =
        row?.expires_at !== null && row?.expires_at !== undefined && new Date(row.expires_at) > at
      if (row && live && at.getTime() - new Date(row.created_at).getTime() < RESEND_AFTER_MS) {
        return { mail: false }
      }
      if (!row) {
        const count = await tx.query<{ n: number }>(
          `select count(*)::int as n from builder_leads
            where org_id = $1 and status = 'pending' and expires_at > $2`,
          [input.orgId, at]
        )
        if ((count.rows[0]?.n ?? 0) >= MAX_PENDING_PER_ORG) {
          throw new LeadStoreError(429, 'too_many_requests')
        }
      }
      const token = randomBytes(32).toString('base64url')
      const params = [
        input.page.id,
        input.page.slug,
        input.page.locale,
        input.sectionId,
        input.page.version,
        input.email,
        input.name,
        input.consentText,
        hashToken(token),
        at,
        expires
      ]
      if (row) {
        // A new link replaces the old one: the old token stops working.
        await tx.query(
          `update builder_leads
              set page_id = $1, slug = $2, locale = $3, section_id = $4, page_version = $5,
                  email = $6, name = $7, consent_text = $8, token_hash = $9, created_at = $10,
                  expires_at = $11
            where id = $12`,
          [...params, row.id]
        )
        return { mail: true, leadId: row.id, token }
      }
      const id = randomUUID()
      await tx.query(
        `insert into builder_leads (id, org_id, page_id, slug, locale, section_id, page_version,
           email, name, consent_text, status, token_hash, created_at, expires_at)
         values ($12, $13, $1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11)`,
        [...params, id, input.orgId]
      )
      return { mail: true, leadId: id, token }
    })
  }

  /** Confirms the pending lead of the token. A used, expired or unknown token: 410. */
  async confirm(token: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `update builder_leads
          set status = 'confirmed', token_hash = null, expires_at = null, confirmed_at = $2
        where token_hash = $1 and status = 'pending' and expires_at > $2
        returning id`,
      [hashToken(token), this.now()]
    )
    if (rows.length === 0) throw new LeadStoreError(410, 'link_invalid')
  }

  /** Deletes a pending lead whose confirm mail could not be sent, so the visitor can try again. */
  async dropPending(leadId: string): Promise<void> {
    await this.db.query("delete from builder_leads where id = $1 and status = 'pending'", [leadId])
  }

  /** Deletes the expired pending leads. Returns how many. */
  async purgeExpired(): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>(
      `delete from builder_leads where status = 'pending' and expires_at <= $1 returning id`,
      [this.now()]
    )
    return rows.length
  }

  /** The confirmed leads of the org, newest first. `before` is the `next` of the page before. */
  async list(orgId: string, before?: string): Promise<LeadPage> {
    const cursor = before && /^[1-9][0-9]{0,17}$/.test(before) ? before : null
    const { rows } = await this.db.query<LeadRow>(
      `select ${LEAD_COLUMNS} from builder_leads
        where org_id = $1 and status = 'confirmed' and ($2::bigint is null or seq < $2::bigint)
        order by seq desc limit $3`,
      [orgId, cursor, LEAD_LIST_LIMIT + 1]
    )
    const items = rows.slice(0, LEAD_LIST_LIMIT)
    const last = items[items.length - 1]
    return {
      items: items.map(toLead),
      next: rows.length > LEAD_LIST_LIMIT && last ? String(last.seq) : null
    }
  }

  /** Every confirmed lead of the org for the CSV export, newest first, at most EXPORT_LIMIT. */
  async exportAll(orgId: string): Promise<Lead[]> {
    const { rows } = await this.db.query<LeadRow>(
      `select ${LEAD_COLUMNS} from builder_leads
        where org_id = $1 and status = 'confirmed' order by seq desc limit $2`,
      [orgId, EXPORT_LIMIT]
    )
    return rows.map(toLead)
  }

  /** Deletes one lead of the org (pending or confirmed). */
  async remove(orgId: string, leadId: string): Promise<void> {
    const { rows } = await this.db.query(
      'delete from builder_leads where org_id = $1 and id = $2 returning id',
      [orgId, leadId]
    )
    if (rows.length === 0) throw new LeadStoreError(404, 'lead_not_found')
  }

  /** Deletes every lead of the orgs (the org closed with an account delete). Returns how many. */
  async removeOrgs(orgIds: readonly string[]): Promise<number> {
    if (orgIds.length === 0) return 0
    const { rows } = await this.db.query(
      'delete from builder_leads where org_id = any($1::text[]) returning id',
      [orgIds]
    )
    return rows.length
  }
}
