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
          // The client model names this field `_default` (`default` is reserved in JS). A plain
          // `default` key is silently dropped, and Kubernetes then uses `max` as every container's
          // limit, so a single store exceeds its own quota (SYSTEM.md L32).
          _default: { cpu: "500m", memory: "512Mi" },
          max: { cpu: "2", memory: "2Gi" },
        },
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

// Address of the Kubernetes API server as pods reach it (after kube-proxy's rewrite), e.g.
// 192.168.49.2:8443 on minikube. NetworkPolicies must name this, not the ClusterIP (SYSTEM.md L30).
export type ApiServerEndpoint = { ip: string; port: number };

// "192.168.49.2:8443,10.0.0.5:6443" (env KUBE_API_ENDPOINTS, filled by the platform chart).
export function parseApiServerEndpoints(raw: string | undefined): ApiServerEndpoint[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf(":");
      return { ip: s.slice(0, i), port: Number(s.slice(i + 1)) };
    })
    .filter((e) => /^[0-9a-f.:]+$/i.test(e.ip) && Number.isInteger(e.port) && e.port > 0);
}

// Writes Secret "backup-s3" (what the store chart's backup CronJob reads, DESIGN §13.6) with this
// store's own key and bucket on the backup store.
export async function writeBackupSecret(
  core: k8s.CoreV1Api,
  ns: string,
  v: { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }
) {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const body: k8s.V1Secret = {
    metadata: { name: "backup-s3" },
    type: "Opaque",
    data: {
      endpoint: b64(v.endpoint),
      bucket: b64(v.bucket),
      region: b64(v.region),
      "access-key-id": b64(v.accessKeyId),
      "secret-access-key": b64(v.secretAccessKey),
    },
  };
  try {
    await core.replaceNamespacedSecret("backup-s3", ns, body);
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
    await core.createNamespacedSecret(ns, body);
  }
}

// Pods of the provisioner's Helm jobs carry this label, so a policy can give them (and only them)
// access to the Kubernetes API.
export const HELM_JOB_LABELS = { "app.kubernetes.io/name": "store-helm" };

async function upsertNetworkPolicy(net: k8s.NetworkingV1Api, ns: string, body: k8s.V1NetworkPolicy) {
  const name = body.metadata!.name!;
  try {
    await net.replaceNamespacedNetworkPolicy(name, ns, body);
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
    await net.createNamespacedNetworkPolicy(ns, body);
  }
}

// Namespace guardrails for a provisioned store: deny everything by default, let every pod use
// DNS, and let only the Helm job talk to the Kubernetes API. The store chart adds its own allows
// for WordPress, MariaDB, woo-mcp and the init job (DESIGN §10.2.2), the same ones store-default uses.
export async function applyNetworkPolicy(net: k8s.NetworkingV1Api, ns: string, apiServer: ApiServerEndpoint[]) {
  await upsertNetworkPolicy(net, ns, {
    metadata: { name: "default-deny" },
    spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
  });
  await upsertNetworkPolicy(net, ns, {
    metadata: { name: "allow-dns" },
    spec: {
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ] as any,
        },
      ],
    },
  });
  // Without a known endpoint (running outside the chart), fall back to the usual API server ports.
  const rules: k8s.V1NetworkPolicyEgressRule[] = apiServer.length
    ? apiServer.map((e) => ({ to: [{ ipBlock: { cidr: `${e.ip}/32` } }], ports: [{ protocol: "TCP", port: e.port }] as any }))
    : [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }], ports: [443, 6443, 8443].map((port) => ({ protocol: "TCP", port })) as any }];
  await upsertNetworkPolicy(net, ns, {
    metadata: { name: "helm-job-to-api-server" },
    spec: { podSelector: { matchLabels: HELM_JOB_LABELS }, policyTypes: ["Egress"], egress: rules },
  });
}

// Lets the namespace's default ServiceAccount (the Helm job's) install the store chart, and nothing
// else: a RoleBinding to the narrow store-installer ClusterRole (ROADMAP S6), valid only in this namespace.
export async function ensureNamespaceHelmAccess(
  rbac: k8s.RbacAuthorizationV1Api,
  ns: string,
  roleName: string,
  serviceAccountName = "default"
) {
  const name = "store-helm-admin";
  const body: k8s.V1RoleBinding = {
    metadata: { name },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: roleName },
    subjects: [{ kind: "ServiceAccount", name: serviceAccountName, namespace: ns }],
  };

  let existing: k8s.V1RoleBinding | null = null;
  try {
    existing = (await rbac.readNamespacedRoleBinding(name, ns)).body;
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
  }
  if (existing && existing.roleRef.name === roleName) return;
  // roleRef is immutable: a store created when this bound "admin" gets its binding replaced.
  if (existing) await rbac.deleteNamespacedRoleBinding(name, ns);
  await rbac.createNamespacedRoleBinding(ns, body);
}

async function deleteJobIfExists(batch: k8s.BatchV1Api, ns: string, jobName: string) {
  try {
    await batch.readNamespacedJob(jobName, ns);
    await batch.deleteNamespacedJob(jobName, ns, undefined, undefined, 0, undefined, "Foreground");
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
  }
}

async function jobState(batch: k8s.BatchV1Api, ns: string, jobName: string): Promise<"missing" | "running" | "finished"> {
  try {
    const { body } = await batch.readNamespacedJob(jobName, ns);
    const s = body.status;
    return (s?.succeeded ?? 0) >= 1 || (s?.failed ?? 0) >= 1 ? "finished" : "running";
  } catch (e: any) {
    if (statusCodeOf(e) === 404) return "missing";
    throw e;
  }
}

// Deletion is asynchronous (the Job and its pod go away in the background), and creating a Job
// with the same name before it is gone fails with 409. So wait until it really is gone.
async function deleteJobAndWait(batch: k8s.BatchV1Api, ns: string, jobName: string, timeoutMs = 60_000) {
  try {
    await batch.deleteNamespacedJob(jobName, ns, undefined, undefined, 0, undefined, "Foreground");
  } catch (e: any) {
    if (statusCodeOf(e) !== 404) throw e;
  }
  const start = Date.now();
  while ((await jobState(batch, ns, jobName)) !== "missing") {
    if (Date.now() - start > timeoutMs) throw new Error(`Job ${ns}/${jobName} still deleting after ${timeoutMs / 1000} s (timeout)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Start the job unless an earlier attempt's job is still running: then the caller just waits for
// it. Killing a running `helm upgrade` would leave the release stuck in a pending state.
async function startJob(batch: k8s.BatchV1Api, ns: string, job: k8s.V1Job): Promise<"started" | "attached"> {
  const name = job.metadata!.name!;
  const state = await jobState(batch, ns, name);
  if (state === "running") return "attached";
  if (state === "finished") await deleteJobAndWait(batch, ns, name);
  await batch.createNamespacedJob(ns, job);
  return "started";
}

// The Helm jobs run the store-chart image (alpine/helm + charts/store-woocommerce baked in at /chart),
// as a non-root user with a read-only root filesystem; helm only needs a writable HOME (/tmp).
function helmJob(jobName: string, image: string, script: string): k8s.V1Job {
  return {
    metadata: { name: jobName, labels: HELM_JOB_LABELS },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: { labels: HELM_JOB_LABELS },
        spec: {
          restartPolicy: "Never",
          securityContext: { runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534, seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "helm",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-c"],
              args: [script],
              env: [{ name: "HOME", value: "/tmp" }],
              resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
              volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: {} }],
        },
      },
    },
  };
}

// Install or upgrade one store: chart defaults, then the environment's values file (local/prod,
// also baked into the image), then this store's own values. `helm upgrade --install` is idempotent,
// so a retry after a crash just converges. Helm waits for the store-init hook job.
export async function applyHelmJob(
  batch: k8s.BatchV1Api,
  ns: string,
  jobName: string,
  args: { image: string; release: string; chartDir: string; envValues: string; valuesYaml: string }
) {
  const rel = `${args.release} -n ${ns}`;
  const script = [
    "set -eu",
    "cat > /tmp/values.yaml <<'YAML'\n" + args.valuesYaml + "\nYAML",
    // A helm process killed mid-operation leaves the release "pending-*", and helm then refuses
    // every new operation. Recover first: undo a half-done upgrade, or remove a half-done first
    // install (its Secret and volumes are kept: resource-policy keep / volumeClaimTemplates).
    `status=$(helm status ${rel} -o json 2>/dev/null | grep -o '"status":"pending-[a-z]*"' | head -1 || true)`,
    `case "$status" in`,
    `  *pending-install*) echo "recovering: uninstall half-installed release"; helm uninstall ${rel} --wait ;;`,
    `  *pending-*) echo "recovering: roll back $status"; helm rollback ${rel} --wait ;;`,
    `esac`,
    `helm upgrade --install ${rel} ${args.chartDir} ` +
      `-f ${args.chartDir}/values.yaml -f ${args.chartDir}/values-${args.envValues}.yaml -f /tmp/values.yaml --timeout 15m`,
  ].join("\n");
  return startJob(batch, ns, helmJob(jobName, args.image, script));
}

export async function applyHelmUninstallJob(
  batch: k8s.BatchV1Api,
  ns: string,
  jobName: string,
  args: { image: string; release: string }
) {
  const script = ["set -eu", `helm uninstall ${args.release} -n ${ns} --wait || true`].join("\n");
  return startJob(batch, ns, helmJob(jobName, args.image, script));
}

export async function applyMysqlBackupJob(
  batch: k8s.BatchV1Api,
  ns: string,
  jobName: string,
  args: { release: string; secretName: string }
) {
  const body: k8s.V1Job = {
    metadata: { name: jobName },
    spec: {
      backoffLimit: 0,
      template: {
        metadata: {
          labels: { "job-name": jobName },
        },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "backup",
              image: "bitnami/mariadb:11.4.8-debian-12-r1",
              command: ["bash", "-lc"],
              args: [
                [
                  "set -euo pipefail",
                  `mysqldump --host=${args.release}-mariadb --user=root --password=\"$MARIADB_ROOT_PASSWORD\" --databases bitnami_wordpress --single-transaction --quick | gzip -9 | base64 | tr -d '\\n'`,
                ].join("\n"),
              ],
              env: [
                {
                  name: "MARIADB_ROOT_PASSWORD",
                  valueFrom: {
                    secretKeyRef: {
                      name: args.secretName,
                      key: "mariadb_root_password",
                    },
                  },
                },
              ] as any,
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

export async function findJobPodName(core: k8s.CoreV1Api, ns: string, jobName: string) {
  const list = await core.listNamespacedPod(ns, undefined, undefined, undefined, undefined, `job-name=${jobName}`);
  const pods = (list as any).body?.items ?? [];
  const pod = pods[0];
  return pod?.metadata?.name ?? null;
}

export async function readPodLogs(core: k8s.CoreV1Api, ns: string, podName: string, container = "backup") {
  const response = await (core as any).readNamespacedPodLog(
    podName,
    ns,
    container,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false
  );

  return typeof response === "string" ? response : response?.body ?? "";
}
