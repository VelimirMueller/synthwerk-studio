// CSRF guard: every unsafe request to /api must come from the studio origin.
// Routes that act on a session also check the x-csrf-token header (AuthService.assertCsrfToken).
// /api/site is public and read only (GET, synthwerk#109): it skips the guard, so the public site
// answers without the sign-in settings (useAuth throws when NUXT_OIDC_* is missing).
export default defineEventHandler((event) => {
  if (event.path.startsWith('/api/site/') && (event.method === 'GET' || event.method === 'HEAD')) {
    return
  }
  if (event.path.startsWith('/api/')) useAuth().assertSameOrigin(event)
})
