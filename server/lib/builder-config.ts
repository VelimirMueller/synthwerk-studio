// Builder settings of the BFF (NUXT_BUILDER_DATABASE_URL). The URL holds the database password:
// it comes from the environment only and no message ever contains it.

export interface BuilderConfig {
  /** postgres:// or postgresql:// URL of the studio database. Server side only; never logged. */
  databaseUrl: string
}

export interface RawBuilderConfig {
  builder?: { databaseUrl?: unknown }
}

export class BuilderConfigError extends Error {}

/**
 * Reads and checks the builder settings. Throws BuilderConfigError and names the variable, never
 * its value. Sign-in does not need these settings: only /api/builder stops without them.
 */
export function readBuilderConfig(raw: RawBuilderConfig): BuilderConfig {
  const value = typeof raw.builder?.databaseUrl === 'string' ? raw.builder.databaseUrl.trim() : ''
  if (value === '') {
    throw new BuilderConfigError('builder is not configured: set NUXT_BUILDER_DATABASE_URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BuilderConfigError('NUXT_BUILDER_DATABASE_URL must be a postgres:// URL')
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hostname === '') {
    throw new BuilderConfigError('NUXT_BUILDER_DATABASE_URL must be a postgres:// URL')
  }
  return { databaseUrl: value }
}

/**
 * Relay settings (synthwerk#106): NUXT_BUILDER_NATS_URL (nats://host:port, no credentials in the
 * URL), NUXT_BUILDER_NATS_USER and NUXT_BUILDER_NATS_PASSWORD (env only), and
 * NUXT_BUILDER_PLATFORM_ENV (local, dev, stg, prd or ci; default local).
 */
export interface RelayConfig {
  natsUrl: string
  user?: string
  password?: string
  platformEnv: string
}

export interface RawRelayConfig {
  builder?: {
    natsUrl?: unknown
    natsUser?: unknown
    natsPassword?: unknown
    platformEnv?: unknown
  }
}

const PLATFORM_ENVS = ['local', 'dev', 'stg', 'prd', 'ci']

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * The relay settings, or null when NUXT_BUILDER_NATS_URL is empty: then no relay runs and the rows
 * wait in builder_events. Throws BuilderConfigError that names the variable, never its value.
 */
export function readRelayConfig(raw: RawRelayConfig): RelayConfig | null {
  const value = text(raw.builder?.natsUrl)
  if (value === '') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BuilderConfigError('NUXT_BUILDER_NATS_URL must be a nats:// URL')
  }
  if ((url.protocol !== 'nats:' && url.protocol !== 'tls:') || url.hostname === '') {
    throw new BuilderConfigError('NUXT_BUILDER_NATS_URL must be a nats:// URL')
  }
  if (url.username !== '' || url.password !== '') {
    throw new BuilderConfigError(
      'NUXT_BUILDER_NATS_URL must not hold credentials: set NUXT_BUILDER_NATS_USER and NUXT_BUILDER_NATS_PASSWORD'
    )
  }
  const user = text(raw.builder?.natsUser)
  const password = text(raw.builder?.natsPassword)
  if ((user === '') !== (password === '')) {
    throw new BuilderConfigError(
      'set both NUXT_BUILDER_NATS_USER and NUXT_BUILDER_NATS_PASSWORD, or neither'
    )
  }
  const platformEnv = text(raw.builder?.platformEnv) || 'local'
  if (!PLATFORM_ENVS.includes(platformEnv)) {
    throw new BuilderConfigError('NUXT_BUILDER_PLATFORM_ENV must be local, dev, stg, prd or ci')
  }
  return {
    natsUrl: value,
    ...(user === '' ? {} : { user, password }),
    platformEnv
  }
}
