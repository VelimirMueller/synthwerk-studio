---
title: Page builder with preview, publish, roll back, unpublish and delete
slug: page-builder
status: beta
epic: E6
owner: studio
paths: ["shared/sections.ts", "server/lib/builder-api.ts", "server/lib/builder-config.ts", "server/lib/builder-db.ts", "server/lib/builder-store.ts", "server/lib/builder-relay.ts", "server/lib/builder-nats.ts", "server/lib/uuidv7.ts", "server/plugins/builder-relay.ts", "server/lib/org-admin.ts", "server/lib/body.ts", "server/api/builder/**", "server/utils/builder.ts", "server/utils/builder-store.ts", "app/pages/builder/**", "app/components/builder/**", "app/components/page/**", "app/composables/useBuilderApi.ts", "app/utils/builder.ts"]
api: ["GET /api/builder/pages", "POST /api/builder/pages", "GET /api/builder/pages/{pageId}", "PUT /api/builder/pages/{pageId}/draft", "POST /api/builder/pages/{pageId}/publish", "POST /api/builder/pages/{pageId}/rollback", "GET /api/builder/pages/{pageId}/versions/{version}", "GET /api/builder/pages/{pageId}/events", "POST /api/builder/pages/{pageId}/unpublish", "DELETE /api/builder/pages/{pageId}", "POST /api/builder/pages/{pageId}/versions/{version}/copy"]
events: ["dev.synthwerk.studio.page.created.v1", "dev.synthwerk.studio.page.published.v1", "dev.synthwerk.studio.page.rolled_back.v1", "dev.synthwerk.studio.page.unpublished.v1", "dev.synthwerk.studio.page.deleted.v1", "dev.synthwerk.studio.page.version_copied.v1"]
mcp: []
updated: 2026-10-30
---

# Page builder with preview, publish, roll back, unpublish and delete

> **In 30 seconds**
>
> - `/builder` lists the pages of your org.
> - Owners and admins create a page and edit its sections. They preview the draft, publish it and roll back to any published version.
> - Sections come from a fixed catalogue: hero, proof, benefits, pricing, FAQ, call to action. There is no free HTML.
> - Text is plain, or a small Markdown subset that renders as Vue nodes. No `v-html`.
> - The studio server owns the data: its own Postgres database (`NUXT_BUILDER_DATABASE_URL`). No other service reads it.
> - Create, publish and roll back write an event to the page history. A relay sends each event to the bus (`EVT_STUDIO`); identity shows publish and roll back in the org audit list (synthwerk#106).
> - Owners and admins unpublish a page and copy any published version into the draft. Owners delete a page (synthwerk#108). Each action writes an event.
> - A lead form section collects addresses with double opt-in: see [leads](leads.md) (synthwerk#105).
> - Proves the studio part of synthwerk#46. The public site (synthwerk#45) and the live demo (synthwerk#47) render what the builder publishes.

## Where the data lives

- Decision: the studio server owns the builder data in its own Postgres database. Reasons:
  - The docs name `synthwerk-studio` as the owner of the builder (feature-catalogue, issue #46).
  - Studio is "admin + builder". Pages are studio content, not identity, llm, vision or pulse data. A table in identity is wrong.
  - A new service for one table set is more to run than it gives. The studio server is already a BFF with a server side.
  - Postgres is in the stack. Versions, a draft revision and an audit trail need transactions and row locks.
- The schema is in `server/lib/builder-db.ts` (`MIGRATIONS`). The server applies missing migrations on the first builder call, in one transaction, under an advisory lock.

| Table | Content |
|---|---|
| `builder_pages` | One row per page: org, slug, locale, the draft (`{ title, sections }`, jsonb), the draft revision, the live version |
| `builder_page_versions` | One immutable row per published version: page, number (1, 2, 3, …), content, who, when |
| `builder_events` | Create, publish and roll back. CloudEvents fields (`id` UUIDv7, `type`, `time`, `actor`, `subject`, `data`) and `identity_org_id`. The outbox of the relay: `relayed_at` is set when the event is on the bus, `relay_error` when a row can never be an event |
| `builder_leads` | Leads of the lead forms: pending (token hash, expiry) or confirmed. See [leads](leads.md) |
| `builder_schema` | The applied migration versions |

## What it does

1. The page calls a BFF route under `/api/builder`.
2. The BFF checks the session and the role (see the order below).
3. The BFF checks the input. A draft passes `checkContent` (`shared/sections.ts`).
4. The BFF reads or writes the database. Every query has the org id of the session: a page of another org is "not found".
5. The BFF gives the page the result. On an error it gives the status and a `code`, and `field` for a bad input.

| Route | Body | Answer |
|---|---|---|
| `GET /api/builder/pages` | | Page list |
| `POST /api/builder/pages` | `{ slug, locale, title }` | 201 page |
| `GET /api/builder/pages/{pageId}` | | Page with `draft` and `versions` (newest first) |
| `PUT /api/builder/pages/{pageId}/draft` | `{ revision, content: { title, sections } }` | Page. `draftRevision` + 1 |
| `POST /api/builder/pages/{pageId}/publish` | `{ revision }` | 201 page. The draft is the new live version |
| `POST /api/builder/pages/{pageId}/rollback` | `{ version }` | Page. That version is live again |
| `GET /api/builder/pages/{pageId}/versions/{version}` | | The content of one published version |
| `GET /api/builder/pages/{pageId}/events` | | `{ items }`: the 50 newest events of the page |
| `POST /api/builder/pages/{pageId}/unpublish` | | Page with `liveVersion` null. Every version stays |
| `DELETE /api/builder/pages/{pageId}` | `{ slug }` | 204. Owners only. `slug` must be the slug of the page |
| `POST /api/builder/pages/{pageId}/versions/{version}/copy` | `{ revision }` | Page. The draft is that version, `draftRevision` + 1. Nothing goes live |

The BFF checks in this order and stops at the first refusal:

| Step | Check | Refusal |
|---|---|---|
| 1 | Session (`AuthService.current`) | 401 `unauthenticated` |
| 2 | CSRF on PUT, POST and DELETE: `Origin` and `x-csrf-token` | 403 `csrf_failed` |
| 3 | `NUXT_BUILDER_DATABASE_URL` is set | 503 `builder_not_configured` |
| 4 | The token gives `owner` or `admin` in the session org | 403 `forbidden` |
| 5 | The org id matches `^[A-Za-z0-9_-]{1,64}$`, the subject `^[A-Za-z0-9_-]{1,128}$` | 403 `forbidden` |
| 6 | Identity confirms the stored membership (same call as the label admin, `server/lib/org-admin.ts`) | 503 `identity_not_configured`, 401, 403, 502 `upstream_unavailable` |
| 7 | The database is reachable and migrated | 503 `builder_unavailable` |

## Draft, publish, roll back

- A page has one draft. A save sends the `revision` it read. Another revision gives 409 `draft_conflict`: two editors cannot overwrite each other.
- Publish sends the draft `revision` too, so it publishes the draft the user saw. It copies the draft into the next version and makes it live. A draft equal to the live version gives 409 `no_changes`.
- Roll back makes any published version live again. It does not change the draft. The live version gives 409 `already_live`.
- "Done looks like": publish a change, roll it back, the old version shows. `tests/server/builder-api.test.ts` runs exactly this.

## Unpublish, delete, copy into draft (synthwerk#108)

- **Unpublish** clears the live version. Every version stays. The public site answers 404 for the page (within the 60 s cache of `/api/site`). Publish or roll back brings it back. A page that is not live gives 409 `not_live`.
- **Delete** removes the page with its draft and versions. Owners only (token role `owner` and the stored owner or admin membership): an admin gets 403 `owner_required`. The editor asks for the slug, and the server checks it (409 `confirm_mismatch`). The page events stay in `builder_events`: the audit trail outlives the page. Confirmed leads of the page stay with slug, locale and version; pending leads of the page are deleted.
- **Copy into draft** puts the content of a published version into the draft. It needs the draft `revision`, like a save (409 `draft_conflict`). The editor asks first when the draft has unsaved changes.

## Section catalogue

| Type | Fields | ui-vue |
|---|---|---|
| `hero` | eyebrow, headline, text (Markdown), main and second button | `SwPill`, link with `SwButton` classes |
| `proof` | title, 1 to 6 numbers with a label | Definition list |
| `benefits` | title, 1 to 6 benefits (title, text) | `SwCard` |
| `pricing` | title, 1 to 4 plans (name, price, period, up to 10 features, recommended, button) | `SwCard`, `SwPill` |
| `faq` | title, 1 to 12 questions with an answer (Markdown) | `<details>`, `SwDivider` |
| `cta` | title, text (Markdown), button | `SwCard` |
| `lead` | title, text (Markdown), name field on or off, consent text (Markdown), button label. One per page. See [leads](leads.md) | `SwCard`, `SwInput`, `SwButton` |

- Markdown subset: paragraphs, line breaks, lists (lines that start with "- "), `**bold**`, `*italic*`, `[text](link)`. Everything else is text.
- Links and buttons: `https://`, `http://`, `mailto:`, `/path` or `#anchor`. No `javascript:`, `data:`, `//host` or user info. The server refuses a bad button link. A bad Markdown link keeps its text only. At render, links also pass `safeHref()` of `@synthwerk/ui-vue`.
- `app/components/page/PageView.vue` renders a page. The editor preview uses it; the public site (#45) uses the same component.

## How to use

- Set `NUXT_BUILDER_DATABASE_URL` to a `postgres://` URL of an empty database (or a database that has the builder tables). Env only: it holds the password. Local: `postgres://studio:studio@localhost:5432/studio`.
- Set `NUXT_IDENTITY_URL` (see [users-and-audit](users-and-audit.md)).
- To send the events to the bus, set `NUXT_BUILDER_NATS_URL` (`nats://bus:4222`, no credentials in the URL), `NUXT_BUILDER_NATS_USER` and `NUXT_BUILDER_NATS_PASSWORD` (env only), and `NUXT_BUILDER_PLATFORM_ENV` (`local`, `dev`, `stg`, `prd`; `ci` sends as `local`). Empty URL: no relay; the events wait in `builder_events` and go out after a start with the URL.
- Sign in as an owner or an admin. Open **Builder** in the navigation.
- Create a page: title, slug (`/pricing`), language.
- Add sections, edit them, move them up and down. **Preview draft** shows the page as it will look.
- **Save draft**, then **Publish**. The table **Published versions** shows every version.
- **View** shows a published version. **Roll back** makes it live again. **Copy into draft** starts the draft from it.
- **Unpublish** takes the page off the public site. **Delete page** (owners) asks for the slug.

## Rules and limits

| Rule | Value |
|---|---|
| Who | Owner and admin of the org, in the token and in the stored membership |
| Pages | 50 per org. Slug `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`, unique per org and locale. Locale `de` or `en` |
| Sections | 20 per page. Section id `^[a-z0-9]{1,24}$`, unique on the page |
| Text | One-line texts 120 characters or less, no control characters. Markdown texts 2000 characters or less |
| Links | 500 characters or less |
| Body | 256 KiB or less. Read after the checks above, as a stream (`server/lib/body.ts`): the read stops with 413 as soon as the cap is passed, also for a chunked body without Content-Length |
| Logs | The error code only (`database call failed (ECONNREFUSED)`). No URL, no SQL, no page text |
| Cache | `/api/builder/**` has `Cache-Control: no-store` |
| Page | Text only, no `v-html`. Leaving the editor with unsaved changes asks first |

## Events

| Type | When |
|---|---|
| `dev.synthwerk.studio.page.created.v1` | A page is created. Data: `page_id`, `slug`, `locale` |
| `dev.synthwerk.studio.page.published.v1` | A version is published. Data: `page_id`, `slug`, `locale`, `version`, `previous_version` |
| `dev.synthwerk.studio.page.rolled_back.v1` | An older version is live again. Same data |
| `dev.synthwerk.studio.page.unpublished.v1` | The page is off the site. Data: `page_id`, `slug`, `locale`, `previous_version` |
| `dev.synthwerk.studio.page.deleted.v1` | The page is deleted. Same data as unpublished |
| `dev.synthwerk.studio.page.version_copied.v1` | A version is copied into the draft. Data: `page_id`, `slug`, `locale`, `version` |

- The schemas are in `synthwerk-contracts` (`events/studio`, tag `go/v0.12.0`). Draft saves write no event.
- The events go to `builder_events` in the transaction of the change and show in the page history.
- On the bus, `data` also holds `org_id`: the identity org UUID of the session org. `orgid` is the same; `subject` is the page id. No title and no section text.
- Identity reads them from `EVT_STUDIO` into the org audit list (synthwerk-identity `docs/features/audit-list.md`).

## Relay to the bus

- `server/plugins/builder-relay.ts` starts the relay at server start (`server/lib/builder-relay.ts`, `builder-nats.ts`).
- It applies the builder migrations, connects to NATS, and creates or updates the stream `EVT_STUDIO` (`evt.studio.>`, file storage, 30 days, duplicate window 2 min). Studio owns this stream. While the database or NATS is down, it tries again with backoff (1 s to 30 s).
- Each run takes up to 20 rows with `relayed_at` empty, in `seq` order, `FOR UPDATE SKIP LOCKED`, in one transaction. It publishes each row (`Nats-Msg-Id` = event id, `Content-Type: application/cloudevents+json`) and sets `relayed_at`. A publish error stops the run: the rows before stay marked, the rest waits for the next run.
- Delivery is at least once. A stop between the publish and the commit sends the row again with the same id: JetStream drops it in the 2 min window, identity drops it by id after that.
- The publishes run inside the transaction that holds the row locks: with the 5 s publish timeout, a slow bus keeps one transaction open 100 s at most.
- A row that can never be a valid event (no identity org id, an id that is not a UUIDv7, a bad actor) gets `relayed_at` and `relay_error`, and an ERROR log line with the event id. Rows from before the relay (migration 2) are closed that way. Such a row is never sent again by itself: to send it after a fix, set `relay_error` and `relayed_at` back to null.
- The identity org id comes from identity (`GET /v1/me`), read in the same call that confirms the stored role (`server/lib/org-admin.ts`).
- Logs: the error class only (`publish failed (NatsError)`, `database (28P01)`). No URL, no user, no password, no event data.

## Errors

| Status | Code | Cause |
|---|---|---|
| 400 | `invalid_request` | Bad slug, locale, title, revision, version or body. `field` names it |
| 400 | `invalid_content` | The draft fails the catalogue check. `field` names it, for example `sections[2].cta.href` |
| 401 | `unauthenticated` | No session, or identity refused the token |
| 403 | `csrf_failed` | Other origin, or no or wrong `x-csrf-token` |
| 403 | `forbidden` | Not owner or admin in the token or in the stored membership, or a bad org id or subject |
| 404 | `page_not_found` | No such page in this org |
| 404 | `version_not_found` | No such published version |
| 409 | `slug_taken` | The slug and locale exist in this org |
| 409 | `page_limit_reached` | The org has 50 pages |
| 409 | `draft_conflict` | The revision is not the current one |
| 409 | `no_changes` | Publish of a draft equal to the live version |
| 409 | `already_live` | Roll back to the live version |
| 403 | `owner_required` | Delete by an admin |
| 409 | `not_live` | Unpublish of a page that is not live |
| 409 | `confirm_mismatch` | Delete with a slug that is not the slug of the page |
| 413 | `payload_too_large` | Body over 256 KiB |
| 502 | `upstream_unavailable` | Identity could not confirm the membership |
| 503 | `builder_not_configured` | `NUXT_BUILDER_DATABASE_URL` is missing or not a `postgres://` URL |
| 503 | `builder_unavailable` | The database is not reachable, or a query failed |
| 503 | `identity_not_configured` | `NUXT_IDENTITY_URL` is missing or not valid |

## Tests

- `tests/shared/sections.test.ts`: the catalogue check, every refused field, the link rule, the Markdown subset. HTML stays text. Unsafe links lose the target.
- `tests/server/builder-store.test.ts`: the SQL and the migrations on PGlite (in-process Postgres).
  - Create, slug and page limits, org isolation, draft revision.
  - Publish, no changes, roll back and forward, events.
  - A failed publish rolls back. The pg pool adapter.
- `tests/server/builder-api.test.ts`: the BFF routes with the real `AuthService`, the mock OIDC provider, the fake identity and PGlite.
  - Session, CSRF, origin, member role, stale admin, identity down, bad org id.
  - Both 503 config cases. Database down: the log has no URL.
  - Inputs, the publish and roll back flow, conflicts, body limit.
- `tests/server/body.test.ts`: the body cap on the web and the Node path. A chunked body over the cap stops the read.
- `tests/server/builder-relay.test.ts`: the relay on PGlite with a fake bus.
  - Create, publish, roll back: sent once, in order, then marked; the CloudEvent shape; no page text.
  - A publish error mid-batch, a crash before the commit (same id again), batch size, a row that can never be an event, migration 2.
  - Backoff logs without secrets, the start with retries, the relay settings.
- `tests/server/builder-nats.test.ts`: opt-in against a real NATS (`BUILDER_TEST_NATS_URL`): stream create and update, a duplicate id, a subject outside `evt.studio.>` refused for the studio user.
- `tests/app/builder.test.ts`: the page texts.
- `tests/server/builder-api.test.ts` (synthwerk#108): unpublish, delete (owner, admin, slug check, event stays), copy (revision, missing version).

## Open points

- The public site reads the live version through `GET /api/site/pages/{locale}/{slug}` (synthwerk#109). See [public-site](public-site.md).
- No Postgres for the studio in the compose stack and the prd setup yet (`synthwerk-infra`).
- The three new event types need schemas in `synthwerk-contracts` before a relay sends them (synthwerk#106).
- Delete checks the owner role in the token; identity confirms owner or admin. A demoted owner keeps delete until the token expires (5 minutes).
- No Playwright e2e in this change. Add it with the local stack (synthwerk-e2e).

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version: section editor, preview, publish, roll back, page history (synthwerk#46). |
| 2026-10-30 | The relay sends `builder_events` to `EVT_STUDIO`; identity shows them in the org audit list. Migration 2: `identity_org_id`, `relay_error`; event ids are UUIDv7 (synthwerk#106). |
| 2026-10-30 | Unpublish, delete, copy a version into the draft (synthwerk#108). Lead form section (synthwerk#105). |
