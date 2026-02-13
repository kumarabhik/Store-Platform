# Store Provisioning Platform (Kubernetes + Helm)

A Kubernetes-native platform that automatically provisions fully functional WooCommerce stores.
Designed to run locally on **Minikube** and in **production (k3s/VPS)** using the same Helm charts with only configuration changes.

---

# Introduction

This project is a Kubernetes-based Store Provisioning Platform that automatically creates fully functional WooCommerce stores using Helm.

The goal of this system is to safely provision multiple independent ecommerce stores with:

* Strong isolation
* Persistent storage
* Automatic provisioning and cleanup
* Recovery-safe and idempotent infrastructure

The platform demonstrates **production-style Kubernetes orchestration**, local-to-production deployability, and reliable multi-tenant store provisioning.

---

# Overview

The platform allows users to create, monitor, and delete isolated ecommerce stores from a dashboard.

Each store is deployed automatically using Kubernetes and Helm, with:

* Namespace-per-store isolation
* Persistent storage
* Secrets management
* Ingress URL for storefront access
* Idempotent provisioning and recovery
* Safe teardown and cleanup

The system follows a **desired-state reconciliation model** similar to Kubernetes controllers.

---

# Architecture

## Components

* **Dashboard (React)** — UI to create, view, and delete stores
* **API / Orchestrator (Node.js)** — Source of truth, provisioning logic, reconciliation loop
* **Helm Provisioner** — Deploys WooCommerce store using Kubernetes resources
* **SQLite** — Stores desired state, status, and activity logs

## Control Plane Flow

1. User creates store from dashboard
2. API writes desired state to database
3. Provisioner loop reconciles desired vs actual state
4. Kubernetes resources are created
5. Store becomes **Ready** with stable URL
6. User can place orders in WooCommerce
7. Delete removes all resources safely

The **database acts as the source of truth**, and the provisioner ensures the real system matches the desired state.

---

# Dashboard Overview

## Stores Section

Displays:

* Store ID
* Status (Provisioning / Ready / Failed)
* Created timestamp
* Engine (WooCommerce)
* Kubernetes namespace

Each store runs inside its own namespace, ensuring full isolation.

## Activity Section

Shows step-by-step provisioning events:

* store created
* reconcile started
* secrets created
* helm provisioning started
* ingress ready

This acts as:

* Debug log
* Audit trail
* Progress tracker

---

# Store Creation Flow

When a store is created:

1. Dashboard → API request
2. API → writes store in DB (status = Provisioning)
3. Provisioner loop detects new desired state
4. Namespace + Secrets + PVC + Helm release created
5. If success → status = Ready
6. If failure → status = Failed (error recorded)

Provisioning is **idempotent and retry-safe**.

---

# Kubernetes Resources per Store

Each store gets its own namespace containing:

* Kubernetes Secret (credentials)
* Persistent Volume Claim (data storage)
* Helm deployment (WordPress + WooCommerce)
* Service + Ingress (stable URL)

This ensures:

* Isolation
* Persistence
* Reliable networking
* Easy cleanup

---

# Idempotency & Recovery

Provisioning is safe to retry:

* Provisioner reads DB repeatedly
* Continues from last known state
* No duplicate resources created
* Recovers automatically after crash
* System converges to desired state

---

# Store Access URL

After provisioning, each store receives a stable Ingress URL:

```
http://store-<id>.<minikube-ip>.nip.io
```

`nip.io` maps domain to Minikube IP automatically.

---

# End-to-End Store Functionality

Each provisioned store is fully functional:

* Open store URL
* Add product to cart
* Checkout (Cash on Delivery test mode)
* Confirm order in WooCommerce admin

---

# Store Deletion & Cleanup

Deleting a store:

1. API marks store as **Deleting**
2. Provisioner triggers Helm uninstall
3. Namespace removed
4. All resources cleaned:

   * Pods
   * PVC
   * Secrets
   * Services
   * Ingress

---

# Security

* No hardcoded secrets
* Credentials stored in Kubernetes Secrets
* Namespace isolation per store
* Least-privilege RBAC for provisioner
* Only storefront publicly exposed

---

# Guardrails & Abuse Prevention

Each store namespace includes:

* ResourceQuota (CPU / Memory / Storage limits)
* LimitRange (safe defaults)

Prevents resource abuse and protects cluster stability.

---

# Observability & Audit

The Activity panel provides:

* Step-by-step provisioning logs
* Failure debugging
* Audit trail of actions

---

# Scaling

* API and Dashboard are stateless → horizontally scalable
* Provisioner concurrency-safe
* Stores are isolated and independent
* Guardrails prevent overload

---

# Local Setup (Minikube)

## 1. Start Cluster

```bash
minikube start
minikube addons enable ingress
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
```

## 2. Build Images

```bash
eval $(minikube docker-env)
docker build -t store-platform/api-node:dev backend-node
```

## 3. Install Platform

```bash
helm upgrade --install platform ./charts/platform \
  -n platform --create-namespace \
  -f ./charts/platform/values-local.yaml
```

## 4. Verify API

```bash
curl http://api.127.0.0.1.nip.io/healthz
```

## 5. Create Store

```bash
curl -X POST http://api.127.0.0.1.nip.io/stores \
  -H "content-type: application/json" \
  -d '{"engine":"woocommerce"}'
```

## 6. Open Store

```
http://store-<id>.127.0.0.1.nip.io
```

## 7. Delete Store

```bash
curl -X DELETE http://api.127.0.0.1.nip.io/stores/<id>
```

---

# Demo Checklist

* Dashboard shows store list and status
* Create store → Provisioning → Ready
* Namespace isolation verified

```bash
kubectl get ns | grep store-
```

* Guardrails verified

```bash
kubectl describe quota -n store-<id>
```

* Open store and place order
* Delete store → namespace removed

---

# Local → Production Deployment

Same Helm chart works for local and production.

Only change Helm values:

* Domain / DNS
* Storage class
* Ingress config
* TLS / certificates

Helm supports:

* Safe upgrades
* Rollbacks
* Versioned deployments

---

# Project Structure

```
dashboard/        React dashboard UI
backend-node/     Node.js API + orchestrator
charts/platform/  Helm chart
```

---

# Architecture Summary

This platform provides:

* Automated store provisioning
* Namespace-based isolation
* Persistent storage
* Recovery-safe reconciliation
* Secure secrets handling
* Guardrails and resource protection
* Observability and audit logs
* Safe cleanup
* Horizontal scalability
* Local-to-production compatibility

---

# Conclusion

This project demonstrates a production-style Kubernetes provisioning platform capable of automatically creating isolated, persistent, and fully functional ecommerce stores using Helm and Kubernetes-native orchestration.
