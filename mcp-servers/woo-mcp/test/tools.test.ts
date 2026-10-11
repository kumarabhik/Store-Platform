import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/tools";
import { WooError, type WooClient } from "../src/woo";

interface Call {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

const wcOrder = {
  id: 42,
  number: "42",
  status: "processing",
  total: "199.00",
  currency: "INR",
  date_created: "2026-10-09T10:15:00",
  date_paid: null,
  payment_method_title: "Cash on delivery",
  customer_note: "Ring the bell",
  billing: { first_name: "Asha", last_name: "Rao", email: "asha@example.com" },
  line_items: [{ name: "Ceramic Mug", quantity: 1, total: "199.00" }],
  meta_data: [{ key: "huge", value: "x".repeat(1000) }],
};

const wcProduct = { id: 7, name: "Ceramic Mug", sku: "", status: "publish", price: "199", regular_price: "199", stock_status: "instock", stock_quantity: null, permalink: "http://store/mug", images: [] };

function fakeWoo(respond: (call: Call) => unknown): { woo: WooClient; calls: Call[] } {
  const calls: Call[] = [];
  const handle = async <T>(call: Call): Promise<T> => {
    calls.push(call);
    const result = respond(call);
    if (result instanceof Error) throw result;
    return result as T;
  };
  return {
    calls,
    woo: {
      get: (path, query) => handle({ method: "GET", path, query }),
      post: (path, body) => handle({ method: "POST", path, body }),
      put: (path, body) => handle({ method: "PUT", path, body }),
      storeIndex: async () => ({ name: "Demo Store", description: "", home: "http://store.example.com", timezone: "Asia/Kolkata" }),
      ping: async () => {},
    },
  };
}

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(woo: WooClient): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(woo).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("woo-mcp tools", () => {
  it("lists all six tools with input and output schemas and annotations", async () => {
    const c = await connect(fakeWoo(() => []).woo);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["create_product", "get_order", "get_store_info", "list_orders", "list_products", "update_order_status"],
    );
    for (const t of tools) {
      expect(t.outputSchema?.type).toBe("object");
      expect(t.annotations).toBeDefined();
    }
    expect(tools.find((t) => t.name === "update_order_status")?.annotations?.destructiveHint).toBe(true);
  });

  it("list_products passes filters and trims the output", async () => {
    const { woo, calls } = fakeWoo(() => [wcProduct]);
    const c = await connect(woo);
    const res = await c.callTool({ name: "list_products", arguments: { search: "mug", per_page: 5 } });
    expect(calls[0]).toMatchObject({ path: "/products", query: { search: "mug", per_page: "5", page: "1", status: "any" } });
    expect(res.structuredContent).toEqual({
      products: [{ id: 7, name: "Ceramic Mug", sku: "", status: "publish", price: "199", regular_price: "199", stock_status: "instock", stock_quantity: null, permalink: "http://store/mug" }],
      page: 1,
    });
  });

  it("create_product sends a simple product and rejects a non-decimal price", async () => {
    const { woo, calls } = fakeWoo(() => ({ ...wcProduct, id: 8, name: "Linen Shirt", price: "499", regular_price: "499" }));
    const c = await connect(woo);
    const res = await c.callTool({ name: "create_product", arguments: { name: "Linen Shirt", regular_price: "499", stock_quantity: 3 } });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/products", body: { type: "simple", name: "Linen Shirt", regular_price: "499", status: "publish", manage_stock: true, stock_quantity: 3 } });
    expect((res.structuredContent as { product: { id: number } }).product.id).toBe(8);

    const bad = await c.callTool({ name: "create_product", arguments: { name: "X", regular_price: "₹499" } });
    expect(bad.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("list_orders resolves date=today in the store timezone", async () => {
    const { woo, calls } = fakeWoo(() => [wcOrder]);
    const c = await connect(woo);
    const res = await c.callTool({ name: "list_orders", arguments: { date: "2026-10-09" } });
    expect(calls[0].query).toMatchObject({ after: "2026-10-08T23:59:59", before: "2026-10-10T00:00:00" });
    const out = res.structuredContent as { orders: Record<string, unknown>[]; timezone: string };
    expect(out.timezone).toBe("Asia/Kolkata");
    expect(out.orders[0]).toEqual({
      id: 42, number: "42", status: "processing", total: "199.00", currency: "INR", date_created: "2026-10-09T10:15:00",
      customer_name: "Asha Rao", payment_method: "Cash on delivery", items: [{ name: "Ceramic Mug", quantity: 1, total: "199.00" }],
    });

    await c.callTool({ name: "list_orders", arguments: { date: "today" } });
    expect(calls[1].query?.after).toMatch(/^\d{4}-\d{2}-\d{2}T23:59:59$/);
  });

  it("list_orders refuses date together with after/before", async () => {
    const { woo, calls } = fakeWoo(() => []);
    const c = await connect(woo);
    const res = await c.callTool({ name: "list_orders", arguments: { date: "today", after: "2026-10-01T00:00:00" } });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("get_order adds contact fields and drops raw WooCommerce noise", async () => {
    const c = await connect(fakeWoo(() => wcOrder).woo);
    const res = await c.callTool({ name: "get_order", arguments: { order_id: 42 } });
    const order = (res.structuredContent as { order: Record<string, unknown> }).order;
    expect(order).toMatchObject({ customer_email: "asha@example.com", customer_note: "Ring the bell", date_paid: null });
    expect(order).not.toHaveProperty("meta_data");
  });

  it("update_order_status updates, then adds a private note", async () => {
    const { woo, calls } = fakeWoo((call) => (call.method === "PUT" ? { ...wcOrder, status: "completed" } : {}));
    const c = await connect(woo);
    const res = await c.callTool({ name: "update_order_status", arguments: { order_id: 42, status: "completed", note: "Delivered" } });
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual(["PUT /orders/42", "POST /orders/42/notes"]);
    expect(calls[1].body).toEqual({ note: "Delivered", customer_note: false });
    expect((res.structuredContent as { order: { status: string } }).order.status).toBe("completed");
  });

  it("get_store_info returns name, currency, timezone and today", async () => {
    const c = await connect(fakeWoo(() => ({ value: "INR" })).woo);
    const res = await c.callTool({ name: "get_store_info", arguments: {} });
    expect(res.structuredContent).toMatchObject({ name: "Demo Store", currency: "INR", timezone: "Asia/Kolkata", url: "http://store.example.com" });
  });

  it("maps WooCommerce errors to isError results with the reason", async () => {
    const err = new WooError("WooCommerce at http://wp returned 404 woocommerce_rest_shop_order_invalid_id: Invalid ID.", 404);
    const c = await connect(fakeWoo(() => err).woo);
    const res = await c.callTool({ name: "get_order", arguments: { order_id: 999 } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("woocommerce_rest_shop_order_invalid_id");
  });
});
