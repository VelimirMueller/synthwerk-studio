// One AuthService per server process, built from the runtime config and the `auth` storage.
import { AuthService } from '../lib/auth'
import { readAuthConfig } from '../lib/config'
import { OidcClient } from '../lib/oidc'
import type { KeyValueStore } from '../lib/session'

let service: AuthService | undefined

export function useAuth(): AuthService {
  if (!service) {
    const config = readAuthConfig(useRuntimeConfig())
    service = new AuthService({
      config,
      store: useStorage('auth') satisfies KeyValueStore,
      oidc: new OidcClient(config),
      log: (level, message) => console[level](`[auth] ${message}`)
    })
  }
  return service
}
