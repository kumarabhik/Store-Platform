import * as k8s from "@kubernetes/client-node";

export type KubeClients = {
  core: k8s.CoreV1Api;
  batch: k8s.BatchV1Api;
  net: k8s.NetworkingV1Api;
  apps: k8s.AppsV1Api;
  rbac: k8s.RbacAuthorizationV1Api;
};

function statusCodeOf(e: any): number | undefined {
  return e?.statusCode ?? e?.response?.statusCode ?? e?.response?.status;
}

export function makeKubeClients(): KubeClients {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    net: kc.makeApiClient(k8s.NetworkingV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    rbac: kc.makeApiClient(k8s.RbacAuthorizationV1Api),
  };
}

export async function ensureNamespace(core: k8s.CoreV1Api, ns: string) {
  try {
    await core.readNamespace(ns);
    return;
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
  }
  await core.createNamespace({ metadata: { name: ns } } as any);
}

export async function deleteNamespace(core: k8s.CoreV1Api, ns: string) {
  try {
    await core.deleteNamespace(ns, undefined, undefined, 0);
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
  }
}

export async function applyResourceQuota(core: k8s.CoreV1Api, ns: string) {
  const name = "store-quota";
  const body: k8s.V1ResourceQuota = {
    metadata: { name },
    spec: {
      hard: {
        "requests.cpu": "2",
        "requests.memory": "2Gi",
        "limits.cpu": "4",
        "limits.memory": "4Gi",
        pods: "20",
        services: "10",
        persistentvolumeclaims: "10",
        "requests.storage": "10Gi",
      },
    },
  };

  try {
    await core.replaceNamespacedResourceQuota(name, ns, body);
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
    await core.createNamespacedResourceQuota(ns, body);
  }
}

export async function applyLimitRange(core: k8s.CoreV1Api, ns: string) {
  const name = "store-limits";
  const body: k8s.V1LimitRange = {
    metadata: { name },
    spec: {
      limits: [
        {
          type: "Container",
          defaultRequest: { cpu: "100m", memory: "128Mi" },
          default: { cpu: "500m", memory: "512Mi" } as any,
          max: { cpu: "2", memory: "2Gi" },
        } as any,
      ],
    },
  };

  try {
    await core.replaceNamespacedLimitRange(name, ns, body);
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
    await core.createNamespacedLimitRange(ns, body);
  }
}

export async function applyNetworkPolicy(net: k8s.NetworkingV1Api, ns: string) {
  const name = "default-deny";
  const body: k8s.V1NetworkPolicy = {
    metadata: { name },
    spec: {
      podSelector: {},
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [{ podSelector: {} }],
        },
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" },
              },
            },
          ],
        },
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "platform" },
              },
            },
          ],
        },
      ],
      egress: [
        {
          to: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "ingress-nginx" },
              },
            },
          ],
        },
        { to: [{ podSelector: {} }] },
        {
          to: [{ ipBlock: { cidr: "0.0.0.0/0" } }],
          ports: [
            { protocol: "TCP", port: 443 },
            { protocol: "TCP", port: 53 },
            { protocol: "UDP", port: 53 },
          ] as any,
        },
      ],
    },
  };

  try {
    await net.replaceNamespacedNetworkPolicy(name, ns, body);
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
    await net.createNamespacedNetworkPolicy(ns, body);
  }
}

export async function ensureNamespaceHelmAccess(
  rbac: k8s.RbacAuthorizationV1Api,
  ns: string,
  serviceAccountName = "default"
) {
  const name = "store-helm-admin";
  const body: k8s.V1RoleBinding = {
    metadata: { name },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "admin",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: serviceAccountName,
        namespace: ns,
      },
    ],
  };

  try {
    await rbac.replaceNamespacedRoleBinding(name, ns, body);
  } catch (e: any) {
    const code = e?.statusCode ?? e?.response?.statusCode ?? e?.response?.status;
    if (code !== 404) throw e;
    await rbac.createNamespacedRoleBinding(ns, body);
  }
}

async function deleteJobIfExists(batch: k8s.BatchV1Api, ns: string, jobName: string) {
  try {
    await batch.readNamespacedJob(jobName, ns);
    await batch.deleteNamespacedJob(jobName, ns, undefined, undefined, 0, undefined, "Foreground");
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
  }
}

export async function applyHelmJob(
  batch: k8s.BatchV1Api,
  ns: string,
  jobName: string,
  helmArgs: { valuesYaml: string; release: string; chartRef: string }
) {
  const body: k8s.V1Job = {
    metadata: { name: jobName },
    spec: {
      backoffLimit: 0,
      template: {
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "helm",
              image: "alpine/helm:3.14.4",
              command: ["sh", "-lc"],
              args: [
                [
                  "set -euo pipefail",
                  "helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true",
                  "cat > /tmp/values.yaml <<'YAML'\n" + helmArgs.valuesYaml + "\nYAML",
                  `helm upgrade --install ${helmArgs.release} ${helmArgs.chartRef} -n ${ns} -f /tmp/values.yaml`,
                ].join("\n"),
              ],
            },
          ],
        },
      },
    },
  };

  await deleteJobIfExists(batch, ns, jobName);
  await batch.createNamespacedJob(ns, body);
}

export async function applyHelmUninstallJob(
  batch: k8s.BatchV1Api,
  ns: string,
  jobName: string,
  args: { release: string }
) {
  const body: k8s.V1Job = {
    metadata: { name: jobName },
    spec: {
      backoffLimit: 0,
      template: {
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "helm",
              image: "alpine/helm:3.14.4",
              command: ["sh", "-lc"],
              args: [
                [
                  "set -euo pipefail",
                  "helm repo add bitnami https://charts.bitnami.com/bitnami >/dev/null 2>&1 || true",
                  `helm uninstall ${args.release} -n ${ns} || true`,
                ].join("\n"),
              ],
            },
          ],
        },
      },
    },
  };

  await deleteJobIfExists(batch, ns, jobName);
  await batch.createNamespacedJob(ns, body);
}

export async function waitForJob(
  batch: k8s.BatchV1Api,
  ns: string,
  jobName: string,
  timeoutMs: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = await batch.readNamespacedJob(jobName, ns);
    const s = (j as any).body?.status as k8s.V1JobStatus | undefined;
    if (s?.succeeded && s.succeeded >= 1) return { ok: true };
    if (s?.failed && s.failed >= 1) return { ok: false, reason: "job failed" };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { ok: false, reason: "timeout" };
}

export async function waitForAnyDeploymentAvailable(
  apps: any,
  ns: string,
  selector: string,
  timeoutMs: number
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = await apps.listNamespacedDeployment(ns, undefined, undefined, undefined, undefined, selector);
    const deps = (list as any).body?.items ?? [];
    const ok = deps.some((d: any) =>
      (d.status?.conditions ?? []).some((c: any) => c.type === "Available" && c.status === "True")
    );
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export async function waitForDeploymentAvailable(apps: any, ns: string, name: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await apps.readNamespacedDeployment(name, ns);
      const conditions = (res as any).body?.status?.conditions ?? [];
      const ok = conditions.some((c: any) => c.type === "Available" && c.status === "True");
      if (ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
