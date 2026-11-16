// Lead capture with double opt-in (synthwerk#105, docs/features/leads.md). The public form, the
// server routes and the studio list use the same rules and types.

/** Longest email address (RFC 5321 path limit). */
export const MAX_EMAIL_LENGTH = 254
export const MAX_NAME_LENGTH = 120
/** The confirm token: 32 random bytes, base64url without padding. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** Hours a confirm link is valid. An unconfirmed lead is deleted when it expires. */
export const PENDING_TTL_HOURS = 72

// biome-ignore lint/suspicious/noControlCharactersInRegex: the check refuses control characters
const CONTROL = /[\u0000-\u001f\u007f]/
/** A plain address: one @, no space, no quote, no angle bracket, a host with a dot. */
const EMAIL =
  /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** The trimmed email, or null when it is not a plain address. */
export function checkLeadEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim()
  if (email.length > MAX_EMAIL_LENGTH || CONTROL.test(email) || !EMAIL.test(email)) return null
  return email
}

/** The trimmed name ('' when empty), or null when it is too long or has control characters. */
export function checkLeadName(value: unknown): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (name.length > MAX_NAME_LENGTH || CONTROL.test(name)) return null
  return name
}

/** POST /api/site/leads. `website` is the honeypot: a person leaves it empty. */
export interface LeadRequest {
  locale: string
  slug: string
  sectionId: string
  email: string
  name?: string
  consent: boolean
  website?: string
}

/** A confirmed lead as owners and admins see it in the studio. */
export interface Lead {
  id: string
  email: string
  /** '' when the form had no name field or the visitor left it empty. */
  name: string
  slug: string
  locale: string
  /** The live version of the page when the visitor sent the form. */
  pageVersion: number
  /** The consent text the visitor agreed to. */
  consentText: string
  createdAt: string
  confirmedAt: string
}

export interface LeadPage {
  items: Lead[]
  /** Pass as `before` for the next (older) page. Null: no more. */
  next: string | null
}
