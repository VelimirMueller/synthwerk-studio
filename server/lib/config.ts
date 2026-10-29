// Auth settings of the BFF. They come from the Nuxt runtime config (NUXT_OIDC_*, NUXT_SESSION_*).

export interface AuthConfig {
  issuer: string
  clientId: string
  clientSecret: string
  /** Zitadel project id. Adds the project audience scope when set. */
  projectId: string
  redirectUri: string
  postLogoutRedirectUri: string
  /** Origin of the studio (scheme, host, port), taken from redirectUri. */
  appOrigin: string
  /** Refuse a sign-in whose access token `amr` has no `mfa` (same rule as kit/auth RequireMFA). */
  requireMfa: boolean
  /** Absolute session lifetime. Refresh never extends it. */
  sessionMaxAgeSeconds: number
  /** Key material for sealed cookies (HKDF input). At least 32 characters. */
  sessionSecret: string
}

export interface RawAuthConfig {
  oidc?: Partial<
    Record<keyof Omit<AuthConfig, 'appOrigin' | 'sessionMaxAgeSeconds' | 'sessionSecret'>, unknown>
  >
  session?: { maxAgeSeconds?: unknown; secret?: unknown }
}

export class AuthConfigError extends Error {}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const flag = (value: unknown): boolean => value === true || value === 'true' || value === '1'

/** Reads and checks the auth settings. Throws AuthConfigError and names the missing setting. */
export function readAuthConfig(raw: RawAuthConfig): AuthConfig {
  const oidc = raw.oidc ?? {}
  const missing = (['issuer', 'clientId', 'clientSecret', 'redirectUri'] as const).filter(
    (key) => text(oidc[key]) === ''
  )
  if (missing.length > 0) {
    throw new AuthConfigError(`auth is not configured: set ${missing.map(envName).join(', ')}`)
  }
  const sessionSecret = text(raw.session?.secret)
  if (sessionSecret.length < 32) {
    throw new AuthConfigError('NUXT_SESSION_SECRET must be set, at least 32 characters')
  }
  const issuer = text(oidc.issuer).replace(/\/+$/, '')
  const redirectUri = new URL(text(oidc.redirectUri))
  const appOrigin = redirectUri.origin
  const postLogout = text(oidc.postLogoutRedirectUri) || `${appOrigin}/`
  const rawMaxAge = raw.session?.maxAgeSeconds
  const maxAge = rawMaxAge === undefined || rawMaxAge === '' ? 28800 : Number(rawMaxAge)
  if (!Number.isInteger(maxAge) || maxAge <= 0) {
    throw new AuthConfigError('NUXT_SESSION_MAX_AGE_SECONDS must be a positive whole number')
  }
  return {
    issuer,
    clientId: text(oidc.clientId),
    clientSecret: text(oidc.clientSecret),
    projectId: text(oidc.projectId),
    redirectUri: redirectUri.toString(),
    postLogoutRedirectUri: new URL(postLogout).toString(),
    appOrigin,
    requireMfa: flag(oidc.requireMfa),
    sessionMaxAgeSeconds: maxAge,
    sessionSecret
  }
}

const envName = (key: string): string =>
  `NUXT_OIDC_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`

/** The scope the studio asks for: profile, refresh token, project audience, roles and own org. */
export function studioScope(config: Pick<AuthConfig, 'projectId'>): string {
  const scopes = ['openid', 'profile', 'email', 'offline_access']
  if (config.projectId) scopes.push(`urn:zitadel:iam:org:project:id:${config.projectId}:aud`)
  scopes.push('urn:zitadel:iam:org:projects:roles', 'urn:zitadel:iam:user:resourceowner')
  return scopes.join(' ')
}
