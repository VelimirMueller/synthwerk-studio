// The answer of GET /api/site/pages/{locale}/{slug} (synthwerk#109). The server route and the
// public pages use the same type. No author and no page id: only what the page shows.
import type { Locale, PageContent } from './sections'

export interface LivePage {
  slug: string
  locale: Locale
  version: number
  publishedAt: string
  content: PageContent
}
