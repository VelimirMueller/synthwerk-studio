// One BuilderApi per server process. The database pool is shared with /api/site
// (utils/builder-store.ts). A missing NUXT_BUILDER_DATABASE_URL stops only /api/builder and
// /api/site (503). The log lines name the variable, never the URL.
import { BuilderApi } from '../lib/builder-api'
import { IdentityConfigError, readIdentityConfig } from '../lib/identity-config'

let api: BuilderApi | undefined

export function useBuilder(): BuilderApi {
  if (!api) {
    const log = (level: 'warn' | 'error', message: string) => console[level](`[builder] ${message}`)
    const config = useRuntimeConfig()
    let identity: ReturnType<typeof readIdentityConfig> | IdentityConfigError
    try {
      identity = readIdentityConfig(config)
    } catch (err) {
      if (!(err instanceof IdentityConfigError)) throw err
      log('warn', err.message)
      identity = err
    }
    const store = useBuilderStore()
    api = new BuilderApi({ identity, store, auth: useAuth(), log })
  }
  return api
}
