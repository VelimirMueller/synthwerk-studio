// One StatsService per server process (synthwerk#47). Pulse is reached inside the network
// (NUXT_PULSE_BASE_URL), never from the browser.
import { StatsService } from '../lib/site-stats'

let service: StatsService | undefined

export function useSiteStats(): StatsService {
  if (!service) {
    const { pulse } = useRuntimeConfig()
    service = new StatsService({
      baseUrl: typeof pulse?.baseUrl === 'string' ? pulse.baseUrl.trim() : '',
      log: (level, message) => console[level](`[site-stats] ${message}`)
    })
  }
  return service
}
