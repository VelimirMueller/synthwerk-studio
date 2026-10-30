// One AccountApi per server process. A missing NUXT_IDENTITY_URL stops only DELETE /api/me (503).
// An org that closes with the account loses its leads in the studio database (synthwerk#105).
import { AccountApi } from '../lib/account-api'
import { BuilderConfigError } from '../lib/builder-config'
import { IdentityConfigError, readIdentityConfig } from '../lib/identity-config'

let api: AccountApi | undefined

export function useAccountApi(): AccountApi {
  if (!api) {
    const log = (level: 'warn' | 'error', message: string) => console[level](`[account] ${message}`)
    let identity: ReturnType<typeof readIdentityConfig> | IdentityConfigError
    try {
      identity = readIdentityConfig(useRuntimeConfig())
    } catch (err) {
      if (!(err instanceof IdentityConfigError)) throw err
      log('warn', err.message)
      identity = err
    }
    const removeOrgData = async (orgIds: string[]) => {
      const open = useBuilderStore()
      if (open instanceof BuilderConfigError) return
      await (await open()).leads.removeOrgs(orgIds)
    }
    api = new AccountApi({ auth: useAuth(), identity, log, removeOrgData })
  }
  return api
}
