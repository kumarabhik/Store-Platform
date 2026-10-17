import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "../src/db";

// A fresh, empty database for one suite. SQLite by default (a temp file); with
// TEST_DATABASE_URL=postgres://… a new schema in that Postgres, so the same suites prove both
// dialects (DESIGN §13.3, scripts/test-backend.sh --postgres, CI).
export const onPostgres = !!process.env.TEST_DATABASE_URL;

export async function testDb(name = "t"): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    const schema = `t_${crypto.randomBytes(6).toString("hex")}`;
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`create schema ${schema}`);
    await client.end();
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const { openPostgres } = await import("../src/dbPostgres");
    return openPostgres(scoped.toString());
  }
  const { openDb } = await import("../src/db");
  return openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gw-")), `${name}.db`));
}
