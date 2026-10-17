import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db";
import type { HealthChecker } from "./health";
import { allows, loadPolicy, type MinRole, type Role } from "./policy";
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
  callerOf: (req: FastifyRequest) => Promise<{ role: Role } | null>;
}

const STATUS: Record<RegistryError["code"], number> = { invalid: 400, not_found: 404, conflict: 409, forbidden: 403 };

export function registerServerRoutes(app: FastifyInstance, deps: ServerRoutesDeps) {
  const { db, registry, health, pool } = deps;

  async function caller(req: FastifyRequest, reply: FastifyReply, needAdmin: boolean) {
    const c = await deps.callerOf(req);
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

  // Each tool with its effective rule (S2): min_role and whether it comes from a rule on the tool,
  // on the whole server, or the default (destructive tools are admin-only).
  const toolsOf = async (serverId: string) => {
    const policy = await loadPolicy(db);
    const rows = await db.all<{ name: string; description: string | null; annotations: string | null; definition_hash: string; approved_hash: string | null }>(
      `select name, description, annotations, definition_hash, approved_hash from mcp_tools where server_id = ? order by name`,
      serverId,
    );
    return rows.map((t) => {
      const { minRole, source } = policy.decide(serverId, t.name, t.annotations ? JSON.parse(t.annotations) : undefined);
      // changed: the upstream now describes this tool differently than what was approved; it is
      // hidden from everyone until an admin approves it (pinning, S6).
      return { name: t.name, description: t.description, min_role: minRole, policy_source: source, changed: t.definition_hash !== t.approved_hash };
    });
  };

  app.get("/api/servers", async (req, reply) => {
    const c = await caller(req, reply, false);
    if (!c) return;
    const servers = await registry.list();
    if (c.role === "admin") {
      return {
        servers: await Promise.all(
          servers.map(async (s) => {
            const tools = await toolsOf(s.id);
            return { ...s, tools, changed_tools: tools.filter((t) => t.changed).length };
          }),
        ),
      };
    }
    // Members: names and the tools they may use only. URLs and auth details are infrastructure,
    // and an admin-only tool is as invisible here as it is in tools/list.
    return {
      servers: await Promise.all(
        servers.map(async (s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          enabled: s.enabled,
          status: s.status,
          tools: (await toolsOf(s.id)).filter((t) => !t.changed && allows(c.role, t.min_role)).map((t) => t.name),
        })),
      ),
    };
  });

  app.post("/api/servers", async (req, reply) => {
    if (!(await caller(req, reply, true))) return;
    try {
      const server = await registry.create(req.body ?? {});
      health.reschedule(server.id);
      return reply.code(201).send({ server });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch("/api/servers/:id", async (req, reply) => {
    if (!(await caller(req, reply, true))) return;
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
    if (!(await caller(req, reply, true))) return;
    const { id } = req.params as { id: string };
    try {
      await registry.delete(id);
      pool.drop(id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Who may use one tool (ROADMAP S2): "member", "admin", "nobody", or null to go back to the default.
  // tool "*" sets the rule for every tool of the server that has no rule of its own.
  app.put("/api/servers/:id/tools/:tool/policy", async (req, reply) => {
    if (!(await caller(req, reply, true))) return;
    const { id, tool } = req.params as { id: string; tool: string };
    const minRole = (req.body as { min_role?: MinRole | null } | undefined)?.min_role;
    if (minRole === undefined) return reply.code(400).send({ error: "invalid", message: "Gateway: body needs min_role (member, admin, nobody or null)" });
    try {
      await registry.setToolPolicy(id, tool, minRole);
      return { tools: await toolsOf(id) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Accept the current definitions of a server's changed tools after reviewing them (pinning, S6).
  app.post("/api/servers/:id/approve-tools", async (req, reply) => {
    if (!(await caller(req, reply, true))) return;
    const { id } = req.params as { id: string };
    try {
      const approved = await registry.approveTools(id);
      return { approved, tools: await toolsOf(id) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Probe now and return the result, so the admin sees "Connected" or the exact reason right away.
  app.post("/api/servers/:id/test", async (req, reply) => {
    if (!(await caller(req, reply, true))) return;
    const { id } = req.params as { id: string };
    const before = await registry.get(id);
    if (!before) return reply.code(404).send({ error: "not_found", message: `Gateway registry: server ${id} not found` });
    if (!before.enabled) return reply.code(409).send({ error: "disabled", message: `Gateway: '${before.slug}' is disabled; enable it to test` });
    pool.drop(id);
    await health.probe(id);
    const server = (await registry.get(id))!;
    return { ok: server.status === "Connected", server: { ...server, tools: await toolsOf(id) } };
  });
}
