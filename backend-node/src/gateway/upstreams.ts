import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

// MCP client pool: one SDK Client per upstream, created lazily and reused (DESIGN §6.6).
// The gateway's own credential for each upstream is injected here; the caller's credential never is (I3).

export type FailureKind = "timeout" | "unreachable" | "tool_error";

export class UpstreamError extends Error {
  constructor(readonly kind: FailureKind, message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface UpstreamTarget {
  id: string;
  slug: string;
  url: string;
  // Changes when the row changes (updated_at), so an edited URL or credential gets a new client.
  version: string;
  headers: () => Record<string, string>;
}

interface Pooled {
  version: string;
  client: Client;
  connecting: Promise<void>;
}

export function createUpstreamPool(opts: { fetch?: FetchLike; maxInFlight?: number } = {}) {
  const maxInFlight = opts.maxInFlight ?? 16;
  const pool = new Map<string, Pooled>();
  const inFlight = new Map<string, number>();

  function drop(id: string) {
    const p = pool.get(id);
    pool.delete(id);
    void p?.client.close().catch(() => {});
  }

  function clientFor(t: UpstreamTarget, timeoutMs: number): Pooled {
    const existing = pool.get(t.id);
    if (existing && existing.version === t.version) return existing;
    if (existing) drop(t.id);
    const client = new Client({ name: "mcp-gateway", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(t.url), {
      fetch: opts.fetch,
      requestInit: { headers: t.headers() },
    });
    const entry: Pooled = { version: t.version, client, connecting: client.connect(transport, { timeout: timeoutMs }) };
    // A failed handshake must not poison the pool: the next call starts fresh.
    entry.connecting.catch(() => {
      if (pool.get(t.id) === entry) drop(t.id);
    });
    pool.set(t.id, entry);
    return entry;
  }

  // Turns SDK, HTTP and network errors into one of three outcomes with a message naming the upstream.
  function classify(t: UpstreamTarget, err: unknown, timeoutMs: number): UpstreamError {
    if (err instanceof UpstreamError) return err;
    const e = err as Error & { code?: unknown; cause?: { code?: string; message?: string } };
    if ((e instanceof McpError && e.code === ErrorCode.RequestTimeout) || e.name === "TimeoutError" || e.name === "AbortError") {
      return new UpstreamError("timeout", `Upstream '${t.slug}' timed out after ${timeoutMs} ms`);
    }
    if (e instanceof StreamableHTTPError) {
      if (e.code === 401 || e.code === 403) {
        return new UpstreamError("unreachable", `Upstream '${t.slug}' rejected the gateway's credential (HTTP ${e.code}): check the server's credential`);
      }
      return new UpstreamError("unreachable", `Upstream '${t.slug}' returned HTTP ${e.code ?? "error"}`);
    }
    if (e instanceof McpError) {
      // A JSON-RPC error from the upstream itself (e.g. unknown tool): it answered, so it is reachable.
      return new UpstreamError("tool_error", `Upstream '${t.slug}' error: ${e.message}`);
    }
    const reason = e.cause?.code ?? e.cause?.message ?? e.message;
    return new UpstreamError("unreachable", `Upstream '${t.slug}' is unreachable: ${reason}`);
  }

  async function withClient<T>(t: UpstreamTarget, timeoutMs: number, fn: (c: Client) => Promise<T>): Promise<T> {
    // Bulkhead: one slow upstream can hold at most maxInFlight sockets and requests.
    const busy = inFlight.get(t.id) ?? 0;
    if (busy >= maxInFlight) throw new UpstreamError("unreachable", `Upstream '${t.slug}' is busy (${maxInFlight} calls in flight)`);
    inFlight.set(t.id, busy + 1);
    try {
      for (let attempt = 0; ; attempt++) {
        const entry = clientFor(t, timeoutMs);
        try {
          await entry.connecting;
          return await fn(entry.client);
        } catch (err) {
          // 404 on a session-bound upstream means it restarted and forgot our session: reconnect once.
          if (attempt === 0 && err instanceof StreamableHTTPError && err.code === 404) {
            drop(t.id);
            continue;
          }
          // A dead or misbehaving connection is not reused for the next call.
          if (!(err instanceof McpError) || err.code === ErrorCode.RequestTimeout || err.code === ErrorCode.ConnectionClosed) drop(t.id);
          throw classify(t, err, timeoutMs);
        }
      }
    } finally {
      inFlight.set(t.id, (inFlight.get(t.id) ?? 1) - 1);
    }
  }

  return {
    async listTools(t: UpstreamTarget, timeoutMs: number): Promise<Tool[]> {
      return withClient(t, timeoutMs, async (c) => {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await c.listTools(cursor ? { cursor } : {}, { timeout: timeoutMs });
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        return tools;
      });
    },

    async callTool(t: UpstreamTarget, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult> {
      return withClient(t, timeoutMs, (c) => c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }) as Promise<CallToolResult>);
    },

    drop,

    async closeAll() {
      for (const id of [...pool.keys()]) drop(id);
    },
  };
}

export type UpstreamPool = ReturnType<typeof createUpstreamPool>;
