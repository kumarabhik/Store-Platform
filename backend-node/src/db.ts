import Database from "better-sqlite3";

// One small async interface over SQLite and Postgres (DESIGN §13.3). Every query in the code goes
// through it, written once in SQL both understand: `?` placeholders, `on conflict … do update`,
// `returning`. The few things that differ are named fields here (now, inSeconds), not string rewrites.
// SQLite stays the default (one file, nothing to run); DATABASE_URL=postgres://… switches to Postgres.

export type Param = string | number | null;

export interface Db {
  readonly dialect: "sqlite" | "postgres";
  // SQL for the current UTC time as "YYYY-MM-DD HH:MM:SS", the format of every *_at column.
  readonly now: string;
  // SQL for "now + ? seconds" in the same format; it takes one `?` parameter (the seconds).
  readonly inSeconds: string;
  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): Promise<T | undefined>;
  run(sql: string, ...params: Param[]): Promise<{ changes: number }>;
  // Several statements, no parameters (schema).
  exec(sql: string): Promise<void>;
  // All-or-nothing. `lock` serialises transactions that check-then-write the same rule across
  // replicas (e.g. "is there still an admin?"); SQLite runs one transaction at a time anyway.
  tx<T>(fn: (db: Db) => Promise<T>, lock?: string): Promise<T>;
  close(): Promise<void>;
}

// Postgres when DATABASE_URL is a postgres:// URL, otherwise the SQLite file at sqlitePath.
export async function openDatabase(databaseUrl: string | undefined, sqlitePath: string): Promise<Db> {
  if (databaseUrl && /^postgres(ql)?:\/\//.test(databaseUrl)) {
    const { openPostgres } = await import("./dbPostgres.js");
    return openPostgres(databaseUrl);
  }
  return openDb(sqlitePath);
}

// ---- SQLite ----

export function openDb(path: string): Db {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  migrateSqlite(raw);
  return sqliteDb(raw);
}

function sqliteDb(raw: InstanceType<typeof Database>): Db {
  // better-sqlite3 is synchronous, so one statement never interleaves with another. A transaction
  // spans several awaits, though: while one is open, queries from outside it wait until it ends,
  // so they can't land inside it (and be rolled back with it).
  let current: Promise<void> | null = null;

  const make = (inTx: boolean): Db => {
    // The wait and the statement must run in the same synchronous step: after an `await` returns,
    // another transaction could otherwise begin before the statement runs.
    const when = async <T>(statement: () => T): Promise<T> => {
      if (!inTx) while (current) await current;
      return statement();
    };
    const db: Db = {
      dialect: "sqlite",
      now: "datetime('now')",
      inSeconds: "datetime('now', '+' || ? || ' seconds')",
      all<T>(sql: string, ...params: Param[]) {
        return when(() => raw.prepare(sql).all(...params) as T[]);
      },
      get<T>(sql: string, ...params: Param[]) {
        return when(() => raw.prepare(sql).get(...params) as T | undefined);
      },
      run(sql, ...params) {
        return when(() => ({ changes: raw.prepare(sql).run(...params).changes }));
      },
      exec(sql) {
        return when(() => void raw.exec(sql));
      },
      async tx(fn) {
        if (inTx) return fn(db);
        while (current) await current;
        let end!: () => void;
        current = new Promise((resolve) => (end = resolve));
        raw.exec("begin immediate");
        try {
          const result = await fn(make(true));
          raw.exec("commit");
          return result;
        } catch (err) {
          raw.exec("rollback");
          throw err;
        } finally {
          current = null;
          end();
        }
      },
      async close() {
        raw.close();
      },
    };
    return db;
  };
  return make(false);
}

function migrateSqlite(db: InstanceType<typeof Database>) {
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

    create table if not exists leader_lock (
      name text primary key,
      owner text not null,
      lease_until text not null
    );
  `);

  // Columns added after the first release (additive only, SYSTEM.md I10).
  const addColumn = (table: string, column: string, type: string) => {
    const cols = (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(column)) db.exec(`alter table ${table} add column ${column} ${type};`);
  };
  addColumn("store_events", "actor", "text");
  for (const c of ["created_by", "name", "user_id", "custom_domain", "domain_status", "domain_last_error", "last_backup_at", "lease_owner", "lease_until"]) {
    addColumn("stores", c, "text");
  }

  migrateGateway(db, addColumn);

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
}

// MCP gateway schema (DESIGN §5). Additive only (SYSTEM.md I10): new tables and new columns, so an
// older image still runs against this database after a `helm rollback`.
function migrateGateway(db: InstanceType<typeof Database>, addColumn: (table: string, column: string, type: string) => void) {
  // Source of truth for roles (team/members.ts). ADMIN_EMAILS still promotes on login.
  addColumn("users", "role", "text not null default 'member' check (role in ('admin','member'))");
  addColumn("users", "disabled_at", "text");

  db.exec(`
    create table if not exists invites (
      id text primary key,
      email text not null,
      role text not null check (role in ('admin','member')),
      token_hash text not null unique,
      invited_by text not null references users(id),
      expires_at text not null,
      accepted_at text,
      created_at text not null default (datetime('now'))
    );

    create table if not exists api_keys (
      id text primary key,
      user_id text not null references users(id),
      name text not null,
      prefix text not null unique,
      key_hash text not null,
      created_at text not null default (datetime('now')),
      last_used_at text,
      expires_at text,
      revoked_at text,
      revoked_by text
    );

    create table if not exists mcp_servers (
      id text primary key,
      slug text not null unique check (slug glob '[a-z]*' and length(slug) <= 24),
      name text not null,
      url text not null,
      auth_type text not null default 'none' check (auth_type in ('none','bearer','header')),
      auth_header_name text,
      auth_secret_enc text,
      enabled integer not null default 1,
      timeout_ms integer not null default 15000,
      managed_by text not null default 'admin' check (managed_by in ('admin','helm','provisioner')),
      store_id text references stores(id),
      status text not null default 'Unknown',
      last_error text,
      last_ok_at text,
      last_check_at text,
      last_latency_ms integer,
      consecutive_failures integer not null default 0,
      created_at text not null default (datetime('now')),
      updated_at text not null default (datetime('now'))
    );

    create table if not exists mcp_tools (
      server_id text not null references mcp_servers(id) on delete cascade,
      name text not null,
      description text,
      input_schema text not null,
      annotations text,
      definition_hash text not null,
      approved_hash text,
      seen_at text not null,
      primary key (server_id, name)
    );

    create table if not exists tool_policies (
      server_id text not null references mcp_servers(id) on delete cascade,
      tool_name text not null,
      min_role text not null check (min_role in ('member','admin','nobody')),
      primary key (server_id, tool_name)
    );

    -- Append-only: no UPDATE or DELETE on this table anywhere in the code (SYSTEM.md I2).
    create table if not exists audit_log (
      id integer primary key autoincrement,
      ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      request_id text not null,
      user_id text not null,
      user_email text not null,
      api_key_id text,
      source text not null check (source in ('mcp','chat')),
      server_id text,
      server_slug text,
      tool_name text not null,
      exposed_name text not null,
      duration_ms integer not null,
      outcome text not null check (outcome in ('ok','tool_error','timeout','unreachable','denied','not_found','bad_request')),
      error text,
      args_preview text
    );

    -- Pending "may the chat run this tool?" questions (P10). In the database, not in memory, so the
    -- Approve click can reach any API replica, not only the one streaming the chat (DESIGN §13.3).
    create table if not exists chat_approvals (
      id text primary key,
      user_id text not null,
      decision text check (decision in ('approved','declined')),
      created_at text not null default (datetime('now')),
      decided_at text
    );

    create index if not exists idx_api_keys_user on api_keys(user_id, created_at desc);
    create index if not exists idx_invites_email on invites(email);
    create index if not exists idx_audit_ts on audit_log(ts desc);
    create index if not exists idx_audit_user on audit_log(user_id, ts desc);
  `);
}

export async function addEvent(db: Db, storeId: string, type: string, msg?: string, actor?: string) {
  await db.run(
    `insert into store_events (store_id, ts, type, message, actor) values (?, ${db.now}, ?, ?, ?)`,
    storeId, type, msg ?? null, actor ?? null,
  );
}
