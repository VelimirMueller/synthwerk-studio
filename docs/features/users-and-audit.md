---
title: Users, roles and the audit list
slug: users-and-audit
status: beta
epic: E4
owner: studio
paths: ["server/lib/members.ts", "server/lib/members-api.ts", "server/lib/identity-config.ts", "server/api/org/**", "server/utils/members.ts", "app/pages/users.vue", "app/pages/audit.vue", "app/components/StudioNav.vue", "app/composables/useOrgApi.ts", "app/utils/audit.ts"]
api: ["GET /api/org/members", "POST /api/org/members", "GET /api/org/invitations", "DELETE /api/org/invitations/{invitationId}", "PATCH /api/org/members/{userId}", "POST /api/org/members/{userId}/deactivate", "POST /api/org/members/{userId}/reactivate", "GET /api/org/audit-events"]
events: []
mcp: []
updated: 2026-10-30
---

# Users, roles and the audit list

> **In 30 seconds**
>
> - `/users` lists the members of your org. Owners and admins change roles, invite users, and deactivate or reactivate members.
> - `/audit` lists the admin actions of your org, newest first.
> - The studio BFF calls synthwerk-identity with the access token of your session. The browser never sees the token.
> - Proves the studio part of synthwerk#37.

## What it does

1. The page calls a BFF route under `/api/org`.
2. The BFF gets the session through `AuthService.current`. That call refreshes the access token when it ends soon.
3. The BFF checks the input, then reads the identity org UUID from `GET /v1/me`. The session org id is the Zitadel org id, not this UUID.
4. The BFF calls identity with `Authorization: Bearer <access token>`.
5. The BFF gives the page the member or the page. On an error it gives the status and the problem `code` only.

| BFF route | Identity call |
|---|---|
| `GET /api/org/members?cursor=` | `GET /v1/orgs/{orgId}/members` |
| `POST /api/org/members` `{ email, role }` → 202 invitation | `POST /v1/orgs/{orgId}/members` |
| `GET /api/org/invitations?cursor=` | `GET /v1/orgs/{orgId}/invitations` |
| `DELETE /api/org/invitations/{invitationId}` → 204 | `DELETE /v1/orgs/{orgId}/invitations/{invitationId}` |
| `PATCH /api/org/members/{userId}` `{ role }` | `PATCH /v1/orgs/{orgId}/members/{userId}` |
| `POST /api/org/members/{userId}/deactivate` | `POST /v1/orgs/{orgId}/members/{userId}:deactivate` |
| `POST /api/org/members/{userId}/reactivate` | `POST /v1/orgs/{orgId}/members/{userId}:reactivate` |
| `GET /api/org/audit-events?cursor=` | `GET /v1/orgs/{orgId}/audit-events` |

## How to use

- Set `NUXT_IDENTITY_URL` to the identity base URL. Local stack: `http://localhost:8080/identity` (the edge).
- Sign in. Open `/users` or `/audit` from the navigation (Me, Users, Audit).
- Invite: type the email, choose the role, select **Send invite**. The invitation shows under **Pending invitations**. The user shows in the users list after the first sign-in.
- The answer is the same for every email: the page never shows whether the email has an account.
- Revoke: select **Revoke** on a pending invitation.
- Role: choose a new role in the row. The page shows the stored role until identity accepts the change.
- Deactivate or reactivate: select the button in the row.
- Select **Load more** for the next page.

## Rules and limits

| Rule | Value |
|---|---|
| Who | Owner and admin. An operator can read the members, not change them. The audit list is owner and admin only. Identity decides. |
| Own row | The page disables the role and the buttons on your own row (session `sub`). Identity refuses it too. |
| Status | Active members show plain text; deactivated members show a neutral pill. |
| CSRF | POST, PATCH and DELETE need `Origin` = studio origin and `x-csrf-token` = the session CSRF token. |
| Input checks | Before identity is called: user id `^[A-Za-z0-9_-]{1,128}$`, role `owner`, `admin` or `member`, email with one `@` and 254 characters or less, cursor 256 characters or less, invitation id a UUID. |
| Page size | Identity default, 50. |
| Timeout | 10 s per identity call. |
| Logs | No token, no email, no upstream `detail`. |
| Rate limit | Identity limits invites. A 429 passes with `Retry-After` (seconds, 1 to 3600). |
| Cache | `/api/org/**` has `Cache-Control: no-store`. |
| Audit lines | Known types get a sentence. Other types show the type and the actor. The page strips `dev.synthwerk.identity.` and the version. Text only, no `v-html`. |
| Configuration | `NUXT_IDENTITY_URL`, absolute `http` or `https` URL, no user info, query or fragment. Server side only. Missing or bad: `/api/org` answers 503, sign-in keeps working. |

## Events

| Type | When |
|---|---|
| None. The studio emits no event. Identity emits the member events. | |

## Errors

| Status | Code | Cause |
|---|---|---|
| 400 | `invalid_request` | Bad user id, role, email, cursor or body. Identity is not called. |
| 401 | `unauthenticated` | No session, or identity refused the token. The page starts the sign-in. |
| 403 | `csrf_failed` | Other origin, or no or wrong `x-csrf-token` |
| 403 | `forbidden` | The role does not allow the call. The page says only owners and admins can do it. |
| 404 | `not_found` | Unknown member, invitation or org |
| 409 | `last_owner` | The org would lose its last active owner |
| 409 | `own_role` | You tried to change your own role |
| 409 | `own_membership` | You tried to deactivate yourself |
| 409 | `member_exists` | The email is an active or deactivated member of the org |
| 429 | `rate_limited` | Too many invites. `Retry-After` says when to try again |
| 502 | `upstream_unavailable` | Zitadel did not take the change, identity is not reachable, or identity gave a bad answer |
| 503 | `identity_not_configured` | `NUXT_IDENTITY_URL` is missing or not valid |

## Tests

- `tests/server/members.test.ts`: the config reader, and `MembersClient` against a fake identity (`tests/support/identity.ts`). Org lookup, method, path, body, bearer token, problem mapping, non-JSON errors, input refusals.
- `tests/server/members-api.test.ts`: the BFF routes with the real `AuthService` and the mock OIDC provider. No session, CSRF, invite (202), invitations, revoke (204), role change, deactivate, reactivate, audit, error pass-through, 429 with `Retry-After`, 503.
- `tests/app/audit.test.ts`: the audit lines.

## Open points

- No Playwright e2e in this change. Add it with the local stack (synthwerk-e2e).
- Invite needs more Zitadel permissions for the machine user `identity-sync`: it must create users in the org. The identity PR for synthwerk#37 names the role.
- The page shows user ids, not names. Identity stores no names; it stores the typed email of a pending invitation only.

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version: members, roles, invite, deactivate, reactivate, audit list (synthwerk#37). |
| 2026-10-30 | Pending invitations and revoke; invite answers 202; 429 with `Retry-After`; neutral status for active rows (synthwerk#37 security review). |
