// One BuilderApi and one database pool per server process. A missing NUXT_BUILDER_DATABASE_URL
// stops only /api/builder (503). Migrations run on the first builder call; a failed run is tried
// again on the next call. The log lines name the variable, never the URL.
import { BuilderApi } from '../lib/builder-api'
import { BuilderConfigError, readBuilderConfig } from '../lib/builder-config'
import { migrate, PoolDb } from '../lib/builder-db'
import { BuilderStore } from '../lib/builder-store'
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
    let store: (() => Promise<BuilderStore>) | BuilderConfigError
    try {
      const { databaseUrl } = readBuilderConfig(config)
      const db = PoolDb.connect(databaseUrl)
      let ready: Promise<BuilderStore> | undefined
      store = () => {
        ready ??= migrate(db).then(
          () => new BuilderStore(db),
          (err) => {
            ready = undefined
            throw err
          }
        )
        return ready
      }
    } catch (err) {
      if (!(err instanceof BuilderConfigError)) throw err
      log('warn', err.message)
      store = err
    }
    api = new BuilderApi({ identity, store, auth: useAuth(), log })
  }
  return api
}
