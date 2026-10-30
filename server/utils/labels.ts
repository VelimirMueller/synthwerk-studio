// One LabelsApi per server process. A missing NUXT_VISION_URL or NUXT_VISION_ADMIN_TOKEN stops
// only /api/labels (503). The log lines name the variable, never the token.
// Named useLabelAdmin: the app composable app/composables/useLabelsApi.ts owns useLabelsApi.
import { IdentityConfigError, readIdentityConfig } from '../lib/identity-config'
import { LabelsApi } from '../lib/labels-api'
import { readVisionConfig, VisionConfigError } from '../lib/vision-config'

let api: LabelsApi | undefined

export function useLabelAdmin(): LabelsApi {
  if (!api) {
    const log = (level: 'warn' | 'error', message: string) => console[level](`[labels] ${message}`)
    const config = useRuntimeConfig()
    let identity: ReturnType<typeof readIdentityConfig> | IdentityConfigError
    try {
      identity = readIdentityConfig(config)
    } catch (err) {
      if (!(err instanceof IdentityConfigError)) throw err
      log('warn', err.message)
      identity = err
    }
    let vision: ReturnType<typeof readVisionConfig> | VisionConfigError
    try {
      vision = readVisionConfig(config)
    } catch (err) {
      if (!(err instanceof VisionConfigError)) throw err
      log('warn', err.message)
      vision = err
    }
    api = new LabelsApi({ auth: useAuth(), identity, vision, log })
  }
  return api
}
