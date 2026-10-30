// Pages, drafts, published versions and builder events (synthwerk#46). Every call is scoped to
// one org: a page of another org is "not found". The caller (BuilderApi) authorizes the user.
//
// Model:
// - A page has one draft (`{ title, sections }`) with a revision. A save needs the revision it
//   read, so two editors cannot overwrite each other without a 409.
// - Publish copies the draft into a new immutable version (1, 2, 3, …) and makes it live.
// - Roll back makes an older published version live again. It does not change the draft.
// - Create, publish and roll back write one row to builder_events: the audit trail.
import { randomUUID } from 'node:crypto'
import type { Locale, PageContent } from '../../shared/sections'
import type { Db } from './builder-db'

export const MAX_PAGES_PER_ORG = 50
export const EVENT_LIST_LIMIT = 50

/** CloudEvents types, same pattern as the identity audit list (`dev.synthwerk.<svc>.<entity>.<action>.v1`). */
export const EVENT_TYPES = {
  created: 'dev.synthwerk.studio.page.created.v1',
  published: 'dev.synthwerk.studio.page.published.v1',
  rolledBack: 'dev.synthwerk.studio.page.rolled_back.v1'
} as const

export interface PageSummary {
  id: string
  slug: string
  locale: Locale
  title: string
  liveVersion: number | null
  draftRevision: number
  draftUpdatedAt: string
  draftUpdatedBy: string
  /** The draft differs from the live version (or nothing is live yet). */
  changed: boolean
}

export interface VersionMeta {
  version: number
  title: string
  publishedAt: string
  publishedBy: string
}

export interface PageDetail extends PageSummary {
  draft: PageContent
  /** Newest first. */
  versions: VersionMeta[]
}

export interface PageVersion extends VersionMeta {
  content: PageContent
}

export interface BuilderEvent {
  id: string
  type: string
  time: string
  actor: string
  subject: string
  data: Record<string, unknown>
}

/** A refused store call. The API maps it to status and code. */
export class BuilderStoreError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: string
  ) {
    super(code)
    this.name = 'BuilderStoreError'
  }
}

const notFound = () => new BuilderStoreError(404, 'page_not_found')

interface PageRow {
  id: string
  slug: string
  locale: Locale
  draft: PageContent
  draft_revision: number
  draft_updated_at: Date | string
  draft_updated_by: string
  live_version: number | null
  changed: boolean
}

const iso = (value: Date | string) => new Date(value).toISOString()

/** pg gives jsonb as an object; keep a string for drivers that do not parse it. */
const json = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T

function toSummary(row: PageRow): PageSummary {
  const draft = json<PageContent>(row.draft)
  return {
    id: row.id,
    slug: row.slug,
    locale: row.locale,
    title: draft.title,
    liveVersion: row.live_version,
    draftRevision: row.draft_revision,
    draftUpdatedAt: iso(row.draft_updated_at),
    draftUpdatedBy: row.draft_updated_by,
    changed: row.changed
  }
}

/** The page columns plus `changed` (draft differs from the live content; jsonb equality). */
const PAGE_SELECT = `
  select p.id, p.slug, p.locale, p.draft, p.draft_revision, p.draft_updated_at,
         p.draft_updated_by, p.live_version,
         (v.content is null or v.content <> p.draft) as changed
    from builder_pages p
    left join builder_page_versions v on v.page_id = p.id and v.version = p.live_version`

export class BuilderStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date()
  ) {}

  async listPages(orgId: string): Promise<PageSummary[]> {
    const { rows } = await this.db.query<PageRow>(
      `${PAGE_SELECT} where p.org_id = $1 order by p.slug, p.locale`,
      [orgId]
    )
    return rows.map(toSummary)
  }

  async createPage(
    orgId: string,
    actor: string,
    input: { slug: string; locale: Locale; title: string }
  ): Promise<PageSummary> {
    return this.db.transaction(async (tx) => {
      // Serializes creates per org, so the page limit holds.
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`builder:${orgId}`])
      const count = await tx.query<{ n: number }>(
        'select count(*)::int as n from builder_pages where org_id = $1',
        [orgId]
      )
      if ((count.rows[0]?.n ?? 0) >= MAX_PAGES_PER_ORG) {
        throw new BuilderStoreError(409, 'page_limit_reached')
      }
      const taken = await tx.query(
        'select 1 from builder_pages where org_id = $1 and slug = $2 and locale = $3',
        [orgId, input.slug, input.locale]
      )
      if (taken.rows.length > 0) throw new BuilderStoreError(409, 'slug_taken')
      const id = randomUUID()
      const at = this.now()
      const draft: PageContent = { title: input.title, sections: [] }
      await tx.query(
        `insert into builder_pages (id, org_id, slug, locale, draft, draft_revision,
           draft_updated_at, draft_updated_by, live_version, created_at, created_by)
         values ($1, $2, $3, $4, $5, 1, $6, $7, null, $6, $7)`,
        [id, orgId, input.slug, input.locale, JSON.stringify(draft), at, actor]
      )
      await this.event(tx, orgId, actor, EVENT_TYPES.created, id, {
        page_id: id,
        slug: input.slug,
        locale: input.locale
      })
      return {
        id,
        slug: input.slug,
        locale: input.locale,
        title: input.title,
        liveVersion: null,
        draftRevision: 1,
        draftUpdatedAt: at.toISOString(),
        draftUpdatedBy: actor,
        changed: true
      }
    })
  }

  async getPage(orgId: string, pageId: string): Promise<PageDetail> {
    const { rows } = await this.db.query<PageRow>(
      `${PAGE_SELECT} where p.org_id = $1 and p.id = $2`,
      [orgId, pageId]
    )
    const row = rows[0]
    if (!row) throw notFound()
    const versions = await this.db.query<{
      version: number
      title: string
      published_at: Date | string
      published_by: string
    }>(
      `select version, content->>'title' as title, published_at, published_by
         from builder_page_versions where page_id = $1 order by version desc`,
      [pageId]
    )
    return {
      ...toSummary(row),
      draft: json<PageContent>(row.draft),
      versions: versions.rows.map((v) => ({
        version: v.version,
        title: v.title,
        publishedAt: iso(v.published_at),
        publishedBy: v.published_by
      }))
    }
  }

  /** Replaces the draft. `revision` must be the current one: else 409 draft_conflict. */
  async saveDraft(
    orgId: string,
    pageId: string,
    actor: string,
    revision: number,
    content: PageContent
  ): Promise<PageSummary> {
    return this.db.transaction(async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `update builder_pages
            set draft = $4, draft_revision = draft_revision + 1,
                draft_updated_at = $5, draft_updated_by = $6
          where org_id = $1 and id = $2 and draft_revision = $3
          returning id`,
        [orgId, pageId, revision, JSON.stringify(content), this.now(), actor]
      )
      if (updated.rows.length === 0) {
        await this.lockPage(tx, orgId, pageId)
        throw new BuilderStoreError(409, 'draft_conflict')
      }
      const { rows } = await tx.query<PageRow>(`${PAGE_SELECT} where p.id = $1`, [pageId])
      return toSummary(rows[0] as PageRow)
    })
  }

  /** Publishes the draft as the next version. `revision` must be the current draft revision. */
  async publish(
    orgId: string,
    pageId: string,
    actor: string,
    revision: number
  ): Promise<PageSummary> {
    return this.db.transaction(async (tx) => {
      const page = await this.lockPage(tx, orgId, pageId)
      if (page.draft_revision !== revision) throw new BuilderStoreError(409, 'draft_conflict')
      if (!page.changed) throw new BuilderStoreError(409, 'no_changes')
      const next = await tx.query<{ v: number }>(
        'select coalesce(max(version), 0) + 1 as v from builder_page_versions where page_id = $1',
        [pageId]
      )
      const version = next.rows[0]?.v ?? 1
      await tx.query(
        `insert into builder_page_versions (page_id, version, content, published_at, published_by)
         values ($1, $2, $3, $4, $5)`,
        [pageId, version, JSON.stringify(page.draft), this.now(), actor]
      )
      await tx.query('update builder_pages set live_version = $2 where id = $1', [pageId, version])
      await this.event(tx, orgId, actor, EVENT_TYPES.published, pageId, {
        page_id: pageId,
        slug: page.slug,
        locale: page.locale,
        version,
        previous_version: page.live_version
      })
      return { ...toSummary(page), liveVersion: version, changed: false }
    })
  }

  /** Makes a published version live again. The draft stays as it is. */
  async rollback(
    orgId: string,
    pageId: string,
    actor: string,
    version: number
  ): Promise<PageSummary> {
    return this.db.transaction(async (tx) => {
      const page = await this.lockPage(tx, orgId, pageId)
      const found = await tx.query<{ content: unknown }>(
        'select content from builder_page_versions where page_id = $1 and version = $2',
        [pageId, version]
      )
      const target = found.rows[0]
      if (!target) throw new BuilderStoreError(404, 'version_not_found')
      if (page.live_version === version) throw new BuilderStoreError(409, 'already_live')
      await tx.query('update builder_pages set live_version = $2 where id = $1', [pageId, version])
      await this.event(tx, orgId, actor, EVENT_TYPES.rolledBack, pageId, {
        page_id: pageId,
        slug: page.slug,
        locale: page.locale,
        version,
        previous_version: page.live_version
      })
      const content = json<PageContent>(target.content)
      return {
        ...toSummary(page),
        liveVersion: version,
        changed: JSON.stringify(content) !== JSON.stringify(json<PageContent>(page.draft))
      }
    })
  }

  async getVersion(orgId: string, pageId: string, version: number): Promise<PageVersion> {
    const { rows } = await this.db.query<{
      version: number
      content: unknown
      published_at: Date | string
      published_by: string
    }>(
      `select v.version, v.content, v.published_at, v.published_by
         from builder_page_versions v join builder_pages p on p.id = v.page_id
        where p.org_id = $1 and p.id = $2 and v.version = $3`,
      [orgId, pageId, version]
    )
    const row = rows[0]
    if (!row) {
      await this.getPage(orgId, pageId)
      throw new BuilderStoreError(404, 'version_not_found')
    }
    const content = json<PageContent>(row.content)
    return {
      version: row.version,
      title: content.title,
      publishedAt: iso(row.published_at),
      publishedBy: row.published_by,
      content
    }
  }

  /**
   * The live content of a page by slug and locale, or null. For the public site (#45): it has
   * no route yet.
   */
  async getLive(orgId: string, slug: string, locale: Locale): Promise<PageVersion | null> {
    const { rows } = await this.db.query<{ id: string; live_version: number | null }>(
      'select id, live_version from builder_pages where org_id = $1 and slug = $2 and locale = $3',
      [orgId, slug, locale]
    )
    const row = rows[0]
    if (!row || row.live_version === null) return null
    return this.getVersion(orgId, row.id, row.live_version)
  }

  /** The newest builder events of a page. */
  async listEvents(orgId: string, pageId: string): Promise<BuilderEvent[]> {
    await this.getPage(orgId, pageId)
    const { rows } = await this.db.query<{
      id: string
      type: string
      time: Date | string
      actor: string
      subject: string
      data: unknown
    }>(
      `select id, type, time, actor, subject, data from builder_events
        where org_id = $1 and subject = $2 order by seq desc limit $3`,
      [orgId, pageId, EVENT_LIST_LIMIT]
    )
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      time: iso(r.time),
      actor: r.actor,
      subject: r.subject,
      data: json<Record<string, unknown>>(r.data)
    }))
  }

  private async lockPage(tx: Db, orgId: string, pageId: string): Promise<PageRow> {
    const { rows } = await tx.query<PageRow>(
      `${PAGE_SELECT} where p.org_id = $1 and p.id = $2 for update of p`,
      [orgId, pageId]
    )
    const row = rows[0]
    if (!row) throw notFound()
    return { ...row, draft: json<PageContent>(row.draft) }
  }

  private async event(
    tx: Db,
    orgId: string,
    actor: string,
    type: string,
    subject: string,
    data: Record<string, unknown>
  ): Promise<void> {
    await tx.query(
      `insert into builder_events (id, org_id, type, subject, actor, time, data)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), orgId, type, subject, actor, this.now(), JSON.stringify(data)]
    )
  }
}
