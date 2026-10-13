# DEMO.md: demo video runbook

How to record the demo video the brief asks for. Each scene names the brief's requirement it
covers, what to show, and the one or two sentences to say. Facts and numbers to quote are in
[SYSTEM.md §5](SYSTEM.md) (verified results). Target length: 18–22 minutes, in one take per scene.

The older `scripts/demo.md` and `scripts/video-*.sh` are from the platform before the gateway
(they call the API without logging in). Use this file instead.

## 0. Before recording (15 minutes)

1. Start the cluster: `powershell -File ops/resume.ps1` (or `ops/up.ps1 -SkipBuild` after a reboot).
2. Run the preflight. It must end with `Preflight: ready to record.`

   ```bash
   ADMIN_TOKEN=$(cat /tmp/sa) bash scripts/preflight.sh
   ```

   It checks pods, that new pods can start (Calico, SYSTEM.md L26), API and dashboard through the
   ingress, every upstream Connected, the LLM model, backups under 26 h old and firing alerts.
3. Optional full rehearsal (changes data: places an order, creates a product, disables and kills
   `notes` for a moment, then restores it):

   ```bash
   DOD_ADMIN_TOKEN=$(tr -d '\r\n' </tmp/sa) DOD_MEMBER_TOKEN=$(tr -d '\r\n' </tmp/sb) bash scripts/dod.sh
   ```

4. Place one order **by hand in the browser** today (`scripts/order-checklist.md`), so "orders
   today" in scene 2 shows an order you made on camera's day.
5. Open, each in its own tab or window:
   - Browser profile 1 (user A, admin `admin-a@example.com`): dashboard
     `http://dashboard.127.0.0.1.nip.io:8088`, logged in.
   - Browser profile 2 or private window (user B, member `tester-b@example.com`): dashboard,
     logged in.
   - Storefront `http://store.127.0.0.1.nip.io:8088` and its `/wp-admin` (Orders).
   - Grafana `http://grafana.127.0.0.1.nip.io:8088` → dashboard "MCP Gateway".
   - Claude Code in a terminal, connected as user B (Connect page snippet, B's own API key).
   - A second terminal for `kubectl` (Git Bash), font size up.
   - VS Code with DESIGN.md, `backend-node/src/gateway/core.ts`, `charts/platform/values-local.yaml`
     and `values-prod.yaml` open.
6. Close notifications. Never show `.env.local`, `kubectl get secret -o yaml` or a full API key
   other than one you revoke on camera.

## 1. System design and components (2 min)

**Brief:** components and responsibilities.

Show the architecture diagram in [DESIGN.md](DESIGN.md) (or SYSTEM_DESIGN.md), then
`kubectl get pods -A` grouped by namespace.

Say:
- Four layers: the **store** (WordPress + WooCommerce + MariaDB), **woo-mcp** (an MCP server that
  talks to the store's REST API with a read/write key it alone holds), the **gateway** inside
  `platform-api` (one `/mcp` endpoint, aggregates every upstream, per-user keys, policy, audit),
  and the **dashboard** with the chat agent.
- Everything that reaches an upstream goes through one function, `GatewayCore.callTool`: the
  external `/mcp` endpoint and the chat share it, so policy, timeouts and audit can't differ.
- SQLite in one API replica for this round; Postgres + 2 replicas is designed (DESIGN §13.3).

## 2. Definition of done, live, with two users (6 min)

**Brief:** the definition-of-done flow, live, with two users.

| Step | Who | Do | Expect |
|---|---|---|---|
| 1 | — | Storefront: add a product to the cart, checkout with **Cash on delivery** | Order received; show it in WP admin → Orders |
| 2 | A | Chat: "Create a product called Demo Mug, price 299" | **Approval card** (tool, arguments) → Approve → product created; refresh the storefront: it's there |
| 3 | A | Chat: "Show me today's orders" | Lists the order from step 1 (read-only: no approval card) |
| 4 | B | Dashboard → Connect: show the snippet (URL + key only); in Claude Code `/mcp` → tools of every enabled server | `woo__…`, `notes__…`, `everything__…`, `store_<id>__…` |
| 5 | B | Claude Code: "What orders came in today?" | Same order as A saw |
| 6 | B | Claude Code: "Get today's orders and save a note summarising them" | Calls `woo__list_orders` **and** `notes__add_note`: two upstreams, one prompt |
| 7 | A | Servers → disable `notes` | B: `/mcp` reconnect → `notes__*` gone; A's chat no longer offers them. Enable again |
| 8 | — | `kubectl -n mcp-servers scale deploy/notes-mcp --replicas=0` | Within ~2 probes Servers shows **Unreachable** with the reason ("timed out after 3000 ms"); B's `woo` question still works. Scale back to 1 → Connected |
| 9 | A | Keys page (all keys) → revoke B's key | B's next call in Claude Code fails (401) |
| 10 | A | Audit page: filter by user | Every call above, under the right email, source `mcp` or `chat`, including the `denied` and `unreachable` ones. Click **Export CSV**: the same rows as a file for a compliance review |

Then give B a new key (Keys page as B) so the later scenes work.

## 3. Kubernetes (3 min)

**Brief:** what runs where; requests, limits, probes; public vs internal and how it's enforced.

```bash
kubectl get ns
kubectl -n store-default get deploy,sts,svc,ingress,pvc,secret
kubectl -n platform get deploy platform-api -o jsonpath='{.spec.template.spec.containers[0].resources}{"\n"}'
kubectl -n platform describe deploy platform-api | grep -A3 -E "Liveness|Readiness"
kubectl get ingress -A
kubectl get networkpolicy -A
```

Say:
- Namespaces: `platform` (API, dashboard), `mcp-servers` (notes, everything), one `store-<id>`
  per store (WordPress, MariaDB, its own woo-mcp, PVCs, Secrets, quota), `backups` (Garage),
  `monitoring`.
- Secrets hold every credential, referenced with `secretKeyRef`; nothing in plain Helm values.
- Public (Ingress): dashboard, API (`/mcp` included), each storefront, Grafana. **Internal only**:
  woo-mcp, MariaDB, the metrics port 9464, Garage. Two layers enforce that: no Ingress exists,
  and **default-deny NetworkPolicies** allow only the named paths (gateway → woo-mcp → WordPress
  → MariaDB).
- Prove it: `bash scripts/verify-store-isolation.sh` (each line is a real connection attempt
  from a labelled pod; blocked paths time out). Quote the count from SYSTEM.md §5.

## 4. MCP internals (3 min)

**Brief:** how the gateway connects to upstreams; a tool call from client to store and back;
collisions, timeouts, a dead upstream.

Walk through `backend-node/src/gateway/core.ts` `callTool` and say the path:

1. Claude Code → `POST /mcp` (Streamable HTTP, stateless) with B's key → the key's SHA-256 is
   looked up, giving the **user**, not just a key.
2. `tools/list` comes from the cached catalog (`catalog.ts`), never a live call, so a dead
   upstream can't slow it. Names are `<server-slug>__<tool>`: that is how **collisions** are
   handled (two stores both have `list_orders`; `store_c6f26425__list_orders` vs `woo__list_orders`).
3. `tools/call` → `findTool` checks the user may see it (policy) → `upstreams.ts` reuses one MCP
   SDK client per upstream and adds the **gateway's own** credential for that upstream.
4. woo-mcp calls the WooCommerce REST API in the store namespace → the result travels back the
   same way → one audit row is written whatever happened.
- **Timeouts:** each server has `timeout_ms`; a slow upstream answers "Upstream 'x' timed out
  after N ms" and the others keep working (bulkhead: limited in-flight calls per upstream).
- **Dead upstream:** the health checker probes with exponential backoff + jitter; after failures
  the server is Unreachable with the reason, and its tools leave the list. You saw this in scene 2.

## 5. Security posture (3 min)

**Brief:** API keys and upstream credentials; member vs admin; a malicious or compromised server.

- **API keys:** shown once; only the SHA-256 is stored (`keys.ts`); checked in the DB on every
  call, so a revoke works on the next call. Passwords use scrypt.
- **Upstream credentials:** AES-GCM-encrypted at rest (`crypto.ts`), key in a K8s Secret; the
  API returns only `has_credential: true`. **No token passthrough:** B's key stops at the
  gateway; upstreams only ever see the gateway's credential, so a member's key is useless against
  WooCommerce directly, and the store's WooCommerce key never leaves the woo-mcp pod.
- **Member vs admin** (show B's dashboard): B can use tools, manage their own keys and see their
  own audit rows. B can't add/edit servers, see other users' calls (the API forces the filter),
  or use destructive tools: `create_refund`, `create_product`, `update_order_status` are
  admin-only and are not even in B's `tools/list` (show B's list vs A's; the counts are in
  SYSTEM.md §5).
- **Malicious or compromised server:**
  - SSRF guard: an admin can't register cloud metadata or cluster-internal addresses that aren't
    on the allowlist (try `http://169.254.169.254/` on the Servers page → refused).
  - Tool descriptions are sanitised (invisible characters removed, labelled with the server's
    name) and treated as data.
  - **Tool pinning:** if a server changes a tool's description or schema later (a "rug pull"),
    the tool is hidden from everyone until an admin approves the change (Servers page).
  - The chat asks the human before any tool that changes data, so a manipulated model can't
    act alone.
  - NetworkPolicies limit what a compromised upstream pod can reach.

## 6. Chat agent (1.5 min)

**Brief:** the tool loop and how the agent acts as the logged-in user.

Show `backend-node/src/chat/agent.ts`, then A's chat:
- The loop: send the user's messages + the tools **this user** may use → the model asks for a
  tool → the gateway runs it as that user (`callTool(user, …, source "chat")`) → the result goes
  back to the model → up to 8 rounds → answer.
- Acting as the user: the same policy and audit as `/mcp`. B's chat wouldn't offer
  `create_refund` at all. Writes need the approval card; decline one on camera ("cancel order
  N" → Decline) and show the `denied` audit row.

## 7. Local to VPS (2.5 min)

**Brief:** what changes through Helm values; ingress, domains, storage, secrets; upgrade and rollback.

Show `charts/platform/values-local.yaml` next to `values-prod.yaml`:
- Same charts; only values differ: domain (`127.0.0.1.nip.io` → real domain), ingress class
  (`nginx` → k3s's `traefik`) + TLS, images (`:dev` built in minikube → GHCR tags published by CI
  on a `v*` tag), secrets (generated locally → pre-created Secrets referenced by name), storage
  class (minikube's `standard` → k3s `local-path`).
- Proven: `scripts/k3d-prod-test.sh` runs `deploy.sh` with the prod values on k3s, then dod and
  isolation checks (results in SYSTEM.md §5).
- Upgrade and rollback, live:

  ```bash
  helm history platform -n platform
  # --reuse-values keeps the values ops/up.ps1 installed with (incl. its env override file)
  helm upgrade platform charts/platform -n platform --reuse-values --atomic --wait
  helm rollback platform <previous-revision> -n platform --wait
  ```

  `--atomic` rolls back by itself if the new pods don't become ready. Stores upgrade the same way
  (`POST /stores/:id/upgrade` re-runs the store's Helm install).

## 8. Extras, if time allows (1 min)

- Grafana "MCP Gateway" dashboard: calls, error rate and p95 latency per server; alerts
  (UpstreamDown fired and resolved in testing; BackupMissing watches the nightly backups).
- Multi-store bonus: create a store from the Stores page; its woo-mcp registers itself as
  `store_<id>`; chat compares orders across two stores.
- Backups: per-store bucket and key; `scripts/restore-drill.sh` restores into a scratch namespace.
- CI: GitHub Actions runs tests, lint, `helm lint`/`template` and kubeconform on every push.

## After recording

- Upload, then submit the video link and the GitHub repo at https://forms.gle/nftwgyNeenSDmiRb6.
- Mark the P9 items in ROADMAP.md.
