---
title: Delete own account
slug: account-delete
status: beta
epic: E2
owner: studio
paths: ["server/lib/account-api.ts", "server/api/me/**", "server/utils/account.ts", "app/composables/useAccount.ts", "app/utils/account.ts"]
api: ["DELETE /api/me"]
events: []
mcp: []
updated: 2026-10-30
---

# Delete own account

> **In 30 seconds**
>
> - `/me` has a **Delete your account** card. The user signs in again (step-up), types `DELETE`, then the BFF calls identity `DELETE /v1/me` (synthwerk#41).
> - Identity needs proof of a sign-in with MFA in the last 15 minutes. Zitadel access tokens carry no `sid` and no `auth_time`, so the BFF also sends the fresh ID token in `X-Synthwerk-Id-Token`.
> - Both tokens stay on the server. The browser sees only the result.

## What it does

1. `/me`: **Delete account** shows what goes away, then **Sign in again to continue**.
2. `GET /api/auth/reauth?purpose=delete_account`: code flow with `prompt=login` and `max_age=0`. Zitadel asks for the password and second factor (or passkey) again.
3. The callback checks the ID token: same `sub` as the session that started the step-up, `auth_time` from within this login. Then it marks the session for `delete_account` for 5 minutes and goes to `/me?delete=confirm`. Else `/me?delete=retry`.
4. `/me?delete=confirm`: the user types `DELETE` and presses **Delete my account**.
5. `DELETE /api/me` (CSRF token): takes the mark (single use), then calls identity `DELETE /v1/me` with `Authorization: Bearer <access token>` and `X-Synthwerk-Id-Token: <ID token>`.
6. On 202 the BFF ends the Zitadel session (`end_session`), revokes the refresh token, deletes the session and the page goes to `/?deleted=1`.

## Rules and limits

| Rule | Value |
|---|---|
| Step-up lifetime | 5 minutes in the BFF. Identity accepts `auth_time` up to 15 minutes old. |
| Single use | The mark is removed before identity is called, whatever identity answers. A retry needs a new sign-in. |
| CSRF | `Origin` check and `x-csrf-token`. A refused request keeps the mark. |
| Refresh | A token refresh keeps the mark and the ID token of the step-up. |
| Detail | Identity's `detail` never reaches the browser; only status and code. |

## Errors

| Status | Code | Cause |
|---|---|---|
| 401 | `unauthenticated` | No session |
| 403 | `csrf_failed` | Other origin or wrong `x-csrf-token` |
| 403 | `step_up_required` | No step-up, older than 5 minutes, or used already |
| 403 | `recent_mfa_required` | Identity refused the proof |
| 403 | `forbidden` | Operator account |
| 409 | `last_owner` | The user is the only owner of an org with other members |
| 502 | `upstream_unavailable` | Identity down or another answer |
| 503 | `identity_not_configured` | `NUXT_IDENTITY_URL` is not set |

## Tests

- `tests/server/account-delete.test.ts` — `GET /api/auth/reauth - signed in - authorize with prompt=login and max_age=0`; `callback - fresh auth_time, same user - /me?delete=confirm`; `callback - ID token without auth_time / old auth_time / another user - /me?delete=retry`; `step-up done - identity gets access token and ID token, 202, session ended at Zitadel`; `no step-up / older than 5 min - 403 step_up_required`; `identity refuses with recent_mfa_required - the step-up is used up`; `409 last_owner`; `502`; `503`
- `tests/app/account.test.ts` — the page step and the error texts

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version (synthwerk#41). |
