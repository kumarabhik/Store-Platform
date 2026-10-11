import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db";
import type { HealthChecker } from "./health";
import type { Role } from "./policy";
import { RegistryError, type Registry } from "./registry";
import type { UpstreamPool } from "./upstreams";

// Dashboard REST for upstream servers (DESIGN §7.6 Servers page). Every write is admin-only and
// checked here on the server (SYSTEM.md I13); members get a read-only list without URLs.

export interface ServerRoutesDeps {
  db: Db;
  registry: Registry;
  health: HealthChecker;
  pool: UpstreamPool;
  // Resolves the caller from the request (session token or admin API key); null = not logged in.
  callerOf: (req: FastifyRequest) => { role: Role } | null;
}

const STATUS: Record<RegistryError["code"], number> = { invalid: 400, not_found: 404, conflict: 409, forbidden: 403 };

export function registerServerRoutes(app: FastifyInstance, deps: ServerRoutesDeps) {
  const { db, registry, health, pool } = deps;

  function caller(req: FastifyRequest, reply: FastifyReply, needAdmin: boolean) {
    const c = deps.callerOf(req);
    if (!c) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (needAdmin && c.role !== "admin") {
      reply.code(403).send({ error: "forbidden", message: "Gateway: only admins can manage MCP servers" });
      return null;
    }
    return c;
  }

  function fail(reply: FastifyReply, err: unknown) {
    if (err instanceof RegistryError) return reply.code(STATUS[err.code]).send({ error: err.code, message: err.message });
    throw err;
  }

  const toolsOf = (serverId: string) =>
    db.prepare(`select name, description from mcp_tools where server_id = ? order by name`).all(serverId) as { name: string; description: string | null }[];

  app.get("/api/servers", async (req, reply) => {
    const c = caller(req, reply, false);
    if (!c) return;
    const servers = registry.list();
    if (c.role === "admin") return { servers: servers.map((s) => ({ ...s, tools: toolsOf(s.id) })) };
    // Members: names and tools only. URLs and auth details are infrastructure, not theirs to see.
    return {
      servers: servers.map((s) => ({ id: s.id, slug: s.slug, name: s.name, enabled: s.enabled, status: s.status, tools: toolsOf(s.id).map((t) => t.name) })),
    };
  });

  app.post("/api/servers", async (req, reply) => {
    if (!caller(req, reply, true)) return;
    try {
      const server = await registry.create(req.body ?? {});
      health.reschedule(server.id);
      return reply.code(201).send({ server });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch("/api/servers/:id", async (req, reply) => {
    if (!caller(req, reply, true)) return;
    const { id } = req.params as { id: string };
    try {
      const server = await registry.update(id, req.body ?? {});
      // New URL or credential: the pooled client must not keep using the old one.
      pool.drop(id);
      health.reschedule(id);
      return { server };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete("/api/servers/:id", async (req, reply) => {
    if (!caller(req, reply, true)) return;
    const { id } = req.params as { id: string };
    try {
      registry.delete(id);
      pool.drop(id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Probe now and return the result, so the admin sees "Connected" or the exact reason right away.
  app.post("/api/servers/:id/test", async (req, reply) => {
    if (!caller(req, reply, true)) return;
    const { id } = req.params as { id: string };
    const before = registry.get(id);
    if (!before) return reply.code(404).send({ error: "not_found", message: `Gateway registry: server ${id} not found` });
    if (!before.enabled) return reply.code(409).send({ error: "disabled", message: `Gateway: '${before.slug}' is disabled; enable it to test` });
    pool.drop(id);
    await health.probe(id);
    const server = registry.get(id)!;
    return { ok: server.status === "Connected", server: { ...server, tools: toolsOf(id) } };
  });
}
