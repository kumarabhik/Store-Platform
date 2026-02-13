import type Database from "better-sqlite3";
import type { Db } from "./db";

export function computeMetrics(db: Db) {
  const created = db.prepare(`select count(*) as c from store_events where type='created'`).get().c as number;
  const ready = db.prepare(`select count(*) as c from store_events where type='ready'`).get().c as number;
  const failed = db.prepare(`select count(*) as c from store_events where type='failed'`).get().c as number;
  const deleted = db.prepare(`select count(*) as c from store_events where type='deleted'`).get().c as number;

  return { created, ready, failed, deleted };
}

export function renderPrometheus(m: { created: number; ready: number; failed: number; deleted: number }) {
  return [
    `stores_created_total ${m.created}`,
    `store_provision_success_total ${m.ready}`,
    `store_provision_failed_total ${m.failed}`,
    `store_deleted_total ${m.deleted}`,
  ].join("\n") + "\n";
}
