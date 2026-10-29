---
title: Health view
slug: health-view
status: beta
epic: E4
owner: studio
paths: ["server/lib/health.ts", "server/utils/health.ts", "server/api/health/**", "app/pages/health.vue", "app/components/health/**", "app/composables/useHealthView.ts"]
api: ["GET /api/health/status", "GET /api/health/stream", "GET /api/health/metrics"]
events: []
mcp: []
updated: 2026-10-30
---

# Health view

> **In 30 seconds**
>
> - `/health` shows the live status, rate, errors and p95 per service, host and bus numbers, and the AI numbers (synthwerk#40).
> - The browser never calls pulse. The BFF routes in `server/api/health` call pulse with the access token of the session.
> - Operators see every number. Org owners and admins see the status and the AI numbers of their own org only.
> - Members get 403. Pulse checks the token and the org again.

## What it does

- The page loads the status once, then opens `GET /api/health/stream` (Server-Sent Events) for live changes.
- The BFF passes the pulse stream through. The browser reconnects by itself after a break.
- The page loads the numbers from `GET /api/health/metrics` every 15 s.
- An operator gets the platform numbers (`/v1/metrics` in pulse).
- An owner or admin gets the numbers of the session org (`/v1/orgs/{org}/metrics`). The org id never comes from the request.
- An operator grant outside the platform org gets 403 from pulse. An org admin then falls back to the own org.
- A part that pulse cannot read shows `-` or a short note. The other parts stay.

## Access per role

| Route | operator | owner, admin (own org) | member | no session |
|---|---|---|---|---|
| `GET /api/health/status`, `GET /api/health/stream` | 200 | 200 | 403 | 401 |
| `GET /api/health/metrics` | 200, `scope: platform` | 200, `scope: org` | 403 | 401 |

- An owner or admin grant counts only in the org of the session.
- The BFF calls pulse only after this check. A refused request never reaches pulse.

## How to use

1. Run pulse with a token check (synthwerk-pulse `docs/features/health-metrics.md`).
2. Set `NUXT_PULSE_BASE_URL` to pulse inside the network, for example `http://pulse:8080`.
3. Sign in as an operator, owner or admin. Open `/health`. The home page links it for these roles.

## Rules and limits

| Rule | Value |
|---|---|
| Numbers refresh | Every 15 s in the page. Pulse refreshes its platform numbers every 10 s. |
| Stream life | Until the access token ends, min 30 s, max 1 h. Then the browser reconnects and the BFF checks the session again. |
| Pulse call timeout | 5 s (status and metrics) |
| Cache | `cache-control: no-store` on `/api/health/**` |

## Events

| Type | When |
|---|---|
| None. | |

## Errors

| Status | Code (`data.code`) | Cause |
|---|---|---|
| 401 | `unauthenticated` | No session. |
| 403 | `forbidden` | No operator, owner or admin role, or pulse refused the token. |
| 502 | `pulse_unavailable` | Pulse does not answer, or answers with an error. |
| 503 | `pulse_not_configured` | `NUXT_PULSE_BASE_URL` is empty. |

## Tests

- `tests/server/health.test.ts` — `GET /api/health/metrics - org admin - own org only, never the platform numbers`
- `tests/server/health.test.ts` — `GET /api/health/status - member - 403, pulse not called`
- `tests/server/health.test.ts` — `GET /api/health/status - admin grant in another org only - 403`
- `tests/server/health.test.ts` — `GET /api/health/metrics - false operator who is org admin - falls back to the own org`
- `tests/server/health.test.ts` — `GET /api/health/stream - org admin - pulse events passed through as SSE`

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version (synthwerk#40). Needs synthwerk-pulse#5. |
