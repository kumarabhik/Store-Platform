
import Database from "better-sqlite3";


export type Db = InstanceType<typeof Database>;



export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    create table if not exists stores (
      id text primary key,
      name text,
      engine text not null,
      status text not null,
      namespace text not null,
      url text,
      user_id text,
      custom_domain text,
      domain_status text,
      domain_last_error text,
      last_backup_at text,
      created_by text,
      created_at text not null,
      updated_at text not null,
      last_error text
    );

    create table if not exists store_events (
      id integer primary key autoincrement,
      store_id text not null,
      type text not null,
      message text,
      actor text,
      ts text not null,
      foreign key(store_id) references stores(id) on delete cascade
    );

    create table if not exists users (
      id text primary key,
      name text not null,
      email text not null unique,
      password_hash text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists user_sessions (
      token text primary key,
      user_id text not null,
      created_at text not null,
      expires_at text not null,
      foreign key(user_id) references users(id) on delete cascade
    );

    create table if not exists billing_accounts (
      user_id text primary key,
      provider text not null default 'stripe',
      plan_key text not null default 'growth',
      status text not null default 'inactive',
      billing_email text,
      stripe_customer_id text,
      stripe_subscription_id text,
      stripe_checkout_session_id text,
      stripe_price_id text,
      current_period_end text,
      created_at text not null,
      updated_at text not null,
      foreign key(user_id) references users(id) on delete cascade
    );

    create table if not exists billing_invoices (
      id integer primary key autoincrement,
      user_id text not null,
      provider text not null,
      external_id text,
      amount_cents integer not null default 0,
      currency text not null default 'usd',
      status text not null,
      hosted_url text,
      invoice_pdf text,
      period_start text,
      period_end text,
      created_at text not null,
      foreign key(user_id) references users(id) on delete cascade
    );

    create table if not exists store_backups (
      id integer primary key autoincrement,
      store_id text not null,
      status text not null,
      file_path text,
      file_name text,
      size_bytes integer,
      error text,
      started_at text not null,
      completed_at text,
      created_by text,
      foreign key(store_id) references stores(id) on delete cascade
    );
  `);

  try { db.exec(`alter table store_events add column actor text;`); } catch {}
  try { db.exec(`alter table stores add column created_by text;`); } catch {}
  try { db.exec(`alter table stores add column name text;`); } catch {}
  try { db.exec(`alter table stores add column user_id text;`); } catch {}
  try { db.exec(`alter table stores add column custom_domain text;`); } catch {}
  try { db.exec(`alter table stores add column domain_status text;`); } catch {}
  try { db.exec(`alter table stores add column domain_last_error text;`); } catch {}
  try { db.exec(`alter table stores add column last_backup_at text;`); } catch {}

  db.exec(`
    create index if not exists idx_store_events_store_ts on store_events(store_id, ts desc);
    create index if not exists idx_stores_status_created on stores(status, created_at);
    create index if not exists idx_stores_user_created on stores(user_id, created_at desc);
    create index if not exists idx_stores_domain_status on stores(domain_status, updated_at desc);
    create unique index if not exists idx_users_email on users(email);
    create index if not exists idx_user_sessions_user on user_sessions(user_id, expires_at desc);
    create index if not exists idx_billing_invoices_user_created on billing_invoices(user_id, created_at desc);
    create unique index if not exists idx_billing_invoices_external on billing_invoices(provider, external_id);
    create index if not exists idx_store_backups_store_started on store_backups(store_id, started_at desc);
  `);

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
