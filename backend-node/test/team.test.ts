import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { sqliteAvailable } from "./sqlite";

// P5: roles in users.role, first-admin bootstrap, invites, member management, API key routes.

describe("team: roles, invites, members, API keys", async () => {
  // Vitest runs a describe body even when skipped, and this one opens SQLite (SYSTEM.md L24).
  if (!sqliteAvailable) {
    it.skip("needs better-sqlite3: run bash scripts/test-backend.sh", () => {});
    return;
  }
  const { openDb } = await import("../src/db");
  const auth = await import("../src/auth");
  const team = await import("../src/team/members");
  const { registerTeamRoutes } = await import("../src/team/routes");
  const { verifyApiKey } = await import("../src/gateway/keys");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-"));
  const db = openDb(path.join(dir, "t.db"));
  const app = Fastify();
  registerTeamRoutes(app, {
    db,
    currentUser: (req) => auth.getUserBySessionToken(db, (req.headers.authorization ?? "").replace(/^Bearer /, "")),
    createSession: (id) => auth.createSession(db, id),
    dashboardUrl: "http://127.0.0.1:5173/",
  });
  afterAll(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // What /auth/signup does in server.ts, minus HTTP.
  const signup = (email: string, open = false) => {
    const role = team.signupRole(db, open);
    if (!role) return null;
    const u = auth.createUser(db, { name: email.split("@")[0], email, password: "password-123" }, role);
    return { user: u, token: auth.createSession(db, u.id) };
  };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  const a = signup("alice@example.com")!;
  const b = signup("bob@example.com", true)!;

  it("first signup becomes admin; afterwards signup is closed unless openSignup", () => {
    expect(a.user.role).toBe("admin");
    expect(b.user.role).toBe("member");
    expect(team.signupRole(db, false)).toBeNull();
    expect(team.signupRole(db, true)).toBe("member");
  });

  it("an install with members but no stored admin lets the next signup become admin", () => {
    const d2 = openDb(path.join(dir, "legacy.db"));
    auth.createUser(d2, { name: "old", email: "old@example.com", password: "password-123" }, "member");
    expect(team.signupRole(d2, false)).toBe("admin");
    d2.close();
  });

  it("ADMIN_EMAILS promotes and stores the role", () => {
    const u = team.applyAdminEmails(db, b.user, new Set(["bob@example.com"]));
    expect(u.role).toBe("admin");
    expect(team.roleOf(db, b.user.id)).toBe("admin");
    team.updateMember(db, b.user.id, { role: "member" });
  });

  it("members can't use admin routes; admins can", async () => {
    expect((await app.inject({ url: "/api/members", headers: as(b.token) })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/members" })).statusCode).toBe(401);
    const res = await app.inject({ url: "/api/members", headers: as(a.token) });
    expect(res.json().members.map((m: { email: string; role: string }) => `${m.email}:${m.role}`)).toEqual(["alice@example.com:admin", "bob@example.com:member"]);
  });

  it("refuses to demote or disable the last active admin", async () => {
    const res = await app.inject({ method: "PATCH", url: `/api/members/${a.user.id}`, headers: as(a.token), payload: { role: "member" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/last active admin/);
    expect((await app.inject({ method: "PATCH", url: `/api/members/${a.user.id}`, headers: as(a.token), payload: { disabled: true } })).statusCode).toBe(409);
  });

  it("invite -> accept creates the account with the invited role; the link works once", async () => {
    const res = await app.inject({ method: "POST", url: "/api/invites", headers: as(a.token), payload: { email: "Carol@Example.com", role: "member" } });
    expect(res.statusCode).toBe(201);
    const { url, invite } = res.json();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:5173\/\?invite=[A-Za-z0-9_-]{43}$/);
    expect(invite.email).toBe("carol@example.com");
    expect((await app.inject({ url: "/api/invites", headers: as(a.token) })).json().invites).toHaveLength(1);

    const token = new URL(url).searchParams.get("invite")!;
    const acc = await app.inject({ method: "POST", url: "/auth/accept-invite", payload: { token, name: "Carol", password: "password-123" } });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().user).toMatchObject({ email: "carol@example.com", role: "member" });
    expect(acc.json().token).toBeTruthy();

    const again = await app.inject({ method: "POST", url: "/auth/accept-invite", payload: { token, name: "Mallory", password: "password-123" } });
    expect(again.statusCode).toBe(400);
    expect((await app.inject({ url: "/api/invites", headers: as(a.token) })).json().invites).toHaveLength(0);
  });

  it("members can't invite; an existing email can't be invited", async () => {
    expect((await app.inject({ method: "POST", url: "/api/invites", headers: as(b.token), payload: { email: "x@example.com" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/invites", headers: as(a.token), payload: { email: "bob@example.com" } })).statusCode).toBe(409);
  });

  it("API keys: shown once, listed without secret, revoked by owner, invisible to other members", async () => {
    const created = await app.inject({ method: "POST", url: "/api/keys", headers: as(b.token), payload: { name: "Claude Code laptop" } });
    expect(created.statusCode).toBe(201);
    const { key, id, prefix } = created.json();
    expect(key).toMatch(new RegExp(`^mcpgw_${prefix}_`));
    expect(verifyApiKey(db, key)?.userId).toBe(b.user.id);

    const list = (await app.inject({ url: "/api/keys", headers: as(b.token) })).json().keys;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(key.slice(15));
    expect(list[0]).not.toHaveProperty("key_hash");

    const carol = auth.authenticateUser(db, "carol@example.com", "password-123")!;
    const carolToken = auth.createSession(db, carol.id);
    expect((await app.inject({ method: "DELETE", url: `/api/keys/${id}`, headers: as(carolToken) })).statusCode).toBe(404);
    expect(verifyApiKey(db, key)).not.toBeNull();

    // Members never see others' keys, even with ?all=1; admins do.
    expect((await app.inject({ url: "/api/keys?all=1", headers: as(carolToken) })).json().keys).toHaveLength(0);
    expect((await app.inject({ url: "/api/keys?all=1", headers: as(a.token) })).json().keys).toHaveLength(1);

    const del = await app.inject({ method: "DELETE", url: `/api/keys/${id}`, headers: as(b.token) });
    expect(del.json().key.revoked_at).toBeTruthy();
    // Revocation applies on the very next request.
    expect(verifyApiKey(db, key)).toBeNull();
  });

  it("an admin can revoke anyone's key", async () => {
    const { id, key } = (await app.inject({ method: "POST", url: "/api/keys", headers: as(b.token), payload: { name: "ci" } })).json();
    expect((await app.inject({ method: "DELETE", url: `/api/keys/${id}`, headers: as(a.token) })).statusCode).toBe(200);
    expect(verifyApiKey(db, key)).toBeNull();
    expect(db.prepare(`select revoked_by from api_keys where id = ?`).get(id)).toEqual({ revoked_by: a.user.id });
  });

  it("disabling a member logs them out, blocks login and kills their keys; enabling restores login", async () => {
    const { key } = (await app.inject({ method: "POST", url: "/api/keys", headers: as(b.token), payload: { name: "k" } })).json();
    const res = await app.inject({ method: "PATCH", url: `/api/members/${b.user.id}`, headers: as(a.token), payload: { disabled: true } });
    expect(res.json().member.disabled_at).toBeTruthy();
    expect(auth.getUserBySessionToken(db, b.token)).toBeNull();
    expect(auth.authenticateUser(db, "bob@example.com", "password-123")).toBeNull();
    expect(verifyApiKey(db, key)).toBeNull();

    await app.inject({ method: "PATCH", url: `/api/members/${b.user.id}`, headers: as(a.token), payload: { disabled: false } });
    expect(auth.authenticateUser(db, "bob@example.com", "password-123")?.role).toBe("member");
  });

  it("audit API: members see only their own rows even if they ask for others; admins filter everything", async () => {
    const { writeAudit } = await import("../src/gateway/audit");
    const row = (userId: string, email: string, outcome: "ok" | "denied", slug: string) =>
      writeAudit(db, { requestId: "r", userId, userEmail: email, apiKeyId: null, source: "mcp", serverId: null, serverSlug: slug, toolName: "list_orders", exposedName: `${slug}__list_orders`, durationMs: 5, outcome, error: null, args: { password: "p" } });
    row(a.user.id, "alice@example.com", "ok", "woo");
    row(b.user.id, "bob@example.com", "ok", "woo");
    row(b.user.id, "bob@example.com", "denied", "notes");

    // The disable test above ended Bob's sessions, so he logs in again.
    const bobToken = auth.createSession(db, b.user.id);
    const mine = (await app.inject({ url: "/api/audit?user=alice@example.com", headers: as(bobToken) })).json().rows;
    expect(mine.map((r: { user_email: string }) => r.user_email)).toEqual(["bob@example.com", "bob@example.com"]);
    expect(mine[0].args_preview).toBe('{"password":"[redacted]"}');

    const all = (await app.inject({ url: "/api/audit", headers: as(a.token) })).json().rows;
    expect(all).toHaveLength(3);
    const denied = (await app.inject({ url: "/api/audit?outcome=denied&server=notes", headers: as(a.token) })).json().rows;
    expect(denied).toHaveLength(1);
    const alice = (await app.inject({ url: "/api/audit?user=alice@example.com", headers: as(a.token) })).json().rows;
    expect(alice).toHaveLength(1);

    // Paging: limit + before_id cursor, newest first.
    const p1 = (await app.inject({ url: "/api/audit?limit=2", headers: as(a.token) })).json();
    expect(p1.rows).toHaveLength(2);
    const p2 = (await app.inject({ url: `/api/audit?limit=2&before_id=${p1.next_before_id}`, headers: as(a.token) })).json();
    expect(p2.rows).toHaveLength(1);
    expect((await app.inject({ url: "/api/audit?outcome=nope", headers: as(a.token) })).statusCode).toBe(400);
  });

  it("promoting a second admin then lets the first step down", async () => {
    await app.inject({ method: "PATCH", url: `/api/members/${b.user.id}`, headers: as(a.token), payload: { role: "admin" } });
    const res = await app.inject({ method: "PATCH", url: `/api/members/${a.user.id}`, headers: as(a.token), payload: { role: "member" } });
    expect(res.statusCode).toBe(200);
    expect(team.roleOf(db, a.user.id)).toBe("member");
  });
});
