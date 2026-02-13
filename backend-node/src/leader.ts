import type { Db } from "./db";
import os from "node:os";

export function ensureLeaderTable(db: Db) {
  db.exec(`
    create table if not exists leader_lock (
      name text primary key,
      owner text not null,
      lease_until text not null
    );
  `);
}

export function tryAcquireLeader(db: Db , name: string, leaseSeconds: number) {
  const owner = `${os.hostname()}-${process.pid}`;
  const untilExpr = `datetime('now', '+${leaseSeconds} seconds')`;

  db.prepare(`
    insert into leader_lock(name, owner, lease_until)
    values(?, ?, ${untilExpr})
    on conflict(name) do update set
      owner=excluded.owner,
      lease_until=${untilExpr}
    where leader_lock.lease_until < datetime('now') or leader_lock.owner = excluded.owner
  `).run(name, owner);

  const row = db.prepare(`select owner, lease_until from leader_lock where name=?`).get(name) as any;
  return row?.owner === owner;
}
