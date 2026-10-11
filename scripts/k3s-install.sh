#!/usr/bin/env bash
# One-time VPS setup: k3s (with its built-in Traefik ingress controller) and helm.
# ingress-nginx is not installed: it is end-of-life (SYSTEM.md G6) and would fight Traefik for
# ports 80/443. Then deploy with scripts/deploy.sh.
set -euo pipefail

curl -sfL https://get.k3s.io | sh -
sudo kubectl get nodes

if ! command -v helm >/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

# The provisioner's legacy store chart (bonus stores) still comes from Bitnami (ROADMAP B).
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Let the current user run kubectl/helm without sudo.
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$(id -u):$(id -g)" ~/.kube/config
echo "k3s ready. Next: edit charts/*/values-prod.yaml, then bash scripts/deploy.sh"
