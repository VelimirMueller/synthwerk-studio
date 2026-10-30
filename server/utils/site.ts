// One SiteApi per server process (synthwerk#109). It shares the builder pool. A missing
// NUXT_SITE_ORG_ID or NUXT_BUILDER_DATABASE_URL stops only /api/site (503).
import { SiteApi } from '../lib/site-api'
import { readSiteConfig, SiteConfigError } from '../lib/site-config'

let api: SiteApi | undefined

export function useSiteApi(): SiteApi {
  if (!api) {
    const log = (level: 'warn' | 'error', message: string) => console[level](`[site] ${message}`)
    let site: ReturnType<typeof readSiteConfig> | SiteConfigError
    try {
      site = readSiteConfig(useRuntimeConfig())
    } catch (err) {
      if (!(err instanceof SiteConfigError)) throw err
      log('warn', err.message)
      site = err
    }
    api = new SiteApi({ site, store: useBuilderStore(), log })
  }
  return api
}
