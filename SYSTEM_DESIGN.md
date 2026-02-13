## Architecture
- Dashboard (React): calls API to create/delete stores and view status/events.
- API/Orchestrator (Node): persists desired state in SQLite and runs a reconcile loop.
- Store engine (WooCommerce): provisioned via Kubernetes Jobs that run Helm.

## Idempotency / Failure handling
- Store create is retry-safe: DB is source of truth, reconciler converges resources.
- Per-store lease prevents concurrent provisioning of the same store.
- Failures write last_error and store_events for visibility.

## Isolation / Guardrails
- Namespace per store.
- ResourceQuota + LimitRange + NetworkPolicy applied per namespace.
- Secrets per store for WP/MariaDB credentials.

## Cleanup guarantees
- Delete transitions store to Deleting.
- Helm uninstall job runs, then namespace is deleted and waited until gone.

## Local vs Production
- Same Helm charts.
- values-local.yaml: nip.io domain, minikube defaults.
- values-prod.yaml: real domain, TLS toggle, storageClass, ingress class.
