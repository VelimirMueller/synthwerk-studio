---
title: Label sets per org and label admin
slug: label-admin
status: beta
epic: E5
owner: studio
paths: ["server/lib/labels.ts", "server/lib/labels-api.ts", "server/lib/vision-config.ts", "server/api/labels/**", "server/utils/labels.ts", "app/pages/labels.vue", "app/composables/useLabelsApi.ts", "app/utils/labels.ts"]
api: ["GET /api/labels", "POST /api/labels", "DELETE /api/labels/{labelId}"]
events: []
mcp: []
updated: 2026-10-30
---

# Label sets per org and label admin

> **In 30 seconds**
>
> - `/labels` shows the label set of your org: the default set or an own set, and the number of labels.
> - Owners and admins add labels and delete added labels. A label can start a new topic.
> - The first change copies the default set into an own set. The own set applies to this org only.
> - The studio BFF calls synthwerk-vision with a service token. The browser never sees the token.
> - Proves the studio part of synthwerk#44.

## What it does

1. The page calls a BFF route under `/api/labels`.
2. The BFF checks the session and the role (see the order below).
3. The BFF checks the input.
4. The BFF calls vision with `Authorization: Bearer <NUXT_VISION_ADMIN_TOKEN>`. The org id in the path is the Zitadel org id of the session (`identity.org.id`).
5. The BFF gives the page the label set or the label. On an error it gives the status and a `code` only.

| BFF route | Vision call |
|---|---|
| `GET /api/labels` | `GET /v1/orgs/{orgId}/labels` |
| `POST /api/labels` `{ name, topic, prompt?, newTopic?, topicParent? }` → 201 label | `POST /v1/orgs/{orgId}/labels` `{ name, topic, prompt, new_topic, topic_parent }` |
| `DELETE /api/labels/{labelId}` → 204 | `DELETE /v1/orgs/{orgId}/labels/{labelId}` |

Vision trusts the org id in the path. The BFF is the authorization point. It checks in this order and stops at the first refusal:

| Step | Check | Refusal |
|---|---|---|
| 1 | Session (`AuthService.current`) | 401 `unauthenticated` |
| 2 | CSRF on POST and DELETE: `Origin` and `x-csrf-token` | 403 `csrf_failed` |
| 3 | `NUXT_VISION_URL` and `NUXT_VISION_ADMIN_TOKEN` are set | 503 `vision_not_configured` |
| 4 | The token gives `owner` or `admin` in the session org | 403 `forbidden` |
| 5 | The org id matches `^[A-Za-z0-9_-]{1,64}$` | 403 `forbidden` |
| 6 | Identity confirms the stored membership: `GET /v1/me`, then `GET /v1/orgs/{uuid}/members?limit=1` with the user's access token. Identity answers only to an active stored owner or admin. | 503 `identity_not_configured`, 401 `unauthenticated`, 403 `forbidden`, 502 `upstream_unavailable` |

- Step 6 exists because token claims can be stale after a demotion or a deactivation.

## How to use

- Set `NUXT_VISION_URL` to the vision base URL. Local: `http://localhost:8000`.
- Set `NUXT_VISION_ADMIN_TOKEN` to the same value as `SYNTHWERK_VISION_ADMIN_TOKEN` in vision.
- Set `NUXT_IDENTITY_URL` (see [users-and-audit](users-and-audit.md)).
- Sign in as an owner or an admin. Open `/labels` from the navigation (Me, Apps, Users, Audit, Labels).
- Add a label: type the name, choose the topic, type a prompt if needed, select **Add label**.
- New topic: select **New topic**, type the topic name, choose the parent topic or **No parent (root)**.
- Adding a label can take up to about 30 seconds. Vision must embed the new text.
- Delete an added label: select **Delete** in its row. Packaged labels cannot be deleted.

## Rules and limits

| Rule | Value |
|---|---|
| Who | Owner and admin of the org, in the token and in the stored membership. |
| Own set | The first change copies the default set into an own set (`custom: true`). Other orgs keep their set. |
| Input checks | Before vision is called: name and topic trimmed, 1 to 80 characters. Prompt 200 characters or less, empty = none (vision uses the name). `newTopic` true or false. `topicParent` 80 characters or less, empty or null = root. Label id `^runtime:[a-z0-9-]{1,100}$`. |
| Response | The BFF keeps the contract fields only: `org_id`, `custom`, `labels`, `topics`, `total_labels`; per label `id`, `name`, `topic`, `prompt`, `path`; per topic `id`, `parent`, `depth`. |
| CSRF | POST and DELETE need `Origin` = studio origin and `x-csrf-token` = the session CSRF token. |
| Timeout | 60 s for POST, 10 s for the other vision calls. 10 s per identity call. No redirects. |
| Logs | No token, no vision `detail`, no label text. |
| Cache | `/api/labels/**` has `Cache-Control: no-store`. |
| Page | Text only, no `v-html`. Topics show as a tree in the select. The topic path shows as `a → b → c`. |
| Configuration | `NUXT_VISION_URL`, absolute `http` or `https` URL, no user info, query or fragment. `NUXT_VISION_ADMIN_TOKEN`, not empty, env only. Server side only. Missing or bad: `/api/labels` answers 503, sign-in keeps working. |

## Events

| Type | When |
|---|---|
| None. The studio emits no event. | |

## Errors

| Status | Code | Cause |
|---|---|---|
| 400 | `invalid_request` | Bad name, topic, prompt, flags, label id or body. Or vision answered 422. |
| 401 | `unauthenticated` | No session, or identity refused the token. The page starts the sign-in. |
| 403 | `csrf_failed` | Other origin, or no or wrong `x-csrf-token` |
| 403 | `forbidden` | Not owner or admin in the token or in the stored membership, or a bad org id. The page says only owners and admins can change the labels. |
| 404 | `not_found` | DELETE of a label that is not in the set |
| 409 | `label_conflict` | Vision refused the change: the label exists, a clash, an unknown topic, a packaged label, or a backend with fixed labels |
| 502 | `vision_unavailable` | Vision is not reachable, gave a bad answer, or refused the service token (401) or has admin routes off (404). The 401 and 404 cases write a warn log. |
| 502 | `upstream_unavailable` | Identity could not confirm the membership |
| 503 | `vision_unavailable` | Vision answered 503 (model not loaded) |
| 503 | `vision_not_configured` | `NUXT_VISION_URL` or `NUXT_VISION_ADMIN_TOKEN` is missing or not valid |
| 503 | `identity_not_configured` | `NUXT_IDENTITY_URL` is missing or not valid |

## Tests

- `tests/server/labels.test.ts`: the config reader, the input checks, the label reader.
- `tests/server/labels-api.test.ts`: the BFF routes with the real `AuthService`, the mock OIDC provider, the fake identity (`tests/support/identity.ts`) and the fake vision (`tests/support/vision.ts`). No session, CSRF, member role, stale admin claim, bad org id, list, add (201, snake_case body, service token), delete (204), bad input, vision 409, 422, 404, 401 (log without token), 503, down, bad answer, both 503 config cases.
- `tests/server/members.test.ts`: the `limit` query of `listMembers`.
- `tests/app/labels.test.ts`: the topic tree for the select and the topic path.

## Open points

- No corrections UI yet. Vision has `POST /v1/orgs/{org_id}/feedback`.
- No label-set-changed event yet.
- No Playwright e2e in this change. Add it with the local stack (synthwerk-e2e).

## Changes

| Date | Change |
|---|---|
| 2026-10-30 | First version: label set view, add label, new topic, delete added label (synthwerk#44). |
| 2026-10-30 | The stored-membership check (step 6) moved to `server/lib/org-admin.ts`, shared with the page builder. Same behaviour. |
