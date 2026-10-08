# SYSTEM — Invariants, hard-won lessons, and gotchas

This file is the project's memory. It records **things that cost time to learn** and **rules that must not be broken**.
Read it before changing anything (see [AGENTS.md](AGENTS.md)). Design lives in [DESIGN.md](DESIGN.md), and progress lives in [ROADMAP.md](ROADMAP.md).

How to add an entry: use the template at the bottom. Keep entries short. Always include **Symptom → Cause → Fix → Where**.

---

## 1. Invariants (never break these)

| # | Invariant | Why |
|---|---|---|
| I1 | **Every tool call goes through `GatewayCore.callTool()`**, from both `/mcp` and the chat agent. No other code talks to upstream MCP servers. | Policy, timeouts and audit cannot drift apart. It is also an assignment requirement ("nothing else talks to the upstream servers directly"). |
| I2 | **Every `callTool` writes exactly one `audit_log` row**, including denied, not-found, timeout and error outcomes. | Assignment requirement and the demo depends on it. Write the audit row in a `finally`. |
| I3 | **No token passthrough.** The client's `Authorization` header is never forwarded upstream. Upstreams get only their own stored credential. | MCP spec forbids passthrough; confused-deputy defence. |
| I4 | **Upstream credentials never leave the server**: not in API responses, not in logs, not in error messages, not in the browser. | Assignment requirement. The API returns only `has_credential: true`. |
| I5 | **API keys and passwords are stored hashed only.** Keys use SHA-256 and passwords use scrypt. A full key is shown exactly once. | Assignment requirement. |
| I6 | **No secrets in git or in plain Helm `env:` values.** Credentials live in K8s Secrets, referenced via `secretKeyRef`. | Assignment requirement. ⚠ `STRIPE_SECRET_KEY` / `GROQ_API_KEY` are currently plain env in values; fix in P0. |
| I7 | **Generated secrets must be stable across retries and upgrades** (store them in the DB or use Helm `lookup`). | See L4: rotating a DB password after first boot locks you out of your own database. |
| I8 | **Tool names exposed by the gateway are always `slug__tool`** and match `^[a-zA-Z0-9_-]{1,64}$`. | Collision scheme, anti-shadowing, client compatibility (L13). |
| I9 | **A slow or dead upstream must never block `tools/list`** (serve from cache), and every upstream call has a timeout. | Assignment requirement. |
| I10 | **DB migrations are additive only** (add tables and columns; never rename or drop in the same release). | So `helm rollback` of the app image still works against the newer DB. |
| I11 | **Desired state goes in the DB first; slow infra work happens in the reconciler**, never inside an HTTP request. | Core design of the provisioner. Survives restarts and retries cleanly. |
| I12 | **Retries use exponential backoff with a cap (and jitter)**, never a fixed short interval. | See L1. Applies to the provisioner, the upstream health checker, and any polling loop. |
| I13 | **Role checks happen on the server for every admin route.** Hiding a button in the UI is not authorization. | Member must not be able to escalate by calling the API directly. |

---

## 2. Lessons learned (from building the existing platform)

### L1 — Retries must back off **exponentially** (cost a lot of debugging time)
- **Symptom:** a store creation failed with "connection refused" or "ingress webhook" errors. Fast fixed-interval retries burned every attempt within a minute, so the store ended `Failed` even though the cluster recovered a few minutes later. Retrying quickly also kept hammering a component that was still starting.
- **Cause:** transient infra faults (ingress-nginx admission webhook still starting, API server EOF/TLS hiccups on minikube, slow image pulls) last **minutes**, not seconds. Fixed short delays don't cover that window.
- **Fix:** `delay = min(30s × 2^retryCount, 300s)`, max 5 retries, only for errors classified as retryable (`timeout`, `connection refused`, `eof`, `tls handshake`, `job failed`, `ingress controller not ready`). The retry count is derived from `store_events` rows of type `retry_scheduled`, so it **survives restarts**. The delay is enforced by setting `lease_until` in the future, so no in-memory timer is needed.
- **Where:** [backend-node/src/provisioner.ts](backend-node/src/provisioner.ts), functions `isRetryableProvisioningError` and the `catch` block of the reconcile loop.
- **Carry forward:** the gateway health checker uses the same pattern (`min(15s × 2^(n-1), 5min)`) **plus ±20% jitter**, so many upstreams don't probe in lockstep. Any new polling or retry loop must do the same (I12).

### L2 — Wait for the ingress controller before installing anything with an Ingress
- **Symptom:** Helm job logs show `failed calling webhook "validate.nginx.ingress.kubernetes.io" … connect: connection refused`.
- **Cause:** ingress-nginx registers a validating admission webhook. If the controller pod isn't Ready, **every Ingress create is rejected**.
- **Fix:** the reconciler waits for `ingress-nginx/ingress-nginx-controller` to be Available (2 min) before the Helm job. `ops/up.ps1` runs `kubectl rollout status` on it. Manual fix: `kubectl -n ingress-nginx rollout restart deploy ingress-nginx-controller`.
- **Where:** `provisioner.ts` (`waitForDeploymentAvailable(... "ingress-nginx-controller")`), [ops/up.ps1](ops/up.ps1).
- **Note:** this check is nginx-specific and is guarded by `ingressClassName === "nginx"`. Traefik on k3s has no such webhook.

### L3 — MariaDB first boot is slow; aggressive liveness probes kill it in a loop
- **Symptom:** mariadb pod in `CrashLoopBackOff` on first install, especially on minikube with slow disks.
- **Cause:** first boot initializes the data directory (can take 1–3 min). The liveness probe fired first and restarted the container mid-init.
- **Fix:** liveness `initialDelaySeconds: 180`, readiness 60, `failureThreshold: 6` ([engine.ts](backend-node/src/engine.ts)). In our own chart, use a **`startupProbe`** (e.g. 30 × 10s) instead of a long initial delay. That is the correct K8s primitive for slow starts.

### L4 — Never regenerate DB passwords for an existing volume
- **Symptom:** after a retry or upgrade, WordPress shows "Error establishing a database connection"; mariadb logs `Access denied`.
- **Cause:** the MariaDB image sets the root/user password **only when the data dir is empty** (first boot). New random passwords in the Secret no longer match what is on the PVC.
- **Fix:** passwords are generated once and stored in `store_secrets` (SQLite), then reused on every retry ([secrets.ts](backend-node/src/secrets.ts)). In Helm charts, use `lookup` to reuse an existing Secret's value. Invariant I7.

### L5 — Windows + minikube (docker driver): the node IP isn't reachable from the host
- **Symptom:** `store-xxxx.192.168.49.2.nip.io` times out in the browser on Windows.
- **Cause:** with the docker driver on Windows, the minikube node network (192.168.49.x) is not routable from the host.
- **Fix:** use `127.0.0.1.nip.io` domains and `kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8088:80`. Store URLs therefore need the port: `STORE_PUBLIC_PORT=8088` → `http://store-<id>.127.0.0.1.nip.io:8088`. Custom domains are built **without** the port. An alternative is `minikube tunnel` (needs admin, binds :80).
- **Where:** `values-local.yaml` (`BASE_DOMAIN`, `STORE_PUBLIC_PORT`), `server.ts` `platformUrlForHost`, `ops/up.ps1`.
- **Gotcha:** WordPress stores `siteurl`/`home` at install time. If you change the port or domain later, WordPress redirects to the old URL. Set them right before first install, or fix with `wp option update home/siteurl`.

### L6 — Port-forwards die silently
- **Symptom:** dashboard says "API unreachable" after a while, or after the API pod restarts.
- **Cause:** `kubectl port-forward` exits when the target pod restarts and doesn't reconnect.
- **Fix:** `ops/up.ps1` / `ops/resume.ps1` start each port-forward with retries until the port listens **and** `/healthz` answers (`Start-ProcessUntilListening`). Long term: serve the dashboard in-cluster behind Ingress so only one forward (8088) is needed.

### L7 — Minikube control plane flakiness (`EOF`, TLS handshake timeout)
- **Fix:** `minikube stop && minikube start`. These errors are classified as retryable in L1. Give minikube ≥ 4 CPUs / 8 GB for WordPress + MariaDB + platform.

### L8 — PVC stuck in `Terminating`
- **Symptom:** platform-api pod Pending after a reinstall; `kubectl get pvc -n platform` shows `Terminating`.
- **Cause:** `kubernetes.io/pvc-protection` finalizer. A pod still uses it, or the namespace was deleted while the pod lived.
- **Fix:** delete the pod using it first. As a **last resort**, `kubectl patch pvc … -p '{"metadata":{"finalizers":[]}}' --type=merge`. ⚠ This can lose data. Then `helm upgrade --install` to recreate.

### L9 — Orphan store rows after manual namespace deletion
- **Symptom:** dashboard shows a store whose namespace you deleted by hand; it never goes away.
- **Fix:** always delete via the API (`DELETE /stores/:id`) so the reconciler cleans up in order. Emergency cleanup is in the old notes: `kubectl exec -n platform deploy/platform-api -- node -e "…delete from stores where id=?…"`.

### L10 — RBAC: creating a RoleBinding to `admin` needs the `bind` verb
- **Symptom:** `rolebindings.rbac.authorization.k8s.io is forbidden: … attempting to grant RBAC permissions not currently held`.
- **Cause:** K8s escalation prevention. You can only bind a role you either hold or have `bind` on.
- **Fix:** ClusterRole has `verbs: ["bind"]` on `clusterroles` with `resourceNames: ["admin"]` ([api-rbac.yaml](charts/platform/templates/api-rbac.yaml)). Phase S6 replaces `admin` with a narrower `store-installer` ClusterRole.

### L11 — "Ready" must mean really reachable
- `Deployment Available` is not enough: WordPress can be Available while still installing. The reconciler also does an in-cluster HTTP GET and treats **any status 200–499 as alive** (WordPress returns 302/404 during setup, while 5xx or connect errors mean not ready).

### L12 — Local `:dev` images are cached; rebuilds don't show up
- **Symptom:** you rebuilt the image but the pod runs old code.
- **Cause:** `imagePullPolicy: IfNotPresent` + same `:dev` tag means the node keeps its cached copy.
- **Fix:** `minikube image load <img>:dev` **and** `kubectl rollout restart deploy/<name>`, or use a unique tag per build (`:dev-<gitsha>`) and pass it via `--set`.

---

## 3. Gotchas discovered during research (apply them before you hit them)

### G1 — Bitnami free images are gone (Aug 28 2025)
Bitnami moved versioned images to `docker.io/bitnamilegacy/*` (frozen, no security patches). Our current `bitnami/wordpress` chart and `bitnami/mariadb:11.4.8-debian-12-r1` backup image **may fail to pull** on a fresh cluster.
- **Decision (DESIGN §7.2):** write our own `charts/store-woocommerce` with the official `wordpress` and `mariadb` images.
- **Stopgap:** override `image.repository: bitnamilegacy/wordpress` (and mariadb) in values.

### G2 — WooCommerce REST auth over plain HTTP needs OAuth 1.0a
WooCommerce docs: Basic auth or query-string `consumer_key`/`consumer_secret` are for **HTTPS**. Over HTTP (in-cluster service URLs) you **must** sign with OAuth 1.0a one-legged (HMAC-SHA1/SHA256, nonce, timestamp). Symptom if wrong: `401 woocommerce_rest_cannot_view` despite correct keys.
- **Fix:** implement the signer in woo-mcp (with a unit test). Don't try to fake HTTPS with headers.
- Also: the API key must belong to a user with `manage_woocommerce` and have permission `read_write`. Keys are stored in `wp_woocommerce_api_keys` with `consumer_key = wc_api_hash(key)` (HMAC-SHA256 with the literal key `wc-api`). The secret is stored in plain text, and `truncated_key` is the last 7 chars.

### G3 — Groq model names expire
`llama-3.1-70b-versatile` (current default in `ai.ts`) is decommissioned. `llama-3.3-70b-versatile` was deprecated on 2026-08-16. Use `openai/gpt-oss-120b` (supports tool calling). **Always keep the model name in Helm values, never hard-coded**, and check https://console.groq.com/docs/deprecations before a demo.

### G4 — MCP spec moved to stateless (2026-07-28)
The 2026-07-28 revision removed `Mcp-Session-Id`, the `initialize` handshake, `ping`, and SSE resumability. It added `server/discover`, `resultType`, and required `Mcp-Method`/`Mcp-Name` headers. Many clients still speak 2025-06-18/2025-11-25 (with `initialize`).
- **Fix:** use the official SDK, run the gateway **stateless** (`sessionIdGenerator: undefined`, new server per request), and let the SDK negotiate. Test with **both** MCP Inspector and Claude Code before the demo.
- Record the pinned SDK version here once chosen: `@modelcontextprotocol/sdk@<TBD>`.

### G5 — Streaming through ingress-nginx gets buffered
SSE / streamed responses from `/mcp` and `/api/chat` are held back by nginx's proxy buffering, and long calls hit the 60s default read timeout.
- **Fix:** on those paths set annotations `nginx.ingress.kubernetes.io/proxy-buffering: "off"`, `proxy-read-timeout: "300"`, `proxy-send-timeout: "300"`. Traefik doesn't buffer by default. Prefer `enableJsonResponse` for plain request/response.

### G6 — ingress-nginx is end-of-life (March 2026)
No more security fixes. It is fine for local minikube; **production values use Traefik** (built into k3s) via `ingressClassName: traefik`. Keep every nginx-specific annotation behind a values switch.

### G7 — Tool name limits differ between clients
Several clients (including Claude's API) require tool names to match `^[a-zA-Z0-9_-]{1,64}$`. Dots, slashes and spaces break them. Hence `slug__tool`, slugs ≤ 24 chars, and hash-truncation if longer (I8).

### G8 — "Today" depends on timezone
"What orders came in today?" is ambiguous: UTC vs store timezone vs user's browser. WooCommerce `after`/`before` are interpreted in the **site timezone** unless `dates_are_gmt=true`.
- **Fix:** `list_orders` accepts `date: "today"` and resolves it in the store timezone. `get_store_info` returns the timezone. The chat system prompt includes the current date-time. **Set the store timezone in `store-init`** (e.g. `Asia/Kolkata`) so the demo isn't off by a day near midnight UTC.

### G9 — SQLite + PVC = single replica, and rolling updates can deadlock
SQLite is a single-writer file on a `ReadWriteOnce` PVC. With the default `RollingUpdate`, the new pod may wait forever for the volume (multi-node) or two processes may write at once.
- **Fix:** platform-api `replicas: 1`, `strategy: Recreate` while on SQLite. Scaling (S7) requires Postgres first.

### G10 — CRLF line endings break shell scripts in containers / on the VPS
Git on Windows warns `LF will be replaced by CRLF`. A `.sh` with CRLF fails on Linux with `/bin/sh^M: bad interpreter`.
- **Fix:** add `.gitattributes` with `*.sh text eol=lf`, `*.yaml text eol=lf`, `*.tpl text eol=lf`, `Dockerfile text eol=lf`.

### G11 — Windows PowerShell 5.1 quirks (for humans and agents running commands)
No `&&` / `||` (use `; if ($?) { … }`); `curl` is an alias, so use `curl.exe`. `Set-Content` writes ANSI by default, so pass `-Encoding utf8`. Run scripts with `powershell -ExecutionPolicy Bypass -File …`.

### G12 — nip.io needs internet DNS
`*.127.0.0.1.nip.io` resolves via public DNS. When offline, or behind DNS that blocks rebinding (some routers, corporate DNS), it fails. Fallback: add hosts-file entries for `dashboard.local.test`, `store.local.test` and switch `baseDomain` in values.

---

## 4. Key numbers and defaults (single source of truth)
| Setting | Value | Where |
|---|---|---|
| Provisioning retry backoff | `min(30s·2^n, 300s)`, max 5 retries | provisioner.ts |
| Helm install job timeout | 20 min | provisioner.ts |
| Deployment-ready wait | 10 min | provisioner.ts |
| In-cluster HTTP ready wait | 5 min, 2s interval, 5s per try | provisioner.ts |
| Upstream tool-call timeout | 15 s (per server, configurable) | DESIGN §6.7 |
| Health probe interval / timeout | 15 s ±20% / 3 s; backoff cap 5 min | DESIGN §6.6 |
| woo-mcp → WordPress timeout | 10 s | DESIGN §6.7 |
| Chat loop | ≤ 8 tool rounds, 120 s | DESIGN §7.4 |
| Max tool result size | 256 KB | DESIGN §6.4 |
| API key format | `mcpgw_<8>_<43>` | DESIGN §8.2 |
| Max stores (default / local) | 3 / 50 | values*.yaml |
| Local URLs | dashboard `http://127.0.0.1:5173` (dev), stores `http://store-<id>.127.0.0.1.nip.io:8088`, API `http://127.0.0.1:8080` | ops/up.ps1 |

---

## 5. Useful commands
```powershell
# bring up / resume / down (local, Windows)
powershell -ExecutionPolicy Bypass -File .\ops\up.ps1
powershell -ExecutionPolicy Bypass -File .\ops\resume.ps1
powershell -ExecutionPolicy Bypass -File .\ops\down.ps1            # keeps data
# debug a store
curl.exe -s http://127.0.0.1:8080/stores/<id>/events
kubectl -n store-<id> get jobs,pods,svc,ingress,pvc
kubectl -n store-<id> logs job/helm-install-<id>
# render charts without installing
helm template platform charts/platform -f charts/platform/values.yaml -f charts/platform/values-local.yaml
# test an MCP server from your laptop
kubectl -n store-default port-forward svc/store-default-woo-mcp 3001:80
npx @modelcontextprotocol/inspector   # connect to http://localhost:3001/mcp (Streamable HTTP)
```

---

## 6. Entry template
```markdown
### Lnn — <short title>
- **Symptom:** what you saw (exact error text helps future grep)
- **Cause:** the real root cause
- **Fix:** what solved it, including numbers/config
- **Where:** file links / commands
- **Carry forward:** (optional) the rule this implies elsewhere
```
