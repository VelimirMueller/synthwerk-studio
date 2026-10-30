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
