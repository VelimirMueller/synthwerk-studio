// One builder database pool per server process, shared by /api/builder (editor), /api/site
// (public read) and the relay to EVT_STUDIO (plugins/builder-relay.ts, synthwerk#106).
// Migrations run on the first call; a failed run is tried again on the next call. The log line
// names the variable, never the URL.
import { BuilderConfigError, readBuilderConfig } from '../lib/builder-config'
import { migrate, PoolDb } from '../lib/builder-db'
import { BuilderStore } from '../lib/builder-store'

let db: PoolDb | BuilderConfigError | undefined
let opener: (() => Promise<BuilderStore>) | BuilderConfigError | undefined

/** The pool of the builder database, or the error that says why it is not configured. */
export function useBuilderDb(): PoolDb | BuilderConfigError {
  if (!db) {
    try {
      db = PoolDb.connect(readBuilderConfig(useRuntimeConfig()).databaseUrl)
    } catch (err) {
      if (!(err instanceof BuilderConfigError)) throw err
      console.warn(`[builder] ${err.message}`)
      db = err
    }
  }
  return db
}

export function useBuilderStore(): (() => Promise<BuilderStore>) | BuilderConfigError {
  if (!opener) {
    const pool = useBuilderDb()
    if (pool instanceof BuilderConfigError) {
      opener = pool
    } else {
      let ready: Promise<BuilderStore> | undefined
      opener = () => {
        ready ??= migrate(pool).then(
          () => new BuilderStore(pool),
          (err) => {
            ready = undefined
            throw err
          }
        )
        return ready
      }
    }
  }
  return opener
}
