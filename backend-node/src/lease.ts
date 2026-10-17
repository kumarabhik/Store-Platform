import type { Db } from "./db";

// Per-store lease, so only one reconciler works on a store at a time. The lease check is repeated in
// the outer WHERE: on Postgres two replicas can pick the same id in the subquery, and the second
// update then re-checks the row the first one just leased and changes nothing.
export async function claimOneStore(db: Db, status: "Provisioning" | "Deleting", owner: string, leaseSeconds: number) {
  const free = `(lease_until is null or lease_until < ${db.now})`;
  const res = await db.run(
    `update stores
     set lease_owner = ?, lease_until = ${db.inSeconds}, updated_at = ${db.now}
     where ${free} and id = (
       select id from stores
       where status = ? and ${free}
       order by created_at asc
       limit 1
     )`,
    owner, leaseSeconds, status,
  );
  if (res.changes === 0) return null;
  return (await db.get(`select * from stores where lease_owner = ? and status = ? order by updated_at desc limit 1`, owner, status)) ?? null;
}

export async function releaseLease(db: Db, storeId: string) {
  await db.run(`update stores set lease_owner = null, lease_until = null, updated_at = ${db.now} where id = ?`, storeId);
}
