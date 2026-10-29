// Server-side session store. The browser holds only a random session id in an HttpOnly cookie;
// the store key is the SHA-256 of that id, so a store dump gives no usable cookie.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { StudioIdentity } from './claims'
import type { TokenSet } from './oidc'

/**
 * The part of an unstorage Storage the BFF needs. `ttl` (seconds) expires the entry in drivers
 * that support it (Redis); the sweep in AuthService removes it in the others (memory).
 */
export interface KeyValueStore {
  getItem(key: string): Promise<unknown>
  setItem(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>
  removeItem(key: string): Promise<void>
  getKeys(base?: string): Promise<string[]>
}

export interface SessionRecord {
  identity: StudioIdentity
  tokens: TokenSet
  /** Per-session CSRF token. The page reads it from GET /api/auth/session. */
  csrf: string
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds. Absolute end of the session; refresh never moves it. */
  expiresAt: number
}

export interface LoginTransaction {
  state: string
  nonce: string
  verifier: string
  returnTo: string
  /** Unix seconds. */
  expiresAt: number
}

export const SESSION_COOKIE = '__Host-sw_session'
export const LOGIN_COOKIE = '__Host-sw_login'
export const LOGIN_TTL_SECONDS = 600
/** Most open login transactions at one time. A new login above it is refused. */
export const MAX_PENDING_LOGINS = 1000
/** Least time between two sweeps of expired entries. */
export const SWEEP_INTERVAL_SECONDS = 60

const digest = (id: string): string => createHash('sha256').update(id).digest('base64url')

export const sessionKey = (id: string): string => `session:${digest(id)}`
export const loginKey = (id: string): string => `login:${digest(id)}`

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Accepts only a same-origin path: one leading slash, no `//` or `/\` (protocol-relative),
 * no control characters. Anything else gives the fallback.
 */
export function safeReturnTo(value: unknown, fallback = '/me'): string {
  if (typeof value !== 'string' || value.length > 512) return fallback
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused on purpose.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback
  return value
}

/** The session as the browser may see it: no token, only identity, CSRF token and expiry. */
export function publicSession(record: SessionRecord) {
  return {
    user: record.identity.user,
    org: record.identity.org,
    roles: record.identity.roles,
    amr: record.identity.amr,
    csrfToken: record.csrf,
    expiresAt: new Date(record.expiresAt * 1000).toISOString()
  }
}

export type PublicSession = ReturnType<typeof publicSession>
