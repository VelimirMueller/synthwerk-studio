// CSRF guard: every unsafe request to /api must come from the studio origin.
// Routes that act on a session also check the x-csrf-token header (AuthService.assertCsrfToken).
export default defineEventHandler((event) => {
  if (event.path.startsWith('/api/')) useAuth().assertSameOrigin(event)
})
