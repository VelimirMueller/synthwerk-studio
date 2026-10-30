---
title: Apps, widget settings and the embed snippet
slug: apps-and-embed
status: beta
epic: E4
owner: studio
paths: ["server/api/apps/**", "server/lib/apps.ts", "server/utils/apps.ts", "shared/widget.ts", "app/pages/apps/**", "app/components/WidgetPreview.vue", "app/composables/useApps.ts"]
api: ["GET /api/apps", "POST /api/apps", "GET /api/apps/{appId}", "PATCH /api/apps/{appId}", "DELETE /api/apps/{appId}"]
events: []
mcp: []
updated: 2026-10-30
---

# Apps, widget settings and the embed snippet

> **In 30 seconds**
>
> - `/apps` lists the apps of your org. An owner or admin adds an app with its allowed origins.
> - `/apps/<id>` shows the embed snippet with a copy button, the allowed origins and the widget settings.
> - The preview changes on every input. Nothing reloads.
> - The BFF calls identity with the session token. The browser never gets a token (synthwerk#38).

## What it does

- `GET /api/apps` lists the apps of the signed-in user's org (identity `listApps`; follows `next_cursor`, 100 pages of 100 at most).
- `POST /api/apps` creates an app: name and allowed origins (identity `createApp`).
- `GET /api/apps/{appId}` returns one app.
- `PATCH /api/apps/{appId}` changes the name, the origins or the widget settings.
- `DELETE /api/apps/{appId}` deletes the app. Its chat stops on every origin.
- The BFF finds the identity org id with `GET /v1/me`. The session holds the Zitadel org id only.
- Identity checks roles, origins, settings and the app limit. The BFF only refuses junk early.
- Settings from identity are read leniently: an unknown value shows as its default. Request bodies are strict.
- The route files only name an entry of `appRoutes` (`server/lib/apps.ts`). The tests run the same table.

## How to use

1. Set `NUXT_IDENTITY_URL`, `NUXT_PUBLIC_WIDGET_SCRIPT_URL` and `NUXT_PUBLIC_WIDGET_API_URL` (see Configuration).
2. Sign in as an owner or admin. Open **Apps** on `/me`.
3. Add an app. Put the page origin in the list, for example `https://shop.example` or `http://localhost:3000`.
4. Copy the snippet into the page. After sign-in, the page hands in the access token of its user:

   ```html
   <script type="module" src="https://<widget host>/widgets/v0.2.0/synthwerk-chat.js"
           integrity="sha384-…" crossorigin="anonymous"></script>
   <synthwerk-chat app-id="<app id>" api-url="https://<edge>"></synthwerk-chat>
   <script type="module">
     // After sign-in and sign-out: hand in the access token of the signed-in user, or null.
     document.querySelector('synthwerk-chat').getUserToken = () => yourAuth.accessToken ?? null
   </script>
   ```

5. Pick the widget settings. Check the preview. Save.

## Embed snippet

- The attributes are the real ones of `<synthwerk-chat>` (synthwerk-widgets `docs/features/chat-widget.md`): `app-id`, `api-url`.
- The snippet has no setting attribute. The widget loads the settings from identity (widgets#34). An attribute would win over the studio value.
- Config values are escaped for an HTML attribute. The page shows the snippet as text (`SwTerminalSnippet`), never as HTML. No `v-html`.
- The copy button uses the Clipboard API. A refused copy shows a hint.
- The snippet shows only when both URLs are absolute `https` URLs, or `http` on localhost. Else the page names the missing variables.
- With `NUXT_PUBLIC_WIDGET_SCRIPT_INTEGRITY` set, the script tag gets `integrity` and `crossorigin="anonymous"` (widgets#32). The browser refuses a changed bundle.
- The value must be one `sha256`, `sha384` or `sha512` hash in base64. Any other value: no `integrity` attribute.
- Set it only with a versioned URL (`/widgets/vX.Y.Z/synthwerk-chat.js`). The hash is in the widgets release notes and the build job summary.

## Widget settings

| Setting | Values | Default |
|---|---|---|
| Position | `bottom-right`, `bottom-left` | `bottom-right` |
| Theme | `default`, `contrast` (tokens `data-theme`) | `default` |
| Mode | `system`, `light`, `dark` | `system` |
| Language | `auto` (browser), `de`, `en` | `auto` |
| Colour | Accent group of `@synthwerk/tokens`: `flagship`, `lab`, `ops`, `venture` | `flagship` |
| Greeting | Plain text, 280 characters or less, line breaks allowed | empty: the widget's own greeting |

- Storage: identity, `apps.widget_settings` (identity migration 0007). Not in the studio.
- No free colour or CSS. Colours stay inside the token groups.
- The preview sets `data-theme`, `data-mode` and `data-group` on its frame, so it reads the same token values as the widget.
- The preview is a picture of the widget, not the widget bundle. The bundle has no host yet (widgets#32).
- The widget loads these settings since widgets 0.2.0 (widgets#34).

## Configuration

| Variable | Default | Use |
|---|---|---|
| `NUXT_IDENTITY_URL` | none | Identity base URL as the studio server reaches it. Local: `http://localhost:8080/identity` (edge). Unset: the app routes answer 503 `not_configured`. |
| `NUXT_PUBLIC_WIDGET_SCRIPT_URL` | none | URL of `synthwerk-chat.js` in the snippet. Use the versioned URL |
| `NUXT_PUBLIC_WIDGET_SCRIPT_INTEGRITY` | none | SRI hash of that version (`sha384-…`). Adds `integrity` and `crossorigin` |
| `NUXT_PUBLIC_WIDGET_API_URL` | none | Edge base URL in the snippet (`api-url`). The widget calls `/identity` and `/llm` below it. |

## Rules and limits

| Rule | Value |
|---|---|
| Read | Any member of the org |
| Write | Owner or admin (identity checks the stored role). The page hides the forms for a member |
| Session | Every route needs a session: 401 `unauthenticated` |
| CSRF | Every write needs `Origin` = studio origin and `x-csrf-token` = the session CSRF token |
| Ids | App ids must be UUIDs. Anything else is 404 and never reaches identity |
| Name | 1 to 128 characters |
| Origins | 1 to 20, 256 characters each. One per line in the form |
| App limit | `apps_per_org` of the org's plan. Identity answers 403 `app_limit_reached` |
| Response headers | `/api/apps/**` has `Cache-Control: no-store` |
| Tokens | The access token stays on the server. No answer carries it |

## Events

| Type | When |
|---|---|
| None. | Identity writes `app.created.v1`. |

## Errors

| Status | Code | Cause |
|---|---|---|
| 400 | `invalid_request` | Bad name, origins or settings. Identity's detail names the bad origin index. |
| 401 | `unauthenticated` | No session, or identity refused the token. |
| 403 | `csrf_failed` | Wrong origin or CSRF token. |
| 403 | `forbidden` | The role does not allow the write. |
| 403 | `app_limit_reached` | The plan allows no more apps. |
| 404 | `not_found` | Unknown app, app of another org, or an id that is not a UUID. |
| 502 | `upstream_unavailable`, `upstream_error` | Identity is down or sent a bad answer. Its body is never passed on. |
| 503 | `not_configured` | `NUXT_IDENTITY_URL` is not set. |

## Tests

- `tests/server/apps.test.ts` — `GET /api/apps - no session - 401 unauthenticated, identity not called`
- `tests/server/apps.test.ts` — `POST /api/apps - wrong CSRF token - 403 csrf_failed, identity not called`
- `tests/server/apps.test.ts` — `GET /api/apps - signed in - looks up the org with /v1/me, lists its apps with the session token`
- `tests/server/apps.test.ts` — `PATCH /api/apps/:id - widget settings only - sends only widget_settings`
- `tests/server/apps.test.ts` — `GET /api/apps/:id - id is not a UUID - 404, no path reaches identity`
- `tests/server/apps.test.ts` — `POST /api/apps - identity says app_limit_reached - 403 with the code and the detail`
- `tests/server/apps.test.ts` — `GET /api/apps - two identity pages - follows next_cursor, returns both pages`
- `tests/server/apps.test.ts` — `server/api/apps/<file> - runs appRoutes.<name>, the route this harness tests`
- `tests/shared/widget.test.ts` — `app and config - one module script, one <synthwerk-chat> with app-id and api-url, the token hook`
- `tests/shared/widget.test.ts` — `versioned URL with SRI - integrity and crossorigin on the script tag`
- `tests/shared/widget.test.ts` — `no or broken integrity - plain script tag, never a broken integrity attribute`
- `tests/shared/widget.test.ts` — `config with quotes and angle brackets - escaped, no attribute break-out`
- `tests/shared/widget.test.ts` — `settings - never in the snippet - the widget loads them, an attribute would win`
- Not yet: Playwright e2e and the timed 5-minute embed run (needs the widget host and a running stack).

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version (synthwerk#38). |
| 2026-10-30 | Snippet with `integrity` and `crossorigin` from `NUXT_PUBLIC_WIDGET_SCRIPT_INTEGRITY` (widgets#32). |
| 2026-10-30 | Write routes read the JSON body through `server/lib/body.ts`: 64 KiB cap, read as a stream, 413 `payload_too_large` as soon as the cap is passed (also chunked). |
