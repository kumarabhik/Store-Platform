import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./tools";
import type { WooClient } from "./woo";

const READY_TIMEOUT_MS = 2_000;

// Hashing first gives equal-length buffers, so timingSafeEqual never throws and length doesn't leak.
function tokenMatches(header: string | undefined, expected: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  const a = createHash("sha256").update(match[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

export function buildApp(opts: { token: string; woo: WooClient; logger?: boolean }): FastifyInstance {
  const app = Fastify({
    logger: opts.logger
      ? { redact: { paths: ["req.headers.authorization"], censor: "[redacted]" } }
      : false,
  });

  app.post("/mcp", async (req, reply) => {
    // Defence in depth on top of the NetworkPolicy: only the gateway holds this token (DESIGN §7.1).
    if (!tokenMatches(req.headers.authorization, opts.token)) {
      return reply
        .code(401)
        .header("WWW-Authenticate", 'Bearer realm="woo-mcp"')
        .send(jsonRpcError(-32001, "woo-mcp: missing or invalid bearer token"));
    }

    // Stateless: no session ID, a fresh server + transport per request, plain JSON responses.
    const server = buildMcpServer(opts.woo);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    // The SDK writes the response to the raw Node stream itself.
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // No server-initiated stream and no sessions to delete in stateless mode (DESIGN §6.2).
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("Allow", "POST").send(jsonRpcError(-32000, "woo-mcp: method not allowed, use POST"));
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // Probes use these, never /mcp (DESIGN §7.1). Liveness checks only the process, so a store
  // outage doesn't make Kubernetes restart a healthy woo-mcp.
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await opts.woo.ping(READY_TIMEOUT_MS);
      return { ok: true };
    } catch (err) {
      return reply.code(503).send({ ok: false, error: (err as Error).message });
    }
  });

  return app;
}
