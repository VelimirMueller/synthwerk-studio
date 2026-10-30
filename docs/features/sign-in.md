---
title: Sign-in through the studio BFF
slug: sign-in
status: beta
epic: E2
owner: studio
paths: ["server/api/auth/**", "server/lib/auth.ts", "server/lib/claims.ts", "server/lib/config.ts", "server/lib/oidc.ts", "server/lib/seal.ts", "server/lib/session.ts", "server/utils/auth.ts", "server/middleware/**", "app/middleware/**", "app/composables/useAuthSession.ts", "app/pages/index.vue", "app/pages/me.vue", "app/assets/app.css"]
api: ["GET /api/auth/login", "GET /api/auth/callback", "GET /api/auth/session", "POST /api/auth/logout"]
events: []
mcp: []
updated: 2026-10-30
---

# Sign-in through the studio BFF

> **In 30 seconds**
>
> - The studio server is a BFF (backend for frontend). It runs the OIDC code flow with PKCE against Zitadel login UI v2.
> - Tokens stay on the server. The browser gets one random session id in an HttpOnly, Secure, SameSite=Lax cookie.
> - Sign-out ends the Zitadel session, revokes the refresh token and deletes the session.
> - `/me` shows the user, the org and the roles. Proves synthwerk#95.

## What it does

1. `GET /api/auth/login?returnTo=/me` makes state, nonce and a PKCE verifier. It seals them into a login cookie (10 minutes) and redirects to Zitadel `authorize`. It writes nothing to the store.
2. Zitadel shows login UI v2. The user signs in with a passkey or a password and a second factor.
3. `GET /api/auth/callback` checks the login cookie and `state`, swaps the code (client secret and PKCE verifier) and checks the tokens.
4. The BFF stores the tokens and the identity in the session store, sets the session cookie and redirects to `returnTo`.
5. `GET /api/auth/session` gives the page the user, org, roles, `amr` and the CSRF token. No token.
6. `POST /api/auth/logout` calls Zitadel `end_session` from the server, revokes the refresh token and deletes the session.

| Check | Rule |
|---|---|
| ID token | Signature (issuer JWKS), `iss`, `aud` = client id, `exp`, `nonce` |
| Access token | JWT like kit/auth: signature, `iss`, `aud` has the client id, `exp`. Org, roles and `amr` come from it. |
| Subject | ID token, access token and userinfo name the same `sub` |
| `returnTo` | Same-origin path only. `//host`, `/\host`, URLs and control characters give `/me`. |
| Login transaction | Sealed cookie `__Host-sw_login` (`HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`, 10 minutes): no sibling subdomain can set it. AES-256-GCM; purpose `login-tx` in the HKDF-SHA256 key and in the AAD, so no other seal opens as a login. Tampered, foreign, other purpose or older = `login_expired`. The callback clears it. A replayed code fails at Zitadel. |
| Session | Absolute end after `NUXT_SESSION_MAX_AGE_SECONDS` (8 h). Refresh does not extend it. |

## Session and CSRF

- Cookie `__Host-sw_session`: random 256-bit id, `HttpOnly; Secure; SameSite=Lax; Path=/`. The `__Host-` prefix locks it to the studio host.
- Lax, not Strict: the callback is a top-level redirect from Zitadel. With Strict the browser would drop the cookie on that hop.
- The store key is the SHA-256 of the id. A store dump gives no usable cookie.
- Each sign-in makes a new id and deletes the old session (no session fixation).
- The access token is refreshed when it ends within 60 s. Parallel requests share one refresh. A failed refresh ends the session.
- CSRF, two layers:
  - Every POST, PUT, PATCH and DELETE to `/api` needs `Origin` = studio origin, or `Sec-Fetch-Site: same-origin` when there is no `Origin` (`server/middleware/csrf.ts`).
  - Routes that act on a session need the header `x-csrf-token` = the session CSRF token. A refused request does not touch the session.

## Sign-out

- The BFF calls `end_session` with `id_token_hint` from the server and does not follow the redirect. Zitadel deletes the session and redirects to the post-logout URI.
- The ID token never goes to the browser. The browser gets `{ "redirectTo": "<post-logout URI>" }`.
- When Zitadel does not confirm, the browser gets the `end_session` URL with `client_id` only (no `id_token_hint`). Login UI v2 then asks the user.
- Zitadel keeps a refresh token valid after `end_session`. So the BFF also revokes it.

## MFA flag

- `NUXT_OIDC_REQUIRE_MFA=true`: a sign-in whose access token `amr` has no `mfa` is refused (`/?error=mfa_required`). Same rule as kit/auth `RequireMFA`.
- The check runs again on each refresh.
- Zitadel access tokens carry `amr` only with the identity MFA gate (synthwerk-identity#15). Keep the flag off until infra turns the gate on. With the flag on and no gate, nobody can sign in (fail closed).

## Configuration

| Variable | Default | Use |
|---|---|---|
| `NUXT_OIDC_ISSUER` | none | Zitadel issuer, for example `http://auth.localhost:8080` |
| `NUXT_OIDC_CLIENT_ID` | none | Studio app client id (infra bootstrap) |
| `NUXT_OIDC_CLIENT_SECRET` | none | Studio app secret. Env only, never in git. |
| `NUXT_OIDC_PROJECT_ID` | empty | Adds the project audience scope |
| `NUXT_OIDC_REDIRECT_URI` | `http://localhost:3000/api/auth/callback` | Must match the Zitadel app exactly |
| `NUXT_OIDC_POST_LOGOUT_REDIRECT_URI` | `http://localhost:3000/` | Must match the Zitadel app exactly |
| `NUXT_OIDC_REQUIRE_MFA` | `false` | See MFA flag |
| `NUXT_SESSION_MAX_AGE_SECONDS` | `28800` | Absolute session lifetime |
| `NUXT_SESSION_SECRET` | none | Key material for the sealed login cookie, 32 characters or more. Env only. A change drops open logins only. |

- Scope: `openid profile email offline_access urn:zitadel:iam:org:project:id:<project>:aud urn:zitadel:iam:org:projects:roles urn:zitadel:iam:user:resourceowner`.
- A missing required variable stops every auth route with a message that names it.

## UI

- `/` has the sign-in button and shows the sign-in errors as text.
- `/me` uses route middleware `auth`. Without a session it starts the sign-in with `returnTo` = the page.
- `/me` links to **Apps** ([apps-and-embed.md](apps-and-embed.md)). `app/assets/app.css` also holds the shared form styles (`.form`, `.field`, `.textarea`, `.select`).
- Components: `SwButton`, `SwCard`, `SwPill` from `@synthwerk/ui-vue`, styles from `@synthwerk/tokens`. No `v-html`.
- The packages are not on npm yet. `vendor/` holds the tarballs packed from synthwerk-sdk `f0bc0cc` (`pnpm -r pack`).

## Rules and limits

| Rule | Value |
|---|---|
| Session store | Nitro storage `auth`, driver `memory`: one process, lost on restart. A shared driver (Redis) is needed before more than one instance runs. |
| Refresh lock | Per process. With more than one instance, two refreshes of one session can race when Zitadel rotates the refresh token. Add a store lock with the shared driver. |
| Login transaction | 10 minutes, in the sealed cookie only. `/login` writes nothing to the store, so anonymous calls cannot fill it. |
| Store bounds | Only signed-in sessions are stored. Each write has `ttl` = remaining life + 10 min (for drivers that expire entries, such as Redis). The grace gives the sweep time to revoke first. |
| Sweep | After each new session, at most once per 60 s: every session past its end gets its refresh token revoked, then is removed. A read of an expired session does the same. |
| Refresh leeway | 60 s |
| Response headers | `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`. `/api/auth/**` and `/api/apps/**` have `Cache-Control: no-store`. |

## Events

| Type | When |
|---|---|
| None. | |

## Errors

| Status | Code | Cause |
|---|---|---|
| 302 to `/?error=login_expired` | `login_expired` | No, old, tampered or foreign login cookie, `state` mismatch, callback without the cookie |
| 302 to `/?error=access_denied` | `access_denied` | The user cancelled at Zitadel |
| 302 to `/?error=mfa_required` | `mfa_required` | Zitadel refused, or the MFA flag is on and `amr` has no `mfa` |
| 302 to `/?error=login_failed` | `login_failed` | Code swap, token check or userinfo failed |
| 401 | `unauthenticated` | `GET /api/auth/session` without a valid session |
| 403 | `csrf_failed` | Unsafe request from another origin, or a wrong `x-csrf-token` |

## Tests

- `tests/server/auth-flow.test.ts` — login, callback, session, refresh, logout and CSRF against a mock OIDC provider (`tests/support/provider.ts`)
- `tests/server/oidc.test.ts` — discovery, PKCE, token checks, end_session
- `tests/server/config-claims.test.ts` — settings, claims, `returnTo`, constant-time compare
- Local stack, 2026-10-29 (synthwerk-infra `64a4a1a`, edge on port 18080): login, Zitadel authorize to login UI v2, session API sign-in of `owner.demo`, callback, `/me` with org `demo` and role `owner`, refresh after 250 s, CSRF refusals, logout. Zitadel answered 404 for the session after logout.

## Changes

| Date | Change |
|---|---|
| 2026-10-29 | First version (synthwerk#95). |
| 2026-10-30 | `paths` lists the sign-in files only, so other features keep their own doc. The home page links `/health` for operators, owners and admins (synthwerk#40). |
| 2026-10-30 | `/me` links to Apps; shared form styles; `/api/apps/**` is `no-store` (synthwerk#38). |
| 2026-10-30 | `/me` shows the studio navigation (Me, Users, Audit). `app.css` adds the nav, table and select styles of the users and audit pages (synthwerk#37). |
