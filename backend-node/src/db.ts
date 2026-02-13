
import Database from "better-sqlite3";


export type Db = InstanceType<typeof Database>;



export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    create table if not exists stores (
      id text primary key,
      engine text not null,
      status text not null,
      namespace text not null,
      url text,
      created_at text not null,
      updated_at text not null,
      last_error text
    );

    create table if not exists store_events (
      id integer primary key autoincrement,
      store_id text not null,
      type text not null,
      message text,
      ts text not null,
      foreign key(store_id) references stores(id) on delete cascade
    );

    create index if not exists idx_store_events_store_ts on store_events(store_id, ts desc);
    create index if not exists idx_stores_status_created on stores(status, created_at);
  `);

  try { db.exec(`alter table store_events add column actor text;`); } catch {}

  return db;
}

export function addEvent(
  db: Db,
  storeId: string,
  type: string,
  msg?: string,
  actor?: string
) {
  db.prepare(
    `insert into store_events (store_id, ts, type, message, actor)
     values (?, datetime('now'), ?, ?, ?)`
  ).run(storeId, type, msg ?? null, actor ?? null);
}
