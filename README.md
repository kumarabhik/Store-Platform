# WooCommerce hosting with a team MCP gateway on Kubernetes

A WooCommerce store runs on Kubernetes. Our own MCP server exposes its products and orders as tools. A **gateway** puts that server and the team's other MCP servers behind **one MCP endpoint** with per-user API keys and an audit log. A **chat agent** in the dashboard uses the same tools as the logged-in user.

```text
 Claude Code / Cursor / Inspector                 Browser
      │ Bearer mcpgw_… (personal key)               │ dashboard.<domain>  (nginx: /api/* proxied)
      ▼  api.<domain>/mcp                           ▼
 ┌──────────────── platform namespace ────────────────────────────────┐
 │ platform-api (Fastify): /mcp gateway · REST for the dashboard ·    │
 │ chat agent · store provisioner.  Every tool call: GatewayCore      │
 │ (policy, timeout, audit row) → the upstream's own credential       │
 └──────┬──────────────────────────┬──────────────────────┬───────────┘
        ▼                          ▼                      ▼
 store-default: woo-mcp ─OAuth1─▶ WordPress ─▶ MariaDB    mcp-servers: notes-mcp, everything-mcp
 store-<id> (bonus): the same, one namespace per store, registered as store_<id>
```

| Doc | Read it for |
|---|---|
| [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) | Short "system design and tradeoffs": aggregation, routing, failure handling, production changes |
| [THREAT_MODEL.md](THREAT_MODEL.md) | Shared credentials, no token passthrough, untrusted upstreams, member vs member |
| [DESIGN.md](DESIGN.md) | The full design: research, data model, MCP details, security, Helm |
| [ROADMAP.md](ROADMAP.md) | What is done, with the proof for each item; definition-of-done tracker |
| [SYSTEM.md](SYSTEM.md) | Invariants and lessons learned (each with symptom → cause → fix) |
| [AGENTS.md](AGENTS.md) | Rules for anyone, human or AI agent, changing this repo |

## 1. Run it locally (Windows + minikube)

Prerequisites: Docker Desktop, minikube, kubectl, helm, Node.js 20+ (24 is fine), Git Bash for the `scripts/*.sh`.

```powershell
powershell -ExecutionPolicy Bypass -File .\ops\up.ps1
```

`up.ps1` starts minikube with Calico (so NetworkPolicies are enforced), builds all images inside minikube, installs the three Helm releases in order (`platform`, `store-default`, `upstreams`), and starts the port-forwards. A first run takes about 10 minutes.

| URL | What |
|---|---|
| `http://dashboard.127.0.0.1.nip.io:8088` | Dashboard |
| `http://api.127.0.0.1.nip.io:8088/mcp` | Gateway MCP endpoint (Claude Code, Cursor, Inspector) |
| `http://store.127.0.0.1.nip.io:8088` | Default WooCommerce store (`/wp-admin`, user `admin`) |
| `http://store-<id>.127.0.0.1.nip.io:8088` | Stores created from the dashboard (bonus) |
| `http://127.0.0.1:5173` | Vite dev server for dashboard work (same API through its `/api` proxy) |
| `http://grafana.127.0.0.1.nip.io:8088` | Grafana: the "MCP Gateway" dashboard and alerts (user `admin`, password in Secret `monitoring/monitoring-grafana`) |

Later: `ops\resume.ps1` after a reboot or sleep (port-forwards die with their pod, SYSTEM.md L6), and `ops\down.ps1` to stop. It keeps all data; `-DestroyData` wipes it.

Credentials for the LLM and admin tools go in the repo root `.env.local` (for example `GROQ_API_KEY=…`). `up.ps1`/`resume.ps1` copy them into the Secret `platform-api-env`. They never go into Helm values (SYSTEM.md L16).

### Why these local domains

- **nip.io** is public wildcard DNS: `anything.127.0.0.1.nip.io` resolves to `127.0.0.1`, so every Ingress host works without editing the hosts file.
- **Port-forward 8088**, because with minikube's docker driver on Windows the node IP (`192.168.49.x`) can't be reached from the host (SYSTEM.md L5). One forward to the ingress controller serves every host.
- The **port is part of every URL**, including WordPress's `home` option and invite links, so `values-local.yaml` sets `STORE_PUBLIC_PORT`, `DASHBOARD_PUBLIC_URL` and `GATEWAY_PUBLIC_URL` with `:8088`.
- Offline, or behind DNS that blocks rebinding, nip.io fails (SYSTEM.md G12): add hosts-file entries for `*.local.test` names and change `baseDomain` in `values-local.yaml`.

## 2. Use it

1. **Sign up.** The first account becomes the admin. After that signup is closed, and people join through invite links (Members page → invite → send the link; it works once, for 7 days).
2. **Servers.** Three upstreams are registered by Helm: `woo` (the store), `notes`, `everything`. Admins can add more (URL + optional credential, which is encrypted and never shown again), test, disable or delete them.
3. **Connect a client.** On **API keys**, create a key (it is shown once). The dialog shows the ready command. The **Connect** page also has snippets for Cursor, Inspector and curl.

   ```bash
   claude mcp add --transport http team-gateway http://api.127.0.0.1.nip.io:8088/mcp --header "Authorization: Bearer mcpgw_…"
   ```

   In Claude Code, `/mcp` should show the tools of every enabled server: `woo__*`, `notes__*`, `everything__*`, and `store_<id>__*` for each provisioned store (34 for an admin with one extra store, 28 for a member: the tools that change orders or products are admin-only). Try *"What orders came in today?"* or *"List today's orders and save a follow-up note for each customer"* (two upstreams in one prompt).
4. **Chat.** Before any tool that changes data, the chat shows an approval card (tool, arguments, reason) and waits for **Approve** or **Decline** (`CHAT_APPROVAL` in the values). The Chat page runs the same tools as you: *"Create a product called Linen Shirt priced 499 rupees"*, then find it on the storefront. Every tool call is a card, and each one lands in **Audit** under your name.
5. **Place an order.** On the storefront, add a product to the cart and check out with **Cash on delivery**. The order appears in `/wp-admin` → WooCommerce → Orders, and in *"what orders came in today?"*.
6. **Stores (bonus).** Create a store from the Stores page. It gets its own namespace, database, WooCommerce, MCP server and URL, and once it is Ready its tools appear as `store_<id>__*`. Ask the chat to *"compare today's orders in Anku Shop and Bharat Bazaar"*. Deleting a store removes its tools first, then everything else.
7. **Audit.** Every tool call, including failures and declined approvals, with filters. **Export CSV** downloads the filtered rows (`GET /api/audit.csv`, newest 10 000; members get only their own rows).

## 3. Verify it

| Command | Proves |
|---|---|
| `ADMIN_TOKEN=… bash scripts/preflight.sh` | Read-only check before a demo: pods, new pods can start, API/dashboard, upstreams Connected, LLM model, backups recent, no alerts firing. [DEMO.md](DEMO.md) is the recording runbook |
| `bash scripts/dod.sh` | The whole definition of done, end to end (19 checks: order, member key sees every server, orders today, two upstreams, admin-only tools hidden and refused, chat asks before creating a product, disable/kill/revoke, audit). Needs an admin and a member login, see the script header |
| `bash scripts/verify-store.sh [--persistence]` | Storefront → cart → COD checkout → order in WooCommerce; with `--persistence`, deletes the WordPress and MariaDB pods and checks the order survives |
| `bash scripts/verify-store-isolation.sh` | 40 real connections against the NetworkPolicies, ingress and egress, positive and negative, incl. the backup store. `NS=store-<a> REL=wc-<a> OTHER_ID=<b>` also checks store-to-store isolation |
| `bash scripts/restore-drill.sh [release] [namespace]` | Takes a fresh backup, restores it into a scratch database and compares orders and products with the live store |
| `bash scripts/test-backend.sh [--postgres]` | All backend tests (118) in Node 20, on SQLite or on a throwaway Postgres; CI runs both. `npm --prefix backend-node test` runs the database-free ones on the host |
| `npm --prefix mcp-servers/woo-mcp test`, `npm --prefix mcp-servers/notes-mcp test` | The MCP servers |
| `npm --prefix dashboard run build` / `run lint` | The dashboard |

## 4. Deploy to a VPS (k3s)

```bash
bash scripts/k3s-install.sh      # once: k3s (with Traefik) + helm
# edit charts/*/values-prod.yaml: your domain (wildcard A record *.<domain> -> VPS IP), image tags
bash scripts/deploy.sh           # checks values + Secrets, then installs cert-manager and the charts with --atomic
```

**HTTPS:** `deploy.sh` installs cert-manager first (`charts/cert-manager`). Every host then gets its own Let's Encrypt certificate over HTTP-01, so you only need ports 80 and 443 open and the wildcard A record. Put your email in `charts/cert-manager/values-prod.yaml` (the script refuses the placeholder). Check with `kubectl get certificates -A`. A certificate stuck at `READY False` usually means DNS doesn't point at the VPS yet: `kubectl describe challenge -A` says why.

**Try the production path without a VPS:** `bash scripts/k3d-prod-test.sh` creates a local k3s cluster (k3d) on ports 80/443, fills `values-prod.yaml` like an operator would (in a scratch copy), creates the required Secrets and runs `deploy.sh` unchanged. Then run `dod.sh` and `verify-store-isolation.sh` against it (commands in the script header). Images for a real VPS come from GHCR: push a tag (`git tag v0.1.0 && git push --tags`) and CI publishes them.

`deploy.sh` refuses to run while placeholder domains are left in the prod values, and prints the exact `kubectl create secret` command for every Secret that is still missing. Production never lets a chart generate credentials. Only the values files differ between local and production (SYSTEM_DESIGN.md has the table).

**Upgrade and roll back.** `helm upgrade --install … --atomic` rolls a failed upgrade back by itself. By hand: `helm history <release> -n <ns>`, then `helm rollback <release> <revision> -n <ns>`. Database migrations are additive only, so an older API image still works against a newer database (SYSTEM.md I10).

## 5. How woo-mcp talks to the store, and why

`woo-mcp` is our MCP server for one store. Its six tools are `list_products`, `create_product`, `list_orders`, `get_order`, `update_order_status` and `get_store_info`. It runs next to WordPress in the store namespace and speaks MCP over Streamable HTTP (stateless, JSON responses).

```text
gateway (platform-api) --Bearer mcp-token--> woo-mcp :3000 --OAuth 1.0a signed HTTP--> wordpress /wp-json/wc/v3
        only caller allowed by NetworkPolicy        ClusterIP, no Ingress          same namespace
```

**It uses the WooCommerce REST API.** We considered three ways in:

| Option | Verdict | Why |
|---|---|---|
| WooCommerce REST API v3 | **chosen** | Versioned and documented. Runs WooCommerce's own logic (stock, totals, status transitions, emails, HPOS order tables). Plain HTTP, so a NetworkPolicy can scope it, and it needs no Kubernetes permissions |
| WP-CLI (`wp wc …`) | no | Needs `pods/exec` RBAC (close to cluster-admin) or a shared volume. Starts PHP for every call (slow). Output parsing is brittle |
| SQL on MariaDB | no | Skips WooCommerce logic, breaks with HPOS (orders moved out of `wp_posts`), and gives the MCP server full DB power |

**Authentication.** Requests inside the cluster are plain HTTP, and WooCommerce refuses Basic auth without HTTPS. So woo-mcp signs every request with **OAuth 1.0a (HMAC-SHA256)** ([oauth1.ts](mcp-servers/woo-mcp/src/oauth1.ts)). WooCommerce checks the signature against the store's *public* URL, not the Service URL we call, so woo-mcp gets both: `WOO_BASE_URL` (where to send) and `WOO_HOME_URL` (what to sign) (SYSTEM.md L18). Helm generates the consumer key and secret once, in Secret `<release>-credentials`. The init job inserts them into WooCommerce, and only woo-mcp mounts them.

**Who can call it.** There are three layers:
1. The Service is ClusterIP, and no Ingress routes to it.
2. A NetworkPolicy admits only `platform-api` pods from the `platform` namespace, and woo-mcp itself may only talk to its own WordPress.
3. `/mcp` needs `Authorization: Bearer <mcp-token>`, from the same Secret.

`verify-store-isolation.sh` proves the first two with real connections.

**What it returns.** Trimmed objects (id, status, totals, customer name, line items), not the raw WooCommerce JSON, which is several KB per order. Every tool declares an `outputSchema`. `list_orders date="today"` uses the store's timezone (`Asia/Kolkata`), not UTC. A store error comes back as a readable tool error, for example `WooCommerce at http://… returned 404 woocommerce_rest_shop_order_invalid_id: Invalid ID.`

## 6. Bonus and stand-out items: what is implemented, and where

| Item | Status | Where |
|---|---|---|
| **Bonus: multi-store provisioning** | Done: create/delete from the dashboard, namespace per store with its own DB, Secrets, PVCs, Ingress, quota and limits, default-deny network; each store's own woo-mcp auto-registered as `store_<id>`; deletion removes the tools first; survives an API restart mid-install | `backend-node/src/provisioner.ts`, `gateway/storeServers.ts`, `charts/store-woocommerce` (baked into the `store-chart` image); DESIGN §11 |
| Security hardening (#6) | SSRF guard, upstream credentials encrypted at rest (AES-256-GCM), default-deny NetworkPolicies in every namespace (ingress + egress), non-root everywhere, no token passthrough, pinning, narrow install role (rows below) | `gateway/ssrf.ts`, `gateway/crypto.ts`, `charts/*/templates/networkpolicy.yaml`; THREAT_MODEL.md |
| Scaling (#7) | Postgres and 2 API replicas: stateless gateway (new MCP server per request, no sessions), chat approvals in the database, one replica probes upstreams (leader lease); rolling updates and a PodDisruptionBudget. Deleting a pod under load: 60/60 calls OK. Per-key rate limit and per-upstream bulkhead (limits are per pod) | `src/db.ts`, `dbPostgres.ts`, `templates/postgres.yaml`, DESIGN §13.3 |
| Observability (#8) | Every failure names the server and the cause (API, dashboard, audit log); Prometheus metrics per server/tool/outcome, latency histogram, upstream up, on an in-cluster port (9464) | `gateway/metrics.ts`, `gateway/health.ts`, Servers page |
| Upgrades and rollback (#9) | `--atomic` installs, rollback run live (revision 10 → back to 13), additive migrations | `scripts/deploy.sh`, section 4 |
| VPS (#1, part) | Deploy script and Traefik prod values; not yet run on a real VPS | `scripts/deploy.sh`, `values-prod.yaml` |
| Monitoring (real-world) | Prometheus + Grafana dashboard + 5 alert rules (gateway metrics, failed provisioning, `BackupMissing`); alert proven live | `charts/monitoring` |
| Backups (real-world) | Nightly backups of every store and the platform DB to an in-cluster S3 store (Garage); each provisioned store has its own key and bucket (can't touch another store's backups), revoked on delete; restore drill passes | `charts/backups`, `backend-node/src/backupStore.ts`, `scripts/restore-drill.sh` |
| Audit export (real-world) | CSV of the filtered audit log, same scoping as the page, spreadsheet-formula-safe | `team/routes.ts`, `gateway/audit.ts`, Audit page |
| CI (real-world) | GitHub Actions: tests, lint, `helm lint`/`template` for 5 charts × local/prod, kubeconform schema check, image builds, GHCR publish on a `v*` tag | `.github/workflows/ci.yml` |
| Merchant tools (real-world) | `sales_summary`, `list_low_stock`, `create_refund` (admin-only, asks for approval) | `mcp-servers/woo-mcp/src/tools.ts` |
| Human approval (real-world) | The chat asks before every tool that changes data; declines are audited | `chat/approval.ts`, Chat page |
| Tool permissions (#2) | Destructive tools admin-only by default; hidden from `tools/list` and refused on `tools/call`; per-tool "Who may use it" on the Servers page | `gateway/policy.ts`, `routes.ts`, Servers page |
| Many tools (#4) | `GATEWAY_TOOL_MODE=search\|auto`: `gateway__search_tools` (BM25) + `gateway__call_tool`; -94% tool tokens per chat turn | `gateway/toolSearch.ts` |
| Tool-definition pinning (#6) | A changed tool is hidden until an admin approves it ("Approve changes") | `gateway/health.ts`, `catalog.ts`, Servers page |
| Least-privilege installs (#6) | Store Helm jobs run non-root under a narrow `store-installer` role, not `admin` | `charts/platform/templates/api-rbac.yaml`, `kube.ts` |

Not built yet: OAuth on the gateway (#3), hosted MCP servers (#5), a real VPS run with TLS (#1). ROADMAP.md tracks each one.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard or `*.nip.io:8088` doesn't answer | The port-forwards died (sleep, pod restart): `ops\resume.ps1` (SYSTEM.md L6) |
| A server shows Unreachable "timed out after 3000 ms" | Its pods are gone or not Ready: `kubectl -n <ns> get pods,endpoints`. With default-deny, a Service without pods times out instead of refusing (SYSTEM.md L30) |
| Chat says `429 … tokens per minute` | Groq free tier (8 000 tokens/min); every turn sends all tool schemas. Wait a minute or use a paid key (SYSTEM.md L27) |
| Store stuck in Provisioning | Store events (`GET /stores/<id>/events`, or the Stores page timeline), then `kubectl -n store-<id> get jobs,pods,events` and `kubectl -n store-<id> logs job/helm-install-<id>` |
| `failed calling webhook "validate.nginx.ingress.kubernetes.io"` | Ingress controller still starting: `kubectl -n ingress-nginx rollout restart deploy ingress-nginx-controller`; provisioning retries by itself with backoff (SYSTEM.md L1, L2) |
| New pods stuck in `ContainerCreating` (`calico … Unauthorized`) | `kubectl -n kube-system rollout restart ds/calico-node` (SYSTEM.md L26) |
| `kubectl` shows `EOF` / TLS timeouts | `minikube stop` then `minikube start` (SYSTEM.md L7) |

## 8. Repository map

| Path | What |
|---|---|
| `backend-node/src/gateway/` | The gateway: `core.ts` (the only path to upstreams), `catalog.ts`, `upstreams.ts`, `health.ts`, `policy.ts`, `audit.ts`, `keys.ts`, `registry.ts`, `crypto.ts`, `ssrf.ts`, `mcpEndpoint.ts`, `routes.ts`, `seed.ts`, `storeServers.ts` |
| `backend-node/src/chat/` | Chat agent: OpenAI-compatible client, tool loop, SSE route |
| `backend-node/src/team/` | Members, invites, roles |
| `backend-node/src/provisioner.ts`, `kube.ts`, `engine.ts`, `lease.ts`, `leader.ts` | Store provisioning (bonus): reconciler, Kubernetes helpers, per-store values, leases |
| `backend-node/src/server.ts`, `auth.ts`, `db.ts`, `dbPostgres.ts`, `importSqlite.ts` | Fastify app, sessions/passwords, the database layer (SQLite or Postgres, same SQL), and the one-time SQLite → Postgres move |
| `mcp-servers/woo-mcp`, `notes-mcp`, `everything-mcp` | The upstream MCP servers |
| `dashboard/src/` | React app: `App.tsx` (auth + navigation), `pages/*` (one per page), `lib/*` |
| `charts/platform`, `charts/store-woocommerce`, `charts/mcp-upstreams` | The three application charts; `values-local.yaml` / `values-prod.yaml` hold every environment difference |
| `charts/monitoring`, `charts/backups` | Prometheus/Grafana/alerts, and the backup store (Garage) |
| `ops/*.ps1` | Local up / resume / down (Windows) |
| `scripts/` | `dod.sh`, `verify-store.sh`, `verify-store-isolation.sh`, `test-backend.sh`, `deploy.sh`, `k3s-install.sh`, demo helpers |
