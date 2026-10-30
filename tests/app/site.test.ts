import { describe, expect, it } from 'vitest'
import {
  HOME_SLUG,
  isLocale,
  LEGAL_PAGES,
  LEGAL_PLACEHOLDER,
  LEGAL_SLUGS,
  legalPageOf,
  SITE_TEXTS,
  showEnvBanner,
  sitePath,
  switchPath
} from '../../app/utils/site'
import { LOCALES, SLUG_PATTERN } from '../../shared/sections'

describe('public site routes', () => {
  it('knows the locales', () => {
    expect(isLocale('de')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
  })

  it('maps legal slugs per locale', () => {
    expect(legalPageOf('de', 'impressum')).toBe('imprint')
    expect(legalPageOf('de', 'datenschutz')).toBe('privacy')
    expect(legalPageOf('en', 'privacy')).toBe('privacy')
    expect(legalPageOf('en', 'cookies')).toBe('cookies')
    expect(legalPageOf('en', 'impressum')).toBeNull()
    expect(legalPageOf('de', 'pricing')).toBeNull()
  })

  it('has valid slugs for every legal page and a home slug', () => {
    for (const locale of LOCALES) {
      for (const page of LEGAL_PAGES) expect(LEGAL_SLUGS[locale][page]).toMatch(SLUG_PATTERN)
    }
    expect(HOME_SLUG).toMatch(SLUG_PATTERN)
  })

  it('builds paths and the language switch', () => {
    expect(sitePath('de')).toBe('/de')
    expect(sitePath('en', 'pricing')).toBe('/en/pricing')
    expect(switchPath('de', 'impressum')).toBe('/en/imprint')
    expect(switchPath('en', 'privacy')).toBe('/de/datenschutz')
    expect(switchPath('de', 'preise')).toBe('/en')
  })

  it('shows the test system banner on every environment but prd', () => {
    expect(showEnvBanner('prd')).toBe(false)
    for (const env of ['dev', 'stg', '', undefined, 'PRD']) expect(showEnvBanner(env)).toBe(true)
    expect(SITE_TEXTS.de.envBanner('stg')).toContain('Platzhalter')
    expect(SITE_TEXTS.en.envBanner('')).toContain('placeholders')
  })

  it('marks every legal text as a placeholder that needs the #49 sign-off', () => {
    expect(LEGAL_PLACEHOLDER).toBe('TODO: legal text, needs #49 sign-off')
  })

  it('has the same texts in German and English', () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        v && typeof v === 'object' ? keys(v).map((s) => `${k}.${s}`) : [k]
      )
    expect(keys(SITE_TEXTS.de)).toEqual(keys(SITE_TEXTS.en))
    expect(SITE_TEXTS.de.consent.accept).not.toBe(SITE_TEXTS.en.consent.accept)
  })
})
