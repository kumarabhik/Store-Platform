# SYSTEM — Invariants, hard-won lessons, and gotchas

This file is the project's memory. It records **things that cost time to learn** and **rules that must not be broken**.
Read it before changing anything (see [AGENTS.md](AGENTS.md)). §5 lists the verified results to quote in the demo. Design lives in [DESIGN.md](DESIGN.md), and progress lives in [ROADMAP.md](ROADMAP.md).

How to add an entry: use the template at the bottom. Keep entries short. Always include **Symptom → Cause → Fix → Where**.

---

## 1. Invariants (never break these)

| # | Invariant | Why |
|---|---|---|
| I1 | **Every tool call goes through `GatewayCore.callTool()`** ([gateway/core.ts](backend-node/src/gateway/core.ts)), from both `/mcp` and the chat agent. No other code talks to upstream MCP servers (the health checker only lists tools, through the same client pool). | Policy, timeouts and audit cannot drift apart. It is also an assignment requirement ("nothing else talks to the upstream servers directly"). |
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
| I14 | **A check-then-write is decided by the database**: a unique index (`on conflict do nothing`), a conditional `update … where`, or `db.tx(…, lock)`. Never "select, then insert" in code. | Two API replicas run at once (DESIGN §13.3, L50). |

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
- **Fix:** in Helm charts, use `lookup` to reuse an existing Secret's value and `helm.sh/resource-policy: keep` so uninstall doesn't delete it. Our store chart does this, and since the provisioner switched to it (DESIGN §11) that is the only mechanism. The old way (passwords stored in the `store_secrets` SQLite table by `secrets.ts`) was removed; the table stays because migrations are additive. Invariant I7.

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

### L13 — The API doesn't start on the host Node version (`better-sqlite3` native binding)
- **Symptom:** `node dist/server.js` on the dev machine crashes in `openDb` with `ERR_DLOPEN_FAILED` from `better-sqlite3/lib/database.js`.
- **Cause:** `better-sqlite3` is a native addon compiled for one Node ABI. The dev machine runs **Node 24**, but `node_modules` was built for the Docker image's **Node 20**.
- **Fix:** run the API in its container (the normal path, which is what `ops/up.ps1` does). To run it on the host, `npm --prefix backend-node rebuild better-sqlite3` for the host's Node. For route-level checks without a DB, use `app.inject()` in a test (that is how the `FEATURE_LEGACY_SAAS` gate was verified).
- **Note:** host Node 24.5.0 is intentional. `ops/up.ps1` selects it via nvm because the dashboard's Vite needs Node ≥ 20.19. Don't downgrade the host to 20.
- **Carry forward:** backend tests that need SQLite must run in the Node 20 container, or after a host rebuild of `better-sqlite3`.
- **Update 2026-10-10:** the host rebuild does **not** work on this machine. `better-sqlite3` 9.x has no prebuilt binary for Node 24 (ABI 137), and compiling needs Visual Studio C++ build tools (`gyp ERR! not ok`). The rebuild attempt also removed the old host binary, which was unusable anyway; the API image is unaffected because its Dockerfile runs its own `npm ci`. Use **`bash scripts/test-backend.sh`**: Node 20 Alpine in Docker, Linux `node_modules` in a named volume. SQLite suites use `describe.skipIf(!sqliteAvailable)` ([test/sqlite.ts](backend-node/test/sqlite.ts)), so host `npm test` still passes and prints why they skipped. Upgrading to `better-sqlite3` 12 (Node 24 prebuilds) would fix the host, but it is a production dependency change: owner's call.

### L14 — Deleting Docker's data leaves a stale minikube profile, and `minikube start` hangs
- **Symptom:** `minikube start` sits on `Pulling base image v0.0.47 ...` for 20+ minutes; `minikube status` says `No such container: minikube`.
- **Cause:** Docker's data folder was deleted, which removed the `minikube` container, its volume (the whole cluster: stores, PVCs, platform DB) and the kicbase image. `~\.minikube\profiles` still described the old cluster, so minikube tried to resume something that no longer existed.
- **Fix:** `minikube delete` (cleans the stale profile), then start fresh. `~\.minikube\cache` survives, so the restart reuses the cached kicbase and preload (~1.2 GB) instead of downloading. Full rebuild with `ops/up.ps1` took about 10 minutes.
- **Also:** minikube can't change CPU/memory of an existing cluster; set them once with `minikube config set memory 8192` / `cpus 4` before `minikube start`. Docker Desktop's memory is limited by `%USERPROFILE%\.wslconfig` (`[wsl2] memory=10GB`) then `wsl --shutdown`. This machine: 15.4 GB RAM → WSL 10 GB → minikube 8 GB.

### L15 — NetworkPolicies do nothing on minikube's default network plugin
- **Symptom:** none, which is the danger. Policies apply without error, but every pod can still reach every other pod.
- **Cause:** the default minikube CNI (bridge) does not implement NetworkPolicy. `kubectl -n kube-system get pods` shows no calico/cilium pods.
- **Fix:** `minikube start --cni=calico` (now in `ops/up.ps1` and `ops/resume.ps1`). The CNI can only be chosen when the cluster is created, so an existing cluster must be deleted first. k3s ships with flannel + its own network-policy controller, so policies work there out of the box.
- **Carry forward:** always *prove* a policy with a negative test (a pod that should be blocked gets a timeout), never just `kubectl get networkpolicy`.

### L16 — Ops scripts used to put credentials into the Deployment as plain env
- **Symptom:** `kubectl -n platform get deploy platform-api -o yaml` showed `STRIPE_SECRET_KEY` and `GROQ_API_KEY` values.
- **Cause:** `ops/platform-env.ps1` copied every key from `.env.local` into the Helm override file under `api.env`.
- **Fix:** keys matching `*KEY|*TOKEN|*PASSWORD|*SECRET*` go into Secret `platform-api-env` (through a temp file that is deleted right after), and the pod reads it with `envFrom`. **An explicit `env:` entry beats `envFrom`**, so secret keys must never also appear in `api.env` values (an empty `STRIPE_SECRET_KEY: ""` would blank the real one). A checksum annotation restarts the pod when the Secret changes.

### L17 — Non-root WordPress restarts once on a fresh volume (`tar: .: Cannot change mode`)
- **Symptom:** on first install the wordpress container exits with code 2 and restarts once. Previous log: `WordPress not found in /var/www/html - copying now...` then `tar: .: Cannot change mode to rwxrwxrwx: Operation not permitted`.
- **Cause:** hostPath-backed provisioners (minikube-hostpath, k3s local-path) ignore `fsGroup`, so the volume root stays owned by root. Running as uid 33, the image's first-start `tar` copies every file but cannot chmod the root dir, and exits non-zero. On restart the files exist, so it skips the copy and works. MariaDB (uid 999) is not affected.
- **Fix:** `volume-permissions` init container: runs as root with **only** the `CHOWN` capability, chowns just the mount root (not recursive), and only if it isn't already uid 33 (`wordpress.volumePermissions.enabled`, default true). After the fix: fresh install with 0 restarts.

### L18 — WooCommerce OAuth signatures use the store's **home URL**, not the URL you call
- **Symptom (avoided, found by reading the source first):** woo-mcp calls `http://store-default-wordpress.store-default.svc…/wp-json/wc/v3/…`. Signing that URL gives `401 Invalid signature - provided signature does not match`.
- **Cause:** `WC_REST_Authentication::check_oauth_signature` rebuilds the base string from `get_home_url(null, $request_path, is_ssl() ? 'https' : 'http')`, i.e. the public `home` option (`http://store.127.0.0.1.nip.io:8088`) with the **scheme of the incoming request**. In-cluster requests are plain HTTP, so even an `https://` prod home is signed as `http://`.
- **Fix:** woo-mcp has two settings: `WOO_BASE_URL` (where requests go) and `WOO_HOME_URL` (what is signed). Base string = `<scheme of WOO_BASE_URL>//<host of WOO_HOME_URL>/wp-json/wc/v3/<path>`. Only query + `oauth_*` params are signed; the JSON body is not (WC signs `$_GET` + `$_POST`, and JSON is not `$_POST`). Test vectors in `oauth1.test.ts` came from WC's own PHP run in the store pod (`kubectl exec -i … -- php < script.php`).
- **Where:** [mcp-servers/woo-mcp/src/woo.ts](mcp-servers/woo-mcp/src/woo.ts), [oauth1.ts](mcp-servers/woo-mcp/src/oauth1.ts).
- **Carry forward:** the chart must pass `publicUrl` as `WOO_HOME_URL`. If `publicUrl` changes, both the init job (home option) and woo-mcp must get the new value in the same upgrade.

### L19 — WooCommerce `after` / `before` are exclusive
- **Cause:** the v3 CRUD controller passes them straight into a `date_query` without `inclusive`, so `after=2026-10-09T00:00:00` misses an order at exactly midnight.
- **Fix:** one calendar day is `after=<previous day>T23:59:59`, `before=<next day>T00:00:00`, in store-local time (no `dates_are_gmt`). [dates.ts](mcp-servers/woo-mcp/src/dates.ts).

### L20 — MCP Inspector 0.x CLI is broken from npx; use 2.x
- **Symptom:** `npx @modelcontextprotocol/inspector@0.17.2 --cli …` → `Cannot find module …\inspector\cli\package.json`.
- **Fix:** use `@modelcontextprotocol/inspector@2.8.0 --cli <url> --header "Authorization: Bearer …" --method tools/call --tool-name … --tool-arg k=v`. Note `--tool-arg x=499` sends a **number**; quote it as `'x="499"'` for string args.

### L21 — A connect-time DNS hook never sees literal IPs
- **Symptom (caught while writing it):** the SSRF guard installs a custom `lookup` in the undici Agent, so every connection's resolved address is checked. `http://127.0.0.1:3000/mcp` would still connect.
- **Cause:** Node's `net.connect` skips `lookup` entirely when the host is already an IP.
- **Fix:** `createGuardedFetch` also checks a literal-IP host itself before fetching. Test `gateway-ssrf.test.ts` "a real fetch to a literal loopback IP is refused".
- **Also:** a test server on a random port (`listen(0)`) is outside the allowed ports (3000-9999), so the **port** check fails first and an address test "passes" while proving nothing. The test listens on an allowed port and asserts the server got **zero** hits. Make negative tests fail for the reason you are testing (L15).
- **Where:** [backend-node/src/gateway/ssrf.ts](backend-node/src/gateway/ssrf.ts).

### L22 — `kubectl port-forward` bypasses NetworkPolicy
- Port-forward tunnels through the kubelet into the pod's network namespace, so `port-forward svc/store-default-woo-mcp` works even though the policy admits only platform-api. That is fine for debugging with Inspector, but it **proves nothing** about isolation. Isolation is proven only by connections from other pods (`scripts/verify-store-isolation.sh`).
- To test "allowed from platform-api", exec into the **real** platform-api pod. A throwaway pod labelled `app=platform-api` would also match the platform-api Service selector and receive live API traffic.

### L23 — `minikube image build backend-node` spent ~10 minutes copying `node_modules`
- **Symptom:** the API image build hung for 10+ minutes before Docker even started (`docker build` inside minikube showed an age of 2 min after 12 min wall time).
- **Cause:** no `.dockerignore`, so the whole build context (host `node_modules` ≈ 100 MB, `dist`) was uploaded into the minikube VM, although the Dockerfile only copies `package*.json`, `tsconfig.json` and `src`.
- **Fix:** [backend-node/.dockerignore](backend-node/.dockerignore) (`node_modules`, `dist`, `test`, `*.db`). Every image directory needs one (woo-mcp has it).

### L24 — A skipped Vitest `describe` still runs its body
- **Symptom:** host `npm test` reported `1 failed` for `gateway-core.test.ts`, although the suite was `describe.skipIf(!sqliteAvailable)`.
- **Cause:** Vitest executes every `describe` callback to collect its tests, skipped or not. That body opened SQLite.
- **Fix:** do setup only inside `beforeAll`/`it`, or return early from the body after registering an `it.skip` with the reason (as in `gateway-core.test.ts`).

### L25 — Keep regex sources ASCII; build invisible-character classes from code points
- **Symptom:** `TS1161: Unterminated regular expression literal` in `catalog.ts`.
- **Cause:** the file ended up with the raw characters (U+200B…U+2028) where `​`-style escapes were meant. U+2028 is a line terminator, so it splits a regex literal in two.
- **Fix:** build the class with `String.fromCharCode` from numeric ranges (`INVISIBLE` in [catalog.ts](backend-node/src/gateway/catalog.ts)). Check with `grep -nP '[^\x00-\x7F]'` (from Git Bash with a UTF-8 locale).

### L26 — New pods stuck in `ContainerCreating` after the cluster has run ~1 day (Calico)
- **Symptom:** `kubectl describe pod` → `FailedCreatePodSandBox … plugin type="calico" failed (add): error getting ClusterInformation: connection is unauthorized: Unauthorized`. Existing pods keep running; only **new** pods fail, so a `helm upgrade` or `rollout restart` hangs (`1 old replicas are pending termination`).
- **Cause:** the Calico CNI plugin on the node uses a ServiceAccount token that expires; calico-node refreshes it, but on a long-running minikube it can go stale.
- **Fix:** `kubectl -n kube-system rollout restart ds/calico-node`, then the stuck pods start within seconds. Seen after 26 h of uptime on 2026-10-10.

### L27 — Groq free tier: 8 000 tokens per minute, and every chat turn sends all tool schemas
- **Symptom:** the third chat question in a minute ended with `LLM at api.groq.com returned 429: Rate limit reached for model openai/gpt-oss-120b … tokens per minute (TPM): Limit 8000, Used 5589, Requested 2512. Please try again in 757.5ms`, even after retries.
- **Cause:** each LLM request carries the system prompt plus all 22 tool schemas (~2.5k tokens), so 3–4 requests fill the per-minute window. The suggested wait (~0.8 s) is too short for the window to free enough tokens.
- **Fix:** retries now wait `max(Retry-After, 2.5 s · 2^n)`, capped at 20 s, ± 20% jitter, up to 3 times (fits the 120 s chat budget) ([chat/llm.ts](backend-node/src/chat/llm.ts)). Before a demo: pace questions, use a paid tier, or a smaller tool list (S4 search mode would cut the tokens per turn the most).
- **Also:** check `GET /openai/v1/models` from the pod before the demo (G3). On 2026-10-10 `openai/gpt-oss-120b` was live.

### L28 — The dashboard image would bake in a dev API address from `dashboard/.env`
- **Symptom (caught before it happened):** `dashboard/.env` sets `VITE_API_BASE`. Vite inlines it at build time, and the Dockerfile's `COPY . .` would have copied it into the image, so the in-cluster dashboard would call the developer's API address instead of its own `/api` proxy.
- **Fix:** [dashboard/.dockerignore](dashboard/.dockerignore) excludes `.env` and `.env.*` (and `node_modules`, `dist`, see L23). Without `VITE_API_BASE` the app tries same-origin `/api` first.
- **Carry forward:** anything `VITE_*` is public and build-time. Never put a secret there, and keep env files out of image build contexts.

### L29 — Dashboard lint: `react-hooks/set-state-in-effect` and `erasableSyntaxOnly`
- **Symptom:** `npm run lint` failed with "Calling setState synchronously within an effect" on `useEffect(() => { void loadFirst(); }, [loadFirst])`, although `loadFirst` only sets state after an `await`; the same shape passed in other pages. Separately `tsc -b` failed with `TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled` on `constructor(readonly status: number)`.
- **Cause:** the React Compiler lint rule can't always see that the setState is behind an `await` in a `useCallback` defined elsewhere. The dashboard's tsconfig enables `erasableSyntaxOnly`, which forbids TypeScript-only runtime syntax (parameter properties, enums).
- **Fix:** define the async loader **inside** the effect (with a `cancelled` flag, which also drops stale results when filters change), reset state in the event handler instead of in an effect ([pages/Audit.tsx](dashboard/src/pages/Audit.tsx)); declare class fields explicitly ([lib/api.ts](dashboard/src/lib/api.ts)).

### L30 — Default-deny egress: allow the API server's real endpoint, and dead upstreams now time out
- **Cause 1:** Calico applies egress policy *after* kube-proxy has rewritten the destination, so the `kubernetes` ClusterIP (10.96.0.1:443) is never what the policy sees; the packet goes to the API server endpoint (minikube `192.168.49.2:8443`, k3s node IP `:6443`).
- **Fix 1:** the platform chart reads the `default/kubernetes` Endpoints with Helm `lookup` and allows exactly that IP and port (fallback values for `helm template`). Verified: `platform-api -> kubernetes.default.svc:443 open` in `verify-store-isolation.sh`.
- **Symptom 2 (expected, not a bug):** with `notes-mcp` scaled to 0, the gateway reports `Upstream 'notes' timed out after 3000 ms`, where before default-deny it said `ECONNREFUSED`.
- **Cause 2:** a Service without pods has no endpoint to DNAT to, so the packet matches no allowed pod and the policy drops it silently instead of the kernel refusing it.
- **Carry forward:** a "timed out" for an upstream whose pods are gone is normal; check `kubectl get endpoints` before suspecting the network.

### L31 — Fastify rejects a POST with `Content-Type: application/json` and an empty body
- **Symptom:** in `scripts/dod.sh`, `POST /api/servers/:id/test` returned 400 and the script read an empty status, while the same call from the dashboard worked.
- **Cause:** the script's curl helper always sends `Content-Type: application/json`; Fastify answers `FST_ERR_CTP_EMPTY_JSON_BODY` (400) when that header comes with no body. The browser's `fetch` sends no content type for a body-less POST.
- **Fix:** send `-d '{}'` on body-less POSTs from scripts.

### L32 — A LimitRange `default` built with the Kubernetes JS client was silently dropped
- **Symptom:** the first store from our own chart never started WordPress or MariaDB: `pods … is forbidden: exceeded quota: store-quota, requested: limits.cpu=2, used: limits.cpu=2500m, limited: limits.cpu=4`. The live LimitRange showed `default: {cpu: 2, memory: 2Gi}`, not the 500m/512Mi in the code.
- **Cause:** the client's model calls the field `_default` (`default` is a reserved word), and the serializer drops unknown keys, so `{ default: … } as any` sent nothing. Kubernetes then uses `max` as the default limit. The Bitnami chart set its own CPU limits, which hid the bug; our chart sets none on purpose (DESIGN §10.2).
- **Fix:** `_default` in `applyLimitRange` ([kube.ts](backend-node/src/kube.ts)). **Carry forward:** an `as any` around a client model hides exactly this kind of mistake; check the live object (`kubectl get limitrange -o yaml`), not the code.

### L33 — The provisioner's readiness check followed WordPress's redirect to an unreachable URL
- **Symptom:** a new store ended `Failed: store service not reachable yet` after 5 minutes, although WordPress logs showed `GET / 301` from the API pod every few seconds and the store worked in the browser.
- **Cause:** `fetch` follows redirects. WordPress answers `/` with 301 to its public URL (`http://store-<id>.127.0.0.1.nip.io:8088`), which inside the cluster resolves to 127.0.0.1 where nothing listens. The Bitnami chart's WordPress didn't redirect.
- **Fix:** `redirect: "manual"`: a 301 already proves WordPress answers (L11: 200-499 = alive). [provisioner.ts](backend-node/src/provisioner.ts) `waitForHttp`.

### L34 — Re-creating the Helm job on retry: 409 races and releases stuck "pending"
- **Symptom:** after an API restart the store event log showed `retry_scheduled … reason=HTTP request failed` twice, and the release history had `v1 failed` (its job had been killed mid-install).
- **Cause:** (1) the retry deleted the running job: a helm process killed mid-operation leaves the release `pending-install`/`pending-upgrade`, and helm then refuses every later operation ("another operation is in progress"). (2) Job deletion with `propagationPolicy: Foreground` returns immediately; creating the same name right after fails with 409, which the client reports only as "HTTP request failed".
- **Fix:** a retry **attaches** to a still-running job instead of deleting it (event `helm_job_attached`); a finished job is deleted and the code **waits until it is gone** before creating; the job script recovers a `pending-*` release first (rollback, or uninstall a half-done first install). Proof: restart during install → attached → one `deployed` revision → Ready. [kube.ts](backend-node/src/kube.ts) `startJob`, `applyHelmJob`.

### L35 — Seeded permission defaults must apply once, not on every start
- **Symptom (caught in design review):** the first version re-applied the default tool rules (`create_product` admin-only) on every seed and re-registration. An admin who set the tool back to "Default" in the UI would see it turn admin-only again after the next API restart.
- **Fix:** defaults are inserted only when a server is created (`insert or ignore`), never on update; admin choices are rows that later runs don't touch. Test: `store-servers.test.ts` "is idempotent…".
- **Carry forward:** a "default" that keeps re-asserting itself is not a default; it's an override the admin can't remove.

### L36 — With several stores connected, "create a product" is ambiguous
- **Symptom:** `dod.sh` failed after the bonus stores existed: the chat created the product in Bharat Bazaar, and answered "orders today" for that store, not the default one.
- **Cause:** both `woo__*` and `store_<id>__*` tools match the request; the model picked one.
- **Fix:** the checks name the store ("in the default store (the woo tools)"). Demo prompts should do the same. The server name in each description (`[Store: Anku Shop]`) is what lets the model pick right when the user names the store.

### L37 — `/metrics` on the public API port leaks the tool list
- **Symptom (caught before shipping S8):** the API's `/metrics` was reachable through `api.<domain>`. Per-tool counters there would list admin-only tool names that `tools/list` hides from members (S2).
- **Fix:** metrics are served by a second Fastify instance on port 9464, which no Ingress routes; the NetworkPolicy admits only the `monitoring` namespace. Public `/metrics` → 404; `verify-store-isolation.sh` checks the port is blocked from other namespaces.

### L38 — curl buffers a stream written to a file unless you pass `-N`
- **Symptom:** after chat approvals were added, `dod.sh` saw the `approval_required` event only after the 60 s approval had already timed out, although the same request with `-N` answered instantly.
- **Cause:** curl buffers its output when stdout is not a terminal; the SSE events sat in curl's buffer instead of the file the script was polling.
- **Fix:** `curl -N` (no buffering) for every streamed response a script reacts to while it runs ([dod.sh](scripts/dod.sh) `chat`).

### L39 — Grafana downloaded plugins on every start and the liveness probe killed it
- **Symptom:** `monitoring-grafana` stuck at 2/3 Ready with restarts; events `Liveness probe failed … connection refused`; the log showed `Installing plugin pluginId=grafana-lokiexplore-app` taking ~18 s, plus SQLite lock retries.
- **Cause:** recent Grafana versions preinstall plugins from the internet at startup; together with first-time migrations the server didn't listen before the liveness probe gave up.
- **Fix:** `grafana.ini: plugins: preinstall_disabled: true` ([charts/monitoring/values.yaml](charts/monitoring/values.yaml)); ready in ~60 s afterwards. **Carry forward:** a pod shouldn't need the internet to start.

### L40 — MinIO images can't be pulled anymore; Garage instead
- **Symptom:** `docker pull minio/minio:RELEASE.2025-…` → `pull access denied`; `quay.io/minio/minio:…` → `unauthorized`.
- **Cause:** MinIO stopped publishing free images.
- **Fix:** Garage (`dxflrs/garage:v1.3.0`), approved by the owner. Gotchas: its image has no shell (bootstrap through the admin API from a curl image), and the admin API pretty-prints JSON (`"node": "…"`), so `grep` patterns need optional spaces.

### L41 — A ServiceMonitor selects Services by their labels
- **Symptom:** Prometheus loaded the rules but had no `platform-api` target.
- **Cause:** the `platform-api` Service had only a pod selector, no labels of its own.
- **Fix:** `labels: app: platform-api` on the Service ([api-service.yaml](charts/platform/templates/api-service.yaml)).

### L42 — The narrow install role (S6) blocked the first chart change that added a new kind
- **Symptom:** re-provisioning a store failed 5 times: `cronjobs.batch "wc-…-backup" is forbidden: User "system:serviceaccount:store-…:default" cannot get resource "cronjobs"`.
- **Cause:** `store-installer` lists exactly the kinds the store chart creates; the backup CronJob was new.
- **Fix:** add `cronjobs` to the role ([api-rbac.yaml](charts/platform/templates/api-rbac.yaml)). **Carry forward:** a new kind in `charts/store-woocommerce` needs the role updated in the same change; that's least privilege working, not a bug.

### L43 — After a rollout the gateway still saw the old woo-mcp tools for a while
- **Symptom:** the new woo-mcp image had 9 tools, but a gateway probe right after `rollout restart` still listed 6.
- **Cause:** the old pod was still `Terminating`, and the gateway's kept-alive HTTP connection still reached it.
- **Fix:** nothing to fix; the next probe after the old pod exits sees the new tools. When checking a rollout, wait until only the new pod remains.

### L44 — k3s (kube-router) applies NetworkPolicies asynchronously; and a probe that never ran passed as "blocked"
- **Symptom:** on k3s (`scripts/k3d-prod-test.sh`) the isolation suite failed 1-2 different checks per run: a fresh probe pod reached WordPress it shouldn't, an allowed backup client was blocked, once even `platform-api -> notes-mcp` was blocked (although the gateway used it fine). Every check passed when run alone.
- **Cause:** k3s enforces NetworkPolicies with kube-router, which programs rules asynchronously: a new pod gets its rules a moment after it starts, and each pod the suite creates makes it rebuild its rule sets. Calico (minikube) programs a pod's rules before it starts. Separately, a run started while the previous run's `np-other` namespace was still terminating, so probe pods couldn't be created, and the script counted "couldn't create the pod" as "blocked".
- **Fix:** ([verify-store-isolation.sh](scripts/verify-store-isolation.sh)) every probe prints `OPEN`/`CLOSED`; anything else is `error` and fails. Probe pods wait 3 s, try up to 5 times when expecting "open" (a "blocked" expectation treats any success as a leak), and a mismatch is repeated twice. The script waits until the old `np-other` is gone.
- **Carry forward:** on k3s a brand-new pod can briefly talk before its default-deny is in place. Our workloads only get traffic after their readiness probes, but don't rely on NetworkPolicy for the first seconds of a pod's life. A negative test must prove it actually ran (L15, L21).

### L45 — A dead upstream fails differently on k3s and minikube
- On minikube (Calico) a Service with no pods times out ("timed out after 3000 ms", L30); on k3s it is refused at once ("ECONNREFUSED"). Both are reported clearly; the dashboard, alerts and `dod.sh` don't depend on which.

### L46 — One night's backups silently never ran
- **Symptom:** on 2026-10-13 no store or platform backup had run, and nothing said so: no failed alert, the CronJobs looked normal at a glance.
- **Cause:** the stale Calico token (L26). Running pods were fine, but every backup Job's new pod failed with `FailedCreatePodSandBox` until the Job gave up. A pod that never starts produces no "backup failed" signal.
- **Fix:** `kubectl -n kube-system rollout restart ds/calico-node`, then the alert `BackupMissing` ([prometheusrule.yaml](charts/monitoring/templates/prometheusrule.yaml)): no successful `*-backup` CronJob run for 26 h (kube-state-metrics). [preflight.sh](scripts/preflight.sh) checks for recent sandbox errors and backup age.
- **Carry forward:** alert on the **absence of success** for anything scheduled, never only on failures.

### L47 — Grafana answered 503 now and then
- **Symptom:** `grafana.127.0.0.1.nip.io` sometimes returned 503; the pod showed `2/3` Ready.
- **Cause:** the chart's readiness probe times out after 1 s; on a busy single node `/api/health` was sometimes slower (217 failures in 25 h), and every failure took Grafana out of its Service.
- **Fix:** readiness timeout 5 s, and Grafana's update checks off (nothing in the cluster should call the internet) in [charts/monitoring/values.yaml](charts/monitoring/values.yaml).

### L48 — Git Bash rewrote `/readyz` into a Windows path
- **Symptom:** `kubectl get --raw /readyz` in Git Bash → `NotFound`, so the first preflight run reported the cluster as down.
- **Cause:** MSYS path conversion turns an argument starting with `/` into `C:/Program Files/Git/readyz` (G11).
- **Fix:** the preflight checks the cluster with `kubectl get ns default`; elsewhere prefix `MSYS_NO_PATHCONV=1`.

### L49 — The browser hid the CSV's file name from the dashboard
- **Symptom:** curl showed `Content-Disposition` and `X-Audit-Rows` on `/api/audit.csv`, but the dashboard (another origin) would read `null`.
- **Cause:** for a cross-origin `fetch`, browsers expose only a few "safe" response headers unless the server lists the rest in `Access-Control-Expose-Headers`.
- **Fix:** `exposedHeaders` in the CORS setup ([server.ts](backend-node/src/server.ts)). Checked with an `Origin:` header.

### L50 — Code that was correct only because SQLite is synchronous
- **Symptom:** none yet; found while moving to Postgres (DESIGN §13.3). Comments like "Node runs this synchronously against SQLite, so two first signups can't both win" were true only for one process with a synchronous driver.
- **Cause:** with an async driver and two replicas, "check, then write" (first admin, last admin, invite used once, store lease) can interleave between requests.
- **Fix:** those steps run in `db.tx(…, "team")` (Postgres advisory lock); the lease re-checks itself in the outer `WHERE`; inserts that must be unique rely on the unique index (`on conflict do nothing`) instead of a check first. Test: five simultaneous first signups → one admin, on both databases.
- **Carry forward:** a check-then-write is a race as soon as there are two writers. Let the database decide (unique index, conditional update, lock).

### L51 — The chat told the browser before the approval row existed
- **Symptom:** the Postgres test run failed "Decline …" with a timeout; SQLite passed.
- **Cause:** the agent emitted `approval_required` and only then inserted the pending row. A fast answer (5 ms in the test; the slower Postgres insert made the gap visible) found no row and was lost.
- **Fix:** `approvals.open()` creates the row before the event is sent, then `wait()` ([approval.ts](backend-node/src/chat/approval.ts)).
- **Carry forward:** create the state an answer will land in before asking the question. Running the same tests on a second database is a cheap way to shake out timing bugs.

### L52 — In a container every replica is PID 1
- **Symptom:** none yet; found while reading the reconciler for two replicas. The store lease owner was `reconciler-${process.pid}`.
- **Cause:** `node dist/server.js` is PID 1 in every pod, so two replicas had the same owner name and could each "own" the other's lease.
- **Fix:** owner = `reconciler-<hostname>-<pid>` ([provisioner.ts](backend-node/src/provisioner.ts)); the leader lock already used the hostname.

### L53 — resume.ps1 deployed the new chart with the old image
- **Symptom:** after adding Postgres to the chart, `ops/resume.ps1` (which runs `helm upgrade`) rolled out pods that stayed in `Init:CrashLoopBackOff`; the rollout timed out, the old pods kept serving.
- **Cause:** the chart (Postgres, `dist/importSqlite.js` init container) was applied before the API image that contains the import script was built.
- **Fix:** build the image, then roll. The design held: the init container failing kept the pod from starting on an empty database (where the next signup would become admin), and `maxUnavailable: 0` kept the old pods serving.
- **Carry forward:** when a chart change needs new code, `ops/up.ps1` (builds, then upgrades), not `resume.ps1`. A guard that fails closed is what makes this kind of mistake harmless.

### L54 — Postgres returns `count(*)` and bigint ids as strings
- **Symptom:** (avoided) `count(*) as n` compared with `0` would be `"0" !== 0` on Postgres.
- **Cause:** node-postgres returns int8 and numeric as strings, because they can exceed JavaScript's safe integers.
- **Fix:** type parsers in [dbPostgres.ts](backend-node/src/dbPostgres.ts) turn int8/numeric into numbers; every count and id here fits.

### L55 — `kubectl cp` read the drive letter as a pod name
- **Symptom:** `kubectl cp pod:/data/x.db C:/…/x.db` → "one of src or dest must be a local file specification".
- **Cause:** `C:` looks like `pod:path`.
- **Fix:** `cd` into the target folder and give a relative destination.

### L56 — A database timeout in a timer callback killed the API pod
- **Symptom:** with minikube and the k3s test cluster running side by side, one API replica went into `CrashLoopBackOff`: `Error: Connection terminated due to connection timeout … at Timeout._onTimeout (dist/provisioner.js)`.
- **Cause:** the reconciler's `setInterval(async () => { try … finally … })` had no `catch`. A rejected promise in a timer is an unhandled rejection, and Node exits on it. With SQLite those queries could not fail this way; a network database can.
- **Fix:** the tick catches, logs which component failed and retries on the next tick ([provisioner.ts](backend-node/src/provisioner.ts)). The other timers already did (`runDue().catch`, `tryAcquireLeader(...).catch`).
- **Carry forward:** every async callback that nothing awaits (timers, event handlers) needs its own `catch`. Check: `grep -n "setInterval(async\|setTimeout(async" src`.

### L57 — Production never backed up the platform database
- **Symptom:** the k3s isolation run expected the backup job to reach Postgres and found it blocked; there was no backup policy because there was no backup CronJob.
- **Cause:** `backup.enabled` was set only in values-local. deploy.sh installed the backup store and copied its Secret, but the platform chart never used it in production: users, keys and audit had no nightly copy.
- **Fix:** `backup.enabled: true` in values-prod.yaml; the isolation check for the backup job now runs only where the CronJob exists.
- **Carry forward:** a test that expects "open" finds missing features too, not just leaks.

### L58 — Let's Encrypt on default-deny namespaces with shared TLS Secrets
- **Symptom:** none yet; found while wiring cert-manager (S1), before any VPS run. Both would show as Certificates stuck `READY False`, with the Challenge reporting `wrong status code '404'` or a timeout.
- **Cause:** (1) the api and dashboard Ingresses named one `wildcard-tls-secret`. cert-manager's ingress-shim makes one Certificate per Secret name, so two Ingresses with different hosts would fight over it, and a wildcard needs DNS-01 anyway. (2) HTTP-01 solver pods run in the Ingress's own namespace, and Traefik reaches them on :8089. Default-deny in `platform` and in every store namespace drops that.
- **Fix:** one Secret per host (`platform-api-tls`, `platform-dashboard-tls`, `<store>-tls`). Only the Ingress that owns a host carries the issuer annotation; `platform-api-mcp` reuses `platform-api-tls` without it. A `acme-http01-solver` NetworkPolicy (ingress controller → :8089, no egress) goes in the platform and store charts whenever TLS is on.
- **Where:** [charts/cert-manager](charts/cert-manager), `platform.tlsSecret` in [_helpers.tpl](charts/platform/templates/_helpers.tpl), the solver policies in both charts' `networkpolicy.yaml`.
- **Carry forward:** a new namespace with default-deny and a TLS Ingress needs the same solver policy.

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
- Pinned SDK version: `@modelcontextprotocol/sdk@1.32.1` (woo-mcp, 2026-10-09). Its subpath imports need `"module"/"moduleResolution": "Node16"` in tsconfig; the old `"Node"` resolution ignores package `exports`. The stateless server answers `tools/list` without a prior `initialize`.

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
- **Update 2026-10-15:** done. With `postgres.enabled` (local and prod values) the API keeps nothing on disk and runs 2 replicas with `RollingUpdate` (`maxUnavailable: 0`) and a PodDisruptionBudget. With SQLite, `api.replicas` must stay 1.

### G10 — CRLF line endings break shell scripts in containers / on the VPS
Git on Windows warns `LF will be replaced by CRLF`. A `.sh` with CRLF fails on Linux with `/bin/sh^M: bad interpreter`.
- **Fix:** add `.gitattributes` with `*.sh text eol=lf`, `*.yaml text eol=lf`, `*.tpl text eol=lf`, `Dockerfile text eol=lf`.

### G11 — Windows PowerShell 5.1 quirks (for humans and agents running commands)
No `&&` / `||` (use `; if ($?) { … }`); `curl` is an alias, so use `curl.exe`. In scripts with `$ErrorActionPreference = "Stop"`, **any stderr from a native command (kubectl, helm) aborts the script, even with `2>$null`**. Probe with commands that don't error (list and filter) instead of `kubectl get <missing-thing>`. `Set-Content` writes ANSI by default, so pass `-Encoding utf8`. Run scripts with `powershell -ExecutionPolicy Bypass -File …`. `kubectl cp C:\…` fails ("one of src or dest must be a local file specification") because of the drive colon; pipe instead: `kubectl exec -i <pod> -- php < script.php`. From Git Bash, `docker run -v` needs `$(pwd -W)` and `MSYS_NO_PATHCONV=1`.

### G12 — nip.io needs internet DNS
`*.127.0.0.1.nip.io` resolves via public DNS. When offline, or behind DNS that blocks rebinding (some routers, corporate DNS), it fails. Fallback: add hosts-file entries for `dashboard.local.test`, `store.local.test` and switch `baseDomain` in values.

### G13 — New WooCommerce stores are hidden ("coming soon") and can't check out without shipping
- WooCommerce 9.x+ starts new stores in **coming soon** mode, so visitors see a placeholder instead of the shop. `store-init` sets `woocommerce_coming_soon=no` and `woocommerce_store_pages_only=no`.
- With no shipping zones, physical products fail checkout ("no shipping options"). `store-init` sets `woocommerce_ship_to_countries=disabled`; add a zone instead if you want to demo shipping.
- The onboarding wizard is skipped (`woocommerce_onboarding_profile={"skipped":true}`), and shop/cart/checkout pages are created with `wp wc tool run install_pages`.

### G14 — Store chart conventions that are easy to break
- `store-init` is a **Helm hook Job** (`post-install,post-upgrade`, `before-hook-creation`). A plain Job breaks `helm upgrade` because Job specs are immutable.
- The init Job mounts the **same RWO PVC** as WordPress (it needs the same `wp-config.php`). That works because both pods land on the same node (single-node minikube; on k3s the local-path PV pins them to its node). On a multi-node cluster with network storage this would need RWX or a different approach.
- Credentials Secret and WordPress PVC carry `helm.sh/resource-policy: keep`, so `helm uninstall` + reinstall keeps passwords that match the retained MariaDB volume (L4). To really wipe a store, delete the namespace.
- WordPress runs as uid 33 and binds :80 thanks to the safe sysctl `net.ipv4.ip_unprivileged_port_start=0`. MariaDB runs as uid 999.
- `sendmail: can't connect to remote host` in the init log is expected: WordPress tries to send a notification email and the cluster has no mail server. Harmless.
- Verify a store with `bash scripts/verify-store.sh [--persistence]` and its isolation with `bash scripts/verify-store-isolation.sh`.

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
| Chat loop | ≤ 8 tool rounds, 120 s, ≤ 4 parallel tool calls; model `openai/gpt-oss-120b` (Groq) | chat/agent.ts, values `LLM_*` |
| Per-key `/mcp` limit | burst 120, refill 2/s, 429 + Retry-After | values `MCP_KEY_RATE_LIMIT_*` |
| Max tool result size | 256 KB | DESIGN §6.4 |
| API key format | `mcpgw_<8>_<43>` | DESIGN §8.2 |
| Max stores (default / local) | 3 / 50 | values*.yaml |
| Local URLs | dashboard `http://dashboard.127.0.0.1.nip.io:8088` (in-cluster) or `http://127.0.0.1:5173` (Vite dev), gateway `http://api.127.0.0.1.nip.io:8088/mcp`, default store `http://store.127.0.0.1.nip.io:8088`, provisioned stores `http://store-<id>.127.0.0.1.nip.io:8088`, API `http://127.0.0.1:8080` | ops/up.ps1 |
| woo-mcp | port 3000, Service `<release>-woo-mcp`:80, image `store-platform/woo-mcp:dev` (local, `pullPolicy: Never`), uid 10001, `/readyz` timeout 2 s, WP timeout 10 s | charts/store-woocommerce |
| Upstreams (release `upstreams`, ns `mcp-servers`) | `notes-mcp` :3000 (PVC `notes-mcp-data`, Recreate), `everything-mcp` :3001 (`server-everything@2026.8.31`); Services on :80; token Secret `upstreams-credentials` key `notes-mcp-token` | charts/mcp-upstreams |
| Seeded gateway servers | `woo`, `notes`, `everything` (22 tools) | charts/platform `GATEWAY_SEED_SERVERS` |
| Signup / invites | `AUTH_OPEN_SIGNUP=false`; invite link `DASHBOARD_PUBLIC_URL/?invite=<token>`, 7 days, single use | charts/platform, team/invites.ts |
| Dashboard | image `store-platform/dashboard:dev` on `nginxinc/nginx-unprivileged:1.27-alpine`, uid 101, port 8080, `/healthz`; nginx proxies `/api/*` → platform-api with the prefix stripped | charts/platform `dashboard-*.yaml` |
| Store chart image | `store-platform/store-chart:dev` (local) / `ghcr.io/kumarabhik/store-chart:<v>`: alpine/helm 3.14.4 + `charts/store-woocommerce` at `/chart`, uid 65534; env `STORE_CHART_IMAGE`, `STORE_CHART_ENV`; release `wc-<id>` in `store-<id>`, gateway slug `store_<id>` | `charts/store-woocommerce/Dockerfile`, provisioner.ts |
| Gateway encryption key | Secret `gateway-enc-key`, key `key`, 32 random bytes base64 → env `GATEWAY_ENC_KEY` | charts/platform |
| Default store | release/namespace `store-default`; images `wordpress:7.1.3-php8.3-apache`, `wordpress:cli-2.12.0-php8.3`, `mariadb:11.4.13`; WooCommerce 11.2.0 (latest at install, unpinned) | charts/store-woocommerce |
| Store install time | ~1 min with cached images; first pull ~5 min | measured 2026-10-09 |

---

## 5. Verified results (talking points for the demo video)

Every line below was run, not just written. Dates are when it last passed; ROADMAP.md has the full proof per item. Re-run any of them before recording.

### Tests and checks
| What | Result | How to show it |
|---|---|---|
| Backend tests (gateway, team, chat, approvals, store registration, metrics, search, backup keys, audit CSV) | 118 on SQLite **and** 118 on Postgres (one test per side is dialect-only) | `bash scripts/test-backend.sh [--postgres]` | `bash scripts/test-backend.sh` |
| woo-mcp tests (OAuth 1.0a signer with vectors from WooCommerce's own PHP, 9 tools) | 27/27 | `npm --prefix mcp-servers/woo-mcp test` |
| notes-mcp tests | 6/6 | `npm --prefix mcp-servers/notes-mcp test` |
| CI on GitHub (tests, lint, Helm for 5 charts × local/prod, all 6 images) | 12/12 jobs green | GitHub → Actions |
| Kubernetes schema check of every rendered manifest (kubeconform, strict, incl. Prometheus CRDs) | 335/335 valid, 0 skipped | CI `helm` job |
| Per-store backup keys | store key: own bucket 200, shared bucket read 403, write 403; delete → key revoked, bucket kept | `backup-store.test.ts`; DESIGN §13.6 |
| Pre-recording check | 17/17 PASS; fails with a hint when the port-forward is down | `bash scripts/preflight.sh` |
| SQLite → Postgres move (live data) | one pod copied, the other skipped (lock): users 5, keys 19, servers 4, stores 1, tools 34, policies 4, audit 92: equal to the SQLite backup | API pod init container `import-sqlite` logs |
| Two API replicas, one deleted under load | 60/60 `tools/list` calls OK while the leader pod was deleted; new leader probing 20 s later | DESIGN §13.3 |
| Rolling restart / database restart | 43/43 calls OK during `rollout restart`; Postgres pod deleted: 2 calls failed, back after 9 s, API pods not restarted | DESIGN §13.3, L56 |
| Platform database backup | `pg_dump` uploaded (`platform/Thu.dump`); restored into a scratch database: users, keys, audit, servers equal | `kubectl -n platform create job --from=cronjob/platform-api-backup …` |
| Definition of done, end to end (two users, chat + external client, permissions, approval, disable/kill/revoke, audit) | 19/19 on minikube **and** on k3s | `bash scripts/dod.sh` |
| Network isolation (real connections, positive and negative, ingress and egress, store-to-store, backup store) | 40/40 on minikube **and** on k3s (3 runs in a row) | `bash scripts/verify-store-isolation.sh` |
| Restore drill (fresh backup → scratch database → counts compared) | passed on two stores (10 orders/13 products; 2/4) | `bash scripts/restore-drill.sh` |
| Production path on k3s (values-prod.yaml + deploy.sh unchanged, Traefik, local-path) | all releases deployed; DoD 19/19; isolation 40/40 | `bash scripts/k3d-prod-test.sh` |

### Things that happened live (good stories for the video)
- **Kill an upstream:** `notes-mcp` scaled to 0 → Servers page shows Unreachable with the reason, other servers keep working, the Prometheus alert `MCPUpstreamDown` went pending after 84 s, fired at 146 s, resolved after the restore.
- **Revoke a key:** the member's very next `/mcp` call got HTTP 401 (keys are looked up on every request, no cache).
- **Tool permissions:** a member's client lists 24 tools and no write tools; calling `woo__create_product` directly gets "Unknown tool", indistinguishable from a tool that doesn't exist, and the audit log records `denied`.
- **Human approval:** the chat asked before `create_product` (approved → product created) and before `update_order_status(26, cancelled)` (declined → order still `processing`, audit says "declined by the user in the chat").
- **Two stores, one question:** "Compare today's orders in Anku Shop and Bharat Bazaar" → the agent called `store_550560c1__list_orders` and `store_c6f26425__list_orders` → "1 order ₹199 vs 2 orders ₹398" (correct).
- **Delete a store:** its `store_<id>__*` tools vanished from clients at once (registration removed first); the namespace was gone 51 s later.
- **Restart during provisioning:** the API pod was restarted while a store's Helm job ran → the new pod reclaimed the store after the 60 s lease, attached to the running job instead of killing it (`helm_job_attached`), one clean release revision, Ready.
- **Rollback:** `helm rollback platform 10` (a revision without the metrics port) → healthy → `helm upgrade --atomic` forward again.
- **Search mode for many tools:** tool definitions sent per chat turn went from 16 796 bytes (28 tools) to 1 001 bytes (-94%), and the chat still answered "orders today" (search → call).
- **Audit CSV:** a member asked for everyone's rows and got only their own 46; the admin's `outcome=denied` export had 11 rows.
- **Approve on the other pod:** with two replicas the chat stream ran on one pod and the Approve click landed on the other (pod logs); it worked because pending approvals live in the database.
- **Kill the API leader:** 60 MCP calls during the deletion, 0 failed; the other replica took over upstream probing within 20 s.
- **Merchant tools:** "sales today" → `sales_summary` (8 orders, ₹3,792, no approval needed: read-only); "refund ₹1 on order 34" → approval card → refund recorded.

### Bugs the checks caught (shows the testing is real)
- A LimitRange default was silently dropped by the Kubernetes client (`_default` vs `default`), so a single store exceeded its own quota (L32).
- The readiness check followed WordPress's redirect to an address that doesn't exist inside the cluster (L33).
- Re-creating the Helm job on retry could leave a release stuck "pending"; now the reconciler attaches to the running job and recovers (L34).
- `/metrics` on the public port would have revealed admin-only tool names; moved to an in-cluster port (L37).
- The narrow install role correctly blocked the new backup CronJob until it was added on purpose (L42).
- The isolation test counted "probe pod never started" as "blocked"; now every probe must report OPEN or CLOSED (L44).
- MinIO stopped publishing images; the backups use Garage instead (L40).
- One night every backup silently didn't run (new pods couldn't start); now `BackupMissing` alerts on the absence of success (L46).

### Numbers worth quoting
| | |
|---|---|
| Upstream MCP servers behind one URL | 3 + one per provisioned store (woo, notes, everything, store_&lt;id&gt;) |
| Tools exposed | 34 for an admin with one extra store (9 per store × 2, 3 notes, 13 reference server); 28 for a member |
| Per-call timeout / health probe / backoff | 15 s / every 15 s, 3 s timeout / 15 s → 5 min with ±20% jitter |
| Bulkhead / max result size | 16 in-flight calls per upstream / 256 KB |
| Per-key rate limit | burst 120, then 2/s |
| Chat loop | ≤ 8 tool rounds, 120 s, ≤ 4 parallel calls, approvals time out after 60 s |
| Backups | nightly, 7 days kept (Mon…Sun + latest), every store + platform DB |
| Alerts | 5 rules: upstream down, error rate, latency, failed provisioning, backup missing |
| API replicas / database | 2 / Postgres 17 (SQLite still works with 1 replica) |

---

## 6. Useful commands
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
npx @modelcontextprotocol/inspector@2.8.0   # UI; connect to http://localhost:3001/mcp (Streamable HTTP) + Bearer header
npx @modelcontextprotocol/inspector@2.8.0 --cli http://localhost:3001/mcp --header "Authorization: Bearer <mcp-token>" --method tools/list
# run woo-mcp on the host against the default store (credentials: Secret store-default-credentials)
kubectl -n store-default port-forward svc/store-default-wordpress 8091:80
# env: WOO_BASE_URL=http://127.0.0.1:8091 WOO_HOME_URL=http://store.127.0.0.1.nip.io:8088 WOO_CONSUMER_KEY WOO_CONSUMER_SECRET WOO_MCP_TOKEN
```

---

## 7. Entry template
```markdown
### Lnn — <short title>
- **Symptom:** what you saw (exact error text helps future grep)
- **Cause:** the real root cause
- **Fix:** what solved it, including numbers/config
- **Where:** file links / commands
- **Carry forward:** (optional) the rule this implies elsewhere
```
