import crypto from "node:crypto";
import type Database from "better-sqlite3";
import k8s from "@kubernetes/client-node";

export function randPassword(len = 20) {
  return crypto.randomBytes(len).toString("base64url").slice(0, len);
}

export async function upsertStoreSecret(core: k8s.CoreV1Api, ns: string, name: string, data: Record<string, string>) {
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) encoded[k] = Buffer.from(v, "utf8").toString("base64");

  const body: k8s.V1Secret = {
    metadata: { name, namespace: ns },
    type: "Opaque",
    data: encoded,
  };

  try {
    await core.replaceNamespacedSecret(name, ns, body);
  } catch (e: any) {
    if (e?.response?.statusCode !== 404) throw e;
    await core.createNamespacedSecret(ns, body);
  }
}

export function ensureStoreSecretsInDb(db: InstanceType<typeof Database>, storeId: string) {
  db.exec(`
    create table if not exists store_secrets (
      store_id text primary key,
      wp_admin_password text not null,
      mariadb_root_password text not null,
      mariadb_password text not null
    );
  `);

  const row = db.prepare(`select * from store_secrets where store_id=?`).get(storeId);
  if (row) return row as any;

  const secretRow = {
    store_id: storeId,
    wp_admin_password: randPassword(18),
    mariadb_root_password: randPassword(20),
    mariadb_password: randPassword(18),
  };

  db.prepare(
    `insert into store_secrets(store_id, wp_admin_password, mariadb_root_password, mariadb_password)
     values(?,?,?,?)`
  ).run(
    secretRow.store_id,
    secretRow.wp_admin_password,
    secretRow.mariadb_root_password,
    secretRow.mariadb_password
  );

  return secretRow;
}
