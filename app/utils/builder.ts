// Page texts of the builder (synthwerk#46). Clients branch on the code, never on the message.

/** `error` is an OrgApiError (useOrgApi): status and code. */
export function builderErrorText(error: { status: number; code: string }, field = ''): string {
  switch (error.code) {
    case 'forbidden':
      return 'Only owners and admins can build pages of this org.'
    case 'invalid_content':
      return field
        ? `The page is not valid at ${field}. Check that field.`
        : 'The page is not valid. Check the sections.'
    case 'invalid_request':
      return field ? `The value of ${field} is not valid.` : 'The input is not valid.'
    case 'slug_taken':
      return 'A page with this slug and language exists already.'
    case 'page_limit_reached':
      return 'The org has the maximum number of pages.'
    case 'draft_conflict':
      return 'Somebody else changed the draft. Reload the page, then make your change again.'
    case 'no_changes':
      return 'The draft is the same as the live version. Nothing to publish.'
    case 'already_live':
      return 'This version is live already.'
    case 'page_not_found':
      return 'The page was not found.'
    case 'version_not_found':
      return 'The version was not found.'
    case 'payload_too_large':
      return 'The page is too large.'
    case 'builder_not_configured':
      return 'The studio has no builder database (NUXT_BUILDER_DATABASE_URL).'
    case 'builder_unavailable':
      return 'The builder database could not finish the call. Nothing changed. Try again later.'
    case 'upstream_unavailable':
      return 'The identity service could not confirm your role. Nothing changed. Try again later.'
    case 'identity_not_configured':
      return 'The studio is not connected to the identity service (NUXT_IDENTITY_URL).'
    case 'csrf_failed':
      return 'The request was refused. Reload the page and try again.'
    case 'unauthenticated':
      return 'Your session ended. Sign in again.'
  }
  if (error.status === 403) return builderErrorText({ status: 403, code: 'forbidden' })
  if (error.status === 503) return builderErrorText({ status: 503, code: 'builder_unavailable' })
  return 'Something went wrong. Try again.'
}

/** "Published v3" text of a builder event. Unknown types show their raw type. */
export function builderEventText(type: string, data: Record<string, unknown>): string {
  const v = typeof data.version === 'number' ? `v${data.version}` : ''
  if (type === 'dev.synthwerk.studio.page.created.v1') return 'Created the page'
  if (type === 'dev.synthwerk.studio.page.published.v1') return `Published ${v}`.trim()
  if (type === 'dev.synthwerk.studio.page.rolled_back.v1') return `Rolled back to ${v}`.trim()
  return type
}

/** A deep copy that Vue proxies do not leak into. */
export const cloneContent = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
