// The apps of the signed-in user's org, through the BFF (/api/apps). The BFF holds the token;
// every write sends the CSRF token of the session.
import type { WidgetSettings } from '#shared/widget'

export interface StudioApp {
  id: string
  name: string
  allowedOrigins: string[]
  widgetSettings: WidgetSettings
  createdAt: string
  updatedAt: string
}

export interface AppChange {
  name?: string
  allowedOrigins?: string[]
  widgetSettings?: WidgetSettings
}

/** Text for the problem codes of the BFF and identity. */
const messages: Record<string, string> = {
  invalid_request: 'A value is not valid.',
  unauthenticated: 'Your session ended. Sign in again.',
  forbidden: 'Only an owner or an admin of the org can change apps.',
  csrf_failed: 'The request was refused. Reload the page and try again.',
  not_found: 'This app does not exist in your org.',
  app_limit_reached: 'Your plan allows no more apps.',
  not_configured: 'The studio cannot reach identity. Ask the operator to set NUXT_IDENTITY_URL.'
}

/** A user-facing text for a failed call: the known code, plus the detail of identity. */
export function problemText(err: unknown): string {
  const data = (err as { data?: { data?: { code?: unknown; detail?: unknown } } })?.data?.data
  const code = typeof data?.code === 'string' ? data.code : ''
  const detail = typeof data?.detail === 'string' ? data.detail : ''
  const text = Object.hasOwn(messages, code)
    ? messages[code]
    : 'Identity is not available. Try again.'
  return detail ? `${text} ${detail}` : (text ?? '')
}

export function useApps() {
  const { session } = useAuthSession()
  const headers = () => ({ 'x-csrf-token': session.value?.csrfToken ?? '' })

  return {
    create: (name: string, allowedOrigins: string[]) =>
      $fetch<StudioApp>('/api/apps', {
        method: 'POST',
        headers: headers(),
        body: { name, allowedOrigins }
      }),
    update: (id: string, change: AppChange) =>
      $fetch<StudioApp>(`/api/apps/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: headers(),
        body: change
      }),
    remove: (id: string) =>
      $fetch(`/api/apps/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() })
  }
}

/** Owner and admin may write. Identity checks again; this only shapes the page. */
export function canManageApps(roles: { role: string }[] | undefined): boolean {
  return (roles ?? []).some((r) => r.role === 'owner' || r.role === 'admin')
}

/** One origin per line; blank lines dropped. */
export const parseOrigins = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
