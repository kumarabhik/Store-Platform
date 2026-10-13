import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { dayRange, isDay, todayIn } from "./dates";
import {
  orderDetailDto,
  orderDto,
  productDto,
  storeInfoDto,
  toOrder,
  toOrderDetail,
  toProduct,
  type WcOrder,
  type WcProduct,
} from "./dto";
import { WooError, type WooClient } from "./woo";

const ORDER_STATUSES = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"] as const;

const perPage = z.number().int().min(1).max(50).default(20).describe("Results per page, 1-50");
const page = z.number().int().min(1).default(1).describe("Page number, starting at 1");

function ok<T extends Record<string, unknown>>(data: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// Store failures become tool results with isError, so the model can read the reason and recover
// (DESIGN §6.4). Anything else is a bug and goes to the SDK's own error handling.
async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WooError) return fail(err.message);
    throw err;
  }
}

// A new McpServer per request: the HTTP layer is stateless (DESIGN §6.1), and building one is cheap.
export function buildMcpServer(woo: WooClient): McpServer {
  const server = new McpServer({ name: "woo-mcp", version: "0.1.0" });

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description: "List products in the WooCommerce store, newest first. Optional search text and status filter.",
      inputSchema: {
        search: z.string().max(100).optional().describe("Text to match in product name or description"),
        status: z.enum(["any", "publish", "draft", "pending", "private"]).default("any"),
        per_page: perPage,
        page,
      },
      outputSchema: { products: z.array(productDto), page: z.number() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const query: Record<string, string> = { status: args.status, per_page: String(args.per_page), page: String(args.page) };
        if (args.search) query.search = args.search;
        const products = await woo.get<WcProduct[]>("/products", query);
        return ok({ products: products.map(toProduct), page: args.page });
      }),
  );

  server.registerTool(
    "create_product",
    {
      title: "Create product",
      description: "Create a simple product. Price is in the store currency (see get_store_info). Published by default.",
      inputSchema: {
        name: z.string().min(1).max(200),
        regular_price: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/, "a decimal number like 499 or 499.00")
          .describe("Price as a decimal string, e.g. \"499\""),
        description: z.string().max(5000).optional(),
        sku: z.string().max(100).optional(),
        stock_quantity: z.number().int().min(0).optional().describe("Set to track stock; omit for unlimited"),
        status: z.enum(["publish", "draft"]).default("publish"),
      },
      outputSchema: { product: productDto },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const created = await woo.post<WcProduct>("/products", {
          type: "simple",
          name: args.name,
          regular_price: args.regular_price,
          description: args.description,
          sku: args.sku,
          status: args.status,
          manage_stock: args.stock_quantity !== undefined,
          stock_quantity: args.stock_quantity,
        });
        return ok({ product: toProduct(created) });
      }),
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description:
        "List orders, newest first. Use date=\"today\" or date=\"YYYY-MM-DD\" for one day in the store's timezone, " +
        "or after/before (ISO-8601, store-local time) for a range. Not both.",
      inputSchema: {
        date: z
          .string()
          .refine((v) => v === "today" || isDay(v), "\"today\" or YYYY-MM-DD")
          .optional()
          .describe("\"today\" or YYYY-MM-DD, in the store's timezone"),
        after: z.string().datetime({ local: true }).optional().describe("Orders created after this time, e.g. 2026-10-01T00:00:00"),
        before: z.string().datetime({ local: true }).optional().describe("Orders created before this time"),
        status: z.enum(["any", ...ORDER_STATUSES]).default("any"),
        per_page: perPage,
        page,
      },
      outputSchema: { orders: z.array(orderDto), page: z.number(), timezone: z.string(), range: z.object({ after: z.string().optional(), before: z.string().optional() }) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        if (args.date && (args.after || args.before)) return fail("list_orders: use either date or after/before, not both");
        const { timezone } = await woo.storeIndex();
        let range: { after?: string; before?: string } = { after: args.after, before: args.before };
        if (args.date) range = dayRange(args.date === "today" ? todayIn(timezone) : args.date);

        const query: Record<string, string> = { status: args.status, per_page: String(args.per_page), page: String(args.page) };
        if (range.after) query.after = range.after;
        if (range.before) query.before = range.before;
        const orders = await woo.get<WcOrder[]>("/orders", query);
        return ok({ orders: orders.map(toOrder), page: args.page, timezone, range });
      }),
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "Get one order by its ID, including customer email and note.",
      inputSchema: { order_id: z.number().int().positive() },
      outputSchema: { order: orderDetailDto },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const order = await woo.get<WcOrder>(`/orders/${args.order_id}`);
        return ok({ order: toOrderDetail(order) });
      }),
  );

  server.registerTool(
    "update_order_status",
    {
      title: "Update order status",
      description: "Change an order's status (for example processing to completed). Optionally adds a private order note.",
      inputSchema: {
        order_id: z.number().int().positive(),
        status: z.enum(ORDER_STATUSES),
        note: z.string().max(1000).optional().describe("Private note for store staff, not sent to the customer"),
      },
      outputSchema: { order: orderDto },
      // Destructive: it can cancel or refund. Setting the same status twice changes nothing, so idempotent.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const order = await woo.put<WcOrder>(`/orders/${args.order_id}`, { status: args.status });
        if (args.note) await woo.post(`/orders/${args.order_id}/notes`, { note: args.note, customer_note: false });
        return ok({ order: toOrder(order) });
      }),
  );

  server.registerTool(
    "get_store_info",
    {
      title: "Get store info",
      description: "Store name, URL, currency, timezone, and today's date in that timezone. Call this before date or price questions.",
      inputSchema: {},
      outputSchema: storeInfoDto.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      run(async () => {
        const [index, currency] = await Promise.all([
          woo.storeIndex(),
          woo.get<{ value: string }>("/settings/general/woocommerce_currency"),
        ]);
        return ok({
          name: index.name,
          description: index.description,
          url: index.home,
          currency: currency.value,
          timezone: index.timezone,
          today: todayIn(index.timezone),
        });
      }),
  );

  // ---- Merchant tools (DESIGN §13.7): the questions a shop owner actually asks. ----

  server.registerTool(
    "sales_summary",
    {
      title: "Sales summary",
      description:
        "Sales for a date range in the store's timezone: number of orders, revenue, average order value, orders by status, " +
        "and the top products. Dates are YYYY-MM-DD (inclusive) or \"today\"; both default to today. " +
        "Counts orders that are sales (processing, completed, on-hold), not cancelled/failed/refunded ones.",
      inputSchema: {
        from: z.string().refine((v) => v === "today" || isDay(v), "\"today\" or YYYY-MM-DD").default("today"),
        to: z.string().refine((v) => v === "today" || isDay(v), "\"today\" or YYYY-MM-DD").default("today"),
      },
      outputSchema: salesSummaryDto.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const { timezone } = await woo.storeIndex();
        const today = todayIn(timezone);
        const from = args.from === "today" ? today : args.from;
        const to = args.to === "today" ? today : args.to;
        if (from > to) return fail(`sales_summary: 'from' (${from}) is after 'to' (${to})`);
        const range = { after: dayRange(from).after, before: dayRange(to).before };

        // Page through the range; capped so one question can't pull a whole store's history.
        const orders: WcOrder[] = [];
        let truncated = false;
        for (let p = 1; ; p++) {
          const batch = await woo.get<WcOrder[]>("/orders", {
            status: SALE_STATUSES.join(","),
            after: range.after,
            before: range.before,
            per_page: "100",
            page: String(p),
          });
          orders.push(...batch);
          if (batch.length < 100) break;
          if (p === SUMMARY_MAX_PAGES) {
            truncated = true;
            break;
          }
        }
        return ok(summarize(orders, { from, to, timezone, truncated }));
      }),
  );

  server.registerTool(
    "list_low_stock",
    {
      title: "List low stock",
      description: "Published products that are out of stock, or whose tracked stock is at or below the threshold (default 5).",
      inputSchema: { threshold: z.number().int().min(0).max(10_000).default(5) },
      outputSchema: { threshold: z.number(), products: z.array(lowStockDto), truncated: z.boolean() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const low: WcProduct[] = [];
        let truncated = false;
        for (let p = 1; ; p++) {
          const batch = await woo.get<WcProduct[]>("/products", { status: "publish", per_page: "100", page: String(p) });
          low.push(...batch.filter((x) => x.stock_status === "outofstock" || (typeof x.stock_quantity === "number" && x.stock_quantity <= args.threshold)));
          if (batch.length < 100) break;
          if (p === SUMMARY_MAX_PAGES) {
            truncated = true;
            break;
          }
        }
        const products = low
          .map((x) => ({ id: x.id, name: x.name, sku: x.sku ?? "", stock_quantity: x.stock_quantity ?? null, stock_status: x.stock_status ?? "" }))
          .sort((a, b) => (a.stock_quantity ?? -1) - (b.stock_quantity ?? -1));
        return ok({ threshold: args.threshold, products, truncated });
      }),
  );

  server.registerTool(
    "create_refund",
    {
      title: "Create refund",
      description:
        "Refund an order fully or partly. Records the refund in WooCommerce without calling a payment gateway " +
        "(this store takes cash on delivery), so pay the money back by hand. The order becomes 'refunded' when fully refunded.",
      inputSchema: {
        order_id: z.number().int().positive(),
        amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "a decimal like \"199\" or \"49.50\"").describe("Amount in the store currency"),
        reason: z.string().trim().min(1).max(500).describe("Why, for the order's history"),
      },
      outputSchema: { refund: refundDto, order: orderDto },
      // Destructive and not idempotent: each call refunds again. Admin-only by default and asks for
      // approval in the chat, because of this flag (gateway S2, P10).
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const refund = await woo.post<WcRefund>(`/orders/${args.order_id}/refunds`, {
          amount: args.amount,
          reason: args.reason,
          api_refund: false,
        });
        const order = await woo.get<WcOrder>(`/orders/${args.order_id}`);
        return ok({
          refund: { id: refund.id, amount: refund.amount, reason: refund.reason ?? "", date_created: refund.date_created ?? "" },
          order: toOrder(order),
        });
      }),
  );

  return server;
}

// Orders that are sales. Pending (unpaid), cancelled, failed and refunded orders aren't revenue.
const SALE_STATUSES = ["processing", "completed", "on-hold"];
const SUMMARY_MAX_PAGES = 10;

interface WcRefund {
  id: number;
  amount: string;
  reason?: string;
  date_created?: string;
}

const salesSummaryDto = z.object({
  from: z.string(),
  to: z.string(),
  timezone: z.string(),
  currency: z.string(),
  orders: z.number(),
  revenue: z.string(),
  average_order: z.string(),
  by_status: z.record(z.number()),
  top_products: z.array(z.object({ name: z.string(), quantity: z.number(), revenue: z.string() })),
  truncated: z.boolean(),
});

const lowStockDto = z.object({ id: z.number(), name: z.string(), sku: z.string(), stock_quantity: z.number().nullable(), stock_status: z.string() });
const refundDto = z.object({ id: z.number(), amount: z.string(), reason: z.string(), date_created: z.string() });

// Money is added up in cents, so 0.1 + 0.2 doesn't turn into 0.30000000000000004.
const cents = (s: string) => Math.round(parseFloat(s || "0") * 100);
const money = (c: number) => (c / 100).toFixed(2);

export function summarize(orders: WcOrder[], meta: { from: string; to: string; timezone: string; truncated: boolean }) {
  let total = 0;
  const byStatus: Record<string, number> = {};
  const products = new Map<string, { quantity: number; cents: number }>();
  for (const o of orders) {
    total += cents(o.total);
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    for (const li of o.line_items ?? []) {
      const p = products.get(li.name) ?? { quantity: 0, cents: 0 };
      p.quantity += li.quantity;
      p.cents += cents(li.total);
      products.set(li.name, p);
    }
  }
  const top = [...products.entries()]
    .sort((a, b) => b[1].cents - a[1].cents || b[1].quantity - a[1].quantity)
    .slice(0, 5)
    .map(([name, p]) => ({ name, quantity: p.quantity, revenue: money(p.cents) }));
  return {
    ...meta,
    currency: orders[0]?.currency ?? "",
    orders: orders.length,
    revenue: money(total),
    average_order: money(orders.length ? Math.round(total / orders.length) : 0),
    by_status: byStatus,
    top_products: top,
  };
}
