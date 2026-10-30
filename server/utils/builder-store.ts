// One builder database pool per server process, shared by /api/builder (editor) and
// /api/site (public read). Migrations run on the first call; a failed run is tried again on the
// next call. The log line names the variable, never the URL.
import { BuilderConfigError, readBuilderConfig } from '../lib/builder-config'
import { migrate, PoolDb } from '../lib/builder-db'
import { BuilderStore } from '../lib/builder-store'

let opener: (() => Promise<BuilderStore>) | BuilderConfigError | undefined

export function useBuilderStore(): (() => Promise<BuilderStore>) | BuilderConfigError {
  if (!opener) {
    try {
      const { databaseUrl } = readBuilderConfig(useRuntimeConfig())
      const db = PoolDb.connect(databaseUrl)
      let ready: Promise<BuilderStore> | undefined
      opener = () => {
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
      console.warn(`[builder] ${err.message}`)
      opener = err
    }
  }
  return opener
}
