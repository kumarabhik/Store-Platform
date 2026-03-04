# Store Platform (Minikube Demo)

This repo provisions isolated WooCommerce stores on Kubernetes from a control-plane API and dashboard.

- Control plane API: `backend-node` (Node.js + Fastify)
- Dashboard UI: `dashboard` (Vite + React)
- Platform chart: `charts/platform`

## 1. Prerequisites

- Docker Desktop (running)
- Minikube
- `kubectl`
- `helm`
- Node.js 20+
- npm

Quick version checks:

```powershell
minikube version
kubectl version --client
helm version
node -v
npm -v
```

## 2. One-time cluster start

```powershell
minikube start
minikube addons enable ingress
kubectl config current-context
kubectl get ns
```

Expected context: `minikube`.

## 3. Build and deploy platform

Build API image into Minikube:

```powershell
minikube image build -t store-platform/api-node:dev backend-node
```

Install or upgrade chart:

```powershell
helm upgrade --install platform ./charts/platform -n platform --create-namespace -f ./charts/platform/values-local.yaml --set api.image=store-platform/api-node:dev
```

Verify:

```powershell
kubectl -n platform get pods
kubectl -n platform get svc
```

API pod should be `Running` and ideally `1/1 Ready`.

## 4. Run dashboard locally

Terminal A (API port-forward):

```powershell
kubectl -n platform port-forward svc/platform-api 8080:80
```

Terminal B (dashboard dev server):

```powershell
npm --prefix dashboard install
npm --prefix dashboard run dev -- --host 0.0.0.0 --port 5173
```

Open:

- `http://127.0.0.1:5173`

If you run in a remote IDE/codespace, forward both ports:

- `5173` (dashboard)
- `8080` (API)

## 5. CLI create/verify flow (for interview backup)

API health:

```powershell
curl.exe -s http://127.0.0.1:8080/healthz
```

Create store:

```powershell
curl.exe -s -X POST http://127.0.0.1:8080/stores -H "content-type: application/json" -d "{\"engine\":\"woocommerce\"}"
```

List stores:

```powershell
curl.exe -s http://127.0.0.1:8080/stores
```

Events for one store:

```powershell
curl.exe -s http://127.0.0.1:8080/stores/<storeId>/events
```

Links:

```powershell
curl.exe -s http://127.0.0.1:8080/stores/<storeId>/links
```

Delete store:

```powershell
curl.exe -s -X DELETE http://127.0.0.1:8080/stores/<storeId>
```

## 6. What "Ready" means

A store moves to `Ready` only after:

1. Namespace + guardrails are applied.
2. Secret is created.
3. Helm install job succeeds.
4. Workload availability gate passes.
5. In-cluster WordPress service health check succeeds.

Only then does URL get written in the store row and dashboard.

Transient infrastructure errors (for example ingress webhook/controller hiccups or API timeouts) are retried automatically with backoff while the store remains in `Provisioning` (up to a retry cap), instead of failing immediately on first transient fault.

## 7. Troubleshooting

### A) Dashboard says API unreachable

1. Confirm port-forward is running:
```powershell
kubectl -n platform port-forward svc/platform-api 8080:80
```
2. Confirm API:
```powershell
curl.exe -s http://127.0.0.1:8080/healthz
```
3. Confirm API pod:
```powershell
kubectl -n platform get pods -l app=platform-api -o wide
kubectl -n platform logs deploy/platform-api --tail=100
```

### B) Store stuck in `Provisioning`

Check events first:

```powershell
curl.exe -s http://127.0.0.1:8080/stores/<storeId>/events
```

Then inspect namespace resources:

```powershell
kubectl -n store-<storeId> get jobs,pods,svc,ingress
```

If Helm job is failing:

```powershell
kubectl -n store-<storeId> get pods -l job-name=helm-install-<storeId>
kubectl -n store-<storeId> logs <helm-job-pod-name>
```

### C) Error contains ingress webhook connection refused

Symptom from helm job logs:

- `failed calling webhook "validate.nginx.ingress.kubernetes.io"... connect: connection refused`

Fix:

```powershell
kubectl -n ingress-nginx get pods,svc
kubectl -n ingress-nginx rollout restart deploy ingress-nginx-controller
kubectl -n ingress-nginx get endpoints ingress-nginx-controller-admission
```

Retry store creation after ingress controller is healthy.

### D) `kubectl` shows `EOF` / TLS timeout intermittently

This is usually Minikube control-plane instability.

```powershell
minikube status
minikube stop
minikube start
kubectl get ns
```

## 8. Teardown (bring down)

Stop local foreground processes first (`Ctrl+C` in dashboard and port-forward terminals).

Uninstall platform:

```powershell
helm uninstall platform -n platform
```

Optional cleanup of store namespaces:

```powershell
kubectl get ns --no-headers | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ -like 'store-*' } | ForEach-Object { kubectl delete ns $_ }
```

Stop Minikube:

```powershell
minikube stop
```

Full reset (optional):

```powershell
minikube delete
```

## 9. Interview demo sequence (suggested)

1. Show `kubectl -n platform get pods`.
2. Open dashboard (`127.0.0.1:5173`).
3. Click create store.
4. Open Activity panel and show lifecycle events.
5. Show namespace isolation:
```powershell
kubectl get ns | findstr store-
```
6. Open resulting storefront/admin URL from the dashboard.
7. Delete store and show namespace cleanup.

## 10. API hardening envs

- `MAX_STORES`: max active stores per client IP.
- `TRUST_PROXY`: trust proxy headers.
- `RATE_LIMIT_ENABLED`: global limiter on/off.
- `RATE_LIMIT_CAPACITY` + `RATE_LIMIT_REFILL_PER_SEC`: global bucket.
- `CREATE_RATE_LIMIT_CAPACITY` + `CREATE_RATE_LIMIT_REFILL_PER_SEC`: create endpoint limiter.
- `CORS_ORIGINS`: comma-separated allowlist (`*` supported).
- `ADMIN_API_KEY`: required for sensitive credential endpoints when set.

Note: The orchestrator/API used by the platform is `backend-node` (Node.js). The `backend/` Python folder is not part of this control-plane runtime path.

## 11. Interview Study Plan (Full Project)

Use this order so you understand both architecture and implementation details.

1. Read architecture and runbook:
   - `SYSTEM_DESIGN.md`
   - `README.md` (this file)
2. Understand backend API entrypoint and lifecycle:
   - `backend-node/src/server.ts`
   - `backend-node/src/provisioner.ts`
   - `backend-node/src/kube.ts`
3. Understand persistence and coordination:
   - `backend-node/src/db.ts`
   - `backend-node/src/lease.ts`
   - `backend-node/src/leader.ts`
4. Understand deployment config generation:
   - `backend-node/src/engine.ts`
   - `backend-node/src/secrets.ts`
5. Understand infrastructure chart:
   - `charts/platform/values*.yaml`
   - `charts/platform/templates/*.yaml`
6. Understand UI:
   - `dashboard/src/App.tsx`
   - `dashboard/src/App.css`
   - `dashboard/vite.config.ts`
7. Review helpers and demo scripts:
   - `scripts/*.sh`
   - `scripts/*.md`
8. Review legacy Python prototype only for historical context:
   - `backend/app/*.py`

## 12. Runtime Flow (Code Map)

Create store request path:

1. `POST /stores` in `backend-node/src/server.ts`
2. Row inserted in SQLite (`stores`) with `Provisioning`
3. Reconciler loop in `backend-node/src/provisioner.ts` claims row via lease
4. K8s guardrails applied via `backend-node/src/kube.ts`
5. Secret generated/stored via `backend-node/src/secrets.ts`
6. Helm install job launched (`alpine/helm`) via `applyHelmJob`
7. Deployment availability + in-cluster HTTP checks
8. Store row updated to `Ready` with URL + events written

Delete store request path:

1. `DELETE /stores/:id` marks `Deleting`
2. Reconciler runs Helm uninstall job
3. Namespace deletion and wait-for-gone
4. Store row removed

## 13. File-by-File Guide

### Root files

| File | What it does | Interview note |
|---|---|---|
| `README.md` | Runbook, operations, troubleshooting | Demonstrates production run/operate thinking |
| `SYSTEM_DESIGN.md` | High-level architecture and guarantees | Use this when explaining tradeoffs |
| `ForceDLT.txt` | Local operator notes from debugging | Not runtime code; useful context only |
| `ns.json` | Local artifact/empty file | Not part of runtime |

### Node backend (`backend-node`)

| File | What it does | Interview note |
|---|---|---|
| `backend-node/src/server.ts` | Fastify app, routes, env parsing, CORS, auth for sensitive endpoints, global/create rate limits | Main API entrypoint |
| `backend-node/src/provisioner.ts` | Background reconcile loop for Provisioning/Deleting, retries, status transitions, readiness gates | Core orchestration brain |
| `backend-node/src/kube.ts` | Kubernetes client factory + all K8s CRUD helpers + Helm Job templates + wait helpers | Infra abstraction layer |
| `backend-node/src/db.ts` | SQLite schema/bootstrap and event insert helper | Source of truth for desired/observed state |
| `backend-node/src/lease.ts` | Per-store lease columns and claim/release logic | Prevents concurrent workers from racing on same store |
| `backend-node/src/leader.ts` | Leader lock table and leader lease | Single active reconciler semantics |
| `backend-node/src/secrets.ts` | Password generation, K8s Secret upsert, local secret persistence table | Secret lifecycle handling |
| `backend-node/src/engine.ts` | Engine-specific Helm values generation (WooCommerce implemented, Medusa stubbed) | Extensibility point for new engines |
| `backend-node/src/namespace.ts` | Wait helper for namespace deletion completion | Cleanup reliability |
| `backend-node/src/metrics.ts` | Aggregates event-based metrics and renders Prometheus text | Observability |
| `backend-node/src/ratelimit.ts` | In-memory token-bucket limiter implementation | API hardening |
| `backend-node/src/ai.ts` | Optional content-suggestion call to Groq/OpenAI-compatible endpoint with fallback | Non-critical enhancement path |
| `backend-node/src/readiness.ts` | Generic deployment/ingress readiness helpers (legacy helper style) | Reference utility; main flow uses `kube.ts` waits |
| `backend-node/src/better-sqlite3.d.ts` | TS module declaration shim | Build/type support |
| `backend-node/package.json` | Node scripts and dependencies | Shows runtime stack |
| `backend-node/tsconfig.json` | TypeScript compiler config | Strictness and output layout |
| `backend-node/Dockerfile` | Build + runtime container image for API (non-root, `/data` mount) | Container hardening choices |

### Dashboard (`dashboard`)

| File | What it does | Interview note |
|---|---|---|
| `dashboard/src/App.tsx` | Full UI logic: polling, API fallback candidates, create/delete flows, status/event views, error banners | Primary frontend behavior |
| `dashboard/src/App.css` | Main visual system and component styles | Demonstrates UI/UX polish |
| `dashboard/src/index.css` | Global styles and font setup | App-wide visual baseline |
| `dashboard/src/main.tsx` | React mount/bootstrap | Standard Vite entrypoint |
| `dashboard/vite.config.ts` | Dev proxy (`/api` -> target API) and Vite config | Local dev connectivity |
| `dashboard/package.json` | Frontend scripts and dependencies | Toolchain overview |
| `dashboard/index.html` | Vite HTML shell | Static bootstrap |
| `dashboard/Dockerfile` | Multi-stage build: Vite build -> Nginx static serve | Production frontend container |
| `dashboard/README.md` | Dashboard-specific connectivity notes | Useful for local debug |
| `dashboard/eslint.config.js` | Linting config | Code quality setup |
| `dashboard/tsconfig*.json` | TS configs for app/node builds | Build typing details |
| `dashboard/public/vite.svg`, `dashboard/src/assets/react.svg` | Static assets | Non-critical |

### Helm platform chart (`charts/platform`)

| File | What it does | Interview note |
|---|---|---|
| `charts/platform/Chart.yaml` | Chart metadata | Helm packaging basics |
| `charts/platform/values.yaml` | Default values for API/dashboard/global | Base deployment profile |
| `charts/platform/values-local.yaml` | Minikube/local overrides | Local reproducibility |
| `charts/platform/values-prod.yaml` | Production-oriented overrides | Environment separation |
| `charts/platform/templates/_helpers.tpl` | Naming helpers | Templating conventions |
| `charts/platform/templates/api-deployment.yaml` | API deployment and PVC | Runtime pod config and persistence |
| `charts/platform/templates/api-service.yaml` | API service (80 -> 8000) | In-cluster access |
| `charts/platform/templates/api-ingress.yaml` | Host-based API ingress | External exposure |
| `charts/platform/templates/api-rbac.yaml` | ServiceAccount + ClusterRole + ClusterRoleBinding for orchestration privileges | Critical permissions model |
| `charts/platform/templates/dashboard-deployment.yaml` | Dashboard deployment | Optional in-cluster UI |
| `charts/platform/templates/dashboard-service.yaml` | Dashboard service | In-cluster exposure |
| `charts/platform/templates/dashboard-ingress.yaml` | Dashboard ingress | Host routing for UI |

### Store engine chart (`charts/store-woocommerce`)

| File | What it does | Interview note |
|---|---|---|
| `charts/store-woocommerce/Chart.yaml` | Placeholder chart metadata | Historical stub |
| `charts/store-woocommerce/values.yaml` | Minimal ingress values | Current runtime actually uses Bitnami chart via Helm job |

### Legacy Python prototype (`backend`)

| File | What it does | Interview note |
|---|---|---|
| `backend/app/main.py` | FastAPI prototype orchestrator | Legacy path, not active runtime |
| `backend/app/kube.py` | Python K8s + Helm subprocess helpers | Legacy path |
| `backend/app/models.py` | SQLAlchemy store model | Legacy path |
| `backend/app/settings.py` | Env settings for Python app | Legacy path |
| `backend/requirements.txt` | Python deps | Legacy path |
| `backend/Dockerfile` | Python API image | Legacy path |

### Scripts and operations helpers (`scripts`)

| File | What it does | Interview note |
|---|---|---|
| `scripts/demo.sh` | Simple demo flow (health/create/events) | Quick smoke in shell |
| `scripts/smoke.sh` | More complete create/wait/credentials/delete smoke | CI-like local validation helper |
| `scripts/video-run.sh` | Guided command sequence for recording/demo | Presentation automation |
| `scripts/video-commands.sh` | Companion commands for recorded walkthrough | Demo support |
| `scripts/demo.md` | Narrative demo checklist | Interview flow prep |
| `scripts/order-checklist.md` | WooCommerce order verification checklist | Functional validation |
| `scripts/k3s-install.sh` | K3s + ingress bootstrap helper | Alternative environment setup |

## 14. What to Be Ready to Explain in Interview

1. Why desired-state + reconciler is used instead of synchronous request-only provisioning.
2. Why per-store namespace isolation is combined with quota/limit/network policy.
3. Why leases and leader election are both present.
4. Why store creation is asynchronous and event-driven.
5. Why retries/backoff exist and how transient infra errors are handled.
6. Why Helm is run inside Kubernetes Jobs (and tradeoffs vs direct SDK-only deploys).
7. How RBAC is scoped and why `bind` on `admin` was needed for per-namespace rolebinding.
8. How UI handles API-base fallback and partial outages gracefully.
