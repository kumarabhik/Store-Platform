import type { Db } from "./db";
import { addEvent } from "./db";
import type { KubeClients } from "./kube";
import { ensureLeaseColumns, claimOneStore, releaseLease } from "./lease";
import {
  ensureNamespace,
  applyResourceQuota,
  applyLimitRange,
  applyNetworkPolicy,
  applyHelmJob,
  applyHelmUninstallJob,
  waitForJob,
  deleteNamespace,
  waitForAnyDeploymentAvailable,
} from "./kube";
import { ensureStoreSecretsInDb, upsertStoreSecret } from "./secrets";
import { buildEngineValues } from "./engine";
import { waitForNamespaceGone } from "./namespace";
import { ensureLeaderTable, tryAcquireLeader } from "./leader";



async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status >= 200 && res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

type Config = {
  baseDomain: string;
  ingressClassName: string;
  chartRef: string;
};

type StoreRow = {
  id: string;
  namespace: string;
  status: "Provisioning" | "Deleting" | string;
};

export function startReconciler(db: Db, kube: KubeClients, cfg: Config) {
  const tickMs = 2000;
  try { ensureLeaseColumns(db); } catch {}
  const owner = `reconciler-${process.pid}`;
    ensureLeaderTable(db);
    setInterval(async () => {
      const leader = tryAcquireLeader(db, "reconciler", 15);
      if (!leader) return;

      const del = claimOneStore(db, "Deleting", owner, 60) as any;


    if (del) {
      const storeId = del.id as string;
      const ns = del.namespace as string;


      try {
        addEvent(db, storeId, "delete_reconcile_start", `ns=${ns}`);

        const release = `wc-${storeId}`;
        const jobName = `helm-uninstall-${storeId}`;

        addEvent(db, storeId, "helm_uninstall_job_create", `release=${release}`);

        await applyHelmUninstallJob(kube.batch, ns, jobName, { release });

        const res = await waitForJob(kube.batch, ns, jobName, 10 * 60 * 1000);
        if (!res.ok) throw new Error(res.reason);

        addEvent(db, storeId, "helm_uninstalled");

        addEvent(db, storeId, "namespace_delete", ns);
        await deleteNamespace(kube.core, ns);

        const gone = await waitForNamespaceGone(kube.core, ns, 2 * 60 * 1000);
        if (!gone) throw new Error("namespace deletion timeout");

        db.prepare(`delete from stores where id=?`).run(storeId);
        addEvent(db, storeId, "deleted");
        releaseLease(db, storeId);

        
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
      const host = `store-${storeId}.${cfg.baseDomain}`;
      const url = `http://${host}`;

      addEvent(db, storeId, "reconcile_start", `ns=${ns} host=${host}`);

      await ensureNamespace(kube.core, ns);
      await applyResourceQuota(kube.core, ns);
      await applyLimitRange(kube.core, ns);
      await applyNetworkPolicy(kube.net, ns);

      addEvent(db, storeId, "guardrails_applied");

      const sec = ensureStoreSecretsInDb(db, storeId);
      const secretName = `store-secrets-${storeId}`;

      await upsertStoreSecret(kube.core, ns, secretName, {
        wp_admin_password: sec.wp_admin_password,
        mariadb_root_password: sec.mariadb_root_password,
        mariadb_password: sec.mariadb_password,
      });
      addEvent(db, storeId, "secret_ready", secretName);

      const release = `wc-${storeId}`;
      const jobName = `helm-install-${storeId}`;

      
      const engine = row.engine as "woocommerce" | "medusa";
      const built = buildEngineValues({
        engine,
        ingressClassName: cfg.ingressClassName,
        host,
        secretName,
      });

      if (built.stubbed) throw new Error(built.reason);

      const chartRef = built.chartRef;
      const valuesYaml = built.valuesYaml;

      addEvent(db, storeId, "helm_job_create", `release=${release}`);

      await applyHelmJob(kube.batch, ns, jobName, {
        release,
        chartRef,
        valuesYaml,
      });

      const res = await waitForJob(kube.batch, ns, jobName, 10 * 60 * 1000);
      if (!res.ok) throw new Error(res.reason);

      
      addEvent(db, storeId, "helm_installed");

      const ok = await waitForAnyDeploymentAvailable(
        kube.apps,
        ns,
        `app.kubernetes.io/instance=${release}`,
        4 * 60 * 1000
      );
      if (!ok) throw new Error("k8s readiness gate failed");

      const reachable = await waitForHttp(url, 2 * 60 * 1000);
      if (!reachable) throw new Error("store ingress not reachable yet");

      db.prepare(
        `update stores
         set status='Ready', url=?, updated_at=datetime('now'), last_error=null
         where id=?`
      ).run(url, storeId);

      addEvent(db, storeId, "ready", url);
      releaseLease(db, storeId);
    } catch (e: any) {
      const msg = String(e?.message ?? e);

      db.prepare(
        `update stores
         set status='Failed', last_error=?, updated_at=datetime('now')
         where id=?`
      ).run(msg, storeId);

      addEvent(db, storeId, "failed", msg);
      releaseLease(db, storeId);

    }
  }, tickMs);
}
    
