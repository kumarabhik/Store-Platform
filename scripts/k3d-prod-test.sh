#!/usr/bin/env bash
# Runs the PRODUCTION path (values-prod.yaml, scripts/deploy.sh, Traefik, local-path storage,
# pre-created Secrets) on a local k3s cluster made with k3d, so "same charts, values only" is
# proven without a VPS (DESIGN §13.4). It does what an operator does on a VPS:
#   1. a k3s cluster serving ports 80/443 (like the VPS)
#   2. images built locally and imported (on a VPS: pushed to GHCR by CI on a version tag)
#   3. values-prod.yaml filled in: domain and image names (done in a scratch copy, the repo is untouched)
#   4. the Secrets deploy.sh asks for
#   5. scripts/deploy.sh, unchanged
# Then run the usual checks against it:
#   API=http://api.127.0.0.1.nip.io HOST_NAME=store.127.0.0.1.nip.io PORT=80 STORE_URL=http://store.127.0.0.1.nip.io \
#     DOD_ADMIN_TOKEN=... DOD_MEMBER_TOKEN=... bash scripts/dod.sh
#   bash scripts/verify-store-isolation.sh
# Needs: docker, k3d, helm, kubectl, openssl; ports 80 and 443 free (stop minikube's port-forwards).
# Remove afterwards: k3d cluster delete prodtest; kubectl config use-context minikube
set -euo pipefail

cd "$(dirname "$0")/.."
CLUSTER="${CLUSTER:-prodtest}"
DOMAIN="${DOMAIN:-127.0.0.1.nip.io}"
TAG=prod-test
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for tool in docker k3d helm kubectl openssl; do command -v "$tool" >/dev/null || { echo "k3d-prod-test: $tool not found" >&2; exit 1; }; done

echo "==> k3s cluster '$CLUSTER' on ports 80/443"
k3d cluster list "$CLUSTER" >/dev/null 2>&1 || k3d cluster create "$CLUSTER" --servers 1 -p "80:80@loadbalancer" -p "443:443@loadbalancer" --wait
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
kubectl config use-context "k3d-$CLUSTER" >/dev/null

echo "==> images (built here; on a VPS they come from GHCR)"
images=(api-node:backend-node dashboard:dashboard woo-mcp:mcp-servers/woo-mcp notes-mcp:mcp-servers/notes-mcp
        everything-mcp:mcp-servers/everything-mcp store-chart:charts/store-woocommerce)
for spec in "${images[@]}"; do
  docker build -q -t "store-platform/${spec%%:*}:$TAG" "${spec#*:}" >/dev/null
  echo "  built ${spec%%:*}"
done
k3d image import -c "$CLUSTER" $(for spec in "${images[@]}"; do echo "store-platform/${spec%%:*}:$TAG"; done) >/dev/null

echo "==> values-prod.yaml filled in like an operator would (scratch copy)"
tar --exclude=node_modules --exclude=dist --exclude='*.tgz' -cf - charts scripts | (cd "$WORK" && tar xf -)
sed -i "s/your-vps-domain\.com/$DOMAIN/g; s/example\.com/$DOMAIN/g" "$WORK"/charts/*/values-prod.yaml
sed -i "s#ghcr.io/kumarabhik/store-platform-api:[^\"]*#store-platform/api-node:$TAG#; s#ghcr.io/kumarabhik/store-platform-dashboard:[^\"]*#store-platform/dashboard:$TAG#; s#ghcr.io/kumarabhik/store-chart:[^\"]*#store-platform/store-chart:$TAG#" "$WORK/charts/platform/values-prod.yaml"
printf '\nwooMcp:\n  image: store-platform/woo-mcp:%s\n' "$TAG" >> "$WORK/charts/store-woocommerce/values-prod.yaml"
# Let's Encrypt can't reach a laptop, so the same issuer name signs its own certificates here: the
# cert-manager install, the issuer hook and one Certificate per Ingress host are still exercised.
sed -i 's/^issuer:$/issuer:\n  type: selfSigned/' "$WORK/charts/cert-manager/values-prod.yaml"
printf '\nnotes:\n  image: store-platform/notes-mcp:%s\neverything:\n  image: store-platform/everything-mcp:%s\n' "$TAG" "$TAG" >> "$WORK/charts/mcp-upstreams/values-prod.yaml"

echo "==> Secrets (the commands deploy.sh prints; LLM key from .env.local if present)"
llm=$(grep -E '^(export +)?(LLM_API_KEY|GROQ_API_KEY)=' .env.local 2>/dev/null | head -1 | sed -E 's/^(export +)?[A-Z_]+=//' | tr -d '\r"' || true)
mk() { kubectl get namespace "$1" >/dev/null 2>&1 || kubectl create namespace "$1" >/dev/null
       kubectl -n "$1" get secret "$2" >/dev/null 2>&1 || { shift 2; kubectl "$@" >/dev/null; }; }
mk platform gateway-enc-key -n platform create secret generic gateway-enc-key --from-literal=key="$(openssl rand -base64 32)"
mk platform platform-postgres -n platform create secret generic platform-postgres --from-literal=password="$(openssl rand -hex 24)"
mk platform platform-api-env -n platform create secret generic platform-api-env --from-literal=LLM_API_KEY="$llm" --from-literal=ADMIN_API_KEY="$(openssl rand -hex 24)"
mk store-default store-default-credentials -n store-default create secret generic store-default-credentials \
  --from-literal=mariadb-root-password="$(openssl rand -hex 16)" --from-literal=mariadb-password="$(openssl rand -hex 16)" \
  --from-literal=wordpress-admin-password="$(openssl rand -hex 12)" --from-literal=woo-consumer-key="ck_$(openssl rand -hex 20)" \
  --from-literal=woo-consumer-secret="cs_$(openssl rand -hex 20)" --from-literal=mcp-token="$(openssl rand -hex 24)"
mk backups backups-credentials -n backups create secret generic backups-credentials --from-literal=rpc-secret="$(openssl rand -hex 32)" \
  --from-literal=admin-token="$(openssl rand -hex 32)" --from-literal=access-key-id="GK$(openssl rand -hex 12)" --from-literal=secret-access-key="$(openssl rand -hex 32)"
mk mcp-servers upstreams-credentials -n mcp-servers create secret generic upstreams-credentials --from-literal=notes-mcp-token="$(openssl rand -hex 24)"

echo "==> scripts/deploy.sh (unchanged)"
(cd "$WORK" && KUBECONFIG="$KUBECONFIG" bash scripts/deploy.sh)
