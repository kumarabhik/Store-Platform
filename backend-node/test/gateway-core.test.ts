import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqliteAvailable } from "./sqlite";

// Integration test for P3: three real HTTP MCP upstreams (ok, slow, dead) behind the real registry,
// health checker, client pool, GatewayCore and /mcp endpoint. Only the network edge is faked: the
// upstreams get in-cluster names, and the test's fetch maps those names to local ports.

interface FakeUpstream {
  port: number;
  seenAuth: (string | undefined)[];
  close: () => Promise<void>;
}

async function startUpstream(opts: { token?: string; delayMs?: number }): Promise<FakeUpstream> {
  const seenAuth: (string | undefined)[] = [];
  const server = http.createServer(async (req, res) => {
    seenAuth.push(req.headers.authorization);
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const mcp = new Server({ name: "fake", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "echo", description: "Echo text back.​ Hidden", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
      ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
      if (opts.delayMs) await new Promise((ok) => setTimeout(ok, opts.delayMs));
      if (r.params.name === "fail") return { isError: true, content: [{ type: "text", text: "store said no" }] };
      return { content: [{ type: "text", text: String((r.params.arguments as { text: string }).text) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void mcp.close());
    await mcp.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString() || "null"));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    port: (server.address() as AddressInfo).port,
    seenAuth,
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

describe("gateway core with three upstreams (ok / slow / dead)", async () => {
  // Vitest runs a describe body even when skipped (to collect tests), and this one opens SQLite.
  if (!sqliteAvailable) {
    it.skip("needs better-sqlite3: run bash scripts/test-backend.sh", () => {});
    return;
  }
  const { openDb } = await import("../src/db");
  const { createRegistry } = await import("../src/gateway/registry");
  const { createUpstreamPool } = await import("../src/gateway/upstreams");
  const { createHealthChecker, nextProbeDelay } = await import("../src/gateway/health");
  const { createGatewayCore, UnknownToolError } = await import("../src/gateway/core");
  const { registerMcpEndpoint } = await import("../src/gateway/mcpEndpoint");
  const { createApiKey } = await import("../src/gateway/keys");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-core-"));
  const db = openDb(path.join(dir, "p.db"));
  const policy = { internalHosts: ["*.mcp-servers.svc.cluster.local"], deniedIps: [] };
  const registry = createRegistry(db, crypto.randomBytes(32), policy, async () => [{ address: "10.96.1.1", family: 4 }]);

  let ok: FakeUpstream, slow: FakeUpstream;
  const ports: Record<string, number> = {};
  // The network edge: in-cluster names -> local ports. "dead" maps to a port nothing listens on.
  const testFetch = (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    url.port = String(ports[url.hostname.split(".")[0]]);
    url.hostname = "127.0.0.1";
    return fetch(url, init);
  };
  const pool = createUpstreamPool({ fetch: testFetch });
  const health = createHealthChecker(db, registry, pool, { intervalMs: 15_000, timeoutMs: 1_000, capMs: 300_000, jitter: 0 });
  const core = createGatewayCore(db, registry, pool, health);

  const member = { id: "u-member", email: "b@example.com", role: "member" as const };
  const admin = { id: "u-admin", email: "a@example.com", role: "admin" as const };
  const ids: Record<string, string> = {};
  const auditRows = () => db.prepare(`select * from audit_log order by id`).all() as Record<string, unknown>[];

  beforeAll(async () => {
    ok = await startUpstream({ token: "ok-upstream-token" });
    slow = await startUpstream({ delayMs: 3_000 });
    const closed = await startUpstream({});
    ports.ok = ok.port;
    ports.slow = slow.port;
    ports.dead = closed.port;
    await closed.close();
    for (const u of [member, admin]) {
      db.prepare(`insert into users (id, name, email, password_hash, created_at, updated_at) values (?, ?, ?, 'x', datetime('now'), datetime('now'))`).run(u.id, u.email, u.email);
    }
    ids.ok = (await registry.create({ slug: "ok", name: "OK", url: "http://ok.mcp-servers.svc.cluster.local:3000/mcp", auth_type: "bearer", credential: "ok-upstream-token" })).id;
    ids.slow = (await registry.create({ slug: "slow", name: "Slow", url: "http://slow.mcp-servers.svc.cluster.local:3000/mcp", timeout_ms: 1_000 })).id;
    ids.dead = (await registry.create({ slug: "dead", name: "Dead", url: "http://dead.mcp-servers.svc.cluster.local:3000/mcp" })).id;
    await health.runDue();
  });

  afterAll(async () => {
    health.stop();
    await pool.closeAll();
    await ok.close();
    await slow.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("health: live upstreams are Connected, the dead one Unreachable with a readable reason", () => {
    expect(registry.get(ids.ok)?.status).toBe("Connected");
    expect(registry.get(ids.slow)?.status).toBe("Connected");
    const dead = registry.get(ids.dead)!;
    expect(dead.status).toBe("Unreachable");
    expect(dead.last_error).toMatch(/Upstream 'dead' is unreachable: ECONNREFUSED/);
    expect(dead.consecutive_failures).toBe(1);
  });

  it("backoff doubles per failure up to the cap", () => {
    const o = { intervalMs: 15_000, timeoutMs: 3_000, capMs: 300_000, jitter: 0 };
    expect([0, 1, 2, 3, 10].map((n) => nextProbeDelay(n, o))).toEqual([15_000, 15_000, 30_000, 60_000, 300_000]);
    const jittered = nextProbeDelay(1, { ...o, jitter: 0.2 }, () => 1);
    expect(jittered).toBe(18_000);
  });

  it("tools/list: prefixed, sorted, sanitized, both 'echo' tools visible, nothing from the dead upstream", () => {
    const names = core.listTools(member).map((t) => t.exposedName);
    expect(names).toEqual(["ok__echo", "ok__fail", "slow__echo", "slow__fail"]);
    expect(core.listTools(member)[0].description).toBe("[OK] Echo text back. Hidden");
  });

  it("routes a call, injects the gateway's credential, and audits it", async () => {
    const res = await core.callTool(member, "ok__echo", { text: "hi" }, { source: "mcp", apiKeyId: "k1" });
    expect(res.content).toEqual([{ type: "text", text: "hi" }]);
    expect(ok.seenAuth.at(-1)).toBe("Bearer ok-upstream-token");
    expect(auditRows().at(-1)).toMatchObject({ user_id: member.id, server_slug: "ok", tool_name: "echo", exposed_name: "ok__echo", outcome: "ok", source: "mcp", api_key_id: "k1" });
  });

  it("same tool name on two servers routes by prefix", async () => {
    await core.callTool(member, "slow__echo", { text: "x" }, { source: "chat" }).catch(() => {});
    expect(auditRows().at(-1)).toMatchObject({ server_slug: "slow", tool_name: "echo" });
  });

  it("a slow upstream times out with a clear message and the others keep working", async () => {
    const t0 = Date.now();
    const res = await core.callTool(member, "slow__echo", { text: "x" }, { source: "chat" });
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "Upstream 'slow' timed out after 1000 ms" }]);
    expect(auditRows().at(-1)).toMatchObject({ outcome: "timeout", source: "chat" });
    expect((await core.callTool(member, "ok__echo", { text: "still fine" }, { source: "mcp" })).isError).toBeFalsy();
  });

  it("tool errors pass through as isError and are audited as tool_error", async () => {
    const res = await core.callTool(member, "ok__fail", {}, { source: "mcp" });
    expect(res).toMatchObject({ isError: true, content: [{ type: "text", text: "store said no" }] });
    expect(auditRows().at(-1)).toMatchObject({ outcome: "tool_error", error: "store said no" });
  });

  it("invalid arguments are rejected by the gateway before the upstream sees them", async () => {
    const before = ok.seenAuth.length;
    const res = await core.callTool(member, "ok__echo", { text: 42 }, { source: "mcp" });
    expect(res.isError).toBe(true);
    expect(ok.seenAuth.length).toBe(before);
    expect(auditRows().at(-1)).toMatchObject({ outcome: "bad_request" });
  });

  it("unknown tools and dead-server tools are not_found; a policy-denied tool looks the same but is audited as denied", async () => {
    await expect(core.callTool(member, "nope__x", {}, { source: "mcp" })).rejects.toBeInstanceOf(UnknownToolError);
    expect(auditRows().at(-1)).toMatchObject({ outcome: "not_found", exposed_name: "nope__x" });

    db.prepare(`insert into tool_policies (server_id, tool_name, min_role) values (?, 'fail', 'admin')`).run(ids.ok);
    expect(core.listTools(member).map((t) => t.exposedName)).not.toContain("ok__fail");
    expect(core.listTools(admin).map((t) => t.exposedName)).toContain("ok__fail");
    await expect(core.callTool(member, "ok__fail", {}, { source: "mcp" })).rejects.toThrow("Unknown tool: ok__fail");
    expect(auditRows().at(-1)).toMatchObject({ outcome: "denied", user_id: member.id });
    db.prepare(`delete from tool_policies`).run();
  });

  it("a disabled server's tools disappear", async () => {
    await registry.update(ids.slow, { enabled: false });
    expect(core.listTools(member).map((t) => t.serverSlug)).not.toContain("slow");
    await registry.update(ids.slow, { enabled: true });
  });

  it("killing an upstream: the call fails as unreachable and the server is marked Unreachable at once", async () => {
    await ok.close();
    pool.drop(ids.ok);
    const res = await core.callTool(member, "ok__echo", { text: "x" }, { source: "mcp" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Upstream 'ok' is unreachable/);
    expect(auditRows().at(-1)).toMatchObject({ outcome: "unreachable" });
    expect(registry.get(ids.ok)?.status).toBe("Unreachable");
  });

  it("every call above wrote exactly one audit row", () => {
    // 1 ok + 1 slow route + 1 timeout + 1 ok + 1 tool_error + 1 bad_request + 1 not_found + 1 denied + 1 unreachable
    expect(auditRows()).toHaveLength(9);
  });

  describe("/mcp endpoint", () => {
    const app = Fastify();
    registerMcpEndpoint(app, { db, core, roleOf: () => "member", allowedOrigins: ["http://127.0.0.1:5173"] });
    const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    afterAll(() => app.close());

    it("401 with WWW-Authenticate without a valid key", async () => {
      const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, authorization: "Bearer mcpgw_00000000_" + "a".repeat(43) }, payload: listTools });
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toContain("Bearer");
    });

    it("lists tools with a key, rejects a foreign Origin, and rejects the key on the next request after revocation", async () => {
      const { id, key } = createApiKey(db, member.id, "laptop");
      const auth = { ...headers, authorization: `Bearer ${key}` };
      const res = await app.inject({ method: "POST", url: "/mcp", headers: auth, payload: listTools });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.tools.map((t: { name: string }) => t.name)).toContain("slow__echo");

      const evil = await app.inject({ method: "POST", url: "/mcp", headers: { ...auth, origin: "http://evil.example" }, payload: listTools });
      expect(evil.statusCode).toBe(403);

      db.prepare(`update api_keys set revoked_at = datetime('now') where id = ?`).run(id);
      expect((await app.inject({ method: "POST", url: "/mcp", headers: auth, payload: listTools })).statusCode).toBe(401);
    });

    it("rate-limits per API key: another key is unaffected", async () => {
      const { makeTokenBucket } = await import("../src/ratelimit");
      const limited = Fastify();
      registerMcpEndpoint(limited, { db, core, roleOf: () => "member", allowedOrigins: [], keyLimiter: makeTokenBucket({ capacity: 2, refillPerSec: 0.001 }) });
      const k1 = createApiKey(db, member.id, "busy").key;
      const k2 = createApiKey(db, member.id, "quiet").key;
      const send = (k: string) => limited.inject({ method: "POST", url: "/mcp", headers: { ...headers, authorization: `Bearer ${k}` }, payload: listTools });
      expect((await send(k1)).statusCode).toBe(200);
      expect((await send(k1)).statusCode).toBe(200);
      const third = await send(k1);
      expect(third.statusCode).toBe(429);
      expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
      expect(third.json().error.message).toMatch(/rate limit for this API key/);
      expect((await send(k2)).statusCode).toBe(200);
      await limited.close();
    });
  });
});
