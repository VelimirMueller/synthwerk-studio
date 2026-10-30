// Deletes expired unconfirmed leads (synthwerk#105): once after the start, then every hour.
// No builder database: the job does nothing. The log line gives the count only.
import { BuilderConfigError } from '../lib/builder-config'

export const PURGE_INTERVAL_MS = 60 * 60 * 1000

export default defineNitroPlugin(() => {
  if (import.meta.prerender) return
  const run = async () => {
    const open = useBuilderStore()
    if (open instanceof BuilderConfigError) return
    try {
      const removed = await (await open()).leads.purgeExpired()
      if (removed > 0) console.info(`[leads] deleted ${removed} unconfirmed leads`)
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      console.warn(`[leads] purge failed (${typeof code === 'string' ? code : 'error'})`)
    }
  }
  setTimeout(run, 30_000).unref()
  setInterval(run, PURGE_INTERVAL_MS).unref()
})
