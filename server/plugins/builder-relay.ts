// Starts the builder relay at server start (synthwerk#106): builder_events -> EVT_STUDIO.
// Off when NUXT_BUILDER_NATS_URL or NUXT_BUILDER_DATABASE_URL is empty: the rows wait in the
// table and a later start sends them. Stops when the server closes.
import { BuilderConfigError, readRelayConfig } from '../lib/builder-config'
import { migrate } from '../lib/builder-db'
import { NatsBus } from '../lib/builder-nats'
import { eventSource, superviseRelay } from '../lib/builder-relay'

const log = (level: 'info' | 'warn' | 'error', message: string) =>
  console[level](`[builder-relay] ${message}`)

export default defineNitroPlugin((nitro) => {
  let config: ReturnType<typeof readRelayConfig>
  try {
    config = readRelayConfig(useRuntimeConfig())
  } catch (err) {
    if (!(err instanceof BuilderConfigError)) throw err
    log('warn', `relay off: ${err.message}`)
    return
  }
  if (!config) {
    log('info', 'relay off: NUXT_BUILDER_NATS_URL is not set')
    return
  }
  const db = useBuilderDb()
  if (db instanceof BuilderConfigError) {
    log('warn', 'relay off: NUXT_BUILDER_DATABASE_URL is not set')
    return
  }
  const relay = config
  const stop = new AbortController()
  nitro.hooks.hook('close', () => stop.abort())
  void superviseRelay({
    signal: stop.signal,
    db,
    source: eventSource(relay.platformEnv),
    migrate: () => migrate(db),
    openBus: () => NatsBus.open(relay),
    log
  })
})
