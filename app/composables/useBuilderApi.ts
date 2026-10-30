// Calls to the /api/builder BFF routes (synthwerk#46). Unsafe calls carry the session CSRF token.
// Errors use orgApiError from useOrgApi: status and `data.code` only.
import type { Locale, PageContent } from '#shared/sections'

export interface BuilderPageSummary {
  id: string
  slug: string
  locale: Locale
  title: string
  liveVersion: number | null
  draftRevision: number
  draftUpdatedAt: string
  draftUpdatedBy: string
  changed: boolean
}

export interface BuilderVersionMeta {
  version: number
  title: string
  publishedAt: string
  publishedBy: string
}

export interface BuilderPage extends BuilderPageSummary {
  draft: PageContent
  versions: BuilderVersionMeta[]
}

export interface BuilderVersion extends BuilderVersionMeta {
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

export function useBuilderApi() {
  const { session } = useAuthSession()
  const headers = () => ({ 'x-csrf-token': session.value?.csrfToken ?? '' })
  const page = (id: string) => `/api/builder/pages/${encodeURIComponent(id)}`

  return {
    list: () => $fetch<BuilderPageSummary[]>('/api/builder/pages'),
    create: (input: { slug: string; locale: Locale; title: string }) =>
      $fetch<BuilderPageSummary>('/api/builder/pages', {
        method: 'POST',
        headers: headers(),
        body: input
      }),
    get: (id: string) => $fetch<BuilderPage>(page(id)),
    saveDraft: (id: string, revision: number, content: PageContent) =>
      $fetch<BuilderPageSummary>(`${page(id)}/draft`, {
        method: 'PUT',
        headers: headers(),
        body: { revision, content }
      }),
    publish: (id: string, revision: number) =>
      $fetch<BuilderPageSummary>(`${page(id)}/publish`, {
        method: 'POST',
        headers: headers(),
        body: { revision }
      }),
    rollback: (id: string, version: number) =>
      $fetch<BuilderPageSummary>(`${page(id)}/rollback`, {
        method: 'POST',
        headers: headers(),
        body: { version }
      }),
    version: (id: string, version: number) =>
      $fetch<BuilderVersion>(`${page(id)}/versions/${version}`),
    events: (id: string) => $fetch<{ items: BuilderEvent[] }>(`${page(id)}/events`)
  }
}

/** The `data.field` of a 400 answer: the bad field, for example `sections[1].title`. */
export function builderErrorField(err: unknown): string {
  const field = (err as { data?: { data?: { field?: unknown } } } | null)?.data?.data?.field
  return typeof field === 'string' ? field : ''
}
