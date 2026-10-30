// One HealthService per server process. Pulse is reached inside the network
// (NUXT_PULSE_BASE_URL), never from the browser.
import { HealthService } from '../lib/health'

let service: HealthService | undefined

export function useHealth(): HealthService {
  if (!service) {
    const { pulse } = useRuntimeConfig()
    service = new HealthService(useAuth(), {
      baseUrl: typeof pulse?.baseUrl === 'string' ? pulse.baseUrl.trim() : '',
      log: (level, message) => console[level](`[health] ${message}`)
    })
  }
  return service
}
