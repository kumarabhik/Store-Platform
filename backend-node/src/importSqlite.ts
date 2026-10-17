import fs from "node:fs";
import Database from "better-sqlite3";
import type { Db } from "./db";

// One-time move of an existing SQLite database into Postgres (DESIGN §13.3). Runs as the API pod's
// init container: when Postgres has no users yet and the old SQLite file exists, every row is
// copied with its ids; otherwise it does nothing. Under a lock, so two replicas can't both copy.

// Parents before children (foreign keys). leader_lock and chat_approvals are runtime state.
const TABLES = [
  "users", "stores", "store_events", "user_sessions", "billing_accounts", "billing_invoices", "store_backups",
  "invites", "api_keys", "mcp_servers", "mcp_tools", "tool_policies", "audit_log",
];
// Tables whose id is generated: the sequence must continue after the copied ids.
const IDENTITY = ["store_events", "billing_invoices", "store_backups", "audit_log"];

export type ImportResult = { copied: { table: string; rows: number }[] } | { skipped: string };

export async function importSqlite(sqlitePath: string, pg: Db): Promise<ImportResult> {
  if (pg.dialect !== "postgres") throw new Error("Import: the target must be Postgres");
  if (!fs.existsSync(sqlitePath)) return { skipped: `no SQLite file at ${sqlitePath}` };
  const src = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    return await pg.tx(async (t) => {
      if (await t.get(`select 1 from users limit 1`)) return { skipped: "Postgres already has data" };
      const copied: { table: string; rows: number }[] = [];
      for (const table of TABLES) {
        const exists = src.prepare(`select 1 from sqlite_master where type = 'table' and name = ?`).get(table);
        if (!exists) continue;
        // Only columns both sides have: an old SQLite file may lack columns added later.
        const srcCols = (src.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
        const dstCols = (await t.all<{ column_name: string }>(
          `select column_name from information_schema.columns where table_schema = current_schema() and table_name = ?`,
          table,
        )).map((c) => c.column_name);
        const cols = srcCols.filter((c) => dstCols.includes(c));
        const rows = src.prepare(`select ${cols.join(", ")} from ${table}`).all() as Record<string, string | number | null>[];
        const insert = `insert into ${table} (${cols.join(", ")}) values (${cols.map(() => "?").join(", ")})`;
        for (const row of rows) await t.run(insert, ...cols.map((c) => row[c] ?? null));
        if (IDENTITY.includes(table)) {
          await t.get(`select setval(pg_get_serial_sequence('${table}', 'id'), (select coalesce(max(id), 0) + 1 from ${table}), false)`);
        }
        const { n } = (await t.get<{ n: number }>(`select count(*) as n from ${table}`))!;
        if (n !== rows.length) throw new Error(`Import: ${table} has ${n} rows in Postgres, ${rows.length} in SQLite`);
        copied.push({ table, rows: rows.length });
      }
      return { copied };
    }, "sqlite-import");
  } finally {
    src.close();
  }
}

// node dist/importSqlite.js /data/platform.db   (DATABASE_URL points at Postgres)
if (require.main === module) {
  void (async () => {
    const [sqlitePath] = process.argv.slice(2);
    const url = process.env.DATABASE_URL;
    if (!sqlitePath || !url) {
      console.error("usage: DATABASE_URL=postgres://… node dist/importSqlite.js <sqlite file>");
      process.exit(2);
    }
    const { openPostgres } = await import("./dbPostgres.js");
    const pg = await openPostgres(url);
    try {
      const result = await importSqlite(sqlitePath, pg);
      if ("skipped" in result) console.log(`SQLite import skipped: ${result.skipped}`);
      else for (const c of result.copied) console.log(`copied ${c.table}: ${c.rows} rows`);
    } catch (err) {
      // The pod must not start against a half-copied or empty database: fail loudly instead.
      console.error((err as Error).message);
      process.exitCode = 1;
    } finally {
      await pg.close();
    }
  })();
}
