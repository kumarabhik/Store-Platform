import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db";
import type { RateLimitDecision } from "../ratelimit";
import { UnknownToolError, type GatewayCore, type GatewayUser } from "./core";
import { verifyApiKey } from "./keys";
import type { Role } from "./policy";

// The gateway's own MCP endpoint (DESIGN §6.1-6.2): one URL, per-user API keys, every enabled
// upstream's tools. Stateless: a new SDK Server per HTTP request, so any replica can serve any call.

export interface McpEndpointDeps {
  db: Db;
  core: GatewayCore;
  // Role of the key's owner, read from users.role on every request (a demotion applies at once).
  roleOf: (user: { id: string; email: string }) => Role;
  // Browser origins allowed to call /mcp. CLI clients send no Origin header and are unaffected.
  allowedOrigins: string[];
  // Per-API-key limiter (DESIGN §9.4): one runaway agent loop can't exhaust the gateway for the team.
  keyLimiter?: (keyId: string) => RateLimitDecision;
}

function rpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

export function registerMcpEndpoint(app: FastifyInstance, deps: McpEndpointDeps) {
  app.post("/mcp", async (req, reply) => {
    // DNS-rebinding defence required by the MCP spec: a web page must not drive a local gateway.
    const origin = req.headers.origin;
    if (origin && !deps.allowedOrigins.includes(origin)) {
      return reply.code(403).send(rpcError(-32000, `Gateway: origin '${origin}' is not allowed`));
    }

    const auth = req.headers.authorization ?? "";
    const owner = auth.startsWith("Bearer ") ? verifyApiKey(deps.db, auth.slice(7).trim()) : null;
    if (!owner) {
      return reply
        .code(401)
        .header("WWW-Authenticate", 'Bearer realm="mcp-gateway"')
        .send(rpcError(-32001, "Gateway: missing, invalid or revoked API key"));
    }
    // Counted per key, after authentication, so unauthenticated noise can't use up a user's budget.
    const decision = deps.keyLimiter?.(owner.keyId);
    if (decision && !decision.allowed) {
      return reply
        .code(429)
        .header("Retry-After", String(decision.retryAfterSec))
        .send(rpcError(-32000, `Gateway: rate limit for this API key exceeded (${decision.limit} requests); retry in ${decision.retryAfterSec} s`));
    }
    const user: GatewayUser ={ id: owner.userId, email: owner.email, role: deps.roleOf({ id: owner.userId, email: owner.email }) };

    const server = new Server({ name: "mcp-gateway", version: "0.1.0" }, { capabilities: { tools: { listChanged: false } } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: deps.core.listTools(user).map(
        (e): Tool => ({ name: e.exposedName, description: e.description, inputSchema: e.inputSchema as Tool["inputSchema"], annotations: e.annotations }),
      ),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await deps.core.callTool(user, request.params.name, request.params.arguments, {
          source: "mcp",
          apiKeyId: owner.keyId,
          requestId: String(req.id),
        });
      } catch (err) {
        if (err instanceof UnknownToolError) throw new McpError(ErrorCode.InvalidParams, err.message);
        throw err;
      }
    });

    // The client's Authorization header ends here: it is never forwarded upstream (SYSTEM.md I3).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    reply.hijack();
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  // No server-initiated stream and no sessions in stateless mode (DESIGN §6.2).
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("Allow", "POST").send(rpcError(-32000, "Gateway: method not allowed, use POST"));
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
