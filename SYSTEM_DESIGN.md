# System design and tradeoffs

Short note for reviewers. The full design (research, data model, every decision) is [DESIGN.md](DESIGN.md); the threat model is [THREAT_MODEL.md](THREAT_MODEL.md); what is done, with proof, is [ROADMAP.md](ROADMAP.md).

```text
 Claude Code / Cursor (API key)        Browser (session)
          │ api.<domain>/mcp               │ dashboard.<domain>  ── nginx: /api/* proxied
          ▼                                ▼
   platform-api (Fastify) ── GatewayCore.listTools / callTool ── policy · approval · audit · metrics
          │ each upstream's own credential, timeout, bulkhead
          ├──▶ woo-mcp (store-default) ──OAuth1──▶ WordPress/WooCommerce ──▶ MariaDB
          ├──▶ store_<id> woo-mcp (one per provisioned store, bonus)
          ├──▶ notes-mcp (mcp-servers)
          └──▶ everything-mcp (mcp-servers)
```

## Design principles

1. **One path to every upstream.** `/mcp` and the chat agent both go through `GatewayCore.listTools` / `callTool`, so filtering, permissions, timeouts and audit can't drift apart, and the chat really acts as the logged-in user.
2. **Authorization doesn't trust the model.** What a user may do is decided by the gateway (roles, per-tool rules, approvals), never by what the model says it wants.
3. **Cache first, never block on an upstream.** Tool lists come from a cache that a health checker refreshes; a slow server can't slow down everyone.
4. **Fail clearly.** Every error names the component and the reason ("Upstream 'notes' timed out after 3000 ms"), in the API, the dashboard and the audit log.
5. **Defence in depth.** Each boundary has its own control: API keys at the gateway, a separate credential per upstream, NetworkPolicies between pods, non-root containers, and an audit row for every call.
6. **Same charts everywhere.** Local and production differ only in `values-local.yaml` / `values-prod.yaml`.

## The life of one tool call

1. **Authenticate.** The client sends `Authorization: Bearer mcpgw_…`. The gateway hashes the key, finds its owner, and checks it isn't revoked or disabled. This is a database lookup on every request, so revocation applies on the next call. Then the per-key rate limit.
2. **Resolve.** `woo__list_orders` is looked up in the cached catalog (not split by string), so cleaned or renamed tools still route right. Unknown, disabled, changed-and-unapproved (pinning) and not-permitted tools all answer the same "Unknown tool", so a member can't probe what exists.
3. **Check.** The role must meet the tool's rule (destructive tools are admin-only by default). In the chat, a tool that changes data waits for the user's **Approve**. Arguments are validated against the tool's JSON schema.
4. **Call.** The upstream gets **its own** credential (decrypted only for this request), never the client's token. Per-server timeout (15 s) and bulkhead (16 in flight).
5. **Return.** Results over 256 KB are refused; upstream errors come back as readable `isError` results the model can act on.
6. **Record.** Exactly one audit row (user, key, tool, outcome, duration, redacted arguments), written in a `finally`, plus metrics.

## Key decisions and their tradeoffs

| Decision | Alternative we didn't take | Why |
|---|---|---|
| Always prefix tool names (`slug__tool`) | Prefix only on collision | Names stay stable when a server is added; no upstream can shadow another's tool; the model sees which system it acts on. Cost: longer names |
| Stateless gateway (new MCP server per request, no sessions) | Session-sticky gateway | Any replica can serve any request; matches the 2026 MCP spec; works with old clients too |
| Gateway inside platform-api | A separate gateway Deployment | One process shares auth, users and the DB; simpler to test. Cost: the internet-facing pod also holds the provisioner's RBAC (split planned, DESIGN §13.8) |
| WooCommerce REST API with OAuth 1.0a | WP-CLI or direct SQL | Runs WooCommerce's own logic, needs no Kubernetes privileges, and a NetworkPolicy can scope it |
| API keys hashed with SHA-256 | scrypt/argon2 | Keys are 256 random bits, so brute force is impossible anyway, and auth stays under 1 ms per request. Passwords use scrypt |
| Upstream credentials encrypted, server id as AES-GCM associated data | Plain columns, or a vault | The DB file alone reveals nothing, and a sealed credential can't be moved to another server's row; no extra service |
| Default-deny NetworkPolicies, ingress **and** egress | Ingress-only policies | A compromised upstream can't call out, scan the cluster, or reach cloud metadata (proven by 37 negative and positive tests) |
| Search mode (BM25) above 40 tools | Always send every tool | -94% tool tokens per chat turn, better tool choice; no embedding service needed yet |
| Trust-on-first-use pinning | Admin approves every new tool | No friction on first registration; any later change (description, schema or annotations) is held for review |
| Store chart baked into an image for the provisioner | Helm repository at runtime | New stores install offline with the exact chart version of the platform release |

## Failure handling

| Failure | What happens |
|---|---|
| Upstream slow | Per-call timeout (15 s, per server); error names the server and the limit |
| Upstream down | "Upstream 'notes' is unreachable / timed out"; marked Unreachable at once; probes back off exponentially (15 s → 5 min, ±20% jitter); its tools disappear after a 60 s grace |
| Upstream overloaded | Bulkhead: at most 16 in-flight calls per upstream; more fail fast as "upstream busy" |
| Upstream changes a tool | Pinning hides the changed tool until an admin approves it |
| Huge result | Over 256 KB is refused, not truncated (half a JSON document misleads the model) |
| Model proposes a risky change | The chat shows it and waits; decline or 60 s without an answer = not done, audited |
| LLM rate limit / 5xx | Retries with capped exponential backoff + jitter; chat budget 8 rounds / 120 s |
| API restarts mid-provisioning | Desired state is in the DB; the next reconcile attaches to the running Helm job instead of killing it, and recovers a release left half-done |
| Any outcome | Exactly one audit row, written in a `finally` |

## Local vs production

| | Local (Windows + minikube) | Production (k3s VPS) |
|---|---|---|
| Install | `ops/up.ps1` | `scripts/k3s-install.sh`, then `scripts/deploy.sh` (`--atomic`, refuses placeholders and missing Secrets) |
| Domains | `*.127.0.0.1.nip.io` + port-forward 8088 | wildcard DNS for a real domain |
| Ingress | ingress-nginx (minikube addon) | Traefik (built into k3s; ingress-nginx is end-of-life) |
| Secrets | chart-generated once, kept with `lookup` | created beforehand, referenced with `existingSecret` |
| Images | `:dev`, built inside minikube | versioned tags from a registry |

## Built, and what comes next

**Built and verified** (ROADMAP has the proof for each): the gateway and chat, three upstreams plus one MCP server per provisioned store, roles, invites, keys and audit, per-tool permissions, human approval in the chat, tool-definition pinning, search mode, default-deny networking, a narrow install role, monitoring (Prometheus, Grafana, alerts), nightly backups with a passing restore drill, merchant tools (sales summary, low stock, refunds), Postgres behind two API replicas (one leader probes upstreams, chat approvals in the database, rolling updates without downtime), rollback, and CI on every push (tests on SQLite and on Postgres).

**Planned before submission** (designed in [DESIGN.md §13](DESIGN.md#13-production-readiness-plan-p10-before-the-2026-10-26-submission)):

| Step | Why it matters |
|---|---|
| VPS + HTTPS (cert-manager, Let's Encrypt) | A live URL; exercises the production values for real |

**Later:** split the provisioner into its own Deployment, CloudNativePG for failover, OAuth on the gateway, hosted MCP servers, embeddings for tool search.
