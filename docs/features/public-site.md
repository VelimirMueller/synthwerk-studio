---
title: Public site with live pages, legal pages and consent
slug: public-site
status: beta
epic: E6
owner: studio
paths: ["server/lib/site-api.ts", "server/lib/site-config.ts", "server/utils/site.ts", "server/api/site/**", "server/middleware/csrf.ts", "shared/site.ts", "app/pages/[locale]/**", "app/components/site/**", "app/composables/useConsent.ts", "app/composables/useLivePage.ts", "app/utils/consent.ts", "app/utils/site.ts", "app/assets/site.css"]
api: ["GET /api/site/pages/{locale}/{slug}"]
events: []
mcp: []
updated: 2026-10-30
---

# Public site with live pages, legal pages and consent

> **In 30 seconds**
>
> - The public site lives in `synthwerk-studio`: SSR routes `/de`, `/en`, `/de/{slug}`, `/en/{slug}`. No sign-in.
> - It shows the live version of a builder page. Never a draft. No live version: 404.
> - `GET /api/site/pages/{locale}/{slug}` gives the live page with `Cache-Control` and a strong `ETag`.
> - Legal pages (Impressum, Datenschutz, Cookies) are static pages with a placeholder: `TODO: legal text, needs #49 sign-off`.
> - Every environment except `prd` shows a test system banner.
> - A consent banner in German and English. Umami loads only after an opt-in. The choice is in a first-party cookie.
> - Proves synthwerk#109 and the code part of synthwerk#45. The legal texts and the #49 sign-off are still open.

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

- A legal slug always shows the static legal page. A builder page with the same slug never shows.
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

## Public HTML

- `/de/**` and `/en/**` send `Cache-Control: public, max-age=60, stale-while-revalidate=300`.
- The HTML is the same for every visitor: the consent banner renders on the client, after the cookie is read.
- A 503 page sends `no-store`.

## Consent

- Cookie `sw_consent`, first party, `Path=/`, `SameSite=Lax`, `Secure` on https, 182 days. Values `v1.analytics-yes`, `v1.analytics-no`.
- No valid cookie: the banner shows. Nothing non-essential loads.
- Two buttons of the same kind: "Essential only" and "Allow analytics". Refusing is as easy as accepting.
- "Cookie settings" in the footer and on the cookie page opens the banner again. It takes the focus.
- A saved choice is announced in a `role="status"` region.
- Withdrawn analytics consent reloads the page: the loaded script goes away.
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

- `tests/server/site-api.test.ts`: live version, draft never shown, 404 without a live version, org and locale isolation, bad input, publish and roll back with a new ETag, 304, cookies ignored, 503 cases, no URL in logs, config check.
- `tests/app/consent.test.ts`: cookie values, cookie attributes, the analytics script gate.
- `tests/app/site.test.ts`: routes, legal slugs, language switch, env banner, the same text keys in German and English.
- No Playwright in this repo yet. Checked by hand in Chrome on a local build: banner, opt-in, withdraw, no request before consent.

## Open points

- Legal texts and the #49 sign-off.
- Prerender at build time (#45): needs a database at build time and the hosting decision (#8).
- Playwright request audit (#45) with synthwerk-e2e.
- Mascot (#48) and widget wiring.
- The builder does not refuse a legal slug. Such a page never shows.

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version: live read route, public SSR pages, legal placeholders, consent banner (synthwerk#109, #45). |
