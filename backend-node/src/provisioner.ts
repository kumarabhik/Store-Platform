import * as dns from "node:dns/promises";
import type { Db } from "./db";
import { addEvent } from "./db";
import type { KubeClients } from "./kube";
import { ensureLeaseColumnsSafe, claimOneStore, releaseLease } from "./lease";
import {
  ensureNamespace,
  ensureNamespaceHelmAccess,
  applyResourceQuota,
  applyLimitRange,
  applyNetworkPolicy,
  applyHelmJob,
  applyHelmUninstallJob,
  waitForJob,
  deleteNamespace,
  waitForAnyDeploymentAvailable,
  waitForDeploymentAvailable,
  type ApiServerEndpoint,
} from "./kube";
import { buildEngineValues, CHART_DIR } from "./engine";
import { waitForNamespaceGone } from "./namespace";
import { ensureLeaderTable, tryAcquireLeader } from "./leader";

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      // Don't follow redirects: WordPress answers 301 to its public URL, which from inside the cluster
      // may not resolve or be reachable (local: 127.0.0.1:8088). A redirect already proves it's alive.
      const res = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal }).finally(() =>
        clearTimeout(timeout)
      );
      if (res.status >= 200 && res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function namespaceExists(kube: KubeClients, ns: string): Promise<boolean> {
  try {
    await kube.core.readNamespace(ns);
    return true;
  } catch (e: any) {
    const code = e?.statusCode ?? e?.response?.statusCode ?? e?.response?.status;
    if (code === 404) return false;
    throw e;
  }
}

function getRetryCount(db: Db, storeId: string): number {
  const row = db
    .prepare(`select count(*) as c from store_events where store_id=? and type='retry_scheduled'`)
    .get(storeId) as { c: number } | undefined;
  return row?.c ?? 0;
}

function isRetryableProvisioningError(msg: string): boolean {
  const normalized = msg.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("job failed") ||
    normalized.includes("http request failed") ||
    normalized.includes("connection refused") ||
    normalized.includes("ingress controller not ready") ||
    normalized.includes("eof") ||
    normalized.includes("tls handshake") ||
    normalized.includes("mcp registration")
  );
}

type Config = {
  baseDomain: string;
  ingressClassName: string;
  // Image with helm and charts/store-woocommerce at /chart (DESIGN §11).
  chartImage: string;
  // Which of the chart's values files to apply: "local" or "prod".
  chartEnv: string;
  apiServer: ApiServerEndpoint[];
  // ClusterRole bound for the Helm job in each store namespace (ROADMAP S6).
  installerRole: string;
  storePublicScheme?: string;
  storePublicPort?: string;
};

// What the gateway does around a store's lifecycle (DESIGN §11): register the store's own MCP
// server once it is Ready, and remove it before anything is torn down.
export type StoreHooks = {
  onReady(store: { id: string; name: string; namespace: string; release: string }): Promise<void>;
  onRemove(storeId: string): Promise<void>;
};

type StoreRow = {
  id: string;
  namespace: string;
  custom_domain?: string | null;
  status: "Provisioning" | "Deleting" | string;
};

async function resolveDomainStatus(domain: string, targetHost: string) {
  try {
    const cname = await dns.resolveCname(domain);
    if (cname.some((value) => value.replace(/\.$/, "") === targetHost.replace(/\.$/, ""))) {
      return "Verified";
    }
  } catch {}

  try {
    const records = await dns.lookup(domain, { all: true });
    if (records.length > 0) return "Configured";
  } catch {}

  return "Awaiting DNS";
}

export function startReconciler(db: Db, kube: KubeClients, cfg: Config, hooks?: StoreHooks): () => void {
  const tickMs = 2000;
  const helmInstallTimeoutMs = 20 * 60 * 1000;
  ensureLeaseColumnsSafe(db);
  const owner = `reconciler-${process.pid}`;
  ensureLeaderTable(db);
  let running = false;
  const platformStoreUrlFor = (host: string, includePort = true) =>
    `${cfg.storePublicScheme?.trim() || "http"}://${host}${includePort && cfg.storePublicPort?.trim() ? `:${cfg.storePublicPort.trim()}` : ""}`;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const leader = tryAcquireLeader(db, "reconciler", 15);
      if (!leader) return;

      const del = claimOneStore(db, "Deleting", owner, 60) as any;

      if (del) {
        const storeId = del.id as string;
        const ns = del.namespace as string;

        try {
          // Tools first: clients must stop seeing the store before its pods go away.
          await hooks?.onRemove(storeId);
          const exists = await namespaceExists(kube, ns);
          if (!exists) {
            addEvent(db, storeId, "delete_skip_missing_namespace", ns);
            db.prepare(`delete from stores where id=?`).run(storeId);
            return;
          }

          addEvent(db, storeId, "delete_reconcile_start", `ns=${ns}`);
          await ensureNamespaceHelmAccess(kube.rbac, ns, cfg.installerRole);

          const release = `wc-${storeId}`;
          const jobName = `helm-uninstall-${storeId}`;

          addEvent(db, storeId, "helm_uninstall_job_create", `release=${release}`);

          await applyHelmUninstallJob(kube.batch, ns, jobName, { image: cfg.chartImage, release });

          const res = await waitForJob(kube.batch, ns, jobName, 10 * 60 * 1000);
          if (!res.ok) throw new Error(res.reason);

          addEvent(db, storeId, "helm_uninstalled");

          addEvent(db, storeId, "namespace_delete", ns);
          await deleteNamespace(kube.core, ns);

          const gone = await waitForNamespaceGone(kube.core, ns, 2 * 60 * 1000);
          if (!gone) throw new Error("namespace deletion timeout");

          db.prepare(`delete from stores where id=?`).run(storeId);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          db.prepare(
            `update stores
             set last_error=?, updated_at=datetime('now')
             where id=?`
          ).run(msg, storeId);
          addEvent(db, storeId, "delete_failed", msg);
          releaseLease(db, storeId);
        }

        return;
      }

      const row = claimOneStore(db, "Provisioning", owner, 60) as any;
      if (!row) return;

      const storeId = row.id as string;
      const ns = row.namespace as string;

      try {
        const defaultHost = `store-${storeId}.${cfg.baseDomain}`;
        const customDomain = String(row.custom_domain ?? "").trim();
        const host = customDomain || defaultHost;
        const url = customDomain ? platformStoreUrlFor(host, false) : platformStoreUrlFor(host, true);

        addEvent(db, storeId, "reconcile_start", `ns=${ns} host=${host}`);

        await ensureNamespace(kube.core, ns);
        await ensureNamespaceHelmAccess(kube.rbac, ns, cfg.installerRole);
        await applyResourceQuota(kube.core, ns);
        await applyLimitRange(kube.core, ns);
        await applyNetworkPolicy(kube.net, ns, cfg.apiServer);

        addEvent(db, storeId, "guardrails_applied");

        const release = `wc-${storeId}`;
        const jobName = `helm-install-${storeId}`;

        const engine = row.engine as "woocommerce" | "medusa";
        const built = buildEngineValues({
          engine,
          ingressClassName: cfg.ingressClassName,
          host,
          publicUrl: url,
          storeName: String(row.name ?? "").trim() || `Store ${storeId}`,
        });

        if (built.stubbed) throw new Error(built.reason);

        if (cfg.ingressClassName === "nginx") {
          const ingressReady = await waitForDeploymentAvailable(
            kube.apps,
            "ingress-nginx",
            "ingress-nginx-controller",
            2 * 60 * 1000
          );
          if (!ingressReady) throw new Error("ingress controller not ready");
        }

        // After an API restart the previous attempt's job may still be running; then we wait for it.
        const job = await applyHelmJob(kube.batch, ns, jobName, {
          image: cfg.chartImage,
          release,
          chartDir: CHART_DIR,
          envValues: cfg.chartEnv,
          valuesYaml: built.valuesYaml,
        });
        addEvent(db, storeId, job === "attached" ? "helm_job_attached" : "helm_job_create", `release=${release}`);

        const res = await waitForJob(kube.batch, ns, jobName, helmInstallTimeoutMs);
        if (!res.ok) throw new Error(res.reason);

        addEvent(db, storeId, "helm_installed");

        const ok = await waitForAnyDeploymentAvailable(
          kube.apps,
          ns,
          `app.kubernetes.io/instance=${release}`,
          10 * 60 * 1000
        );
        if (!ok) throw new Error("k8s readiness gate failed");

        const serviceUrl = `http://${release}-wordpress.${ns}.svc.cluster.local`;
        const reachable = await waitForHttp(serviceUrl, 5 * 60 * 1000);
        if (!reachable) throw new Error("store service not reachable yet");

        const domainStatus = customDomain ? await resolveDomainStatus(customDomain, defaultHost) : "Platform subdomain";

        // Its own woo-mcp becomes store_<id>__* tools. Idempotent, so a restart here just redoes it.
        if (hooks) {
          try {
            await hooks.onReady({ id: storeId, name: String(row.name ?? storeId), namespace: ns, release });
          } catch (err: any) {
            throw new Error(`mcp registration failed: ${String(err?.message ?? err)}`);
          }
          addEvent(db, storeId, "mcp_registered", `store_${storeId}`);
        }

        db.prepare(
          `update stores
           set status='Ready', url=?, domain_status=?, domain_last_error=null, updated_at=datetime('now'), last_error=null
           where id=?`
        ).run(url, domainStatus, storeId);

        addEvent(db, storeId, "ready", url);
        releaseLease(db, storeId);
      } catch (e: any) {
        const msg = String(e?.message ?? e);

        const retryCount = getRetryCount(db, storeId);
        const maxRetries = 5;

        if (isRetryableProvisioningError(msg) && retryCount < maxRetries) {
          const delaySeconds = Math.min(30 * Math.pow(2, retryCount), 300);
          db.prepare(
            `update stores
             set status='Provisioning',
                 last_error=?,
                 lease_owner=null,
                 lease_until=datetime('now', '+' || ? || ' seconds'),
                 updated_at=datetime('now')
             where id=?`
          ).run(msg, delaySeconds, storeId);

          addEvent(
            db,
            storeId,
            "retry_scheduled",
            `attempt=${retryCount + 1} delay_sec=${delaySeconds} reason=${msg}`
          );
          return;
        }

        db.prepare(
          `update stores
           set status='Failed',
               last_error=?,
               domain_last_error=case when custom_domain is not null and trim(custom_domain) <> '' then ? else domain_last_error end,
               updated_at=datetime('now')
           where id=?`
        ).run(msg, msg, storeId);

        addEvent(db, storeId, "failed", msg);
        releaseLease(db, storeId);
      }
    } finally {
      running = false;
    }
  }, tickMs);

  if (typeof (timer as any).unref === "function") {
    (timer as any).unref();
  }

  return () => clearInterval(timer);
}
