// Public: no session. The site settings of this server (synthwerk#45). A prerendered page holds
// the settings of the build, so its client asks here (app/composables/useSiteConfig.ts). The
// values are public: every server-rendered page has them in its HTML too.
import { publicSiteConfig } from '#shared/site'
import { LIVE_CACHE_CONTROL } from '../../lib/site-api'

export default defineEventHandler((event) => {
  setResponseHeader(event, 'cache-control', LIVE_CACHE_CONTROL)
  return publicSiteConfig(useRuntimeConfig(event).public.site)
})
