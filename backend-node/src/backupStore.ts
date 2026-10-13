// Per-store access to the backup store (Garage, DESIGN §13.6). Each provisioned store gets its own
// bucket "store-<id>" and its own S3 key that may read and write only that bucket, so a compromised
// store namespace can't touch another store's backups (THREAT_MODEL known gap, closed). Deleting the
// store deletes its key; the bucket and its backups are kept so a deleted store can still be restored.

export interface GarageAdminOptions {
  // Garage admin API (v1), e.g. http://garage.backups.svc.cluster.local:3903/v1
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface StoreBackupKey {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export const storeBucket = (storeId: string) => `store-${storeId}`;
export const storeKeyName = (storeId: string) => `store-${storeId}`;

export function createGarageAdmin(opts: GarageAdminOptions) {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = [200]): Promise<{ status: number; data: T | null }> {
    const res = await f(`${opts.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!okStatuses.includes(res.status)) {
      throw new Error(`Backup store: ${method} ${path} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    return { status: res.status, data: text ? (JSON.parse(text) as T) : null };
  }

  async function findKeyId(name: string): Promise<string | null> {
    const { data } = await call<{ id: string; name: string }[]>("GET", "/key");
    return data?.find((k) => k.name === name)?.id ?? null;
  }

  return {
    // Idempotent: reuses the store's key and bucket if they exist (a retried provisioning).
    async ensureStoreKey(storeId: string): Promise<StoreBackupKey> {
      const name = storeKeyName(storeId);
      const bucketAlias = storeBucket(storeId);

      const existingId = await findKeyId(name);
      const key = existingId
        ? (await call<{ accessKeyId: string; secretAccessKey: string }>("GET", `/key?id=${existingId}&showSecretKey=true`)).data!
        : (await call<{ accessKeyId: string; secretAccessKey: string }>("POST", "/key", { name })).data!;

      let bucket = await call<{ id: string }>("GET", `/bucket?globalAlias=${bucketAlias}`, undefined, [200, 404]);
      if (bucket.status === 404) bucket = await call<{ id: string }>("POST", "/bucket", { globalAlias: bucketAlias });

      await call("POST", "/bucket/allow", {
        bucketId: bucket.data!.id,
        accessKeyId: key.accessKeyId,
        permissions: { read: true, write: true, owner: false },
      });
      return { bucket: bucketAlias, accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey };
    },

    // Deleting the key is enough to cut the store off; the bucket stays as the store's last backups.
    async revokeStoreKey(storeId: string): Promise<boolean> {
      const id = await findKeyId(storeKeyName(storeId));
      if (!id) return false;
      await call("DELETE", `/key?id=${id}`, undefined, [200, 204]);
      return true;
    },
  };
}

export type GarageAdmin = ReturnType<typeof createGarageAdmin>;
