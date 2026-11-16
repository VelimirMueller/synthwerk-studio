---
title: Public site with live pages, legal pages and consent
slug: public-site
status: beta
epic: E6
owner: studio
paths: ["server/lib/site-api.ts", "server/lib/site-config.ts", "server/utils/site.ts", "server/api/site/**", "shared/site.ts", "app/pages/[locale]/**", "app/components/site/**", "app/composables/useConsent.ts", "app/composables/useLivePage.ts", "app/composables/useSiteConfig.ts", "app/utils/consent.ts", "app/utils/site.ts", "app/assets/site.css"]
api: ["GET /api/site/pages/{locale}/{slug}", "GET /api/site/config"]
events: []
mcp: []
updated: 2026-11-16
---

# Public site with live pages, legal pages and consent

> **In 30 seconds**
>
> - The public site lives in `synthwerk-studio`: SSR routes `/de`, `/en`, `/de/{slug}`, `/en/{slug}`. No sign-in.
> - It shows the live version of a builder page. Never a draft. No live version: 404.
> - `GET /api/site/pages/{locale}/{slug}` gives the live page with `Cache-Control` and a strong `ETag`.
> - Legal pages (Impressum, Datenschutz, Cookies) are static pages with a placeholder: `TODO: legal text, needs #49 sign-off`.
> - The legal pages are prerendered at build time in German and English. The builder pages stay SSR with a CDN cache.
> - Every environment except `prd` shows a test system banner.
> - A consent banner in German and English. Umami loads only after an opt-in. The choice is in a first-party cookie.
> - Proves synthwerk#109 and the code part of synthwerk#45. The legal texts and the #49 sign-off are still open.
> - The request audit of synthwerk#45 is in synthwerk-e2e: `tests/site/request-audit.spec.ts`.

## Where it lives

- Decision: studio. The docs name `synthwerk-studio` as the owner of the public site (developer-guide, #45, #109).
- The pages use `PageView.vue`, the same component as the editor preview (synthwerk#46).
- The read route shares the builder database pool (`server/utils/builder-store.ts`).

## Routes

| Path | Shows |
|---|---|
| `/de`, `/en` | The live builder page with the slug `home` |
| `/de/{slug}`, `/en/{slug}` | The live builder page with that slug and locale |
| `/de/impressum`, `/en/imprint` | Imprint placeholder |
| `/de/datenschutz`, `/en/privacy` | Privacy placeholder |
| `/de/cookies`, `/en/cookies` | Cookie placeholder, technical cookie facts, cookie settings |
| `/de/confirm`, `/en/confirm` | Confirm page of the lead form (synthwerk#105, [leads](leads.md)). A builder page with the slug `confirm` never shows |

- A legal slug always shows the static legal page. A builder page with the same slug never shows.
- The six legal paths are prerendered (`LEGAL_PATHS` in `shared/site.ts`). See [Prerender](#prerender).
- The language link goes to the same legal page in the other language, else to the other start page.

## The read route

`GET /api/site/pages/{locale}/{slug}`

| Step | Check | Answer |
|---|---|---|
| 1 | Locale is `de` or `en`, slug matches the builder slug rule | 404 `page_not_found` |
| 2 | `NUXT_SITE_ORG_ID` and `NUXT_BUILDER_DATABASE_URL` are set | 503 `site_not_configured` |
| 3 | The database answers | 503 `site_unavailable` |
| 4 | The page of the site org has a live version | 404 `page_not_found` |
| 5 | `If-None-Match` matches the ETag | 304, no body |
| 6 | | 200 `{ slug, locale, version, publishedAt, content }` |

- No session and no cookie is read. The CSRF middleware skips `GET` and `HEAD` on `/api/site/`, so the route works without the sign-in settings.
- The org is a config value (`NUXT_SITE_ORG_ID`), never a request value.
- The answer has no author and no page id.
- `Cache-Control: public, max-age=60, stale-while-revalidate=300`. A publish or roll back shows within about one minute.
- ETag: sha256 of the JSON body, base64url. A roll back gives a new ETag.
- Errors: Nitro sends `Cache-Control: no-cache`.
- The route makes no third-party request. It reads the studio database only.

## Prerender

| Pages | How | Why |
|---|---|---|
| Legal pages, both locales | Prerendered by `nuxt build` (route rule `prerender: true`) | The content is static. It needs no database |
| `/de`, `/en`, `/de/{slug}`, `/en/{slug}` | SSR on each request, CDN cache of 60 s | The content is the live builder version in Postgres |

- Decision (2026-11-16): the builder pages stay SSR with the cache headers below.
- Reason: a publish or a roll back must show within about one minute, without a new build.
- Reason: a build-time prerender needs the builder database during the build. The image build has no database.
- Reason: the hosting decision (#8) is still open. A rebuild on each publish needs a build hook there.
- Nitro serves a prerendered page as a file, with the same route rule headers.
- A prerendered page holds the public runtime config of the build, not of the running server.
- So the client asks `GET /api/site/config` once after a prerendered first page. See [Settings per environment](#settings-per-environment).
- A new legal page needs an entry in `LEGAL_PAGES` and `LEGAL_SLUGS`. The prerender list follows.

## Settings per environment

`GET /api/site/config` gives `{ env, analytics: { scriptUrl, websiteId } }` of the running server.

- No session. The CSRF middleware skips `GET` on `/api/site/`.
- The values are public. Every SSR page has them in its HTML too.
- `Cache-Control: public, max-age=60, stale-while-revalidate=300`.
- `useSiteConfig()` asks this route only when the first page of the visit was prerendered (`payload.prerenderedAt`).
- Until the answer, the build values show. The test system banner of the build can show for a moment.
- Until the answer, no analytics script loads. An error keeps the build values and analytics off.

## Public HTML

- `/de/**` and `/en/**` send `Cache-Control: public, max-age=60, stale-while-revalidate=300`.
- The HTML is the same for every visitor: the consent banner renders on the client, after the cookie is read.
- The prerendered legal pages get the same `Cache-Control` from the route rules.
- A 503 page sends `no-store`.

## Consent

- Cookie `sw_consent`, first party, `Path=/`, `SameSite=Lax`, `Secure` on https, 182 days. Values `v1.analytics-yes`, `v1.analytics-no`.
- No valid cookie: the banner shows. Nothing non-essential loads.
- Two buttons of the same kind: "Essential only" and "Allow analytics". Refusing is as easy as accepting.
- "Cookie settings" in the footer and on the cookie page opens the banner again. It takes the focus.
- A saved choice is announced in a `role="status"` region.
- Withdrawn analytics consent reloads the page: the loaded script goes away.
- On a prerendered first page, Umami also waits for `GET /api/site/config`.
- Umami loads only with consent and with both `NUXT_PUBLIC_SITE_ANALYTICS_SCRIPT_URL` (https or an own-origin path) and `NUXT_PUBLIC_SITE_ANALYTICS_WEBSITE_ID`. Empty values: no analytics.
- No third-party consent vendor.

## Placeholders

- Legal text: `TODO: legal text, needs #49 sign-off`. Velimir and legal write the texts. Do not write legal text in code.
- Mascot (#48) and chat widget: empty `data-site-slot` elements. They load nothing.

## How to use

| Variable | Value |
|---|---|
| `NUXT_SITE_ORG_ID` | The org whose builder pages are public. Server only |
| `NUXT_BUILDER_DATABASE_URL` | The builder database (see [page-builder](page-builder.md)) |
| `NUXT_PUBLIC_SITE_ENV` | `dev`, `stg` or `prd`. Every value but `prd` shows the test system banner |
| `NUXT_PUBLIC_SITE_ANALYTICS_SCRIPT_URL` | Umami script, optional |
| `NUXT_PUBLIC_SITE_ANALYTICS_WEBSITE_ID` | Umami website id, optional |

- In the builder, publish a page with slug `home` in `de` and `en`. Open `/de` and `/en`.

## Tests

- `tests/server/site-api.test.ts`:
  - Live version only. The draft never shows. 404 without a live version.
  - Org and locale isolation. Bad input.
  - Publish and roll back give a new ETag. 304. Cookies have no effect.
  - 503 cases. No URL in the logs. The config check.
- `tests/app/consent.test.ts`: cookie values, cookie attributes, the analytics script gate.
- `tests/app/site.test.ts`: routes, legal slugs, language switch, env banner, the same text keys in German and English. The prerender list. The settings reader.
- synthwerk-e2e `tests/site/request-audit.spec.ts`: Chromium opens the start pages, a builder page and each legal page without consent. Every request goes to the own origin. Analytics loads only after the opt-in.
- Checked by hand in Chrome on a local build: banner, opt-in, withdraw, no request before consent.
- Checked on a local build with `NUXT_PUBLIC_SITE_ENV=prd`: a prerendered legal page drops the test system banner after `/api/site/config`.

## Open points

- Legal texts and the #49 sign-off.
- Builder pages: a build-time prerender waits for the hosting decision (#8). Today SSR with a CDN cache (see [Prerender](#prerender)).
- Mascot (#48) and widget wiring.
- The builder does not refuse a legal slug. Such a page never shows.

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version: live read route, public SSR pages, legal placeholders, consent banner (synthwerk#109, #45). |
| 2026-10-30 | Confirm page of the lead form; an unpublished page answers 404 (synthwerk#105, #108). |
| 2026-11-16 | Legal pages prerendered in German and English. `GET /api/site/config` gives the live settings to prerendered pages. Builder pages stay SSR: decision recorded (synthwerk#45). |
