---
title: AI settings
slug: ai-settings
status: beta
epic: E4
owner: studio
paths: ["server/api/ai-settings/**", "server/lib/ai-settings.ts", "server/lib/llm-config.ts", "server/utils/ai-settings.ts", "app/pages/ai.vue", "app/composables/useAiSettings.ts"]
api: ["GET /api/ai-settings", "PUT /api/ai-settings"]
events: ["dev.synthwerk.llm.ai_settings.changed.v1"]
mcp: []
updated: 2026-10-30
---

# AI settings

> **In 30 seconds**
>
> - `/ai` shows the AI settings of your org: default model, allowed models, system prompt, input limit, token cap per user, temperature.
> - Only an owner or an admin sees and saves them. A member sees a short message, no form.
> - The BFF calls synthwerk-llm with the session token. The browser never gets a token (synthwerk#39).
> - Each save goes into the audit list. The audit line names the changed settings, never the prompt text.

## What it does

- `GET /api/ai-settings` returns the settings of the token's org and their bounds (llm `GET /v1/ai-settings`).
- `PUT /api/ai-settings` replaces every setting in one step (llm `PUT /v1/ai-settings`). The body holds the `version` the page read.
- llm acts in the org of the token. The BFF sends no org id.
- llm checks the role (owner or admin, active membership), the bounds and the version. The BFF only refuses junk early.
- The BFF reads the llm answer strictly: a missing or wrong field is 502, never passed on.
- The route files only name an entry of `aiSettingsRoutes` (`server/lib/ai-settings.ts`). The tests run the same table.

## How to use

1. Set `NUXT_LLM_URL` (see Configuration).
2. Sign in as an owner or admin. Open **AI** in the navigation.
3. Change the values. Save.
4. Somebody else saved first: the page says "The settings changed. Reload them." Reload, change again, save.

## Settings

| Setting | Values | Default (version 0) |
|---|---|---|
| Default model | One alias of `bounds.models` | The default alias of llm |
| Allowed models | Aliases of `bounds.models`. Must hold the default model | Every alias of llm |
| System prompt | Plain text, at most `bounds.system_prompt_max_chars` (4000). Line breaks and tabs only | Empty: the prompt of llm |
| Max characters of one message | 1 to `bounds.max_input_chars` | The llm limit |
| Tokens per user per day | 0 or more. 0 = the plan limit only. At most the plan limit when the plan has one | 0 |
| Temperature | 0 to `bounds.temperature_max` (2). Empty = the model default | Empty |

- Storage: llm, one record per org. Not in the studio.
- The page shows the version and the time of the last save.
- The page shows the plan limit from `bounds.user_tokens_per_day`. 0 there means no limit.

## Configuration

| Variable | Default | Use |
|---|---|---|
| `NUXT_LLM_URL` | none | llm base URL as the studio server reaches it. Local: `http://localhost:8080/llm` (edge). Unset: the routes answer 503 `not_configured`. |

## Rules and limits

| Rule | Value |
|---|---|
| Who | Owner or admin. llm asks identity for the stored membership. A member, an operator and a widget token get 403 |
| Session | Every route needs a session: 401 `unauthenticated` |
| CSRF | `PUT` needs `Origin` = studio origin and `x-csrf-token` = the session CSRF token |
| Body | Every field must be there. Unknown keys are dropped. Aliases match `^[a-z][a-z0-9_-]{0,63}$`, 1 to 32 of them, each once |
| System prompt | 4000 characters or less. Control characters other than `\n`, `\r`, `\t` are refused |
| Numbers | `max_input_chars` 1 to 8000, `user_tokens_per_day` 0 to 10^12, integers. `temperature` 0 to 2, or null |
| Version | A stale `version` gets 409 `version_conflict`. Nothing changes |
| Response headers | `/api/ai-settings/**` has `Cache-Control: no-store` |
| Tokens | The access token stays on the server. No answer carries it |
| Rendering | Text only. No `v-html` |

## Events

| Type | When |
|---|---|
| `dev.synthwerk.llm.ai_settings.changed.v1` | llm emits it on a saved change. Identity copies it into the audit list. The studio shows "user X changed the AI settings: max_input_chars, system_prompt (version 3)". No prompt text. |

## Errors

| Status | Code | Cause |
|---|---|---|
| 400 | `invalid_request` | A value is out of range. The detail names the field. |
| 401 | `unauthenticated` | No session, or llm refused the token. |
| 403 | `csrf_failed` | Wrong origin or CSRF token. |
| 403 | `forbidden` | The role is not owner or admin. |
| 409 | `version_conflict` | Somebody saved first. Reload and save again. |
| 502 | `upstream_unavailable`, `upstream_error` | llm is down or sent a bad answer. Its body is never passed on. |
| 503 | `settings_unavailable` | llm cannot check the role at identity. The llm detail is dropped. |
| 503 | `not_configured` | `NUXT_LLM_URL` is not set. |

- A 4xx of llm keeps its code and its detail, cut to 512 characters.

## Tests

- `tests/server/ai-settings.test.ts` — `GET /api/ai-settings - no session - 401 unauthenticated, llm not called`
- `tests/server/ai-settings.test.ts` — `PUT /api/ai-settings - wrong CSRF token - 403 csrf_failed, llm not called`
- `tests/server/ai-settings.test.ts` — `GET /api/ai-settings - signed in - calls llm with the session token, returns the settings`
- `tests/server/ai-settings.test.ts` — `PUT /api/ai-settings - valid body - sends exactly the validated body in the contract shape`
- `tests/server/ai-settings.test.ts` — `PUT /api/ai-settings - <case> - 400 invalid_request before llm`
- `tests/server/ai-settings.test.ts` — `PUT /api/ai-settings - llm says version_conflict - 409 with the code and the detail`
- `tests/server/ai-settings.test.ts` — `llm 503 settings_unavailable - 503 with the code, no llm detail`
- `tests/server/ai-settings.test.ts` — `llm 500 - 502 upstream_error, no llm body`
- `tests/server/ai-settings.test.ts` — `llm down - 502 upstream_unavailable`
- `tests/server/ai-settings.test.ts` — `NUXT_LLM_URL unset - 503 not_configured, llm not called`
- `tests/server/ai-settings.test.ts` — `server/api/ai-settings/<file> - runs aiSettingsRoutes.<name>, the route this harness tests`
- `tests/app/audit.test.ts` — `llm.ai_settings.changed <n> - known setting names and the version, plain text`
- Not yet: a Playwright e2e against a running llm.

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version (synthwerk#39). |
| 2026-10-30 | Write routes read the JSON body through `server/lib/body.ts`: 64 KiB cap, read as a stream, 413 `payload_too_large` as soon as the cap is passed (also chunked). |
