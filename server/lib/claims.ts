// Maps Zitadel claims to the view of the signed-in user (D-50 claim contract).

export const ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles'
const ORG_ID = 'urn:zitadel:iam:user:resourceowner:id'
const ORG_NAME = 'urn:zitadel:iam:user:resourceowner:name'
const ORG_DOMAIN = 'urn:zitadel:iam:user:resourceowner:primary_domain'

export interface StudioUser {
  sub: string
  name: string
  username: string
  email: string
}

export interface StudioOrg {
  id: string
  name: string
  domain: string
}

/** One project role and the org ids it is granted in. */
export interface StudioRole {
  role: string
  orgIds: string[]
}

export interface StudioIdentity {
  user: StudioUser
  org: StudioOrg
  roles: StudioRole[]
  amr: string[]
}

type Claims = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** First non-empty string of the claim in the given claim sets. */
const pick = (key: string, ...sources: Claims[]): string => {
  for (const source of sources) {
    const value = str(source[key])
    if (value) return value
  }
  return ''
}

/** Reads the roles claim: `{ role: { orgId: orgDomain } }`. Bad shapes give no role. */
export function readRoles(claims: Claims): StudioRole[] {
  const raw = claims[ROLES_CLAIM]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, orgs]) => orgs && typeof orgs === 'object' && !Array.isArray(orgs))
    .map(([role, orgs]) => ({ role, orgIds: Object.keys(orgs as object).sort() }))
    .sort((a, b) => a.role.localeCompare(b.role))
}

export const readAmr = (claims: Claims): string[] =>
  Array.isArray(claims.amr) ? claims.amr.filter((v): v is string => typeof v === 'string') : []

/** Same rule as kit/auth RequireMFA: `amr` must contain `mfa`. */
export const hasMfa = (amr: readonly string[]): boolean => amr.includes('mfa')

/**
 * Builds the identity from the verified access token (org, roles, amr: what services see)
 * and the ID token and userinfo (profile).
 */
export function toIdentity(access: Claims, id: Claims, userinfo: Claims): StudioIdentity {
  const sub = pick('sub', id, access)
  return {
    user: {
      sub,
      name: pick('name', userinfo, id),
      username: pick('preferred_username', userinfo, id),
      email: pick('email', userinfo, id)
    },
    org: {
      id: pick(ORG_ID, access, userinfo, id),
      name: pick(ORG_NAME, access, userinfo, id),
      domain: pick(ORG_DOMAIN, access, userinfo, id)
    },
    roles: readRoles(access[ROLES_CLAIM] ? access : userinfo),
    amr: readAmr(access)
  }
}
