import { describe, expect, it } from "vitest";
import { auditCsv, csvCell, type AuditRow } from "../src/gateway/audit";

// The audit CSV export (DESIGN §8.1): quoting and the spreadsheet formula-injection guard.

describe("audit CSV", () => {
  it("quotes commas, quotes and newlines (RFC 4180)", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  it("neutralises cells a spreadsheet would run as formulas", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("writes a header row and one CRLF line per row", () => {
    const row: AuditRow = {
      id: 7, ts: "2026-10-13T10:00:00.000Z", user_id: "u1", user_email: "a@example.com", api_key_id: null,
      source: "chat", server_slug: "woo", tool_name: "list_orders", exposed_name: "woo__list_orders",
      duration_ms: 12, outcome: "ok", error: null, args_preview: '{"status":"processing"}',
    };
    const csv = auditCsv([row]);
    expect(csv.endsWith("\r\n")).toBe(true);
    const [header, line] = csv.trimEnd().split("\r\n");
    expect(header.split(",")).toHaveLength(13);
    expect(line).toBe('7,2026-10-13T10:00:00.000Z,a@example.com,u1,,chat,woo,list_orders,woo__list_orders,12,ok,,"{""status"":""processing""}"');
  });
});
