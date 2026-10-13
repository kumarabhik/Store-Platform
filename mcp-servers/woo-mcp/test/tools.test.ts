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
  it("lists all nine tools with input and output schemas and annotations", async () => {
    const c = await connect(fakeWoo(() => []).woo);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_product", "create_refund", "get_order", "get_store_info", "list_low_stock",
      "list_orders", "list_products", "sales_summary", "update_order_status",
    ]);
    for (const t of tools) {
      expect(t.outputSchema?.type).toBe("object");
      expect(t.annotations).toBeDefined();
    }
    expect(tools.find((t) => t.name === "update_order_status")?.annotations?.destructiveHint).toBe(true);
    // The gateway makes destructive tools admin-only and asks before them in the chat (S2, P10).
    expect(tools.find((t) => t.name === "create_refund")?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    for (const name of ["sales_summary", "list_low_stock"]) expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(true);
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

  it("sales_summary adds up sales in cents for an inclusive date range, by status, with top products", async () => {
    const order = (id: number, status: string, total: string, items: [string, number, string][]) => ({
      ...wcOrder, id, number: String(id), status, total, line_items: items.map(([name, quantity, t]) => ({ name, quantity, total: t })),
    });
    const { woo, calls } = fakeWoo(() => [
      order(1, "processing", "199.10", [["Ceramic Mug", 1, "199.10"]]),
      order(2, "completed", "0.20", [["Sticker", 2, "0.20"]]),
      order(3, "on-hold", "499.00", [["Linen Shirt", 1, "499.00"]]),
    ]);
    const c = await connect(woo);
    const res = await c.callTool({ name: "sales_summary", arguments: { from: "2026-10-01", to: "2026-10-07" } });
    expect(calls[0].query).toMatchObject({ status: "processing,completed,on-hold", after: "2026-09-30T23:59:59", before: "2026-10-08T00:00:00", per_page: "100" });
    expect(res.structuredContent).toMatchObject({
      from: "2026-10-01", to: "2026-10-07", timezone: "Asia/Kolkata", currency: "INR",
      orders: 3, revenue: "698.30", average_order: "232.77", truncated: false,
      by_status: { processing: 1, completed: 1, "on-hold": 1 },
    });
    expect((res.structuredContent as { top_products: { name: string }[] }).top_products.map((p) => p.name)).toEqual(["Linen Shirt", "Ceramic Mug", "Sticker"]);

    const bad = await c.callTool({ name: "sales_summary", arguments: { from: "2026-10-07", to: "2026-10-01" } });
    expect(bad.isError).toBe(true);
  });

  it("sales_summary stops after 10 pages and says it was truncated", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ ...wcOrder, id: i, total: "1.00" }));
    const { woo, calls } = fakeWoo(() => page);
    const res = await (await connect(woo)).callTool({ name: "sales_summary", arguments: {} });
    expect(calls).toHaveLength(10);
    expect(res.structuredContent).toMatchObject({ orders: 1000, revenue: "1000.00", truncated: true });
  });

  it("list_low_stock returns out-of-stock and at-or-below-threshold products, lowest first", async () => {
    const p = (id: number, stock_quantity: number | null, stock_status = "instock") => ({ ...wcProduct, id, name: `P${id}`, stock_quantity, stock_status });
    const { woo } = fakeWoo(() => [p(1, 10), p(2, 3), p(3, null), p(4, 0, "outofstock"), p(5, 5)]);
    const res = await (await connect(woo)).callTool({ name: "list_low_stock", arguments: {} });
    const out = res.structuredContent as { threshold: number; products: { id: number }[] };
    expect(out.threshold).toBe(5);
    expect(out.products.map((x) => x.id)).toEqual([4, 2, 5]);
  });

  it("create_refund records the refund without a payment gateway call and returns the updated order", async () => {
    const { woo, calls } = fakeWoo((call) =>
      call.method === "POST" ? { id: 90, amount: "199.00", reason: "Damaged", date_created: "2026-10-11T10:00:00" } : { ...wcOrder, status: "refunded" },
    );
    const c = await connect(woo);
    const res = await c.callTool({ name: "create_refund", arguments: { order_id: 42, amount: "199", reason: "Damaged" } });
    expect(calls[0]).toEqual({ method: "POST", path: "/orders/42/refunds", body: { amount: "199", reason: "Damaged", api_refund: false } });
    expect(res.structuredContent).toMatchObject({ refund: { id: 90, amount: "199.00" }, order: { id: 42, status: "refunded" } });

    const bad = await c.callTool({ name: "create_refund", arguments: { order_id: 42, amount: "1,99", reason: "x" } });
    expect(bad.isError).toBe(true);
  });
});
