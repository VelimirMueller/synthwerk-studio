// Public site settings (synthwerk#109, #45). The org that owns the public pages is a config value
// (NUXT_SITE_ORG_ID), never a request value: a visitor cannot read the pages of another org.

import { ORG_PATTERN } from './builder-api'

export interface SiteConfig {
  /** The org whose live builder pages the public site serves. */
  orgId: string
}

export interface RawSiteConfig {
  site?: { orgId?: unknown }
}

export class SiteConfigError extends Error {}

/** Reads and checks the site settings. The message names the variable only. */
export function readSiteConfig(raw: RawSiteConfig): SiteConfig {
  const value = typeof raw.site?.orgId === 'string' ? raw.site.orgId.trim() : ''
  if (value === '') throw new SiteConfigError('site is not configured: set NUXT_SITE_ORG_ID')
  if (!ORG_PATTERN.test(value)) {
    throw new SiteConfigError('NUXT_SITE_ORG_ID must match ^[A-Za-z0-9_-]{1,64}$')
  }
  return { orgId: value }
}
