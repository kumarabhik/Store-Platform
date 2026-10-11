import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { openStore } from "../src/store";

const token = "notes-test-token-0123";
const store = openStore(":memory:");
const app = buildApp({ token, store });
afterAll(async () => {
  await app.close();
  store.close();
});

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
let id = 0;
const rpc = async (method: string, params: object) => {
  const res = await app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", id: ++id, method, params } });
  return res.json();
};
const call = async (name: string, args: object) => (await rpc("tools/call", { name, arguments: args })).result;

describe("notes-mcp", () => {
  it("requires its own bearer token", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, authorization: "Bearer wrong" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("notes-mcp");
  });

  it("lists three tools with output schemas", async () => {
    const { result } = await rpc("tools/list", {});
    expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["add_note", "list_notes", "search_notes"]);
    for (const t of result.tools) expect(t.outputSchema.type).toBe("object");
  });

  it("adds, lists by tag, and searches notes", async () => {
    const a = await call("add_note", { title: "Follow up: Test Buyer", body: "Order 14, COD 199 INR. Call tomorrow.", tags: ["follow-up", "order-14"] });
    expect(a.structuredContent.note).toMatchObject({ id: 1, title: "Follow up: Test Buyer", tags: ["follow-up", "order-14"] });
    await call("add_note", { title: "Supplier", body: "Mugs restock 100% confirmed" });

    expect((await call("list_notes", {})).structuredContent.notes.map((n: { id: number }) => n.id)).toEqual([2, 1]);
    expect((await call("list_notes", { tag: "follow-up" })).structuredContent.notes).toHaveLength(1);
    expect((await call("search_notes", { query: "cod 199" })).structuredContent.notes[0].id).toBe(1);
  });

  it("treats % and _ in a search literally", async () => {
    expect((await call("search_notes", { query: "100%" })).structuredContent.notes).toHaveLength(1);
    expect((await call("search_notes", { query: "%" })).structuredContent.notes).toHaveLength(1);
    expect((await call("search_notes", { query: "_" })).structuredContent.notes).toHaveLength(0);
  });

  it("rejects invalid input", async () => {
    const r = await call("add_note", { title: "", body: "x" });
    expect(r.isError).toBe(true);
  });

  it("probes: healthz always, readyz when the DB is readable", async () => {
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/readyz" })).statusCode).toBe(200);
  });
});
