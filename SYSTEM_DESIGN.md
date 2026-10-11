# System design and tradeoffs

Short note for reviewers. The full design (research, data model, every decision) is [DESIGN.md](DESIGN.md); the threat model is [THREAT_MODEL.md](THREAT_MODEL.md).

```text
 Claude Code / Cursor (API key)        Browser (session)
          │ api.<domain>/mcp               │ dashboard.<domain>  ── nginx: /api/* proxied
          ▼                                ▼
   platform-api (Fastify, one pod) ── GatewayCore.listTools / callTool ── audit_log
          │ each upstream's own credential, timeout, bulkhead
          ├──▶ woo-mcp (store-default) ──OAuth1──▶ WordPress/WooCommerce ──▶ MariaDB
          ├──▶ notes-mcp (mcp-servers)
          └──▶ everything-mcp (mcp-servers)
```

## Aggregation: one MCP server in front of many

- platform-api is an **MCP client** of every registered upstream and an **MCP server** to clients, using the official SDK on both sides.
- `tools/list` is served from a **cached catalog** (`mcp_tools`). A health checker refreshes it every 15 s, so a slow or dead upstream never slows the listing. A server's tools stay visible for 60 s after its last success, so one missed probe doesn't make tools flicker.
- **Names are always prefixed** `slug__tool`, not only on collision. Two stores' `list_orders` both work (`woo__list_orders`, `shop2__list_orders`), names stay stable when a server is added later, and no upstream can shadow another's tool. Names are cleaned to `^[a-zA-Z0-9_-]{1,64}$` because several clients reject anything else.
- *Tradeoff:* always-prefixed names are longer and change the upstream's own names. We accept that for stability and for protection against shadowing.

## Routing

- An exposed name is resolved against the catalog (not by string surgery), then checked: server enabled, tool known, role allowed (`tool_policies`), arguments valid against the tool's JSON schema.
- The gateway then calls the upstream with **that upstream's credential only**. The client's token is never forwarded.
- `/mcp` and the chat agent use the **same two functions**, `GatewayCore.listTools(user)` and `callTool(user, …)`. Filtering, policy and audit can't differ between them, and the chat really acts as the logged-in user.
- The gateway is **stateless** Streamable HTTP: a new SDK server per request, no session ids. Any replica could serve any request.

## Failure handling

| Failure | What happens |
|---|---|
| Upstream slow | Per-call timeout (15 s, per server); error names the server and the limit |
| Upstream down | Error "Upstream 'notes' is unreachable/timed out…"; server marked Unreachable at once, probes back off exponentially (15 s → 5 min, ±20% jitter) |
| Upstream overloaded | Bulkhead: at most 16 in-flight calls per upstream; more fail fast as "upstream busy" |
| Huge result | Over 256 KB is rejected, not truncated (half a JSON document misleads the model) |
| Tool error | Returned as an `isError` result so the model can read and recover; protocol misuse (unknown tool) is a JSON-RPC error |
| Any outcome | Exactly one audit row, written in a `finally` |
| LLM rate limit / 5xx | Retries with capped exponential backoff + jitter; chat budget 8 rounds / 120 s |
| Store provisioning | Desired state in DB first; reconciler with leases, leader lock and exponential backoff survives restarts |

## Security in one paragraph

Per-user API keys (SHA-256, shown once, revocable on the next request) and scrypt passwords. Admin/member roles checked on the server. Upstream credentials are encrypted at rest and write-only. An SSRF guard covers registered URLs and every connection. Default-deny NetworkPolicies cover ingress and egress in every namespace, and non-root containers run everywhere. Details and residual risks: [THREAT_MODEL.md](THREAT_MODEL.md).

## Local vs production

The same three charts run in both (`platform`, `store-woocommerce`, `mcp-upstreams`). Only `values-local.yaml` / `values-prod.yaml` differ:

| | Local (Windows + minikube) | Production (k3s VPS) |
|---|---|---|
| Install | `ops/up.ps1` | `scripts/k3s-install.sh`, then `scripts/deploy.sh` (`--atomic`) |
| Domains | `*.127.0.0.1.nip.io` + port-forward 8088 | wildcard DNS for a real domain |
| Ingress | ingress-nginx (minikube addon) | Traefik (built into k3s; ingress-nginx is end-of-life) |
| Secrets | chart-generated once, kept with `lookup` | created out-of-band, referenced with `existingSecret` |
| Images | `:dev`, built inside minikube | versioned tags from a registry |

## What changes for real production

1. **Postgres instead of SQLite.** SQLite on a ReadWriteOnce volume means exactly one API replica (`Recreate` strategy). With Postgres the stateless gateway can scale horizontally.
2. **Split the reconciler** into its own Deployment. Today the pod that faces the internet also holds the RBAC that creates namespaces.
3. **TLS with cert-manager** and image digests instead of tags. Secrets from a manager (External Secrets / SealedSecrets).
4. **A Prometheus + Alertmanager stack** scraping the metrics port that already exists (`mcp_tool_calls_total`, `mcp_tool_call_duration_seconds`, `mcp_upstream_up`), with alerts on Unreachable and error rates.
5. **Embeddings for tool search** once there are hundreds of tools; search mode uses BM25 today (no extra service).

Already built for scale and safety: per-tool permissions (destructive tools admin-only by default), tool-definition pinning, search mode for many tools (`auto` above 40 tools; -94% tool tokens per chat turn), and a narrow RBAC role for store installs.
