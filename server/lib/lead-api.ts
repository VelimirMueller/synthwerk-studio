// The public lead routes (synthwerk#105, docs/features/leads.md). No session and no cookie.
// - POST /api/site/leads: the lead form. Origin must be the site origin (NUXT_SITE_ORIGIN); no
//   CSRF token, since there is no session to protect. Rate limit per client address and per
//   page, a honeypot field and the body size cap of lib/body.ts. The answer is 202 for every
//   valid form, whatever the address: no one learns if an address is known.
// - POST /api/site/leads/confirm { token }: the confirm page sends the token from the mail link.
//   A GET link would let a mail scanner confirm for the visitor, so the page asks for a click.
// The confirm mail goes out after the answer. If it fails, the pending lead is deleted again.
import {
  createError,
  getRequestHeader,
  getRequestIP,
  type H3Event,
  isError,
  setResponseStatus
} from 'h3'
import { checkLeadEmail, checkLeadName, PENDING_TTL_HOURS, TOKEN_PATTERN } from '../../shared/leads'
import {
  type LeadSection,
  LOCALES,
  type Locale,
  SECTION_ID_PATTERN,
  SLUG_PATTERN
} from '../../shared/sections'
import { readJsonBody } from './body'
import { BuilderConfigError } from './builder-config'
import type { BuilderStore } from './builder-store'
import { hashToken, LeadStoreError } from './lead-store'
import type { Mailer } from './mail'
import { clientKey, type Limit, type RateLimiter } from './rate-limit'
import { type SiteConfig, SiteConfigError } from './site-config'

/** The form is small: email, name, a few ids. */
export const MAX_LEAD_BODY_BYTES = 4 * 1024
/** Per client address: 5 forms in 10 minutes. */
export const IP_LIMIT: Limit = { max: 5, windowMs: 10 * 60 * 1000 }
/** Per page: 60 forms per hour from all visitors together. */
export const PAGE_LIMIT: Limit = { max: 60, windowMs: 60 * 60 * 1000 }
/** Confirm calls per client address: 20 in 10 minutes. */
export const CONFIRM_LIMIT: Limit = { max: 20, windowMs: 10 * 60 * 1000 }

export interface LeadApiDeps {
  site: SiteConfig | SiteConfigError
  store: (() => Promise<BuilderStore>) | BuilderConfigError
  /** Null: no mail provider set (NUXT_MAIL_PROVIDER). The form answers 503. */
  mailer: Mailer | null
  limiter: RateLimiter
  /** Runs the mail after the answer. Default: fire and forget, errors are logged. */
  defer?: (work: Promise<void>) => void
  log?: (level: 'warn' | 'error', message: string) => void
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  410: 'Gone',
  413: 'Content Too Large',
  429: 'Too Many Requests',
  503: 'Service Unavailable'
}

export interface LeadAccepted {
  status: 'pending'
}

const ACCEPTED: LeadAccepted = { status: 'pending' }

/** The confirm mail. Plain text, no name, no page content: only what the reader needs. */
export function confirmMail(locale: Locale, link: string, host: string) {
  if (locale === 'de') {
    return {
      subject: 'Bitte bestätigen Sie Ihre E-Mail-Adresse',
      text: [
        `Sie haben auf ${host} Ihre E-Mail-Adresse eingetragen.`,
        '',
        'Bitte bestätigen Sie die Adresse mit diesem Link:',
        link,
        '',
        `Der Link gilt ${PENDING_TTL_HOURS} Stunden und nur einmal.`,
        'Waren Sie das nicht? Dann ignorieren Sie diese Mail. Ohne Bestätigung löschen wir die Adresse.'
      ].join('\n')
    }
  }
  return {
    subject: 'Please confirm your email address',
    text: [
      `You entered your email address on ${host}.`,
      '',
      'Please confirm the address with this link:',
      link,
      '',
      `The link works once and for ${PENDING_TTL_HOURS} hours.`,
      'Was this not you? Then ignore this mail. Without a confirmation we delete the address.'
    ].join('\n')
  }
}

export class LeadApi {
  constructor(private readonly deps: LeadApiDeps) {}

  /** POST /api/site/leads -> 202 { status: 'pending' } */
  async submit(event: H3Event): Promise<LeadAccepted> {
    const { site, mailer } = this.deps
    if (site instanceof SiteConfigError || site.origin === null || mailer === null) {
      throw fail(503, 'leads_not_configured')
    }
    this.assertOrigin(event, site.origin)
    // The cheap checks first: a bad or bot form never creates a rate limit key.
    const body = await readObject(event)
    const locale = body.locale
    const slug = body.slug
    const sectionId = body.sectionId
    if (
      typeof locale !== 'string' ||
      !LOCALES.includes(locale as Locale) ||
      typeof slug !== 'string' ||
      !SLUG_PATTERN.test(slug) ||
      typeof sectionId !== 'string' ||
      !SECTION_ID_PATTERN.test(sectionId)
    ) {
      throw fail(400, 'invalid_request')
    }
    // Honeypot: a person never fills the hidden field. Same answer, nothing stored, no mail.
    if (typeof body.website === 'string' && body.website !== '') {
      setResponseStatus(event, 202)
      return ACCEPTED
    }
    const email = checkLeadEmail(body.email)
    if (!email) throw fail(400, 'invalid_email')
    if (body.consent !== true) throw fail(400, 'consent_required')
    const name = checkLeadName(body.name)
    if (name === null) throw fail(400, 'invalid_request')
    const ip = this.clientIp(event, site)
    if (!this.deps.limiter.hit(`lead-ip:${ip}`, IP_LIMIT)) throw fail(429, 'too_many_requests')
    if (!this.deps.limiter.hit(`lead-page:${locale}/${slug}`, PAGE_LIMIT)) {
      throw fail(429, 'too_many_requests')
    }

    const store = await this.open()
    const result = await this.guard(async () => {
      const page = await store.leads.livePage(site.orgId, slug, locale as Locale)
      const section = page?.content.sections.find(
        (s): s is LeadSection => s.id === sectionId && s.type === 'lead'
      )
      if (!page || !section) throw fail(404, 'form_not_found')
      return store.leads.submit({
        orgId: site.orgId,
        page: { id: page.pageId, slug, locale: locale as Locale, version: page.version },
        sectionId,
        email,
        // Data minimisation: no name unless the form asks for it.
        name: section.nameField ? name : '',
        consentText: section.consent
      })
    })
    if (result.mail) {
      const link = `${site.origin}/${locale}/confirm#token=${result.token}`
      const mail = confirmMail(locale as Locale, link, new URL(site.origin).host)
      const work = mailer
        // The key names the lead and the link (hash), never the token.
        .send({
          to: email,
          ...mail,
          idempotencyKey: `lead-${hashToken(result.token).slice(0, 32)}`
        })
        .catch(async (err: unknown) => {
          const why = err instanceof Error ? err.message : 'error'
          this.deps.log?.('warn', `confirm mail failed: ${why}`)
          await store.leads.dropPending(result.leadId).catch(() => {})
        })
      ;(this.deps.defer ?? ((p) => void p))(work)
    }
    setResponseStatus(event, 202)
    return ACCEPTED
  }

  /** POST /api/site/leads/confirm { token } -> 200 { status: 'confirmed' }, or 410 link_invalid. */
  async confirm(event: H3Event): Promise<{ status: 'confirmed' }> {
    const { site } = this.deps
    if (site instanceof SiteConfigError || site.origin === null) {
      throw fail(503, 'leads_not_configured')
    }
    this.assertOrigin(event, site.origin)
    const body = await readObject(event)
    const token = body.token
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw fail(410, 'link_invalid')
    const ip = this.clientIp(event, site)
    if (!this.deps.limiter.hit(`lead-confirm:${ip}`, CONFIRM_LIMIT)) {
      throw fail(429, 'too_many_requests')
    }
    const store = await this.open()
    await this.guard(() => store.leads.confirm(token))
    return { status: 'confirmed' }
  }

  /** Exact match on the configured site origin. No Origin header: refused. */
  private assertOrigin(event: H3Event, origin: string) {
    if (getRequestHeader(event, 'origin') !== origin) {
      this.deps.log?.('warn', 'lead form from another origin refused')
      throw fail(403, 'origin_refused')
    }
  }

  /** The rate limit key of the client: IPv4, or the IPv6 /64 (rate-limit.ts clientKey). */
  private clientIp(event: H3Event, site: SiteConfig): string {
    if (site.trustForwardedFor) {
      const forwarded = getRequestHeader(event, 'x-forwarded-for')
      const last = forwarded?.split(',').pop()?.trim()
      if (last) return clientKey(last)
    }
    return clientKey(getRequestIP(event) ?? '')
  }

  private async open(): Promise<BuilderStore> {
    const open = this.deps.store
    if (open instanceof BuilderConfigError) throw fail(503, 'leads_not_configured')
    try {
      return await open()
    } catch (err) {
      throw this.unavailable(err)
    }
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (err) {
      if (err instanceof LeadStoreError) throw fail(err.status, err.code)
      if (isError(err)) throw err
      throw this.unavailable(err)
    }
  }

  /** A database failure. The log names the error code only: no address, no SQL. */
  private unavailable(err: unknown) {
    const code = (err as { code?: unknown } | null)?.code
    const name = err instanceof Error ? err.name : 'error'
    this.deps.log?.('warn', `database call failed (${typeof code === 'string' ? code : name})`)
    return fail(503, 'leads_unavailable')
  }
}

async function readObject(event: H3Event): Promise<Record<string, unknown>> {
  const body = await readJsonBody(event, MAX_LEAD_BODY_BYTES)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'invalid_request')
  return body as Record<string, unknown>
}

function fail(status: number, code: string) {
  const text = STATUS_TEXT[status] ?? 'Error'
  return createError({ statusCode: status, statusMessage: text, message: text, data: { code } })
}
