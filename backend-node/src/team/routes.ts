import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db";
import type { PublicUser } from "../auth";
import { queryAudit } from "../gateway/audit";
import { createApiKey, getApiKey, listApiKeys, revokeApiKey } from "../gateway/keys";
import { acceptInvite, createInvite, listPendingInvites, revokeInvite } from "./invites";
import { listMembers, TeamError, updateMember } from "./members";

// Members, invites and API keys (DESIGN §7.6, §8.1-8.2). Role checks happen here, on the server,
// for every admin route (SYSTEM.md I13). These routes need a real logged-in user, not the shared
// X-API-Key admin key, because invites and revocations record which person did them.

export interface TeamRoutesDeps {
  db: Db;
  currentUser: (req: FastifyRequest) => PublicUser | null;
  createSession: (userId: string) => string;
  // Base URL of the dashboard, used to build invite links.
  dashboardUrl: string;
}

const STATUS: Record<TeamError["code"], number> = { forbidden: 403, not_found: 404, conflict: 409, invalid: 400 };
const role = z.enum(["admin", "member"]);

export function registerTeamRoutes(app: FastifyInstance, deps: TeamRoutesDeps) {
  const { db } = deps;

  function caller(req: FastifyRequest, reply: FastifyReply, needAdmin: boolean): PublicUser | null {
    const user = deps.currentUser(req);
    if (!user) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (needAdmin && user.role !== "admin") {
      reply.code(403).send({ error: "forbidden", message: "Team: only admins can do this" });
      return null;
    }
    return user;
  }

  function body<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: FastifyRequest, reply: FastifyReply): T | null {
    const r = schema.safeParse(req.body ?? {});
    if (r.success) return r.data;
    reply.code(400).send({ error: "invalid", message: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return null;
  }

  function fail(reply: FastifyReply, err: unknown) {
    if (err instanceof TeamError) return reply.code(STATUS[err.code]).send({ error: err.code, message: err.message });
    throw err;
  }

  // ---- Members (admin) ----
  app.get("/api/members", async (req, reply) => {
    if (!caller(req, reply, true)) return;
    return { members: listMembers(db) };
  });

  app.patch("/api/members/:id", async (req, reply) => {
    if (!caller(req, reply, true)) return;
    const v = body(z.object({ role: role.optional(), disabled: z.boolean().optional() }), req, reply);
    if (!v) return;
    try {
      return { member: updateMember(db, (req.params as { id: string }).id, v) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- Invites (admin), accept (public, needs the token) ----
  app.get("/api/invites", async (req, reply) => {
    if (!caller(req, reply, true)) return;
    return { invites: listPendingInvites(db) };
  });

  app.post("/api/invites", async (req, reply) => {
    const admin = caller(req, reply, true);
    if (!admin) return;
    const v = body(z.object({ email: z.string().trim().email(), role: role.default("member") }), req, reply);
    if (!v) return;
    try {
      const invite = createInvite(db, v, admin.id);
      // The link holds the only copy of the token; it is not stored and can't be shown again.
      const url = `${deps.dashboardUrl.replace(/\/$/, "")}/?invite=${invite.token}`;
      return reply.code(201).send({ invite: { id: invite.id, email: v.email.toLowerCase(), role: v.role, expires_at: invite.expires_at }, url });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete("/api/invites/:id", async (req, reply) => {
    if (!caller(req, reply, true)) return;
    try {
      revokeInvite(db, (req.params as { id: string }).id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post("/auth/accept-invite", async (req, reply) => {
    const v = body(z.object({ token: z.string().min(20).max(200), name: z.string().trim().min(2).max(80), password: z.string().min(8).max(128) }), req, reply);
    if (!v) return;
    try {
      const user = acceptInvite(db, v);
      return { token: deps.createSession(user.id), user };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---- Audit log: admins see everyone, members only their own rows ----
  app.get("/api/audit", async (req, reply) => {
    const user = caller(req, reply, false);
    if (!user) return;
    const q = z
      .object({
        user: z.string().trim().email().optional(),
        server: z.string().max(24).optional(),
        tool: z.string().max(64).optional(),
        outcome: z.enum(["ok", "tool_error", "timeout", "unreachable", "denied", "not_found", "bad_request"]).optional(),
        source: z.enum(["mcp", "chat"]).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        before_id: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: "invalid", message: q.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const v = q.data;
    // A member's filter is overridden, not just hidden in the UI (SYSTEM.md I13).
    const result = queryAudit(db, {
      userId: user.role === "admin" ? undefined : user.id,
      userEmail: user.role === "admin" ? v.user : undefined,
      server: v.server,
      tool: v.tool,
      outcome: v.outcome,
      source: v.source,
      from: v.from,
      to: v.to,
      beforeId: v.before_id,
      limit: v.limit,
    });
    return { rows: result.rows, next_before_id: result.nextBeforeId };
  });

  // ---- API keys: own keys for everyone, all keys for admins ----
  app.get("/api/keys", async (req, reply) => {
    const user = caller(req, reply, false);
    if (!user) return;
    const all = (req.query as { all?: string }).all === "1" && user.role === "admin";
    return { keys: listApiKeys(db, all ? null : user.id) };
  });

  app.post("/api/keys", async (req, reply) => {
    const user = caller(req, reply, false);
    if (!user) return;
    const v = body(z.object({ name: z.string().trim().min(1).max(60) }), req, reply);
    if (!v) return;
    const created = createApiKey(db, user.id, v.name);
    // The only time the full key is ever returned (SYSTEM.md I5).
    return reply.code(201).send({ key: created.key, id: created.id, prefix: created.prefix, name: v.name });
  });

  app.delete("/api/keys/:id", async (req, reply) => {
    const user = caller(req, reply, false);
    if (!user) return;
    const key = getApiKey(db, (req.params as { id: string }).id);
    // A member asking about someone else's key gets the same 404 as for a key that doesn't exist.
    if (!key || (key.user_id !== user.id && user.role !== "admin")) {
      return reply.code(404).send({ error: "not_found", message: "Gateway: API key not found" });
    }
    revokeApiKey(db, key.id, user.id);
    return { ok: true, key: getApiKey(db, key.id) };
  });
}
