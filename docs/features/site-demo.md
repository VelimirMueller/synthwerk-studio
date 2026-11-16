---
title: Live demo and public numbers on the site
slug: site-demo
status: beta
epic: E6
owner: studio
paths: ["server/lib/site-demo.ts", "server/lib/site-stats.ts", "server/utils/site-demo.ts", "server/utils/site-stats.ts", "server/api/site/demo/**", "server/api/site/stats.get.ts", "app/components/site/SiteDemo.vue", "app/components/site/SiteStats.vue", "app/utils/site-demo.ts"]
api: ["POST /api/site/demo/chat", "POST /api/site/demo/vision", "GET /api/site/stats"]
events: []
mcp: []
updated: 2026-11-16
---

# Live demo and public numbers on the site

> **In 30 seconds**
>
> - The public site has a "Try the live demo" block in the `widget` place (synthwerk#47).
> - The block sends no request on page view. Only the click asks `GET /api/auth/session`.
> - Signed out: a sign-in link back to the page. Signed in: a chat with llm and an image upload to vision.
> - Strict limits per user and for all users, and at most 2 model calls at the same time.
> - A refused request never reaches llm, identity or vision. The model load stays flat.
> - The site shows uptime, p95 and answered chats from pulse `GET /v1/public-stats`.

## The demo block

- Component `SiteDemo.vue`, root `data-site-slot="widget"`. German and English.
- Before the click: a title, one sentence and a "Try the live demo" button. No fetch.
- After the click: `GET /api/auth/session` on the own origin.
- No session: a sign-in link `/api/auth/login?returnTo=<current path>`.
- Session: a chat box (up to 2000 characters) and an image upload (JPEG, PNG or WebP, up to 5 MiB).
- The chat shows the answer while it streams. The image result shows the best label and the next four.
- Each error code has a text in both languages. A 401 shows the sign-in link again.

## Routes

| Route | Body | Upstream |
|---|---|---|
| `POST /api/site/demo/chat` | JSON `{ message: 1..2000 chars, conversation_id?: uuid }` | llm `POST /v1/conversations` (no id), then `POST /v1/conversations/{id}/messages` |
| `POST /api/site/demo/vision` | multipart, field `image` | identity `POST /v1/apps/{app}/widget-tokens`, then vision `POST /v1/classifications` |
| `GET /api/site/stats` | none | pulse `GET /v1/public-stats` |

- Chat: the answer is the llm stream, passed through (`text/event-stream`).
- Chat: the header `X-Demo-Conversation-Id` holds the conversation id. The page sends it with the next message.
- Chat: llm gets the access token of the session. The llm quotas of that user and org apply.
- Vision: vision takes widget tokens only. The BFF gets one for the demo app with `Origin: NUXT_SITE_ORIGIN`.
- Vision: the widget token is kept per session until 30 s before it ends. A 401 from vision drops it.
- Vision: the page gets `{ primary, labels (at most 5), uncertain }`. Request id, model and timings stay on the server.
- Both demo routes send `Cache-Control: no-store` (route rule `/api/site/demo/**` and the handler).

## Order of the checks

1. Session. None: 401 `sign_in_required`.
2. CSRF. The middleware checks the Origin (`assertSameOrigin`). The handler checks `x-csrf-token`.
3. Body (chat) or content type and length (vision). Bad input: 400, 413 or 415.
4. Rate limits. Over a limit: 429 `demo_rate_limited` with `Retry-After`.
5. Concurrency gate. Full: 429 `demo_busy` with `Retry-After: 5`.
6. Upstream call.

- A refused hit still counts. A flood cannot reset its own window.
- The vision route reads the image body only after the limits.

## Limits

| Limit | Default | Variable |
|---|---|---|
| Per user (session `sub`), chat and vision together | 5 per minute | `NUXT_SITE_DEMO_USER_PER_MINUTE` |
| Per user, UTC day | 30 per day | `NUXT_SITE_DEMO_USER_PER_DAY` |
| All users | 30 per minute | `NUXT_SITE_DEMO_GLOBAL_PER_MINUTE` |
| Model calls at the same time | 2 | `NUXT_SITE_DEMO_MAX_IN_FLIGHT` |

- The counters live in memory. They hold per studio process. Today there is one process.
- A slot of the gate is free when the stream ends, fails, or the visitor leaves. An answer stream lasts at most 120 s.

## Error codes

| Status | Code | When |
|---|---|---|
| 401 | `sign_in_required` | No session |
| 403 | `csrf_failed` | Wrong or missing `x-csrf-token` |
| 400 | `invalid_request` | Bad body. Also an unknown conversation id (llm 404) |
| 413 | `payload_too_large` | Image over 5 MiB |
| 415 | `unsupported_media_type` | Not multipart, or not JPEG, PNG or WebP |
| 429 | `demo_rate_limited` | A limit is used up |
| 429 | `demo_busy` | 2 model calls run already |
| 429 | `demo_quota_exhausted` | llm or vision answers 429 |
| 403 | `demo_not_member` | identity answers 403 or 404: the user is not in the org of the demo app |
| 502 | `demo_unavailable` | Any other upstream error |
| 503 | `demo_not_configured` | llm URL missing (chat). App id, identity, vision URL or site origin missing (vision) |

## Public numbers

- `GET /api/site/stats` has no session. pulse is reached inside the network (`NUXT_PULSE_BASE_URL`), 5 s timeout.
- The answer is kept 60 s in memory. Callers at the same time share one pulse call.
- Only these fields pass: `generated_at`, `window_days`, `uptime_ratio`, `p95_ms`, `answered_chats`.
- `Cache-Control: public, max-age=60, stale-while-revalidate=300`.
- pulse down or not set: 503 `stats_unavailable` with `no-store`. A failure is kept 10 s, then pulse is asked again.
- `SiteStats.vue` shows "Uptime 30 days", "p95" and "Answered chats 30 days". A null value shows `-`.
- The numbers load on the client after mount. A prerendered page never keeps old numbers.

## How to use

| Variable | Value |
|---|---|
| `NUXT_SITE_DEMO_APP_ID` | The demo app (UUID) in the demo org. Empty: the image demo answers 503 |
| `NUXT_SITE_ORIGIN` | The public origin. The demo app must allow it |
| `NUXT_LLM_URL`, `NUXT_VISION_URL`, `NUXT_IDENTITY_URL` | Service URLs as the studio server reaches them |
| `NUXT_PULSE_BASE_URL` | pulse inside the network |
| `NUXT_SITE_DEMO_*` limits | See [Limits](#limits) |

- The session cookie is host-only. The demo works when the site and the studio sign-in share one origin.
- Owner tasks: open self-registration for the demo org, create the demo app with the site origin, set the app id and the limits.

## Tests

- `tests/server/site-demo.test.ts`:
  - Order of the checks. No upstream call on any refusal.
  - Codes, `Retry-After`, `no-store`, upstream mapping, widget token cache.
  - Load test: one user, 50 concurrent chats: exactly 5 reach llm, 45 get 429.
  - Load test: 50 users: exactly 30 reach llm. Never more than 2 answer streams at the same time.
- `tests/server/site-stats.test.ts`: whitelist, 60 s cache, 503 when pulse is down.
- `tests/app/site-demo.test.ts`: SSE parser, error texts in both languages, number format.
- synthwerk-e2e: the journeys and the request audit (separate PR).

## Open points

- Limits per process. More studio processes need a shared store (for example Redis).
- The demo org self-registration and the demo app are owner tasks.

## Changes

| Date | Change |
|---|---|
| 2026-11-16 | First version: demo chat and image routes with strict limits and a gate, click-to-start block, public numbers (synthwerk#47). |
