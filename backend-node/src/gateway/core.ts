import crypto from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../db";
import { writeAudit, type Outcome } from "./audit";
import { buildCatalog, type CatalogEntry } from "./catalog";
import type { GatewayMetrics } from "./metrics";
import { CALL_TOOL, META_TOOLS, SEARCH_TOOL, searchTools, type ToolMode } from "./toolSearch";
import { targetFor, type HealthChecker } from "./health";
import { allows, loadPolicy, type Role } from "./policy";
import type { Registry } from "./registry";
import { UpstreamError, type UpstreamPool } from "./upstreams";

// GatewayCore: the ONLY way to reach upstream MCP servers (SYSTEM.md I1). Both /mcp and the chat
// agent call listTools/callTool, so filtering, policy, timeouts and audit can't drift apart.

export interface GatewayUser {
  id: string;
  email: string;
  role: Role;
}

export interface CallContext {
  source: "mcp" | "chat";
  apiKeyId?: string | null;
  requestId?: string;
}

// Returned to the client for protocol misuse (unknown or forbidden tool), as a JSON-RPC error.
// Denied and not-found look the same on purpose: a member can't probe which tools exist.
export class UnknownToolError extends Error {
  constructor(readonly exposedName: string) {
    super(`Unknown tool: ${exposedName}`);
    this.name = "UnknownToolError";
  }
}

const MAX_RESULT_BYTES = 256 * 1024;

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export interface GatewayOptions {
  metrics?: GatewayMetrics;
  // S4: "direct" lists every tool, "search" only the two meta-tools, "auto" switches to search
  // when a user can see more than autoThreshold tools (DESIGN §7.5).
  toolMode?: ToolMode;
  autoThreshold?: number;
  // S6: hide tools whose definition changed until an admin approves it (default on).
  pinTools?: boolean;
}

export function createGatewayCore(db: Db, registry: Registry, pool: UpstreamPool, health: HealthChecker, opts: GatewayOptions = {}) {
  const { metrics, toolMode = "direct", autoThreshold = 40, pinTools = true } = opts;
  const catalog = (role: Role | null) => buildCatalog(db, role, { pin: pinTools });
  const searchMode = (visible: CatalogEntry[]) => toolMode === "search" || (toolMode === "auto" && visible.length > autoThreshold);
  const ajv = new Ajv({ allErrors: false, strict: false });
  // Compiled schemas, keyed by the tool's definition so a changed schema recompiles.
  const validators = new Map<string, ValidateFunction>();

  function validatorFor(entry: CatalogEntry): ValidateFunction | null {
    const key = `${entry.serverId}\u0000${entry.toolName}\u0000${JSON.stringify(entry.inputSchema)}`;
    let v = validators.get(key);
    if (!v) {
      try {
        v = ajv.compile(entry.inputSchema);
      } catch {
        return null; // An upstream with an invalid schema: let the upstream validate its own input.
      }
      validators.set(key, v);
    }
    return v;
  }

  // A search over the tools this user may see. Audited like any call (I2), although it never
  // reaches an upstream.
  function runSearch(user: GatewayUser, visible: CatalogEntry[], args: Record<string, unknown> | undefined, ctx: CallContext): CallToolResult {
    const started = performance.now();
    const query = typeof args?.query === "string" ? args.query.slice(0, 200) : "";
    const limit = Number.isInteger(args?.limit) ? Number(args!.limit) : 5;
    const found = query.trim() ? searchTools(visible, query, limit) : [];
    const tools = found.map((e) => ({ name: e.exposedName, description: e.description, inputSchema: e.inputSchema }));
    writeAudit(db, {
      requestId: ctx.requestId ?? crypto.randomUUID(),
      userId: user.id,
      userEmail: user.email,
      apiKeyId: ctx.apiKeyId ?? null,
      source: ctx.source,
      serverId: null,
      serverSlug: "gateway",
      toolName: "search_tools",
      exposedName: SEARCH_TOOL,
      durationMs: performance.now() - started,
      outcome: query.trim() ? "ok" : "bad_request",
      error: query.trim() ? null : "query is required",
      args: args ?? {},
    });
    metrics?.observe("gateway", "search_tools", query.trim() ? "ok" : "bad_request", (performance.now() - started) / 1000);
    if (!query.trim()) return errorResult("Gateway: search_tools needs a non-empty 'query'");
    return {
      content: [{ type: "text", text: tools.length ? JSON.stringify({ tools }) : `No tools match '${query}'. Try other words.` }],
      structuredContent: { tools },
    };
  }

  return {
    // What a client is shown: every visible tool, or in search mode only the two meta-tools.
    listTools(user: GatewayUser): CatalogEntry[] {
      const visible = catalog(user.role);
      return searchMode(visible) ? META_TOOLS : visible;
    },

    async callTool(user: GatewayUser, exposedName: string, args: Record<string, unknown> | undefined, ctx: CallContext): Promise<CallToolResult> {
      if (exposedName === SEARCH_TOOL || exposedName === CALL_TOOL) {
        const visible = catalog(user.role);
        // Outside search mode the meta-tools don't exist; fall through to "Unknown tool".
        if (searchMode(visible)) {
          if (exposedName === SEARCH_TOOL) return runSearch(user, visible, args, ctx);
          // The real tool is resolved, checked and audited exactly like a direct call.
          const inner = args?.arguments;
          return callUpstream(user, String(args?.name ?? ""), inner && typeof inner === "object" ? (inner as Record<string, unknown>) : {}, ctx);
        }
      }
      return callUpstream(user, exposedName, args, ctx);
    },
  };

  // Resolve, check policy, validate, call the upstream, audit (I2). The only path to an upstream (I1).
  async function callUpstream(user: GatewayUser, exposedName: string, args: Record<string, unknown> | undefined, ctx: CallContext): Promise<CallToolResult> {
    const started = performance.now();
    let outcome: Outcome = "not_found";
    let error: string | null = null;
    let entry: CatalogEntry | undefined;
    try {
      // Resolve against all visible tools first, then apply policy, so the audit log can say "denied".
      entry = catalog(null).find((e) => e.exposedName === exposedName);
      if (!entry) throw new UnknownToolError(exposedName);
      if (!allows(user.role, loadPolicy(db).minRole(entry.serverId, entry.toolName, entry.annotations))) {
        outcome = "denied";
        throw new UnknownToolError(exposedName);
      }

      const validate = validatorFor(entry);
      if (validate && !validate(args ?? {})) {
        outcome = "bad_request";
        error = `invalid arguments: ${ajv.errorsText(validate.errors)}`;
        return errorResult(`Gateway: ${error}`);
      }

      const server = registry.get(entry.serverId)!;
      let result: CallToolResult;
      try {
        result = await pool.callTool(targetFor(registry, server), entry.toolName, args ?? {}, server.timeout_ms);
      } catch (err) {
        const e = err instanceof UpstreamError ? err : new UpstreamError("unreachable", `Upstream '${server.slug}' failed: ${(err as Error).message}`);
        outcome = e.kind;
        error = e.message;
        // Don't wait for the next health tick: hide this server's tools after the grace period now.
        if (e.kind === "unreachable") health.markUnreachable(server.id, e.message);
        return errorResult(e.message);
      }

      const size = Buffer.byteLength(JSON.stringify(result));
      if (size > MAX_RESULT_BYTES) {
        outcome = "tool_error";
        error = `Upstream '${server.slug}' returned ${Math.round(size / 1024)} KB, over the ${MAX_RESULT_BYTES / 1024} KB limit`;
        return errorResult(error);
      }
      outcome = result.isError ? "tool_error" : "ok";
      if (result.isError) error = result.content?.find((c) => c.type === "text")?.text?.slice(0, 500) ?? "tool returned isError";
      return result;
    } finally {
      // Exactly one audit row per call, whatever happened above (SYSTEM.md I2).
      writeAudit(db, {
        requestId: ctx.requestId ?? crypto.randomUUID(),
        userId: user.id,
        userEmail: user.email,
        apiKeyId: ctx.apiKeyId ?? null,
        source: ctx.source,
        serverId: entry?.serverId ?? null,
        serverSlug: entry?.serverSlug ?? null,
        toolName: entry?.toolName ?? exposedName,
        exposedName,
        durationMs: performance.now() - started,
        outcome,
        error,
        args: args ?? {},
      });
      metrics?.observe(entry?.serverSlug, entry?.toolName, outcome, (performance.now() - started) / 1000);
    }
  }
}

export type GatewayCore = ReturnType<typeof createGatewayCore>;
