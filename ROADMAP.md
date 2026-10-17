# ROADMAP

Legend: `[ ]` not started · `[~]` partial / in progress · `[x]` complete (verified, not just written)

Rules for this file (see [AGENTS.md](AGENTS.md)):
- Update the marker **in the same change** that does the work.
- `[x]` means it was **run and verified**. Put the proof (command, screenshot, or test name) in the item's note.
- Add new items where they belong. Never delete items; strike through ~~like this~~ with a reason if dropped.
- Design details live in [DESIGN.md](DESIGN.md) (section numbers given as §n). Lessons and gotchas go into [SYSTEM.md](SYSTEM.md).

Last reviewed: 2026-10-17

---

## Progress at a glance
| Phase | Scope | Status |
|---|---|---|
| P0 | Repo cleanup and baseline | `[x]` |
| P1 | Store chart (own) + default store | `[x]` |
| P2 | WooCommerce MCP server | `[x]` |
| P3 | Gateway core + `/mcp` endpoint | `[x]` |
| P4 | Two more upstream MCP servers | `[x]` |
| P5 | Team and access (roles, invites, API keys, audit) | `[x]` |
| P6 | Chat agent | `[x]` |
| P7 | Dashboard pages | `[x]` |
| P8 | Helm and K8s completeness | `[~]` (only a real VPS run of `deploy.sh` left) |
| P9 | Docs, threat model, demo video | `[~]` |
| B  | Bonus: multi-store provisioning | `[x]` |
| P10 | Real-world additions (before the 2026-10-26 submission) | `[~]` |
| S  | Stand-out items | `[~]` (S2, S4, S6, S7, S8, S9 done; S1 VPS, S3 OAuth, S5 hosted servers open) |

---

## P0 — Repo cleanup and baseline
- [x] Commit current uncommitted work on `main` (ops scripts, port 8088 store URLs) as a checkpoint. Proof: commit `e2d8e56` on `main`; `.env.example` (Loom link) intentionally left uncommitted
- [x] Create branch `mcp-gateway`
- [x] Remove leftovers: `ForceDLT.txt`, `ns.json`, `tmp-store-ingress-patch.json`, `outputs/` (notes moved to SYSTEM.md L8/L9). Proof: commit `9b1ed9b`
- [x] Delete legacy Python `backend/` (still in git history). Proof: commit `f22cd07`
- [x] Put Stripe billing, custom domains, backups, content suggestions and Medusa behind `FEATURE_LEGACY_SAAS` (default `false`; routes return 404 `feature_disabled`; dashboard reads `GET /config` and hides the panels; code kept). Proof: `npm run check` ✓, dashboard `build` + `lint` ✓, gate verified with `app.inject()` on Fastify 4.29.1 (both flag values). Not yet run in-cluster
- [x] Make backend tests runnable: pure tests run on the host (`npm test`, SQLite suites skip with a message); everything runs in Node 20 with `bash scripts/test-backend.sh` (SYSTEM.md L13). Proof: 43/43 in the container, 2026-10-10
- [x] Move credentials out of plain Helm `env` into Secret `platform-api-env` (`envFrom` + checksum restart; SYSTEM.md L16). Proof: `kubectl get deploy platform-api` env has no `GROQ_API_KEY`/`STRIPE_SECRET_KEY`; `printenv` in the pod shows both
- [x] Remove the Loom link appended to `.env.example` (reverted, never committed)
- [x] Add `backend-node` test runner: vitest, `npm test`, 7 tests (legacy gate via `app.inject`, rate limiter)
- [x] Local cluster enforces NetworkPolicies (`minikube start --cni=calico` in ops scripts; SYSTEM.md L15). Proof: `scripts/verify-store-isolation.sh`
- [x] `.gitattributes` forces LF for scripts/charts that run in Linux containers
- [x] Fix `ops/resume.ps1` assigning the read-only `$pid` variable (stale processes were never stopped)
- [x] AGENTS.md / DESIGN.md / ROADMAP.md / SYSTEM.md created

## P1 — Store (DESIGN §7.2)
- [x] WooCommerce store provisioned on Kubernetes via Helm Job (`bitnami/wordpress` + `extraPlugins: woocommerce`) — existing reconciler
- [x] MariaDB + WordPress use PVCs (`engine.ts` persistence 2Gi/5Gi)
- [x] Per-store secrets are stable across retries (now the store chart's `lookup` + `resource-policy: keep`; the old `secrets.ts` path was removed, SYSTEM.md L4)
- [x] Storefront exposed through Ingress with a stable URL: `http://store.127.0.0.1.nip.io:8088` (default store)
- [x] **Image source decided**: own chart with official images `wordpress:7.1.3-php8.3-apache`, `wordpress:cli-2.12.0-php8.3`, `mariadb:11.4.13` (SYSTEM.md G1)
- [x] `charts/store-woocommerce`: mariadb StatefulSet (uid 999), wordpress Deployment (uid 33, sysctl for :80, volume-permissions init with CHOWN only), PVCs, Secret persisted with `lookup` + `resource-policy: keep`, Ingress, startup/readiness/liveness probes, requests/limits, NetworkPolicies. Proof: `helm lint` + `helm template` for local and prod values; fresh install 0 restarts
- [x] `store-init` hook Job (idempotent): WP install, WooCommerce 11.2.0, INR, timezone, coming-soon off, shipping off, **COD enabled**, pages, REST API key upsert, 3 seed products. Proof: `helm upgrade` rerun → "already installed", key "up to date", still 3 products, credentials hash unchanged
- [x] Default store installed by Helm as release `store-default` in namespace `store-default` from `ops/up.ps1` (always) and `ops/resume.ps1` (if missing)
- [x] Verify: storefront → add to cart → checkout with COD → order in WooCommerce. Proof: `scripts/verify-store.sh` (Store API checkout → order `processing cod 199.00 INR`). Manual browser run-through still to do before the demo (`scripts/order-checklist.md`)
- [x] Verify persistence: delete wordpress + mariadb pods → order and 3 products still there. Proof: `scripts/verify-store.sh --persistence`

## P2 — WooCommerce MCP server (DESIGN §7.1)
Live proof for the items below: woo-mcp run on the host (`node dist/server.js`) against the real default store through `kubectl -n store-default port-forward svc/store-default-wordpress 8091:80`, with credentials from Secret `store-default-credentials`, called with `npx @modelcontextprotocol/inspector@2.8.0 --cli` (2026-10-09). Unit tests: `npm --prefix mcp-servers/woo-mcp test` (21 tests) and `run check`.

- [x] Scaffold `mcp-servers/woo-mcp` (TS, `@modelcontextprotocol/sdk@1.32.1`, zod 3, Fastify, Streamable HTTP, stateless, JSON responses). Proof: `run check` ✓; `app.test.ts` "serves MCP statelessly" (no `initialize`, no `Mcp-Session-Id`)
- [x] OAuth 1.0a (HMAC-SHA256) signer for WC REST over HTTP + unit test with known vectors. Proof: `oauth1.test.ts`; vectors computed with WooCommerce 11.2's own PHP functions in the store pod; live signed calls accepted (incl. a search with spaces). Signs against the **home URL** (SYSTEM.md L18)
- [x] Tool `list_products`. Proof: live `search="Ceramic Mug"` → product 12
- [x] Tool `create_product`. Proof: live → draft product 15 "woo-mcp live test" (left as a draft, not on the storefront); bad price → validation `isError`
- [x] Tool `list_orders` (with `date: today` resolved in **store timezone**). Proof: live `date=today` → order 14 (COD, 199 INR), `date=2026-10-08` → none; `dates.test.ts` (UTC 20:00 = next day in Asia/Kolkata)
- [x] Tool `get_order`. Proof: live order 14; unknown id 99999 → `isError` "WooCommerce at … returned 404 woocommerce_rest_shop_order_invalid_id: Invalid ID."
- [x] Tool `update_order_status`. Proof: live order 14 → `processing` (unchanged status, so no data change); note path covered by `tools.test.ts`
- [x] Tool `get_store_info` (name, currency, timezone). Proof: live → "Urumi Demo Store", INR, Asia/Kolkata, today 2026-10-09
- [x] Trimmed output DTOs + `structuredContent` + `outputSchema`. Proof: `tools.test.ts` (all tools have `outputSchema` + annotations; raw `meta_data` dropped); SDK validates `structuredContent` against `outputSchema` on every live call
- [x] Bearer-token check on `/mcp` (`WOO_MCP_TOKEN` from Secret). Proof: `app.test.ts` (missing/wrong → 401 + `WWW-Authenticate`); live `curl` without token → 401. Token is the chart's existing `mcp-token` key; mounting it is part of the chart item below
- [x] `/healthz` + `/readyz` endpoints. `/readyz` = WordPress answers within 2 s (any status < 500, SYSTEM.md L11); `/healthz` = process only. Proof: `app.test.ts` "probes" (store down → healthz 200, readyz 503 with the reason); in-cluster pod Ready
- [x] Dockerfile (non-root, multi-stage). Proof: `minikube image build -t store-platform/woo-mcp:dev mcp-servers/woo-mcp`; runs as uid 10001 with `readOnlyRootFilesystem`; `ops/up.ps1` builds it and restarts the Deployment (L12)
- [x] Added to `charts/store-woocommerce`: Deployment, ClusterIP Service, **NetworkPolicy (ingress only from platform-api)**, Secret mount (`templates/woo-mcp.yaml`, `wooMcp.*` values). Proof: `helm lint` + `helm template` local and prod; `helm upgrade store-default` (rev 3) → woo-mcp 1/1 Ready, 0 restarts
- [x] Verified with MCP Inspector via `kubectl port-forward` (all 6 tools). Proof (2026-10-10): `port-forward svc/store-default-woo-mcp 3001:80` + Inspector 2.8.0 CLI → tools/list = 6; get_store_info, list_products, list_orders today, get_order 14, update_order_status (same status), create_product (draft 16) all OK; no token → 401
- [x] Verified **not reachable** from outside the cluster and from other namespaces. Proof: `bash scripts/verify-store-isolation.sh` → 12/12 PASS (woo-mcp blocked from another namespace, from its own namespace and from non-API pods in `platform`; open from the real platform-api pod; Service is ClusterIP; no Ingress backend names it)
- [x] README section: "How woo-mcp talks to the store and why (REST vs WP-CLI vs SQL)". README §6.1

## P3 — Gateway core (DESIGN §6, §7.3)
SQLite suites run in Node 20 with `bash scripts/test-backend.sh` (43 tests); on the Windows host they skip (SYSTEM.md L13) and the rest pass with `npm --prefix backend-node test` (35 passed, 8 skipped).

- [x] DB migrations: `mcp_servers`, `mcp_tools`, `api_keys`, `audit_log`, `tool_policies`, `invites`, `users.role` (+ `users.disabled_at`), additive in `db.ts` `migrateGateway`. Proof: `gateway-db.test.ts` (old DB upgraded with rows kept, idempotent, CHECKs enforced); live: API image rebuilt + `helm upgrade platform` → in-pod query shows 6/6 tables and `role,disabled_at` columns, `/healthz` 200. `users.role` is not read yet (P5)
- [x] `crypto.ts`: AES-256-GCM seal/open; key from Secret `gateway-enc-key` (chart-generated with `lookup` + `keep` locally, `existingSecret` in prod). Server id is the AAD, so a sealed credential can't be moved to another row. Proof: `gateway-crypto.test.ts`; pod env `GATEWAY_ENC_KEY` = 32 bytes
- [x] `ssrf.ts`: URL + resolved-IP validation, connect-time re-check, no redirects (unit-tested). Proof: `gateway-ssrf.test.ts` (23 tests, incl. a real server on loopback that a rebound name never reaches). Not wired into upstream calls yet: that is `upstreams.ts`
- [x] `registry.ts`: CRUD; credential write-only; slug rules. Proof: `gateway-db.test.ts` "gateway registry" (sealed in DB, absent from public view, SSRF on create/update, immutable slug, no `__`, Helm-managed rows can't be deleted)
Live proof for the items below (2026-10-10): API image rebuilt, `helm upgrade platform`; test user `tester-b@example.com` (signup via API, key minted with `dist/gateway/keys.js` in the pod until the P5 key routes exist); Inspector 2.8.0 CLI against `http://api.127.0.0.1.nip.io:8088/mcp`. Integration suite: `gateway-core.test.ts` (14 tests) in `bash scripts/test-backend.sh` → 57/57.

- [x] REST: `GET/POST/PATCH/DELETE /api/servers`, `POST /api/servers/:id/test` (admin only; [gateway/routes.ts](backend-node/src/gateway/routes.ts)). Proof (live): member GET → names/status/tool names only (no URL, no auth fields); member POST → 403 "only admins can manage MCP servers"; no session → 401. Admin write paths covered by registry tests; admin = `ADMIN_EMAILS` or `X-API-Key` until P5
- [x] `upstreams.ts`: client pool, credential injection, per-call timeout, bulkhead, error classification. Proof: `gateway-core.test.ts` (upstream sees `Bearer ok-upstream-token`; timeout → "Upstream 'slow' timed out after 1000 ms"; dead → "is unreachable: ECONNREFUSED"); uses the SSRF-guarded fetch in production (`server.ts`)
- [x] `health.ts`: periodic probe, **exponential backoff + jitter**, catalog refresh, status Connected/Unreachable/Disabled with human-readable `last_error`. Proof (live): `kubectl scale store-default-woo-mcp --replicas=0` → `Unreachable`, `last_error` "Upstream 'woo' is unreachable: ECONNREFUSED"; scaled back → `Connected` after 3 failed probes (15 s → 30 s → 60 s), failures reset to 0. Test "backoff doubles per failure up to the cap"
- [x] `catalog.ts`: prefixed (`slug__tool`), filtered, sorted, 64-char-safe names. Proof: test "tools/list: prefixed, sorted, sanitized…" (zero-width char stripped, `[Server]` label); live: the 6 tools disappear 60 s (grace) after woo-mcp is killed
- [x] `policy.ts`: role × tool_policies. Proof: test "…a policy-denied tool looks the same but is audited as denied" (hidden for member, visible for admin)
- [x] `audit.ts`: append-only writes on **every** call outcome. Proof: test "every call above wrote exactly one audit row" (ok, timeout, tool_error, bad_request, not_found, denied, unreachable); live: 5 calls → 5 rows under `tester-b@example.com`, source `mcp`
- [x] `mcpEndpoint.ts`: `POST /mcp`, stateless SDK server, API-key auth, Origin check, 401 + `WWW-Authenticate`. Proof (live): no key → 401; key → tools/list = 6 `woo__*`; `woo__get_store_info` and `woo__list_orders date=2026-10-09` (order 14) OK; `order_id:"abc"` → "Gateway: invalid arguments: data/order_id must be integer"; `nope__x` → JSON-RPC -32602 "Unknown tool". Tests: foreign Origin → 403; revoked key → 401 on the next request
- [x] Seed default upstreams from `GATEWAY_SEED_SERVERS` (idempotent upsert, `managed_by=helm`). Credential referenced by Secret `store-default/store-default-credentials:mcp-token`, read through the K8s API (DESIGN §10.1). Proof (live): log `{"slug":"woo","result":"created"}`, status Connected, 6 tools cached
- [x] Integration test: 3 fake upstreams (ok / slow / dead) → list works, calls route, timeout message clear, audit rows present. Proof: `backend-node/test/gateway-core.test.ts` (14 tests, real HTTP MCP servers, SSRF guard on)
- [x] Ingress for `/mcp` with buffering off + long read timeout (`templates/api-mcp-ingress.yaml`, annotations in `gateway.mcpIngress`). Proof: `helm lint`/`template` local + prod; live calls above went through ingress-nginx at `api.127.0.0.1.nip.io:8088/mcp`

## P4 — Two more upstream servers (DESIGN §4.1)
- [x] `notes-mcp` (ours): `add_note`, `list_notes`, `search_notes`; SQLite on PVC; requires bearer token (`mcp-servers/notes-mcp`, Node 22 built-in `node:sqlite`). Proof: `npm --prefix mcp-servers/notes-mcp test` (6 tests: 401 without token, tools + outputSchema, tag filter, literal `%`/`_` search, probes); live via gateway (below)
- [x] `everything-mcp`: official reference server in Streamable HTTP mode, pinned version (`@modelcontextprotocol/server-everything@2026.8.31` with lockfile, `mcp-servers/everything-mcp`). Proof: seeded → Connected, 13 tools; `everything__echo` via gateway → "Echo: hello from the gateway"
- [x] `charts/mcp-upstreams` with probes, resources, NetworkPolicies (release `upstreams`, ns `mcp-servers`; `ops/up.ps1` installs it after the store). Proof: `helm lint` + `template` local and prod; both pods 1/1, 0 restarts, PVC Bound; `verify-store-isolation.sh` 5 new checks PASS (blocked from another ns, from a neighbour in `mcp-servers`, from non-API pods in `platform`; open from platform-api)
- [x] Cross-server prompt designed and verified, e.g. *"List today's orders and save a follow-up note for each customer"* (woo + notes). Proof (live, chat agent, 2026-10-10): the prompt → `woo__list_orders {"date":"today"}` → `notes__add_note` "Follow-up for order #17" tags `follow-up,order-17`, 2 rounds, 2.9 s; both audited under `admin-a`, source `chat`. Same chain earlier through `/mcp` with a member key
- [x] Collision demo: two servers exposing the same tool name (e.g. two stores' `list_orders`) are both visible and route correctly. Proof (live): admin registered the same store again as `shop2` → member's tools/list shows `shop2__list_orders` and `woo__list_orders`; both calls OK; audit rows carry `server_slug` `shop2` and `woo` respectively; demo entry deleted afterwards. Unit: `gateway-core.test.ts` `ok__echo` / `slow__echo`

## P5 — Team and access (DESIGN §8.1–8.2)
- [x] Email/password signup + login with scrypt hashing and session tokens (`auth.ts`)
P5 proof (2026-10-10): `team.test.ts` (11 tests) in `bash scripts/test-backend.sh` → 68/68; live on the cluster DB (which had one member and no admin) with `curl` against `api.127.0.0.1.nip.io:8088`. Owner approved implementing DESIGN §8.1 as written (Rule 8).

- [x] Roles: persistent `users.role` is the source of truth (`team/members.ts`); `ADMIN_EMAILS` still promotes and now stores it; gateway reads the role per request. Proof: test "ADMIN_EMAILS promotes and stores the role"; live members list `admin-a:admin`, `tester-b:member`
- [x] First user becomes admin; open signup disabled afterwards (`AUTH_OPEN_SIGNUP` env, default `"false"`). Rule is "no active admin yet → next signup is admin", which also fixes installs upgraded from the ADMIN_EMAILS era. Proof (live): `admin-a` signup → `role=admin`; next signup → 403 `signup_closed`
- [x] Invites: admin creates invite (email, role) → link → accept + set password (`team/invites.ts`; token SHA-256, 7 days, single use). Proof (live): invite `member-c` → link → accepted as member; tests: reuse → 400, member can't invite → 403, existing email → 409
- [x] Admin can change roles / disable users (`GET/PATCH /api/members`). Last active admin can't be demoted or disabled (409). Disabling deletes sessions, blocks login and kills API keys. Proof: tests "refuses to demote or disable the last active admin", "disabling a member logs them out…"; live member → `/api/members` 403
- [x] API keys: create (shown once), list, revoke; stored as SHA-256; `last_used_at` (`GET/POST/DELETE /api/keys`, `?all=1` for admins). Proof: test "API keys: shown once, listed without secret, revoked by owner, invisible to other members", "an admin can revoke anyone's key"; live B created key `eba8b338`
- [x] Revoked key rejected on the **next** request (test). Proof (live): B's key HTTP 200 → `DELETE /api/keys/:id` → next `/mcp` call HTTP 401 "missing, invalid or revoked API key"; tests in `team.test.ts` and `gateway-core.test.ts`
- [x] Audit log API with filters; members see own rows, admins see all (`GET /api/audit?user=&server=&tool=&outcome=&source=&from=&to=&limit=&before_id=`). Proof: test "audit API: members see only their own rows even if they ask for others…" (args redacted, paging by `before_id`, bad filter → 400); live `?source=chat&limit=3` → newest 3 chat rows + `next_before_id`, no session → 401
- [x] Per-API-key limit on `/mcp` (token bucket per key, after auth: burst `MCP_KEY_RATE_LIMIT_CAPACITY`=120, refill 2/s; 429 + `Retry-After`). Per-IP limits (`ratelimit.ts`) stay for everything else. Proof: test "rate-limits per API key: another key is unaffected"

## P6 — Chat agent (DESIGN §7.4)
P6 proof (2026-10-10): `chat.test.ts` (9 tests, host) + full suite 79/79 in Node 20; live against Groq `openai/gpt-oss-120b` (checked present in `/models` first, SYSTEM.md G3) as `admin-a` through ingress `api.127.0.0.1.nip.io:8088/api/chat`.

- [x] Default model switched: `ai.ts` and the chat use `LLM_MODEL` (values: `openai/gpt-oss-120b`); `llama-3.1-70b-versatile` removed
- [x] Generic OpenAI-compatible client with `tools` / `tool_calls` support (`chat/llm.ts`; retries 429/5xx with capped exponential backoff + jitter). Proof: tests "retries 429 with backoff…", "errors name the provider and status but never contain the key"
- [x] LLM key from a Secret; base URL, model, timeout in values (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_TIMEOUT_MS`, `CHAT_TIMEZONE`). *Design change:* the key is `LLM_API_KEY` (or the existing `GROQ_API_KEY`) in Secret `platform-api-env`, not a separate `llm-credentials` Secret (DESIGN §7.4 says why). No key → `/api/chat` 503 with the reason
- [x] Tool loop (≤ 8 rounds, 120 s budget, ≤ 4 parallel), calls `GatewayCore.callTool(user, …, source='chat')` (`chat/agent.ts`). Proof: tests "calls the tool as the logged-in user with source=chat…", "stops after 8 tool rounds…", "runs at most 4 tool calls at once", bad JSON / unknown tool → error fed back to the model
- [x] System prompt: current date/time, timezone, untrusted-tool-output rule; browser can't send system/tool messages. Proof: tests "system prompt carries date/time in the store timezone…", "drops system/tool messages sent by the browser"
- [x] SSE stream of tool_call / tool_result / message events (`POST /api/chat`, `text/event-stream`; `/api/chat` added to the no-buffering Ingress). Proof (live): HTTP 200 `text/event-stream`, events `tool_call → tool_result → message → done`
- [x] Verified: "create product X for 499" → visible on storefront; audit row under user A. Proof (live): "Create a product called Linen Shirt priced 499 rupees." → `woo__create_product` → product 18; public Store API search returns `18 Linen Shirt 499 INR`, product page HTTP 200; audit `admin-a@example.com chat woo__create_product ok`
- [x] Verified: "what orders came in today?" returns the hand-placed order. Proof (live): `woo__list_orders {"date":"today"}` → order 17 (COD, 199 INR, 2026-10-10 Asia/Kolkata), answer names it

## P7 — Dashboard (DESIGN §7.6)
P7 status: every page is built (`dashboard/src/pages/*`, DESIGN §7.6 "As built"); `npm --prefix dashboard run build` + `lint` pass. Each page's API calls were run live through the in-cluster dashboard (proof per item), and the owner clicked through every page in the browser as admin and member (2026-10-11).

- [x] React + Vite dashboard with login/signup and session restore; now also invite acceptance (`?invite=<token>` → name + password)
- [x] Stores page: the existing store UI moved unchanged into `pages/Stores.tsx` behind the nav
- [x] Navigation shell: Servers · Chat · API keys · Audit · Members (admin only) · Stores · Connect; hash routing (`#/audit`); any 401 returns to login
- [x] Servers page: status pills, last error + failed probes, latency, last check/OK, tools list (expand), add/edit/disable/delete, test connection; members get names + tools only. API proof (2026-10-10, in-cluster dashboard at `dashboard.127.0.0.1.nip.io`, every call through its nginx `/api` proxy with admin `admin-a` and member `tester-b` sessions): admin list has URLs + 22 tools, member list keys are only `id,slug,name,enabled,status,tools`; test `woo` → ok; delete Helm-managed `woo` → 403 "disable it instead"; disable `notes` → a key's tools/list 22 → 19, re-enable + test → 22
- [x] Members page: invite (link shown once), pending invites + revoke, role change, disable/enable. API proof (2026-10-10, in-cluster dashboard at `dashboard.127.0.0.1.nip.io`, every call through its nginx `/api` proxy with admin `admin-a` and member `tester-b` sessions): invite link `http://dashboard.127.0.0.1.nip.io:8088/?invite=…` → accepted as member, reuse → 400; disable → login 401; demote last admin → 409 message shown; member → 403
- [x] API keys page: create (copy-once modal + ready `claude mcp add` command), list (admins: everyone's), revoke. API proof (2026-10-10, in-cluster dashboard at `dashboard.127.0.0.1.nip.io`, every call through its nginx `/api` proxy with admin `admin-a` and member `tester-b` sessions): member key created, absent from the list response, 22 tools via `/mcp`, admin revokes it → next `/mcp` call 401
- [x] Audit page: filters (user for admins, server, tool, outcome, source, from/to), 5 s auto-refresh, "Load older" by `before_id`, row details (error, redacted args). API proof (2026-10-10, in-cluster dashboard at `dashboard.127.0.0.1.nip.io`, every call through its nginx `/api` proxy with admin `admin-a` and member `tester-b` sessions): member asking for `user=admin-a` still gets only own rows; admin `server=woo&source=mcp` + `next_before_id` paging
- [x] Chat page: messages + collapsible tool-call cards, Stop button, history kept while switching pages. API proof (2026-10-10, in-cluster dashboard at `dashboard.127.0.0.1.nip.io`, every call through its nginx `/api` proxy with admin `admin-a` and member `tester-b` sessions): "What orders came in today?" streamed through both nginx proxies as separate SSE events `tool_call → tool_result (167 ms) → message → done`
- [x] Connect page: gateway URL from `GET /config` (`GATEWAY_PUBLIC_URL`) + Claude Code / Cursor / Inspector / curl snippets. Proof: `/api/config` → `{"gateway":{"url":"http://api.127.0.0.1.nip.io:8088/mcp"}}`
- [x] Hide legacy SaaS panels behind the feature flag (done in P0)

## P8 — Helm and Kubernetes completeness (DESIGN §10)
- [x] `charts/platform` with `values.yaml`, `values-local.yaml`, `values-prod.yaml`
- [x] platform-api: readiness + liveness probes, requests/limits, non-root, seccomp, dropped caps
- [x] Platform API persistence via PVC
- [x] Scoped RBAC ClusterRole for the reconciler (no wildcards)
- [x] Dashboard Deployment fixed: `nginx-unprivileged` (uid 101, port 8080), readiness + liveness on `/healthz`, requests 20m/32Mi + limit 128Mi, read-only root FS, no SA token; all dashboard templates honour `dashboard.enabled`; `up.ps1` builds the image and restarts API + dashboard after a rebuild (L12). Proof: `helm lint` + `template` local and prod; `--set dashboard.enabled=false` renders no dashboard objects; live `ops/up.ps1` → pod 1/1, `id` = uid 101, `touch /etc/x` → read-only, no `/var/run/secrets/kubernetes.io`
- [x] Dashboard served in-cluster behind Ingress at `dashboard.<domain>`, with `/api` proxied to platform-api by the dashboard's nginx (same origin, no CORS). *Design change:* the gateway stays at `api.<domain>/mcp` (DESIGN §10.2.1 says why). Proof: `http://dashboard.127.0.0.1.nip.io:8088/` 200, deep link 200 (SPA fallback), `/api/config` 200, chat SSE streamed through it
- [x] Every workload has readiness + liveness + requests/limits (checklist table in DESIGN §10.2). Proof: rendered all three charts (local + prod) and checked every Deployment/StatefulSet: readiness + liveness + requests + memory limit on all; the store-init Job has requests/limits (no probes: it is a Job)
- [x] All credentials in Secrets; `existingSecret` support for prod; chart-generated with `lookup` for local. Proof (2026-10-11 audit): no credential-like key in any `values*.yaml`; every credential reaches pods via `secretKeyRef`/`envFrom`; local Secrets chart-generated with `lookup` + `resource-policy: keep` (gateway key, store, upstreams) or from `.env.local` by ops (`platform-api-env`); prod sets `existingSecret` for all four, and `deploy.sh` refuses to run until they exist; `git grep` finds no key/token literals
- [x] Default-deny NetworkPolicies (ingress **and egress**) in `platform`, `store-default`, `mcp-servers` with explicit allows (DESIGN §10.2.2). Proof: `bash scripts/verify-store-isolation.sh` 36/36 PASS (2026-10-11), including egress negatives (woo-mcp -> DB/internet/notes blocked, upstreams can't call out at all, dashboard only reaches the API, platform-api -> 169.254.169.254 blocked) and positives (platform-api -> K8s API and public 443, WordPress -> its DB and internet); `bash scripts/dod.sh` 16/16 PASS (2026-10-11, admin-a + tester-b) under the policies
- [x] `automountServiceAccountToken: false` on all pods that don't need it. Proof: rendered charts: every pod sets it except platform-api (reconciler needs the API); dashboard pod has no `/var/run/secrets/kubernetes.io`
- [x] `ops/up.ps1` installs all releases in order; `scripts/deploy.sh` for VPS, **run for real on k3s** (k3d, 2026-10-11): `scripts/k3d-prod-test.sh` builds/imports images, fills values-prod.yaml like an operator (domain, images), creates the Secrets the preflight lists, runs `deploy.sh` unchanged → all 6 releases deployed on Traefik + local-path; then `dod.sh` 19/19 (HTTPS hosts via Traefik, gateway seeded from Secrets, admin + invited member) and `verify-store-isolation.sh` 40/40 on k3s (after fixing the test harness, SYSTEM.md L44). Earlier note: `up.ps1` does (platform, store, upstreams; run 2026-10-10). `scripts/deploy.sh` written: same order, `--atomic`, refuses placeholder domains and lists missing Secrets with the command to create each (both checks run against minikube, nothing installed). Not yet run on a real k3s VPS (S1)
- [x] `helm lint` + `helm template` pass for local and prod values (all three charts). Proof: `helm lint` + `helm template` with `values.yaml` + `values-local.yaml` and + `values-prod.yaml` for platform, store-woocommerce, mcp-upstreams: 6/6 pass (2026-10-11)
- [x] Local domain approach documented (nip.io + port-forward 8088 on Windows/minikube). README §3.1 (nip.io, why port-forward 8088, port in every URL, offline fallback)
- [x] CI on GitHub Actions (`.github/workflows/ci.yml`): backend typecheck + all tests (SQLite suites run on Linux), woo-mcp/notes-mcp (Node 20/22), dashboard lint + build, `helm lint` + `template` for 3 charts x local/prod, shell syntax + no CRLF, every Dockerfile built (not pushed). Proof: first GitHub run 38129313617 on `mcp-gateway` (2026-10-11): all 12 jobs green in 58 s, backend 11/11 test files incl. SQLite suites

## P9 — Docs and demo (deliverables)
- [x] STORE_PLATFORM_FULL_GUIDE.md (easy-language guide to the existing platform)
- [x] DESIGN.md with research, architecture, threat model
- [x] README rewrite: run locally, local domains, use it (sign up, invite, connect Claude Code, chat, place an order, stores), verify, VPS deploy + rollback, woo-mcp design, troubleshooting, repo map. Every command in it was run in this setup (2026-10-11)
- [x] SYSTEM_DESIGN.md → short "System design and tradeoffs" note (aggregation, routing, failure handling, prod changes). [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md), every claim checked against the code
- [x] THREAT_MODEL.md short note (from DESIGN §9). [THREAT_MODEL.md](THREAT_MODEL.md): built controls only, known gaps listed separately
- [x] "Bonus and stand-out items implemented, and where to find them" list in README (§6), incl. what is not built
- [x] `scripts/dod.sh` automated definition-of-done checks. Proof: `bash scripts/dod.sh` 16/16 PASS (2026-10-11, admin-a + tester-b): storefront COD order, B's tools/list = every enabled server, B's orders today, B uses two upstreams, A's chat creates a product (on storefront) and finds today's order, disable -> tools gone, kill pod -> Unreachable while woo works, revoke -> 401, audit rows per user
- [x] Recording runbook [DEMO.md](DEMO.md) (scenes mapped to the brief's video list) + `scripts/preflight.sh` (read-only, 17 checks). Proof: preflight 17/17 PASS (2026-10-13); with a wrong API URL it fails with the port-forward hint and exits 1
- [ ] Demo video recorded (two users, full DoD flow, K8s walkthrough, MCP internals, security, chat loop, local→VPS, upgrade/rollback)
- [ ] Submitted via form

### Definition-of-done tracker (must all be `[x]` before recording)
- [x] Storefront checkout with COD; order visible in WC admin. Proof: `bash scripts/dod.sh` 16/16 PASS (2026-10-11, admin-a + tester-b) (Store API checkout -> order in WooCommerce); owner's browser checkout (2026-10-11)
- [x] User A (chat): create product → visible on storefront (2026-10-10: Linen Shirt, product 18, Store API + product page)
- [x] User A (chat): "orders today" returns the hand-placed order (order 17). Note: order placed by `verify-store.sh`; repeat with a browser order before recording (`scripts/order-checklist.md`)
- [x] User B (Claude Code/Cursor/Inspector): sees tools of every enabled server using only URL + key. Proof: owner in Claude Code `/mcp` (2026-10-11); `bash scripts/dod.sh` 16/16 PASS (2026-10-11, admin-a + tester-b)
- [x] User B: same orders question works. Proof: owner in Claude Code (2026-10-11); `bash scripts/dod.sh` 16/16 PASS (2026-10-11, admin-a + tester-b) (`woo__list_orders` today includes the new order)
- [x] User B: one prompt that uses tools from two different upstreams. Proof: owner's two-upstream prompt in Claude Code (2026-10-11); `dod.sh` checks the same key calls `woo__*` and `notes__*`
- [x] Revoke B's key → next call rejected (2026-10-10: HTTP 200 → revoke → HTTP 401 on the next `/mcp` call)
- [x] Disable an upstream → its tools disappear from chat and the external client. Proof: `bash scripts/dod.sh` 16/16 PASS (2026-10-11, admin-a + tester-b) (`notes` disabled → B's tools/list = everything,woo); owner saw it in the dashboard (2026-10-11). The chat builds its tool list with the same `GatewayCore.listTools`
- [x] Kill an upstream pod → others keep working; dashboard shows it Unreachable. Proof: `bash scripts/dod.sh` 16/16 PASS (2026-10-11, admin-a + tester-b) (`notes-mcp` scaled to 0 → Unreachable "timed out after 3000 ms" (SYSTEM.md L30), `woo` still answers, back → Connected); owner saw the Unreachable pill (2026-10-11)
- [x] Every call above appears in the audit log under the right user. Proof: `bash scripts/dod.sh` 16/16 PASS (2026-10-11, admin-a + tester-b) (B's mcp rows and A's chat rows found under the right emails)

## B — Bonus: multi-store provisioning (DESIGN §11)
- [x] Create/delete stores from the dashboard; list with status (Provisioning/Ready/Failed), URL, created time
- [x] Namespace per store with its own DB, Secrets, PVCs, Ingress host
- [x] ResourceQuota + LimitRange per store namespace
- [x] Provisioning timeout (Helm job 20 min) and retry with exponential backoff (max 5)
- [x] Leader lock + per-store lease, so concurrent provisioning is safe
- [x] Clean teardown: Helm uninstall → delete namespace → wait until gone → delete row
- [x] NetworkPolicy per store tightened: namespace-wide default-deny + DNS + API-server egress for the Helm job only (provisioner), plus the chart's per-workload policies (same as store-default). Proof: `NS=store-550560c1 REL=wc-550560c1 OTHER_ID=c6f26425 bash scripts/verify-store-isolation.sh` 43/43 PASS, incl. 7 store-to-store checks (A's woo-mcp/WordPress -> B's WordPress/DB/woo-mcp blocked, B -> A blocked, gateway -> B's woo-mcp open)
- [x] Max stores enforced per **user** (`POST /stores` counts `stores.user_id` in Provisioning/Ready; `MAX_STORES` 3, local 50). The ROADMAP note "per IP" was out of date: the per-IP part is only the create rate limiter
- [x] Reconciler installs our `charts/store-woocommerce`, baked into image `store-chart` (alpine/helm + chart at /chart; non-root, read-only FS). Proof (2026-10-11, live): stores `550560c1` "Anku Shop" and `c6f26425` "Bharat Bazaar" created through the API as admin; both storefronts answer and take a COD order (`verify-store.sh` with `NS`/`REL`/`HOST_NAME`). Found and fixed on the way: LimitRange default dropped (SYSTEM.md L32), readiness check following a redirect (L33)
- [x] Each store gets its own woo-mcp, auto-registered as `store_<id>` after Ready (`gateway/storeServers.ts`, event `mcp_registered`). Proof: `store_550560c1` Connected with 6 tools, `store_550560c1__get_store_info` via `/mcp` → "Anku Shop"; tests `store-servers.test.ts` (8: idempotent re-register, no slug takeover, missing token, FK order)
- [x] Delete removes MCP registration first. Proof (live): tools/list prefixes before `everything,notes,store_550560c1,store_c6f26425,woo` → right after `DELETE /stores/550560c1`: `everything,notes,store_c6f26425,woo`; server row gone at once; namespace gone after 51 s, then the store row
- [x] Restart platform-api mid-provisioning → store completes. Proof (live): `rollout restart` while `helm-install-c6f26425` was running → new pod reclaimed after the 60 s lease, event `helm_job_attached`, release history one `deployed` revision, Ready + `mcp_registered`. Restart safety fixes in SYSTEM.md L34
- [x] Demo: chat compares today's orders across two stores; delete one; its tools and namespace are gone. Proof (live): "Compare today's orders in Anku Shop and Bharat Bazaar" → `store_550560c1__list_orders` + `store_c6f26425__list_orders` → "1 order, 199 INR vs 2 orders, 398 INR" (correct); deletion as above

## P10 — Real-world additions (plan agreed 2026-10-11; feature freeze 2026-10-22, submit by 2026-10-26)
Not required by the assignment; they make the platform closer to something a real team would run. Order agreed with the owner.

- [x] CI on GitHub Actions (details in P8). Proof: run 38129313617, all 12 jobs green
- [x] Human approval for risky tool calls in the chat (owner approved, Rule 8). The agent shows an approval card (tool, arguments, reason) and waits for Approve/Decline before any tool that isn't read-only (`CHAT_APPROVAL=writes|destructive|off`); in search mode the real tool behind `gateway__call_tool` decides. Decline or no answer in 60 s: the tool never runs, the model is told, and the call is audited as `denied` with the reason. External MCP clients are unaffected (they confirm with their own user). `chat/approval.ts`, `chat/agent.ts`, `POST /api/chat/approvals/:id` (only the asking user; else 404), Chat page card. Proof: `chat.test.ts` (6 new: approve, decline, timeout, read-only runs directly, only the owner can answer, rules), `gateway-core.test.ts` "P10…"; live: create_product → asked → approved → product 30 created; update_order_status(26, cancelled) → asked → declined → order 26 still `processing`, audit `denied … declined by the user in the chat`; answering twice → 404; `dod.sh` now checks the approval (19/19)
- [x] Postgres instead of SQLite, then 2 API replicas (owner approved 2026-10-15, "if it harms the project, roll back"). Async `Db` layer over SQLite and Postgres (same SQL; DESIGN §13.3 as built), `postgres` StatefulSet + NetworkPolicy + generated/existing Secret, `DATABASE_URL` from `secretKeyRef`, API `RollingUpdate maxUnavailable 0` + PDB, chat approvals in the database, leader-only probing/seeding, team lock for first-admin/last-admin/invites, lease owner per pod (SYSTEM.md L50–L54), nightly `pg_dump`. Proof: backend 118 tests on SQLite and 118 on Postgres (`test-backend.sh [--postgres]`, CI job `backend-postgres`), incl. "five first signups → one admin" and "approve on the other pod"; live (minikube): init container copied users 5 / keys 19 / servers 4 / stores 1 / tools 34 / policies 4 / audit 92 (= SQLite backup), the second replica skipped; `dod.sh` 19/19 with 2 replicas; chat stream on one pod, Approve on the other; leader pod deleted under load → 60/60 `/mcp` calls OK, new leader 20 s later; rolling restart of both replicas → 43/43 calls OK; Postgres pod deleted under load → 2 calls failed, recovered after 9 s, 0 API restarts (after fixing L56); `pg_dump` uploaded and restored into a scratch DB with equal counts; isolation 46/46 (6 new Postgres checks). k3s production values (fresh install, no SQLite volume): 2 replicas + PDB on Postgres, `dod.sh` 19/19. Way back: `postgres.enabled: false`, `api.replicas: 1` (the SQLite volume is kept)
- [x] Production values now enable the nightly platform-database backup (it was only on locally: production users, keys and audit had no backup). Found by the k3s isolation run; proof: k3s backup job uploaded `platform/Thu.dump`
- [~] VPS + HTTPS (S1). Production path proven on k3s with `scripts/k3d-prod-test.sh` (deploy.sh, prod values, dod 19/19, isolation 40/40); CI publishes images to GHCR on a version tag. Still needs a real VPS + domain for public HTTPS (cert-manager)
- [x] Prometheus + Grafana dashboard + alerts (owner approved, 2026-10-11). `charts/monitoring` wraps `kube-prometheus-stack` 92.2.0 (pinned, trimmed for one node) and adds a ServiceMonitor for platform-api:9464, 4 alert rules (MCPUpstreamDown, MCPToolErrorRateHigh, MCPToolLatencyHigh, StoreProvisioningFailed) and the "MCP Gateway" Grafana dashboard (JSON in the repo). Grafana at `grafana.127.0.0.1.nip.io:8088`. In `up.ps1`, `deploy.sh`, CI. Proof (live): target `serviceMonitor/monitoring/platform-api/0` up through the NetworkPolicy, `mcp_upstream_up` for all 4 servers, dashboard loaded; `notes-mcp` scaled to 0 → `MCPUpstreamDown{server=notes}` pending at 84 s, firing at 146 s, resolved 176 s after restore
- [x] Backups + restore drill (owner approved in-cluster object storage; MinIO's images are gone, Garage chosen instead, 2026-10-11). `charts/backups`: Garage v1.3.0 (S3-compatible, non-root, PVC, default-deny; S3 only from pods labelled `store-platform/backup-client`, admin API only from its idempotent bootstrap job). Nightly CronJobs: every store (`mariadb-dump`) and the platform DB (online SQLite backup), uploaded with curl `--aws-sigv4`, kept 7 days by weekday names. The provisioner gives each new store its own key and bucket (next item; `backup_enabled` event). `scripts/restore-drill.sh` restores the latest dump into a scratch namespace and compares counts. Proof (live): default store 50 KB + platform DB uploaded; drill on store-default: 10 orders / 13 products = live; Bharat Bazaar re-provisioned with backup, drill: 2 / 4 = live; isolation +3 checks (40/40)
- [x] Per-store backup key and bucket (closes the THREAT_MODEL shared-key gap for provisioned stores). `backend-node/src/backupStore.ts`: the provisioner creates key + bucket `store-<id>` through Garage's admin API (idempotent: reuses a key found by name), writes the store's `backup-s3` Secret, and revokes the key on delete (bucket kept). Admin port 3903 opened only to platform-api. Proof: `backup-store.test.ts` 5/5; live: store c6f26425's key → own bucket 200, shared `backups` read 403 / write 403; temp store 60bb7e11 created → key + bucket, deleted → key gone, bucket kept. Residual: store-default + platform DB still share the bootstrap key
- [x] `BackupMissing` alert (no successful `*-backup` CronJob for 26 h), after one night's backups silently never started (SYSTEM.md L46). Proof: rule loaded and healthy in Prometheus; ages at check 0.9 h / 0.7 h / 0.9 h
- [x] kubeconform in CI: every chart × local/prod rendered and validated against Kubernetes 1.31 schemas + the CRDs catalog, `-strict`, no skips. Proof: GitHub run 38453511750 (`mcp-gateway`, b3f617b) Helm job green, all 12 jobs green; locally 343/343 valid after the Postgres templates
- [x] Audit log CSV export: `GET /api/audit.csv` (same filters and member scoping as `/api/audit`, newest 10 000 rows, `X-Audit-Truncated`, formula-injection guard) + **Export CSV** button on the Audit page. Proof: `audit-csv.test.ts` 3/3, `team.test.ts` "audit CSV export…"; live: member asking for all → only their own 46 rows, admin `outcome=denied` → 11 rows, no session → 401; CORS exposes the file name (SYSTEM.md L49)
- [x] Merchant tools in woo-mcp: `sales_summary(from, to)` (orders, revenue in cents, average, by status, top 5 products; capped at 10 pages, says so), `list_low_stock(threshold)`, `create_refund(order_id, amount, reason)` (destructive: admin-only by default and asks for approval in the chat). Proof: woo-mcp tests 27/27 (5 new); live: both stores expose 9 tools, member sees the two read tools but not `create_refund`; chat "sales today" → `woo__sales_summary` (8 orders, ₹3,792, no approval); "refund 1 rupee on order 34" → approval card → approved → refund 36 (₹1.00)

## S — Stand-out items
### S1 VPS deployment
- [x] `scripts/k3s-install.sh` (k3s + helm; no ingress-nginx, Traefik is built in) and `scripts/deploy.sh`; `values-prod.yaml` on Traefik. Placeholder domain until a VPS exists
- [x] Switch prod ingress class to `traefik` (ingress-nginx EOL). Verified on k3s: every Ingress (dashboard, api, /mcp, store, grafana) served by Traefik over HTTP and HTTPS. Earlier note: Done in values: platform `values-prod.yaml` now uses `traefik` like the store chart, NetworkPolicies allow kube-system, `k3s-install.sh` no longer installs ingress-nginx. Proof: `helm template` prod. Not yet run on k3s
- [~] cert-manager + Let's Encrypt. `charts/cert-manager` (jetstack v1.21.2 pinned, requests + memory limits, ClusterIssuer `platform-tls` as a post-install hook), installed first by `deploy.sh`; one TLS Secret per host, issuer annotation only on the Ingress that owns the host; HTTP-01 solver NetworkPolicy in platform and store charts (SYSTEM.md L58); in CI (lint, render, kubeconform). Proof (k3d, 2026-10-17, issuer switched to `selfSigned` by `k3d-prod-test.sh`): `deploy.sh` installed cert-manager with --atomic, `platform-tls` Ready, Certificates `platform-api-tls`, `platform-dashboard-tls`, `store-default-tls` READY True within 20 s; a rerun upgraded cert-manager, platform, store, upstreams, backups in place. Not verified: Let's Encrypt over HTTP-01 and the solver policy (needs public DNS, i.e. the VPS), and Grafana's certificate: the monitoring release timed out in all three runs because the laptop stalled with minikube running alongside (node `Ready` re-set, every probe timing out). Rerun `k3d-prod-test.sh` with minikube stopped
- [ ] Deployed and demoed on a real VPS (needs a VPS + domain). The same production path is proven on k3s locally (`scripts/k3d-prod-test.sh`); images reach a VPS through the CI `images` job, which pushes to GHCR on a `v*` tag
### S2 Tool permissions
- [x] `tool_policies` + defaults (destructive tools need admin) + UI. Default rule: `destructiveHint` → admin; `woo` (Helm seed `tool_policies`) and every `store_<id>` get `create_product`/`update_order_status` admin-only when first registered (later admin choices are never undone). Admin UI: "Who may use it" per tool on the Servers page (`PUT /api/servers/:id/tools/:tool/policy`). Owner approved admin-only defaults (2026-10-11, Rule 8). Proof (live): member 24 tools / no write tools, admin 28; relax → member sees it, back to admin → hidden; member PUT → 403
- [x] Hidden from `tools/list` and rejected on direct `tools/call` (test). Proof: `gateway-core.test.ts` "S2: a destructive tool is admin-only by default…"; live member `tools/call woo__create_product` → JSON-RPC -32602 "Unknown tool", audit `denied`; `dod.sh` now checks it (18/18)
### S3 OAuth on the gateway
- [ ] (Optional, last) MCP authorization spec: protected resource metadata, browser login
### S4 Many tools
- [x] `GATEWAY_TOOL_MODE=search|auto`, `gateway__search_tools` (BM25) + `gateway__call_tool` (`gateway/toolSearch.ts`, in GatewayCore so /mcp and chat share it; search only sees the user's visible tools; calls keep policy + audit). Default `auto` (search above 40 visible tools). Proof: `tool-search.test.ts`, `gateway-core.test.ts` "S4 search mode…"; live with `search`: tools/list 2 tools / 1 001 bytes vs 28 tools / 16 796 bytes direct (-94%), chat answered "orders today" via search → call_tool
### S5 Hosted MCP servers
- [ ] Add server by container image → Deployment + Secret + limits + NetworkPolicy in `mcp-hosted`, clean removal
### S6 Security hardening
- [x] SSRF guard (P3): `gateway/ssrf.ts`; enforced on registry writes and on every upstream connection (`createGuardedFetch` in `server.ts`). Proof: `gateway-ssrf.test.ts`, live seeded `woo` upstream passes (allowlisted in-cluster name)
- [x] Upstream credentials encrypted at rest (P3): `gateway/crypto.ts` + registry seal on write; REST responses carry only `has_credential`. Proof: `gateway-db.test.ts`
- [x] Default-deny NetworkPolicies everywhere (P8) Proof: `bash scripts/verify-store-isolation.sh` 36/36 PASS (2026-10-11)
- [x] Non-root: API yes; store pods yes (WordPress 33, MariaDB 999, WP-CLI 33; only the CHOWN init container runs as root); dashboard nginx yes (uid 101, P8)
- [x] Tool-definition pinning / rug-pull detection: first definition approved on sight, any later change (description, schema or annotations) hides the tool from everyone until an admin approves it (Servers page "Approve changes", `POST /api/servers/:id/approve-tools`). `GATEWAY_PIN_TOOLS` (default true). Proof: `gateway-core.test.ts` "S6 pinning…" (fake upstream rewrites a description); live: changed definition → `notes__search_notes` hidden from members, approve → back, member approve → 403
- [x] Narrow `store-installer` ClusterRole (bound per store namespace) instead of `admin`; the API may bind only that role. Old bindings are migrated (roleRef is immutable: delete + create). Proof (live): Bharat Bazaar re-provisioned (binding `admin` → `platform-store-installer`, Ready), new store "Chennai Crafts" installed and deleted with it; `kubectl auth can-i` as the job's SA: create deployments yes; roles, rolebindings, pods/exec, delete namespaces, secrets in `platform`: no
### S7 Scaling
- [x] Gateway stateless (P3) → 2 replicas on Postgres. Proof: see P10 Postgres item (pod deleted under load: 60/60 calls OK; approvals across pods)
- [x] Rate limits per IP exist; per-key limit on `/mcp` (P5)
### S8 Observability
- [x] `/metrics` for provisioning events, now on its own port 9464 (no Ingress; NetworkPolicy admits only the `monitoring` namespace; public `/metrics` → 404)
- [x] `mcp_tool_calls_total{server,tool,outcome}`, `mcp_tool_call_duration_seconds`, `mcp_upstream_up{server}` (`gateway/metrics.ts`; unknown names collapse to `unknown`, so callers can't grow the label set). Proof: `gateway-metrics.test.ts`; live counters after `dod.sh` (e.g. `woo/create_product/denied 2`); `verify-store-isolation.sh` checks 9464 is blocked from other namespaces
- [x] Clear reason for unreachable/failed calls in UI: Servers page shows `last_error` and failed probes, Audit shows each call's error (owner checked, P7)
### S9 Upgrades and rollback
- [x] `POST /stores/:id/upgrade` re-runs a store's idempotent install (used live to recover a failed store and to migrate RBAC)
- [x] Runbook: `helm upgrade --atomic`, `helm history`, `helm rollback` (README §4, `deploy.sh`). Proof (live, 2026-10-11): `helm rollback platform 10` (revision without the metrics port; API + dashboard healthy, Service ports `http`) → `helm upgrade --atomic` → revision 13 (`http metrics`). Still to show in the demo video
