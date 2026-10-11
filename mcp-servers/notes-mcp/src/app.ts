import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NoteStore } from "./store";
import { buildMcpServer } from "./tools";

// Hashing first gives equal-length buffers, so timingSafeEqual never throws and length doesn't leak.
function tokenMatches(header: string | undefined, expected: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  return timingSafeEqual(createHash("sha256").update(match[1]).digest(), createHash("sha256").update(expected).digest());
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

export function buildApp(opts: { token: string; store: NoteStore; logger?: boolean }): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ? { redact: { paths: ["req.headers.authorization"], censor: "[redacted]" } } : false,
  });

  app.post("/mcp", async (req, reply) => {
    // This upstream requires its own credential, so the gateway's credential injection is exercised
    // (DESIGN §4.1). The token never comes from the end user: no passthrough (SYSTEM.md I3).
    if (!tokenMatches(req.headers.authorization, opts.token)) {
      return reply.code(401).header("WWW-Authenticate", 'Bearer realm="notes-mcp"').send(rpcError(-32001, "notes-mcp: missing or invalid bearer token"));
    }
    const server = buildMcpServer(opts.store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("Allow", "POST").send(rpcError(-32000, "notes-mcp: method not allowed, use POST"));
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  app.get("/healthz", async () => ({ ok: true }));
  // Ready only when the database file on the PVC can be read.
  app.get("/readyz", async (_req, reply) => {
    try {
      opts.store.ping();
      return { ok: true };
    } catch (err) {
      return reply.code(503).send({ ok: false, error: `notes-mcp: database not readable: ${(err as Error).message}` });
    }
  });

  return app;
}
