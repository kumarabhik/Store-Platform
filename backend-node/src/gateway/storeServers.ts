import type { Db } from "../db";
import type { HealthChecker } from "./health";
import type { MinRole } from "./policy";
import type { Registry } from "./registry";
import type { UpstreamPool } from "./upstreams";

// Each provisioned store runs its own woo-mcp; the gateway registers it as server store_<id>, so
// its tools appear as store_<id>__list_orders next to the default store's woo__list_orders
// (DESIGN §11). The registry treats these rows as managed_by='provisioner'.

export interface StoreServerDeps {
  db: Db;
  registry: Registry;
  health: HealthChecker;
  pool: UpstreamPool;
  // Reads one key of a Secret through the Kubernetes API (the same path as the Helm seeds).
  readSecret: (namespace: string, name: string, key: string) => Promise<string>;
}

export interface ProvisionedStore {
  id: string;
  name: string;
  namespace: string;
  release: string;
}

export const storeSlug = (storeId: string) => `store_${storeId}`;

// Same rule as the default store's seed entry (values GATEWAY_SEED_SERVERS): members may read a
// store, only admins may change it. Applied when the store's server is first registered; an admin
// can change it per tool later, and a re-registration (restart, retry) never undoes that.
export const STORE_TOOL_POLICIES: Record<string, MinRole> = { create_product: "admin", update_order_status: "admin" };

// Service names come from charts/store-woocommerce: <release>-woo-mcp, and the token is the
// release Secret's mcp-token, which only woo-mcp and the gateway ever read.
export const storeServerUrl = (s: ProvisionedStore) => `http://${s.release}-woo-mcp.${s.namespace}.svc.cluster.local/mcp`;

// Idempotent: a reconciler that restarts after registering just updates the same row.
export async function registerStoreServer(deps: StoreServerDeps, store: ProvisionedStore): Promise<string> {
  const slug = storeSlug(store.id);
  const credential = await deps.readSecret(store.namespace, `${store.release}-credentials`, "mcp-token");
  const fields = { name: `Store: ${store.name}`.slice(0, 80), url: storeServerUrl(store), auth_type: "bearer" as const, credential };

  const existing = deps.registry.getBySlug(slug);
  if (existing) {
    if (existing.store_id !== store.id) {
      throw new Error(`Gateway: slug '${slug}' is already used by a server that doesn't belong to store ${store.id}`);
    }
    await deps.registry.update(existing.id, fields);
    deps.pool.drop(existing.id);
    deps.health.reschedule(existing.id);
    return existing.id;
  }
  const created = await deps.registry.create({ slug, ...fields }, "provisioner", store.id);
  deps.registry.ensureToolPolicies(created.id, STORE_TOOL_POLICIES);
  deps.health.reschedule(created.id);
  return created.id;
}

// Removes every gateway server that belongs to the store. Called before teardown starts, so
// clients lose the tools at once instead of seeing them fail while the pods go away.
export function removeStoreServers(deps: Pick<StoreServerDeps, "db" | "registry" | "pool">, storeId: string): number {
  const rows = deps.db.prepare(`select id from mcp_servers where store_id = ?`).all(storeId) as { id: string }[];
  for (const { id } of rows) {
    deps.registry.delete(id);
    deps.pool.drop(id);
  }
  return rows.length;
}
