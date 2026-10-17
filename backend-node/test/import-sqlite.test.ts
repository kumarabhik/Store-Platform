import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sqliteAvailable } from "./sqlite";
import { onPostgres, testDb } from "./testDb";

// The one-time SQLite -> Postgres move (DESIGN §13.3). Needs both: run with --postgres.
describe.skipIf(!sqliteAvailable || !onPostgres)("import SQLite into Postgres", () => {
  it("copies every row with its ids, keeps sequences ahead, and refuses a second run", async () => {
    const { openDb } = await import("../src/db");
    const { createUser, createSession } = await import("../src/auth");
    const { createApiKey } = await import("../src/gateway/keys");
    const { writeAudit } = await import("../src/gateway/audit");
    const { importSqlite } = await import("../src/importSqlite");

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "import-")), "platform.db");
    const lite = openDb(file);
    const admin = await createUser(lite, { name: "Asha", email: "asha@example.com", password: "password-123" }, "admin");
    await createSession(lite, admin.id);
    const key = await createApiKey(lite, admin.id, "laptop");
    for (let i = 0; i < 3; i++) {
      await writeAudit(lite, {
        requestId: `r${i}`, userId: admin.id, userEmail: admin.email, apiKeyId: key.id, source: "mcp", serverId: null,
        serverSlug: "woo", toolName: "list_orders", exposedName: "woo__list_orders", durationMs: 4, outcome: "ok", error: null, args: {},
      });
    }
    await lite.close();

    const pg = await testDb("import");
    const result = await importSqlite(file, pg);
    expect(result).toHaveProperty("copied");
    const rows = Object.fromEntries(("copied" in result ? result.copied : []).map((c) => [c.table, c.rows]));
    expect(rows).toMatchObject({ users: 1, user_sessions: 1, api_keys: 1, audit_log: 3 });

    // The copied key still works, and the next audit row continues after the copied ids.
    const { verifyApiKey } = await import("../src/gateway/keys");
    expect((await verifyApiKey(pg, key.key))?.userId).toBe(admin.id);
    await writeAudit(pg, {
      requestId: "after", userId: admin.id, userEmail: admin.email, apiKeyId: null, source: "chat", serverId: null,
      serverSlug: null, toolName: "t", exposedName: "t", durationMs: 1, outcome: "ok", error: null, args: {},
    });
    expect(await pg.get(`select max(id) as id from audit_log`)).toEqual({ id: 4 });

    expect(await importSqlite(file, pg)).toEqual({ skipped: "Postgres already has data" });
    expect(await importSqlite(path.join(os.tmpdir(), "missing.db"), pg)).toEqual({ skipped: `no SQLite file at ${path.join(os.tmpdir(), "missing.db")}` });
    await pg.close();
  });
});
