// One MembersApi per server process. A missing NUXT_IDENTITY_URL stops only /api/org (503).
import { IdentityConfigError, readIdentityConfig } from '../lib/identity-config'
import { MembersApi } from '../lib/members-api'

let api: MembersApi | undefined

export function useMembersApi(): MembersApi {
  if (!api) {
    const log = (level: 'warn' | 'error', message: string) => console[level](`[org] ${message}`)
    let identity: ReturnType<typeof readIdentityConfig> | IdentityConfigError
    try {
      identity = readIdentityConfig(useRuntimeConfig())
    } catch (err) {
      if (!(err instanceof IdentityConfigError)) throw err
      log('warn', err.message)
      identity = err
    }
    api = new MembersApi({ auth: useAuth(), identity, log })
  }
  return api
}
