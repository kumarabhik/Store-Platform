import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { WooError, type WooClient } from "../src/woo";

const token = "test-token-0123456789";
let storeUp = true;
const woo: WooClient = {
  get: async () => [] as never,
  post: async () => ({}) as never,
  put: async () => ({}) as never,
  storeIndex: async () => ({ name: "", description: "", home: "", timezone: "UTC" }),
  ping: async () => {
    if (!storeUp) throw new WooError("WooCommerce at http://wp is unreachable: ECONNREFUSED");
  },
};
const app = buildApp({ token, woo });
afterAll(() => app.close());

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("/mcp bearer token", () => {
  it("rejects a missing token with 401 and WWW-Authenticate", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", headers, payload: listTools });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Bearer realm="woo-mcp"');
    expect(res.json().error.message).toContain("woo-mcp");
  });

  it("rejects a wrong token", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, authorization: "Bearer nope" }, payload: listTools });
    expect(res.statusCode).toBe(401);
  });

  it("serves MCP statelessly with the right token (no initialize, no session id)", async () => {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { ...headers, authorization: `Bearer ${token}` }, payload: listTools });
    expect(res.statusCode).toBe(200);
    expect(res.headers["mcp-session-id"]).toBeUndefined();
    expect(res.json().result.tools).toHaveLength(6);
  });

  it("answers GET /mcp with 405", async () => {
    const res = await app.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(405);
  });
});

describe("probes", () => {
  it("/healthz is up even when the store is down", async () => {
    storeUp = false;
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("/readyz follows the store and says why it is not ready", async () => {
    storeUp = true;
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    storeUp = false;
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("ECONNREFUSED");
  });
});
