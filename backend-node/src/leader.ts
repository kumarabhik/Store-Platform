import type { Db } from "./db";
import os from "node:os";

// One leader per lock name across all API replicas (DESIGN §13.3). The insert-or-take-over is one
// statement, so two replicas can't both win: the database decides, with its own clock.
export async function tryAcquireLeader(db: Db, name: string, leaseSeconds: number): Promise<boolean> {
  const owner = `${os.hostname()}-${process.pid}`;
  await db.run(
    `insert into leader_lock(name, owner, lease_until)
     values(?, ?, ${db.inSeconds})
     on conflict(name) do update set
       owner = excluded.owner,
       lease_until = excluded.lease_until
     where leader_lock.lease_until < ${db.now} or leader_lock.owner = excluded.owner`,
    name, owner, leaseSeconds,
  );
  const row = await db.get<{ owner: string }>(`select owner from leader_lock where name = ?`, name);
  return row?.owner === owner;
}
