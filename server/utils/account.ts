// One AccountApi per server process. A missing NUXT_IDENTITY_URL stops only DELETE /api/me (503).
import { AccountApi } from '../lib/account-api'
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
    api = new AccountApi({ auth: useAuth(), identity, log })
  }
  return api
}
