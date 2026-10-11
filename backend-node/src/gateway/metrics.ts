// Prometheus metrics for the gateway (ROADMAP S8), in Prometheus text format without a client library:
//   mcp_tool_calls_total{server,tool,outcome}      counter
//   mcp_tool_call_duration_seconds{server,tool}    histogram
//   mcp_upstream_up{server}                        gauge, 1 = Connected
// Kept in memory: counters restart at 0 when the pod restarts, which Prometheus' rate() handles.
// The audit log stays the durable record of every call.

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30];

// A name that doesn't resolve to a catalog tool is counted as "unknown", so a client sending random
// tool names can't create unlimited label values (memory) or learn anything from the output.
export const UNKNOWN = "unknown";

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (l: Record<string, string>) => `{${Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}`;

export function createGatewayMetrics() {
  const calls = new Map<string, { server: string; tool: string; outcome: string; n: number }>();
  const durations = new Map<string, { server: string; tool: string; buckets: number[]; sum: number; count: number }>();

  return {
    observe(server: string | null | undefined, tool: string | null | undefined, outcome: string, seconds: number) {
      const s = server || UNKNOWN;
      const t = server ? tool || UNKNOWN : UNKNOWN;
      const ck = `${s}\u0000${t}\u0000${outcome}`;
      const c = calls.get(ck) ?? { server: s, tool: t, outcome, n: 0 };
      c.n += 1;
      calls.set(ck, c);
      const dk = `${s}\u0000${t}`;
      const d = durations.get(dk) ?? { server: s, tool: t, buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      BUCKETS.forEach((b, i) => {
        if (seconds <= b) d.buckets[i] += 1;
      });
      d.sum += seconds;
      d.count += 1;
      durations.set(dk, d);
    },

    render(upstreams: { slug: string; enabled: boolean; status: string }[]): string {
      const out: string[] = [];
      out.push("# HELP mcp_tool_calls_total Tool calls through the gateway, by upstream server, tool and outcome.");
      out.push("# TYPE mcp_tool_calls_total counter");
      for (const c of calls.values()) out.push(`mcp_tool_calls_total${labels({ server: c.server, tool: c.tool, outcome: c.outcome })} ${c.n}`);
      out.push("# HELP mcp_tool_call_duration_seconds Time from request to result (or error), including the upstream call.");
      out.push("# TYPE mcp_tool_call_duration_seconds histogram");
      for (const d of durations.values()) {
        const base = { server: d.server, tool: d.tool };
        BUCKETS.forEach((b, i) => out.push(`mcp_tool_call_duration_seconds_bucket${labels({ ...base, le: String(b) })} ${d.buckets[i]}`));
        out.push(`mcp_tool_call_duration_seconds_bucket${labels({ ...base, le: "+Inf" })} ${d.count}`);
        out.push(`mcp_tool_call_duration_seconds_sum${labels(base)} ${d.sum.toFixed(6)}`);
        out.push(`mcp_tool_call_duration_seconds_count${labels(base)} ${d.count}`);
      }
      out.push("# HELP mcp_upstream_up 1 if the upstream answered its last health probe, 0 if not or disabled.");
      out.push("# TYPE mcp_upstream_up gauge");
      for (const u of upstreams) out.push(`mcp_upstream_up${labels({ server: u.slug })} ${u.enabled && u.status === "Connected" ? 1 : 0}`);
      return out.join("\n") + "\n";
    },
  };
}

export type GatewayMetrics = ReturnType<typeof createGatewayMetrics>;
