# ROADMAP

Legend: `[ ]` not started · `[~]` partial / in progress · `[x]` complete (verified, not just written)

Rules for this file (see [AGENTS.md](AGENTS.md)):
- Update the marker **in the same change** that does the work.
- `[x]` means it was **run and verified**. Put the proof (command, screenshot, or test name) in the item's note.
- Add new items where they belong. Never delete items; strike through ~~like this~~ with a reason if dropped.
- Design details live in [DESIGN.md](DESIGN.md) (section numbers given as §n). Lessons and gotchas go into [SYSTEM.md](SYSTEM.md).

Last reviewed: 2026-10-09

---

## Progress at a glance
| Phase | Scope | Status |
|---|---|---|
| P0 | Repo cleanup and baseline | `[x]` |
| P1 | Store chart (own) + default store | `[x]` |
| P2 | WooCommerce MCP server | `[ ]` |
| P3 | Gateway core + `/mcp` endpoint | `[ ]` |
| P4 | Two more upstream MCP servers | `[ ]` |
| P5 | Team and access (roles, invites, API keys, audit) | `[~]` |
| P6 | Chat agent | `[~]` |
| P7 | Dashboard pages | `[~]` |
| P8 | Helm and K8s completeness | `[~]` |
| P9 | Docs, threat model, demo video | `[~]` |
| B  | Bonus: multi-store provisioning | `[~]` |
| S  | Stand-out items | `[~]` |

---

## P0 — Repo cleanup and baseline
- [x] Commit current uncommitted work on `main` (ops scripts, port 8088 store URLs) as a checkpoint. Proof: commit `e2d8e56` on `main`; `.env.example` (Loom link) intentionally left uncommitted
- [x] Create branch `mcp-gateway`
- [x] Remove leftovers: `ForceDLT.txt`, `ns.json`, `tmp-store-ingress-patch.json`, `outputs/` (notes moved to SYSTEM.md L8/L9). Proof: commit `9b1ed9b`
- [x] Delete legacy Python `backend/` (still in git history). Proof: commit `f22cd07`
- [x] Put Stripe billing, custom domains, backups, content suggestions and Medusa behind `FEATURE_LEGACY_SAAS` (default `false`; routes return 404 `feature_disabled`; dashboard reads `GET /config` and hides the panels; code kept). Proof: `npm run check` ✓, dashboard `build` + `lint` ✓, gate verified with `app.inject()` on Fastify 4.29.1 (both flag values). Not yet run in-cluster
- [~] Make backend tests runnable: pure tests run on the host (`npm test`); tests that open SQLite still need the Node 20 container or a host rebuild of `better-sqlite3` (SYSTEM.md L13)
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
- [x] Per-store secrets are stable across retries (`secrets.ts`)
- [x] Storefront exposed through Ingress with a stable URL: `http://store.127.0.0.1.nip.io:8088` (default store)
- [x] **Image source decided**: own chart with official images `wordpress:7.1.3-php8.3-apache`, `wordpress:cli-2.12.0-php8.3`, `mariadb:11.4.13` (SYSTEM.md G1)
- [x] `charts/store-woocommerce`: mariadb StatefulSet (uid 999), wordpress Deployment (uid 33, sysctl for :80, volume-permissions init with CHOWN only), PVCs, Secret persisted with `lookup` + `resource-policy: keep`, Ingress, startup/readiness/liveness probes, requests/limits, NetworkPolicies. Proof: `helm lint` + `helm template` for local and prod values; fresh install 0 restarts
- [x] `store-init` hook Job (idempotent): WP install, WooCommerce 11.2.0, INR, timezone, coming-soon off, shipping off, **COD enabled**, pages, REST API key upsert, 3 seed products. Proof: `helm upgrade` rerun → "already installed", key "up to date", still 3 products, credentials hash unchanged
- [x] Default store installed by Helm as release `store-default` in namespace `store-default` from `ops/up.ps1` (always) and `ops/resume.ps1` (if missing)
- [x] Verify: storefront → add to cart → checkout with COD → order in WooCommerce. Proof: `scripts/verify-store.sh` (Store API checkout → order `processing cod 199.00 INR`). Manual browser run-through still to do before the demo (`scripts/order-checklist.md`)
- [x] Verify persistence: delete wordpress + mariadb pods → order and 3 products still there. Proof: `scripts/verify-store.sh --persistence`

## P2 — WooCommerce MCP server (DESIGN §7.1)
- [ ] Scaffold `mcp-servers/woo-mcp` (TS, `@modelcontextprotocol/sdk`, zod, Streamable HTTP, stateless)
- [ ] OAuth 1.0a (HMAC-SHA256) signer for WC REST over HTTP + unit test with known vectors
- [ ] Tool `list_products`
- [ ] Tool `create_product`
- [ ] Tool `list_orders` (with `date: today` resolved in **store timezone**)
- [ ] Tool `get_order`
- [ ] Tool `update_order_status`
- [ ] Tool `get_store_info` (name, currency, timezone)
- [ ] Trimmed output DTOs + `structuredContent` + `outputSchema`
- [ ] Bearer-token check on `/mcp` (`WOO_MCP_TOKEN` from Secret)
- [ ] `/healthz` + `/readyz` endpoints
- [ ] Dockerfile (non-root, multi-stage)
- [ ] Added to `charts/store-woocommerce`: Deployment, ClusterIP Service, **NetworkPolicy (ingress only from platform-api)**, Secret mount
- [ ] Verified with MCP Inspector via `kubectl port-forward` (all 6 tools)
- [ ] Verified **not reachable** from outside the cluster and from other namespaces (curl test documented)
- [ ] README section: "How woo-mcp talks to the store and why (REST vs WP-CLI vs SQL)"

## P3 — Gateway core (DESIGN §6, §7.3)
- [ ] DB migrations: `mcp_servers`, `mcp_tools`, `api_keys`, `audit_log`, `tool_policies`, `invites`, `users.role`
- [ ] `crypto.ts`: AES-256-GCM seal/open; key from Secret `gateway-enc-key`
- [ ] `ssrf.ts`: URL + resolved-IP validation, connect-time re-check, no redirects (unit-tested)
- [ ] `registry.ts`: CRUD; credential write-only; slug rules
- [ ] REST: `GET/POST/PATCH/DELETE /api/servers`, `POST /api/servers/:id/test` (admin only)
- [ ] `upstreams.ts`: client pool, credential injection, per-call timeout, bulkhead, error classification
- [ ] `health.ts`: periodic probe, **exponential backoff + jitter**, catalog refresh, status Connected/Unreachable/Disabled with human-readable `last_error`
- [ ] `catalog.ts`: prefixed (`slug__tool`), filtered, sorted, 64-char-safe names
- [ ] `policy.ts`: role × tool_policies
- [ ] `audit.ts`: append-only writes on **every** call outcome
- [ ] `mcpEndpoint.ts`: `POST /mcp`, stateless SDK server, API-key auth, Origin check, 401 + `WWW-Authenticate`
- [ ] Seed default upstreams from `GATEWAY_SEED_SERVERS` (idempotent upsert, `managed_by=helm`)
- [ ] Integration test: 3 fake upstreams (ok / slow / dead) → list works, calls route, timeout message clear, audit rows present
- [ ] Ingress for `/mcp` with buffering off + long read timeout

## P4 — Two more upstream servers (DESIGN §4.1)
- [ ] `notes-mcp` (ours): `add_note`, `list_notes`, `search_notes`; SQLite on PVC; requires bearer token
- [ ] `everything-mcp`: official reference server in Streamable HTTP mode, pinned version
- [ ] `charts/mcp-upstreams` with probes, resources, NetworkPolicies
- [ ] Cross-server prompt designed and verified, e.g. *"List today's orders and save a follow-up note for each customer"* (woo + notes)
- [ ] Collision demo: two servers exposing the same tool name (e.g. two stores' `list_orders`) are both visible and route correctly

## P5 — Team and access (DESIGN §8.1–8.2)
- [x] Email/password signup + login with scrypt hashing and session tokens (`auth.ts`)
- [~] Roles: `admin` / `member` exist only as derived from `ADMIN_EMAILS`. Need a persistent `users.role` column
- [ ] First user becomes admin; open signup disabled afterwards (`auth.openSignup` value)
- [ ] Invites: admin creates invite (email, role) → link → accept + set password
- [ ] Admin can change roles / disable users
- [ ] API keys: create (shown once), list, revoke; stored as SHA-256; `last_used_at`
- [ ] Revoked key rejected on the **next** request (test)
- [ ] Audit log API with filters; members see own rows, admins see all
- [~] Rate limits exist per IP (`ratelimit.ts`). Add per-API-key limit on `/mcp`

## P6 — Chat agent (DESIGN §7.4)
- [~] LLM client exists (`ai.ts`, Groq, fallback). Default model `llama-3.1-70b-versatile` is **decommissioned**; switch to `openai/gpt-oss-120b`
- [ ] Generic OpenAI-compatible client with `tools` / `tool_calls` support
- [ ] `LLM_API_KEY` in Secret `llm-credentials`; base URL and model in values
- [ ] Tool loop (≤ 8 rounds, 120 s budget), calls `GatewayCore.callTool(user, …, source='chat')`
- [ ] System prompt: current date/time, timezone, untrusted-tool-output rule
- [ ] SSE stream of tool_call / tool_result / message events
- [ ] Verified: "create product X for 499" → visible on storefront; audit row under user A
- [ ] Verified: "what orders came in today?" returns the hand-placed order

## P7 — Dashboard (DESIGN §7.6)
- [x] React + Vite dashboard with login/signup and session restore
- [~] Store list/status UI exists (reuse for bonus Stores page)
- [ ] Navigation shell: Servers · Chat · API keys · Audit · Members · Stores · Connect
- [ ] Servers page: status pills, last error, latency, tools list, add/edit/disable/delete, test connection
- [ ] Members page: invite, role change, disable
- [ ] API keys page: create (copy-once modal + ready `claude mcp add` command), revoke
- [ ] Audit page: filterable table, auto-refresh
- [ ] Chat page: messages + tool-call cards
- [ ] Connect page: gateway URL and snippets for Claude Code / Cursor / Inspector
- [x] Hide legacy SaaS panels behind the feature flag (done in P0)

## P8 — Helm and Kubernetes completeness (DESIGN §10)
- [x] `charts/platform` with `values.yaml`, `values-local.yaml`, `values-prod.yaml`
- [x] platform-api: readiness + liveness probes, requests/limits, non-root, seccomp, dropped caps
- [x] Platform API persistence via PVC
- [x] Scoped RBAC ClusterRole for the reconciler (no wildcards)
- [~] Dashboard Deployment exists but has no liveness probe, `resources: {}`, and runs nginx as root. Also, **the templates ignore `dashboard.enabled`**: with `enabled: false` the pod is still created and sits in `ImagePullBackOff` (image `store-platform/dashboard:dev` is never built). Fix all of these, and have `up.ps1` build the dashboard image
- [ ] Dashboard served in-cluster behind Ingress at `dashboard.<domain>`; API under `/api`, gateway under `/mcp` (same origin → no CORS)
- [ ] Every workload has readiness + liveness + requests/limits (checklist table in DESIGN §10.2)
- [ ] All credentials in Secrets; `existingSecret` support for prod; chart-generated with `lookup` for local
- [~] NetworkPolicies: store-default has ingress policies for mariadb and wordpress (proven by `scripts/verify-store-isolation.sh`). Still to do: default-deny in `platform`, `mcp-servers`, `store-default` incl. egress
- [ ] `automountServiceAccountToken: false` on all pods that don't need it
- [ ] `ops/up.ps1` installs all three releases in order; `scripts/deploy.sh` for VPS
- [ ] `helm lint` + `helm template` pass for local and prod values
- [ ] Local domain approach documented (nip.io + port-forward 8088 on Windows/minikube)

## P9 — Docs and demo (deliverables)
- [x] STORE_PLATFORM_FULL_GUIDE.md (easy-language guide to the existing platform)
- [x] DESIGN.md with research, architecture, threat model
- [ ] README rewrite: local setup, VPS setup, place an order, connect an external MCP client, use the chat agent
- [ ] SYSTEM_DESIGN.md → short "System design and tradeoffs" note (aggregation, routing, failure handling, prod changes)
- [ ] THREAT_MODEL.md short note (from DESIGN §9)
- [ ] "Bonus and stand-out items implemented, and where to find them" list in README
- [ ] `scripts/dod.sh` automated definition-of-done checks
- [ ] Demo video recorded (two users, full DoD flow, K8s walkthrough, MCP internals, security, chat loop, local→VPS, upgrade/rollback)
- [ ] Submitted via form

### Definition-of-done tracker (must all be `[x]` before recording)
- [ ] Storefront checkout with COD; order visible in WC admin
- [ ] User A (chat): create product → visible on storefront
- [ ] User A (chat): "orders today" returns the hand-placed order
- [ ] User B (Claude Code/Cursor/Inspector): sees tools of every enabled server using only URL + key
- [ ] User B: same orders question works
- [ ] User B: one prompt that uses tools from two different upstreams
- [ ] Revoke B's key → next call rejected
- [ ] Disable an upstream → its tools disappear from chat and the external client
- [ ] Kill an upstream pod → others keep working; dashboard shows it Unreachable
- [ ] Every call above appears in the audit log under the right user

## B — Bonus: multi-store provisioning (DESIGN §11)
- [x] Create/delete stores from the dashboard; list with status (Provisioning/Ready/Failed), URL, created time
- [x] Namespace per store with its own DB, Secrets, PVCs, Ingress host
- [x] ResourceQuota + LimitRange per store namespace
- [x] Provisioning timeout (Helm job 20 min) and retry with exponential backoff (max 5)
- [x] Leader lock + per-store lease, so concurrent provisioning is safe
- [x] Clean teardown: Helm uninstall → delete namespace → wait until gone → delete row
- [~] NetworkPolicy per store exists, but allows ingress from the **whole** `platform` namespace and egress to `0.0.0.0/0:443`; tighten and prove isolation between stores
- [~] Max stores enforced per **IP**, not per **user**
- [ ] Switch reconciler to our `charts/store-woocommerce` (chart baked into a `store-chart` image)
- [ ] Each store gets its own woo-mcp; auto-registered as `store_<id>` in the gateway after Ready
- [ ] Delete removes MCP registration first, then resources
- [ ] Restart platform-api mid-provisioning → store completes or fails with a clear reason (test)
- [ ] Demo: chat compares today's orders across two stores; delete one; its tools and namespace are gone

## S — Stand-out items
### S1 VPS deployment
- [~] `scripts/k3s-install.sh` exists; `values-prod.yaml` exists (placeholder domain, nginx class)
- [ ] Switch prod ingress class to `traefik` (ingress-nginx EOL)
- [ ] cert-manager + Let's Encrypt
- [ ] Deployed and demoed on a real VPS
### S2 Tool permissions
- [ ] `tool_policies` + defaults (destructive tools need admin) + UI
- [ ] Hidden from `tools/list` and rejected on direct `tools/call` (test)
### S3 OAuth on the gateway
- [ ] (Optional, last) MCP authorization spec: protected resource metadata, browser login
### S4 Many tools
- [ ] `GATEWAY_TOOL_MODE=search|auto`, `gateway__search_tools` (BM25) + `gateway__call_tool`
### S5 Hosted MCP servers
- [ ] Add server by container image → Deployment + Secret + limits + NetworkPolicy in `mcp-hosted`, clean removal
### S6 Security hardening
- [ ] SSRF guard (P3)
- [ ] Upstream credentials encrypted at rest (P3)
- [ ] Default-deny NetworkPolicies everywhere (P8)
- [~] Non-root: API yes; store pods yes (WordPress 33, MariaDB 999, WP-CLI 33; only the CHOWN init container runs as root); dashboard nginx no
- [ ] Tool-definition pinning / rug-pull detection
- [ ] Narrow `store-installer` role instead of binding `admin` in store namespaces
### S7 Scaling
- [ ] Gateway stateless (P3) → 2 replicas once DB is Postgres
- [~] Rate limits per IP exist; per-key limit (P5)
### S8 Observability
- [~] `/metrics` exists for provisioning events
- [ ] `mcp_tool_calls_total{server,tool,outcome}`, `mcp_tool_call_duration_seconds`, `mcp_upstream_up{server}`
- [ ] Clear reason for unreachable/failed calls in UI (P3)
### S9 Upgrades and rollback
- [~] `POST /stores/:id/upgrade` exists for stores
- [ ] Runbook: `helm upgrade --atomic`, `helm history`, `helm rollback` for all three charts, shown in the demo
