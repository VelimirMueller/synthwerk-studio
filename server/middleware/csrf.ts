// CSRF guard: every unsafe request must come from the studio origin.
// Routes that act on a session also check the x-csrf-token header (AuthService.assertCsrfToken).
// /api/site is public (synthwerk#109): reads (GET, HEAD) skip the guard, so the public site
// answers without the sign-in settings (useAuth throws when NUXT_OIDC_* is missing).
// The two lead routes (synthwerk#105) have no session to protect: they check the Origin header
// against NUXT_SITE_ORIGIN themselves (server/lib/lead-api.ts).
// The rules live in server/lib/csrf-guard.ts. The guard covers every path, not only /api (synthwerk#59).
import { skipsCsrfGuard } from '../lib/csrf-guard'

export default defineEventHandler((event) => {
  if (skipsCsrfGuard(event.method, event.path)) return
  useAuth().assertSameOrigin(event)
})
