// One DemoService per server process (synthwerk#47). A bad NUXT_SITE_DEMO_* value turns the demo
// off (503 demo_not_configured), never the whole site. The log lines name the variable only.
import { RateLimiter } from '../lib/rate-limit'
import { DEFAULT_DEMO_LIMITS, DemoConfigError, DemoService, readDemoConfig } from '../lib/site-demo'

let service: DemoService | undefined

export function useSiteDemo(): DemoService {
  if (!service) {
    const log = (level: 'warn' | 'error', message: string) => console[level](`[demo] ${message}`)
    let config: ReturnType<typeof readDemoConfig>
    try {
      config = readDemoConfig(useRuntimeConfig())
    } catch (err) {
      if (!(err instanceof DemoConfigError)) throw err
      log('warn', `demo is off: ${err.message}`)
      config = {
        llmUrl: null,
        visionUrl: null,
        identityUrl: null,
        appId: null,
        siteOrigin: null,
        limits: DEFAULT_DEMO_LIMITS
      }
    }
    if (!config.appId) log('warn', 'image demo is off: set NUXT_SITE_DEMO_APP_ID')
    service = new DemoService(useAuth(), { config, limiter: new RateLimiter(), log })
  }
  return service
}
