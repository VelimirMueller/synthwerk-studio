// The public site (synthwerk#45, #109): routes, legal pages and UI texts in German and English.
// Legal content is not written here. It needs the legal sign-off of synthwerk#49: until then
// every legal page shows LEGAL_PLACEHOLDER and nothing else as its text.
import { LOCALES, type Locale } from '#shared/sections'

/** The builder slug of the start page of a locale (`/de`, `/en`). */
export const HOME_SLUG = 'home'

export const LEGAL_PAGES = ['imprint', 'privacy', 'cookies'] as const
export type LegalPage = (typeof LEGAL_PAGES)[number]

/** The legal pages are static routes. A builder page with the same slug never shows. */
export const LEGAL_SLUGS: Record<Locale, Record<LegalPage, string>> = {
  de: { imprint: 'impressum', privacy: 'datenschutz', cookies: 'cookies' },
  en: { imprint: 'imprint', privacy: 'privacy', cookies: 'cookies' }
}

/** The one placeholder of every legal text. Do not replace it without the #49 sign-off. */
export const LEGAL_PLACEHOLDER = 'TODO: legal text, needs #49 sign-off'

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && LOCALES.includes(value as Locale)

/** The legal page of a slug in a locale, or null for a builder page. */
export function legalPageOf(locale: Locale, slug: string): LegalPage | null {
  for (const page of LEGAL_PAGES) if (LEGAL_SLUGS[locale][page] === slug) return page
  return null
}

export function sitePath(locale: Locale, slug: string = HOME_SLUG): string {
  return slug === HOME_SLUG ? `/${locale}` : `/${locale}/${slug}`
}

/** The path of the same page in the other language. Builder pages go to the start page. */
export function switchPath(locale: Locale, slug: string): string {
  const other: Locale = locale === 'de' ? 'en' : 'de'
  const legal = legalPageOf(locale, slug)
  return legal ? sitePath(other, LEGAL_SLUGS[other][legal]) : sitePath(other)
}

/** The test system banner shows on every environment that is not `prd`, also when unset. */
export const showEnvBanner = (env: unknown) => env !== 'prd'

export interface SiteTexts {
  languageName: string
  switchLabel: string
  skipLink: string
  footerLabel: string
  legal: Record<LegalPage, string>
  cookieSettings: string
  envBanner: (env: string) => string
  placeholderLabel: string
  notFound: string
  unavailable: string
  consent: {
    title: string
    body: string
    accept: string
    reject: string
    more: string
    saved: (analytics: boolean) => string
  }
  cookieFacts: {
    title: string
    note: string
    name: string
    purpose: string
    duration: string
    consentPurpose: string
    consentDuration: string
    analyticsPurpose: string
    analyticsDuration: string
    current: (analytics: boolean | null) => string
  }
}

export const SITE_TEXTS: Record<Locale, SiteTexts> = {
  de: {
    languageName: 'Deutsch',
    switchLabel: 'English',
    skipLink: 'Zum Inhalt springen',
    footerLabel: 'Rechtliches',
    legal: { imprint: 'Impressum', privacy: 'Datenschutz', cookies: 'Cookies' },
    cookieSettings: 'Cookie-Einstellungen',
    envBanner: (env) =>
      `Testsystem (${env || 'ohne Umgebung'}). Die Rechtstexte sind Platzhalter und gelten nicht.`,
    placeholderLabel: 'Platzhalter',
    notFound: 'Diese Seite gibt es nicht.',
    unavailable: 'Die Seite ist gerade nicht erreichbar. Bitte später erneut versuchen.',
    consent: {
      title: 'Cookies und Statistik',
      body: 'Wir setzen nur notwendige Cookies. Mit Ihrer Einwilligung zählen wir Seitenaufrufe mit Umami. Sie können Ihre Wahl jederzeit unter „Cookie-Einstellungen“ ändern.',
      accept: 'Statistik erlauben',
      reject: 'Nur notwendige',
      more: 'Mehr zu Cookies',
      saved: (analytics) =>
        analytics ? 'Gespeichert: Statistik erlaubt.' : 'Gespeichert: nur notwendige Cookies.'
    },
    cookieFacts: {
      title: 'Technische Angaben',
      note: 'Diese Liste nennt die technischen Fakten. Sie ist kein Rechtstext.',
      name: 'Name',
      purpose: 'Zweck',
      duration: 'Dauer',
      consentPurpose: 'Speichert Ihre Wahl zu Cookies. Notwendig.',
      consentDuration: '6 Monate',
      analyticsPurpose: 'Zählt Seitenaufrufe. Lädt nur nach Ihrer Einwilligung.',
      analyticsDuration: 'Setzt kein Cookie',
      current: (analytics) =>
        analytics === null
          ? 'Ihre Wahl: noch keine.'
          : analytics
            ? 'Ihre Wahl: Statistik erlaubt.'
            : 'Ihre Wahl: nur notwendige Cookies.'
    }
  },
  en: {
    languageName: 'English',
    switchLabel: 'Deutsch',
    skipLink: 'Skip to content',
    footerLabel: 'Legal',
    legal: { imprint: 'Imprint', privacy: 'Privacy', cookies: 'Cookies' },
    cookieSettings: 'Cookie settings',
    envBanner: (env) =>
      `Test system (${env || 'no environment'}). The legal texts are placeholders and not valid.`,
    placeholderLabel: 'Placeholder',
    notFound: 'This page does not exist.',
    unavailable: 'The page is not available now. Try again later.',
    consent: {
      title: 'Cookies and analytics',
      body: 'We use only essential cookies. With your consent we count page views with Umami. You can change your choice at any time under "Cookie settings".',
      accept: 'Allow analytics',
      reject: 'Essential only',
      more: 'More about cookies',
      saved: (analytics) =>
        analytics ? 'Saved: analytics allowed.' : 'Saved: essential cookies only.'
    },
    cookieFacts: {
      title: 'Technical facts',
      note: 'This list gives the technical facts. It is not a legal text.',
      name: 'Name',
      purpose: 'Purpose',
      duration: 'Duration',
      consentPurpose: 'Keeps your cookie choice. Essential.',
      consentDuration: '6 months',
      analyticsPurpose: 'Counts page views. Loads only after your consent.',
      analyticsDuration: 'Sets no cookie',
      current: (analytics) =>
        analytics === null
          ? 'Your choice: none yet.'
          : analytics
            ? 'Your choice: analytics allowed.'
            : 'Your choice: essential cookies only.'
    }
  }
}
