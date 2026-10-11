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

  return server;
}
