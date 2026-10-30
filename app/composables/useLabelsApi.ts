// Calls to the /api/labels BFF routes (synthwerk#44). Unsafe calls carry the session CSRF token.
// Errors use orgApiError from useOrgApi: status and `data.code` only.

export interface LabelTopic {
  id: string
  parent: string | null
  depth: number
}

export interface RuntimeLabel {
  id: string
  name: string
  topic: string
  prompt: string | null
  path: string[]
}

export interface LabelSet {
  org_id: string
  /** false = the org uses the default set. */
  custom: boolean
  labels: RuntimeLabel[]
  topics: LabelTopic[]
  total_labels: number
}

export interface NewLabel {
  name: string
  topic: string
  prompt?: string | null
  newTopic?: boolean
  topicParent?: string | null
}

export function useLabelsApi() {
  const { session } = useAuthSession()
  const headers = () => ({ 'x-csrf-token': session.value?.csrfToken ?? '' })

  return {
    get: () => $fetch<LabelSet>('/api/labels'),
    add: (label: NewLabel) =>
      $fetch<RuntimeLabel>('/api/labels', {
        method: 'POST',
        headers: headers(),
        body: { ...label }
      }),
    remove: (id: string) =>
      $fetch(`/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() })
  }
}

/** Page text for a failed /api/labels call. Clients branch on the code, never on the message. */
export function labelsErrorText(error: OrgApiError): string {
  switch (error.code) {
    case 'forbidden':
      return 'Only owners and admins can change the labels of this org.'
    case 'label_conflict':
      return 'Vision refused the change. The label or the topic exists already, the topic is unknown, or the label is a packaged label.'
    case 'invalid_request':
      return 'The input is not valid. Check the name, the topic and the prompt.'
    case 'not_found':
      return 'The label was not found. Reload the page.'
    case 'vision_unavailable':
      return 'The vision service could not finish the call. Try again later.'
    case 'vision_not_configured':
      return 'The studio is not connected to the vision service (NUXT_VISION_URL, NUXT_VISION_ADMIN_TOKEN).'
    case 'upstream_unavailable':
      return 'The identity service could not confirm your role. Nothing changed. Try again later.'
    case 'identity_not_configured':
      return 'The studio is not connected to the identity service (NUXT_IDENTITY_URL).'
    case 'csrf_failed':
      return 'The request was refused. Reload the page and try again.'
    case 'unauthenticated':
      return 'Your session ended. Sign in again.'
  }
  if (error.status === 403) return labelsErrorText({ status: 403, code: 'forbidden' })
  if (error.status === 502) return labelsErrorText({ status: 502, code: 'vision_unavailable' })
  return 'Something went wrong. Try again.'
}
