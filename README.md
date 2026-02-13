## Local (Minikube)

1) Start
- minikube start
- minikube addons enable ingress
- helm repo add bitnami https://charts.bitnami.com/bitnami
- helm repo update

2) Build images
- eval $(minikube docker-env)
- docker build -t store-platform/api-node:dev backend-node

3) Install platform
- helm upgrade --install platform ./charts/platform -n platform --create-namespace -f ./charts/platform/values-local.yaml

4) Verify API
- curl http://api.127.0.0.1.nip.io/healthz

5) Create store
- curl -X POST http://api.127.0.0.1.nip.io/stores -H "content-type: application/json" -d '{"engine":"woocommerce"}'

6) Open store
- open http://store-<id>.127.0.0.1.nip.io

7) Delete store
- curl -X DELETE http://api.127.0.0.1.nip.io/stores/<id>

## Demo checklist
- Dashboard shows store list with status and URL
- Create store -> Provisioning -> Ready
- Show namespace isolation (kubectl get ns | grep store-)
- Show guardrails applied (kubectl describe quota -n store-<id>)
- Open store URL
- Delete store -> namespace removed

Note: The orchestrator/API is implemented in backend-node (Node.js). The backend/ Python directory is not used.
