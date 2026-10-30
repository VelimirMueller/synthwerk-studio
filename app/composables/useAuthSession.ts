// The signed-in user as the BFF shows it (GET /api/auth/session). It holds no token.

export interface AuthSession {
  user: { sub: string; name: string; username: string; email: string }
  org: { id: string; name: string; domain: string }
  roles: { role: string; orgIds: string[] }[]
  amr: string[]
  csrfToken: string
  expiresAt: string
  /** A fresh sign-in for one action, until this time (ISO). */
  stepUp?: { purpose: 'delete_account'; until: string }
}

/** Loads the session once per request. `null` = not signed in. */
export function useAuthSession() {
  const session = useState<AuthSession | null | undefined>('auth-session', () => undefined)
  // On the server, useRequestFetch forwards the cookie of the page request.
  const request = useRequestFetch()

  async function load(): Promise<AuthSession | null> {
    if (session.value !== undefined) return session.value
    try {
      session.value = await request<AuthSession>('/api/auth/session')
    } catch {
      session.value = null
    }
    return session.value
  }

  /** Ends the session here and at Zitadel, then leaves the app for the Zitadel logout. */
  async function signOut() {
    const csrf = session.value?.csrfToken ?? ''
    const { redirectTo } = await $fetch<{ redirectTo: string }>('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf }
    })
    session.value = null
    await navigateTo(redirectTo, { external: true })
  }

  return { session, load, signOut }
}

/** The sign-in URL that comes back to `returnTo` after the sign-in. */
export const signInUrl = (returnTo: string): string =>
  `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`
