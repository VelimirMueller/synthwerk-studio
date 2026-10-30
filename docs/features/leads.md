---
title: Lead capture with double opt-in
slug: leads
status: beta
epic: E6
owner: studio
paths: ["shared/leads.ts", "shared/sections.ts", "server/lib/lead-api.ts", "server/lib/lead-store.ts", "server/lib/mail.ts", "server/lib/rate-limit.ts", "server/lib/site-config.ts", "server/lib/account-api.ts", "server/api/site/leads/**", "server/api/builder/leads/**", "server/utils/leads.ts", "server/plugins/lead-purge.ts", "server/middleware/csrf.ts", "app/components/page/PageLeadForm.vue", "app/pages/[locale]/confirm.vue", "app/pages/leads.vue"]
api: ["POST /api/site/leads", "POST /api/site/leads/confirm", "GET /api/builder/leads", "GET /api/builder/leads/export", "DELETE /api/builder/leads/{leadId}"]
events: []
mcp: []
updated: 2026-10-30
---

# Lead capture with double opt-in

> **TL;DR**
>
> - A builder page can have one **lead form** section: email, an optional name, a consent checkbox with the text of the page.
> - The visitor gets one confirm mail. The lead counts only after the visitor opens the link and clicks **Confirm**.
> - An unconfirmed address is deleted after 72 hours. Owners and admins see confirmed leads under **Leads**, export them as CSV and delete them.
> - Mail goes to Mailpit locally (SMTP) and through Resend on dev, stg and prd. Every mail is plain text: no tracking pixel.

## Flow

1. The public page renders the form (`PageLeadForm.vue`). It posts to the own origin only.
2. `POST /api/site/leads` checks the Origin, the rate limits, the body, the honeypot, the address and the consent. It finds the lead form in the **live** version of the page.
3. The store keeps a **pending** row with the sha256 of a random token (32 bytes) and an expiry. The token itself is never stored.
4. After the answer (202) the server sends the confirm mail with `https://<site>/<locale>/confirm#token=…`. If the send fails, the pending row is deleted again.
5. The confirm page reads the token from the fragment (never in a server log or a referrer), removes it from the address bar and waits for a click. A mail scanner that opens the link confirms nothing.
6. `POST /api/site/leads/confirm { token }` turns the row **confirmed** and clears hash and expiry. A second click, an old link or an expired link: 410 `link_invalid`.
7. A job (`server/plugins/lead-purge.ts`) deletes expired pending rows every hour.

## Public routes

| Route | Body | Answer |
|---|---|---|
| `POST /api/site/leads` | `{ locale, slug, sectionId, email, name?, consent: true, website }` | 202 `{ status: 'pending' }` |
| `POST /api/site/leads/confirm` | `{ token }` | 200 `{ status: 'confirmed' }` or 410 `link_invalid` |

| Check | Rule | Refusal |
|---|---|---|
| Settings | `NUXT_SITE_ORG_ID`, `NUXT_SITE_ORIGIN`, `NUXT_MAIL_PROVIDER`, the builder database | 503 `leads_not_configured` |
| Origin | `Origin` equals `NUXT_SITE_ORIGIN` exactly. No Origin: refused. No CSRF token: there is no session | 403 `origin_refused` |
| Rate limit | 5 forms per client address in 10 minutes, 60 forms per page per hour, 20 confirms per address in 10 minutes. In memory, per process | 429 `too_many_requests` |
| Body | 4 KiB, `server/lib/body.ts` | 413 `payload_too_large` |
| Honeypot | The hidden field `website` is not empty | 202, nothing stored, no mail |
| Address | One plain address, 254 characters or less | 400 `invalid_email` |
| Consent | `consent` is `true` | 400 `consent_required` |
| Form | The live version of the page has a lead section with this id | 404 `form_not_found` |
| Pending cap | 1000 pending addresses per org | 429 `too_many_requests` |

- The answer is the same for a new, a pending and a confirmed address: nobody learns if an address is known.
- A confirmed address gets no new mail. A pending address gets a new mail only 10 minutes after the last one; the new link replaces the old one.
- Client address: the socket address. Behind the edge proxy set `NUXT_SITE_TRUST_FORWARDED_FOR=true`: then the last `X-Forwarded-For` entry counts (the one the proxy added).

## Data minimisation

- Stored per lead: address, name (only when the form asks for it), page slug, locale and version, the consent text the visitor agreed to, created and confirmed time. No IP address, no user agent.
- The mail holds the site host, the link and the expiry. No name, no page content: Resend keeps mail metadata in the US (see synthwerk `docs/infrastructure.md`).
- Text only: no HTML, so no open pixel and no rewritten links. Keep open and click tracking off for the Resend domain.
- The Resend idempotency key is a hash of the token, never the token.
- Log lines hold error codes only, never an address.

## Studio routes (owners and admins)

| Route | Answer |
|---|---|
| `GET /api/builder/leads?before=` | `{ items, next }`: 100 confirmed leads, newest first |
| `GET /api/builder/leads/export` | `text/csv`, attachment `leads.csv`: up to 10000 confirmed leads |
| `DELETE /api/builder/leads/{leadId}` | 204 |

- Same checks as the builder routes (session, CSRF on DELETE, role, stored membership): see [page-builder](page-builder.md).
- CSV: RFC 4180 quoting. A cell that starts with `=`, `+`, `-`, `@`, tab or carriage return gets a leading `'` (CSV injection).

## Deletion

- Owners and admins delete one lead under **Leads**.
- Delete page: confirmed leads stay (slug, locale, version); pending ones go.
- Account delete (`DELETE /api/me`): when identity closes the session org with the account (`deleted_org_ids`), the studio deletes every lead of that org. The studio reads the identity org UUID (`GET /v1/me`) first. If that read fails, the account delete still runs and a log line says the lead delete was skipped.

## Settings

| Variable | Value |
|---|---|
| `NUXT_SITE_ORIGIN` | Public origin of the site, for example `https://synthwerk.dev`. `http` only for localhost |
| `NUXT_SITE_TRUST_FORWARDED_FOR` | `true` behind the edge proxy |
| `NUXT_MAIL_PROVIDER` | `smtp` (Mailpit) or `resend`. Empty: the form answers 503 |
| `NUXT_MAIL_FROM` | Sender, `Synthwerk <noreply@mail.example>`. The domain must be verified in Resend |
| `NUXT_MAIL_SMTP_URL` | `smtp://mailpit:1025`. No TLS and no login: for a mail catcher only |
| `NUXT_MAIL_RESEND_API_KEY` or `NUXT_MAIL_RESEND_API_KEY_FILE` | The Resend key, from the environment or a file. Never in a repo |

## Tests

- `tests/server/lead-store.test.ts`: pending, confirm once, expiry, purge, cool-down, pending cap, list cursor, deletes.
- `tests/server/lead-api.test.ts`: the public routes. Origin, rate limits, honeypot, body cap, bad inputs, unpublished page, mail failure, 503 cases.
- `tests/server/mail.test.ts`: settings, the Resend call, the SMTP dialogue against a fake server, header injection.
- `tests/server/builder-api.test.ts`: list, CSV export, delete. `tests/server/account-delete.test.ts`: leads of a closed org.

## Open points

- Events for the bus (synthwerk#106): lead events need a contract and an actor without a session. Not in this change.
- The rate limit is per process. Several studio processes need a shared store.
- Withdrawal link in later mails: there are no later mails yet.
- Playwright e2e with Mailpit (synthwerk-e2e).

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version (synthwerk#105). |
