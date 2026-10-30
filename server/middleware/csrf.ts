// CSRF guard: every unsafe request to /api must come from the studio origin.
// Routes that act on a session also check the x-csrf-token header (AuthService.assertCsrfToken).
// /api/site is public (synthwerk#109): reads (GET, HEAD) skip the guard, so the public site
// answers without the sign-in settings (useAuth throws when NUXT_OIDC_* is missing).
// The two lead routes (synthwerk#105) have no session to protect: they check the Origin header
// against NUXT_SITE_ORIGIN themselves (server/lib/lead-api.ts).
const LEAD_ROUTES = new Set(['/api/site/leads', '/api/site/leads/confirm'])

export default defineEventHandler((event) => {
  const path = event.path.split('?')[0] ?? ''
  if (path.startsWith('/api/site/')) {
    if (event.method === 'GET' || event.method === 'HEAD') return
    if (event.method === 'POST' && LEAD_ROUTES.has(path)) return
  }
  if (event.path.startsWith('/api/')) useAuth().assertSameOrigin(event)
})
