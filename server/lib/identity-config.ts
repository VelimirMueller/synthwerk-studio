// Identity settings of the BFF. They come from the Nuxt runtime config (NUXT_IDENTITY_*).

export interface IdentityConfig {
  /** Base URL of synthwerk-identity, without a trailing slash. Server side only. */
  baseUrl: string
}

export interface RawIdentityConfig {
  identity?: { url?: unknown }
}

export class IdentityConfigError extends Error {}

/**
 * Reads and checks the identity settings. Throws IdentityConfigError and names the variable.
 * Sign-in does not need these settings: only the /api/org routes stop without them.
 */
export function readIdentityConfig(raw: RawIdentityConfig): IdentityConfig {
  const value = typeof raw.identity?.url === 'string' ? raw.identity.url.trim() : ''
  if (value === '') {
    throw new IdentityConfigError('identity is not configured: set NUXT_IDENTITY_URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new IdentityConfigError('NUXT_IDENTITY_URL must be an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IdentityConfigError('NUXT_IDENTITY_URL must be an absolute http(s) URL')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new IdentityConfigError('NUXT_IDENTITY_URL must have no user info, query or fragment')
  }
  return { baseUrl: url.toString().replace(/\/+$/, '') }
}
