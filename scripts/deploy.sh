#!/usr/bin/env bash
# Deploy (or upgrade) the whole platform on the VPS (k3s), the production twin of ops/up.ps1:
# the same three charts in the same order, with values-prod.yaml instead of values-local.yaml.
#
#   1. scripts/k3s-install.sh            (once: k3s + helm)
#   2. edit charts/*/values-prod.yaml    (domain, image tags)
#   3. create the Secrets listed below   (once; the script prints the commands if any are missing)
#   4. bash scripts/deploy.sh
#
# Every release uses `helm upgrade --install --atomic`: a failed upgrade rolls itself back
# (DESIGN §10.4). Rollback by hand: `helm history <release> -n <ns>`, `helm rollback <release> <rev> -n <ns>`.
set -euo pipefail

cd "$(dirname "$0")/.."
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
TIMEOUT="${TIMEOUT:-15m}"

fail() { echo "deploy: $*" >&2; exit 1; }

command -v kubectl >/dev/null || fail "kubectl not found (run scripts/k3s-install.sh first)"
command -v helm >/dev/null || fail "helm not found (run scripts/k3s-install.sh first)"
kubectl get nodes >/dev/null || fail "cannot reach the cluster with KUBECONFIG=$KUBECONFIG"

# Placeholders left in the prod values would publish the platform under someone else's domain
# (and register the Let's Encrypt account with an address nobody reads).
if grep -nE "^[^#]*(your-vps-domain\.com|example\.com)" charts/*/values-prod.yaml; then
  fail "replace the placeholder domains and email above in charts/*/values-prod.yaml first"
fi

# Production never lets a chart invent credentials (values-prod.yaml sets existingSecret), so they
# must exist before the install. Listed as namespace/name and the command that creates each one.
missing=0
need_secret() {  # need_secret <namespace> <name> <how to create it>
  kubectl get namespace "$1" >/dev/null 2>&1 || kubectl create namespace "$1" >/dev/null
  if ! kubectl -n "$1" get secret "$2" -o name >/dev/null 2>&1; then
    echo "missing Secret $1/$2. Create it with:"
    echo "  $3"
    missing=$((missing + 1))
  fi
}
need_secret platform gateway-enc-key \
  'kubectl -n platform create secret generic gateway-enc-key --from-literal=key=$(openssl rand -base64 32)   # back it up!'
need_secret platform platform-postgres   'kubectl -n platform create secret generic platform-postgres --from-literal=password=$(openssl rand -hex 24)   # back it up with the database'
need_secret platform platform-api-env \
  'kubectl -n platform create secret generic platform-api-env --from-literal=LLM_API_KEY=<groq key> --from-literal=ADMIN_API_KEY=$(openssl rand -hex 24)'
need_secret store-default store-default-credentials \
  'kubectl -n store-default create secret generic store-default-credentials --from-literal=mariadb-root-password=$(openssl rand -hex 16) --from-literal=mariadb-password=$(openssl rand -hex 16) --from-literal=wordpress-admin-password=$(openssl rand -hex 12) --from-literal=woo-consumer-key=ck_$(openssl rand -hex 20) --from-literal=woo-consumer-secret=cs_$(openssl rand -hex 20) --from-literal=mcp-token=$(openssl rand -hex 24)'
need_secret backups backups-credentials \
  'kubectl -n backups create secret generic backups-credentials --from-literal=rpc-secret=$(openssl rand -hex 32) --from-literal=admin-token=$(openssl rand -hex 32) --from-literal=access-key-id=GK$(openssl rand -hex 12) --from-literal=secret-access-key=$(openssl rand -hex 32)'
need_secret mcp-servers upstreams-credentials \
  'kubectl -n mcp-servers create secret generic upstreams-credentials --from-literal=notes-mcp-token=$(openssl rand -hex 24)'
[ "$missing" -eq 0 ] || fail "$missing Secret(s) missing; create them and run again"

install() {  # install <release> <chart> <namespace>
  echo "==> $1 ($2 -> namespace $3)"
  helm upgrade --install "$1" "charts/$2" -n "$3" --create-namespace \
    -f "charts/$2/values.yaml" -f "charts/$2/values-prod.yaml" \
    --atomic --timeout "$TIMEOUT"
}

# cert-manager first: its ClusterIssuer must exist before any Ingress names it, or the first
# certificates wait for the next resync (DESIGN §13.4).
helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
helm dependency build charts/cert-manager >/dev/null
install cert-manager cert-manager cert-manager

# Then the same order as ops/up.ps1. The gateway seeds its upstreams with backoff retries, so it
# doesn't matter that the store and upstreams come up after it (DESIGN §10.1).
install platform platform platform
install store-default store-woocommerce store-default
install upstreams mcp-upstreams mcp-servers
install backups backups backups
bash scripts/backup-secret.sh platform store-default
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update >/dev/null
helm dependency build charts/monitoring >/dev/null
install monitoring monitoring monitoring

domain=$(sed -n 's/^  baseDomain: "\(.*\)"/\1/p' charts/platform/values-prod.yaml)
echo
echo "Deployed. Releases:"
helm list -A
echo
echo "Dashboard: https://dashboard.${domain}"
echo "Gateway:   https://api.${domain}/mcp"
echo "Certificates: kubectl get certificates -A (READY True within a minute or two once DNS points here)"
echo "Next: open the dashboard and sign up; the first account becomes the admin."
