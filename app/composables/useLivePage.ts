// Loads the live builder page for a public route (synthwerk#45, #109). On the server it runs
// during SSR, so the HTML holds the page. No live version: a 404 page. Database down: a 503 page
// that no cache keeps.
import type { Locale } from '#shared/sections'
import type { LivePage } from '#shared/site'

export async function useLivePage(locale: Locale, slug: string) {
  // Before the await: a Nuxt composable after it has no app context.
  const event = import.meta.server ? useRequestEvent() : undefined
  const { data, error } = await useFetch<LivePage>(`/api/site/pages/${locale}/${slug}`, {
    key: `site-${locale}-${slug}`
  })
  if (error.value) {
    const missing = error.value.statusCode === 404
    // An error page must not stay in a cache (the route rule says public for /de and /en).
    event?.node.res.setHeader('cache-control', 'no-store')
    throw createError({
      statusCode: missing ? 404 : 503,
      statusMessage: missing ? 'Not Found' : 'Service Unavailable',
      message: missing ? SITE_TEXTS[locale].notFound : SITE_TEXTS[locale].unavailable,
      fatal: true
    })
  }
  return data
}
