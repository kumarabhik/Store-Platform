set -e

curl -sfL https://get.k3s.io | sh -
sudo kubectl get nodes

kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/cloud/deploy.yaml

helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
