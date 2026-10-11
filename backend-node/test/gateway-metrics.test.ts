import { describe, expect, it } from "vitest";
import { createGatewayMetrics } from "../src/gateway/metrics";

describe("gateway metrics (S8)", () => {
  it("counts calls by server/tool/outcome, keeps a duration histogram, and reports upstream health", () => {
    const m = createGatewayMetrics();
    m.observe("woo", "list_orders", "ok", 0.08);
    m.observe("woo", "list_orders", "ok", 0.3);
    m.observe("woo", "list_orders", "timeout", 15.2);
    const text = m.render([
      { slug: "woo", enabled: true, status: "Connected" },
      { slug: "notes", enabled: true, status: "Unreachable" },
      { slug: "everything", enabled: false, status: "Disabled" },
    ]);
    expect(text).toContain('mcp_tool_calls_total{server="woo",tool="list_orders",outcome="ok"} 2');
    expect(text).toContain('mcp_tool_calls_total{server="woo",tool="list_orders",outcome="timeout"} 1');
    expect(text).toContain('mcp_tool_call_duration_seconds_bucket{server="woo",tool="list_orders",le="0.1"} 1');
    expect(text).toContain('mcp_tool_call_duration_seconds_bucket{server="woo",tool="list_orders",le="0.5"} 2');
    expect(text).toContain('mcp_tool_call_duration_seconds_bucket{server="woo",tool="list_orders",le="+Inf"} 3');
    expect(text).toContain('mcp_tool_call_duration_seconds_count{server="woo",tool="list_orders"} 3');
    expect(text).toMatch(/mcp_upstream_up\{server="woo"\} 1\n/);
    expect(text).toMatch(/mcp_upstream_up\{server="notes"\} 0\n/);
    expect(text).toMatch(/mcp_upstream_up\{server="everything"\} 0\n/);
  });

  it("names that match no tool collapse into 'unknown', so random names can't grow the label set", () => {
    const m = createGatewayMetrics();
    for (let i = 0; i < 50; i++) m.observe(null, `probe_${i}`, "not_found", 0.001);
    const lines = m.render([]).split("\n").filter((l) => l.startsWith("mcp_tool_calls_total{"));
    expect(lines).toEqual(['mcp_tool_calls_total{server="unknown",tool="unknown",outcome="not_found"} 50']);
  });

  it("escapes label values", () => {
    const m = createGatewayMetrics();
    m.observe('we"ird', "a\\b", "ok", 0);
    expect(m.render([])).toContain('mcp_tool_calls_total{server="we\\"ird",tool="a\\\\b",outcome="ok"} 1');
  });
});
