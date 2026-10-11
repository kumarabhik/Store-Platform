import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAvailable } from "./sqlite";

// Loaded lazily so the module isn't required on hosts where the native addon can't load.
const load = async () => {
  const { openDb } = await import("../src/db");
  const { createRegistry, RegistryError } = await import("../src/gateway/registry");
  return { openDb, createRegistry, RegistryError };
};

const policy = { internalHosts: ["*.mcp-servers.svc.cluster.local", "*.store-*.svc.cluster.local"], deniedIps: [] };
const resolvesTo = (ip: string) => async () => [{ address: ip, family: 4 }];
const key = crypto.randomBytes(32);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-db-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!sqliteAvailable)("gateway migrations", () => {
  it("upgrade an existing database additively and keep its rows; running twice is a no-op", async () => {
    const { openDb } = await load();
    const file = path.join(dir, "platform.db");
    // A database as the previous release left it: users without role/disabled_at.
    const Database = (await import("better-sqlite3")).default;
    const old = new Database(file);
    old.exec(`create table users (id text primary key, name text not null, email text not null unique, password_hash text not null, created_at text not null, updated_at text not null);
              insert into users values ('u1','Asha','asha@example.com','x','2026-01-01','2026-01-01');`);
    old.close();

    openDb(file).close();
    const db = openDb(file);
    const cols = (db.prepare(`pragma table_info(users)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["role", "disabled_at"]));
    expect(db.prepare(`select role from users where id='u1'`).get()).toEqual({ role: "member" });
    const tables = (db.prepare(`select name from sqlite_master where type='table'`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["invites", "api_keys", "mcp_servers", "mcp_tools", "tool_policies", "audit_log"]));
    db.close();
  });

  it("enforces the schema's own checks", async () => {
    const { openDb } = await load();
    const db = openDb(path.join(dir, "p.db"));
    expect(() => db.prepare(`insert into mcp_servers (id, slug, name, url) values ('a','Bad-Slug','n','http://x')`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`insert into users (id,name,email,password_hash,created_at,updated_at,role) values ('u','n','e','h','t','t','root')`).run()).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`insert into audit_log (request_id,user_id,user_email,source,tool_name,exposed_name,duration_ms,outcome) values ('r','u','e','mcp','t','s__t',1,'maybe')`).run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});

describe.skipIf(!sqliteAvailable)("gateway registry", () => {
  const setup = async () => {
    const { openDb, createRegistry, RegistryError } = await load();
    const db = openDb(path.join(dir, "r.db"));
    return { db, reg: createRegistry(db, key, policy, resolvesTo("10.96.10.10")), RegistryError };
  };
  const notes = {
    slug: "notes",
    name: "Team notes",
    url: "http://notes-mcp.mcp-servers.svc.cluster.local:3000/mcp",
    auth_type: "bearer",
    credential: "notes-secret-token",
  };

  it("creates a server; the credential is sealed in the DB and never in the public view", async () => {
    const { db, reg } = await setup();
    const s = await reg.create(notes);
    expect(s).toMatchObject({ slug: "notes", enabled: true, has_credential: true, status: "Unknown", managed_by: "admin" });
    expect(JSON.stringify(s)).not.toContain("notes-secret-token");
    expect(s).not.toHaveProperty("auth_secret_enc");
    const raw = db.prepare(`select auth_secret_enc from mcp_servers where id=?`).get(s.id) as { auth_secret_enc: string };
    expect(raw.auth_secret_enc).toMatch(/^v1:/);
    expect(raw.auth_secret_enc).not.toContain("notes-secret-token");
    expect(reg.authHeadersFor(s.id)).toEqual({ Authorization: "Bearer notes-secret-token" });
    db.close();
  });

  it("rejects bad slugs, duplicate slugs and slug changes", async () => {
    const { db, reg } = await setup();
    await expect(reg.create({ ...notes, slug: "a__b" })).rejects.toThrow(/slug/);
    await expect(reg.create({ ...notes, slug: "woo_" })).rejects.toThrow(/slug/);
    await expect(reg.create({ ...notes, slug: "x".repeat(25) })).rejects.toThrow(/slug/);
    const s = await reg.create(notes);
    await expect(reg.create(notes)).rejects.toThrow(/already used/);
    await expect(reg.update(s.id, { slug: "renamed" })).rejects.toThrow(/cannot change/);
    db.close();
  });

  it("runs the SSRF guard on create and on URL change", async () => {
    const { db, reg } = await setup();
    await expect(reg.create({ ...notes, url: "http://169.254.169.254/latest/meta-data" })).rejects.toThrow(/SSRF/);
    await expect(reg.create({ ...notes, url: "http://evil.example.com:3000/mcp" })).rejects.toThrow(/private address/);
    const s = await reg.create(notes);
    await expect(reg.update(s.id, { url: "http://127.0.0.1:3000/mcp" })).rejects.toThrow(/SSRF/);
    db.close();
  });

  it("requires a credential for bearer/header and a header name for header auth", async () => {
    const { db, reg } = await setup();
    await expect(reg.create({ ...notes, credential: undefined })).rejects.toThrow(/credential/);
    await expect(reg.create({ ...notes, auth_type: "header" })).rejects.toThrow(/auth_header_name/);
    const s = await reg.create({ ...notes, slug: "keyed", auth_type: "header", auth_header_name: "X-API-Key" });
    expect(reg.authHeadersFor(s.id)).toEqual({ "X-API-Key": "notes-secret-token" });
    db.close();
  });

  it("update keeps, replaces or clears the credential, and tracks Disabled status", async () => {
    const { db, reg } = await setup();
    const s = await reg.create(notes);
    await reg.update(s.id, { name: "Renamed" });
    expect(reg.authHeadersFor(s.id)).toEqual({ Authorization: "Bearer notes-secret-token" });
    await reg.update(s.id, { credential: "rotated" });
    expect(reg.authHeadersFor(s.id)).toEqual({ Authorization: "Bearer rotated" });
    expect((await reg.update(s.id, { enabled: false })).status).toBe("Disabled");
    expect((await reg.update(s.id, { enabled: true })).status).toBe("Unknown");
    const none = await reg.update(s.id, { auth_type: "none" });
    expect(none.has_credential).toBe(false);
    expect(reg.authHeadersFor(s.id)).toEqual({});
    db.close();
  });

  it("refuses to delete a Helm-managed server, deletes an admin one", async () => {
    const { db, reg } = await setup();
    const seeded = await reg.create({ ...notes, slug: "woo" }, "helm");
    await expect(Promise.resolve().then(() => reg.delete(seeded.id))).rejects.toThrow(/managed by Helm/);
    const s = await reg.create(notes);
    reg.delete(s.id);
    expect(reg.get(s.id)).toBeUndefined();
    db.close();
  });
});
