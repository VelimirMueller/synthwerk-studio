// Which requests the CSRF middleware (server/middleware/csrf.ts) lets through without the
// same-origin check. Kept out of the middleware file so tests can import it.
const LEAD_ROUTES = new Set(['/api/site/leads', '/api/site/leads/confirm'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The request path without query, with repeated leading slashes collapsed to one. */
export function guardPath(raw: string): string {
  const path = raw.split('?')[0] ?? ''
  return `/${path.replace(/^\/+/, '')}`
}

/**
 * True when the request needs no same-origin check:
 * - safe methods (GET, HEAD, OPTIONS) on any path;
 * - POST to the two lead routes, which check Origin against NUXT_SITE_ORIGIN themselves.
 * Every other request is checked, on every path, so a path the router reads differently than
 * this function (a leading "//", Nuxt < 4.6.4) cannot skip the check (synthwerk#59).
 */
export function skipsCsrfGuard(method: string, rawPath: string): boolean {
  if (SAFE_METHODS.has(method)) return true
  return method === 'POST' && LEAD_ROUTES.has(guardPath(rawPath))
}
