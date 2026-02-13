import type { Db } from "./db";

export function ensureLeaseColumns(db: Db) {
  db.exec(`alter table stores add column lease_owner text;`);
  db.exec(`alter table stores add column lease_until text;`);
}
export function ensureLeaseColumnsSafe(db: Db) {
  const cols = db.prepare(`pragma table_info(stores)`).all().map((r: any) => r.name as string);
  if (!cols.includes("lease_owner")) db.exec(`alter table stores add column lease_owner text;`);
  if (!cols.includes("lease_until")) db.exec(`alter table stores add column lease_until text;`);
}


export function claimOneStore(
  db: Db,
  status: "Provisioning" | "Deleting",
  owner: string,
  leaseSeconds: number
) {
  const until = `datetime('now', '+${leaseSeconds} seconds')`;
  const res = db
    .prepare(
      `
      update stores
      set lease_owner=?, lease_until=${until}, updated_at=datetime('now')
      where id = (
        select id from stores
        where status=?
          and (lease_until is null or lease_until < datetime('now'))
        order by created_at asc
        limit 1
      )
      `
    )
    .run(owner, status);

  if (res.changes === 0) return null;

  const row = db
    .prepare(`select * from stores where lease_owner=? and status=? order by updated_at desc limit 1`)
    .get(owner, status);

  return row ?? null;
}

export function releaseLease(db: Db, storeId: string) {
  db.prepare(
    `update stores set lease_owner=null, lease_until=null, updated_at=datetime('now') where id=?`
  ).run(storeId);
}
