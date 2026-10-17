import type { Db } from "./db";

export async function computeMetrics(db: Db) {
  const count = async (type: string) =>
    (await db.get<{ c: number }>(`select count(*) as c from store_events where type = ?`, type))?.c ?? 0;
  return { created: await count("created"), ready: await count("ready"), failed: await count("failed"), deleted: await count("deleted") };
}

export function renderPrometheus(m: { created: number; ready: number; failed: number; deleted: number }) {
  return [
    `stores_created_total ${m.created}`,
    `store_provision_success_total ${m.ready}`,
    `store_provision_failed_total ${m.failed}`,
    `store_deleted_total ${m.deleted}`,
  ].join("\n") + "\n";
}
