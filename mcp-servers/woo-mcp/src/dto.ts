import { z } from "zod";

// Trimmed shapes returned to the model. Raw WooCommerce JSON is several KB per object (links, meta,
// images, tax lines), which wastes context and over-shares (OWASP MCP10). Each schema doubles as the
// tool's outputSchema, so clients can rely on the fields.

export const productDto = z.object({
  id: z.number(),
  name: z.string(),
  sku: z.string(),
  status: z.string(),
  price: z.string(),
  regular_price: z.string(),
  stock_status: z.string(),
  stock_quantity: z.number().nullable(),
  permalink: z.string(),
});
export type ProductDto = z.infer<typeof productDto>;

export const orderDto = z.object({
  id: z.number(),
  number: z.string(),
  status: z.string(),
  total: z.string(),
  currency: z.string(),
  // Store-local time, the same clock as list_orders' date filter.
  date_created: z.string(),
  customer_name: z.string(),
  payment_method: z.string(),
  items: z.array(z.object({ name: z.string(), quantity: z.number(), total: z.string() })),
});
export type OrderDto = z.infer<typeof orderDto>;

// get_order is a deliberate lookup of one order, so it adds contact and note fields that the list leaves out.
export const orderDetailDto = orderDto.extend({
  customer_email: z.string(),
  customer_note: z.string(),
  date_paid: z.string().nullable(),
});
export type OrderDetailDto = z.infer<typeof orderDetailDto>;

export const storeInfoDto = z.object({
  name: z.string(),
  description: z.string(),
  url: z.string(),
  currency: z.string(),
  timezone: z.string(),
  today: z.string(),
});
export type StoreInfoDto = z.infer<typeof storeInfoDto>;

// Only the WooCommerce fields we read.
export interface WcProduct {
  id: number;
  name: string;
  sku?: string;
  status: string;
  price?: string;
  regular_price?: string;
  stock_status?: string;
  stock_quantity?: number | null;
  permalink?: string;
}

export interface WcOrder {
  id: number;
  number: string;
  status: string;
  total: string;
  currency: string;
  date_created: string;
  date_paid?: string | null;
  payment_method_title?: string;
  customer_note?: string;
  billing?: { first_name?: string; last_name?: string; email?: string };
  line_items?: { name: string; quantity: number; total: string }[];
}

export function toProduct(p: WcProduct): ProductDto {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku ?? "",
    status: p.status,
    price: p.price ?? "",
    regular_price: p.regular_price ?? "",
    stock_status: p.stock_status ?? "",
    stock_quantity: p.stock_quantity ?? null,
    permalink: p.permalink ?? "",
  };
}

export function toOrder(o: WcOrder): OrderDto {
  return {
    id: o.id,
    number: o.number,
    status: o.status,
    total: o.total,
    currency: o.currency,
    date_created: o.date_created,
    customer_name: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" "),
    payment_method: o.payment_method_title ?? "",
    items: (o.line_items ?? []).map((li) => ({ name: li.name, quantity: li.quantity, total: li.total })),
  };
}

export function toOrderDetail(o: WcOrder): OrderDetailDto {
  return {
    ...toOrder(o),
    customer_email: o.billing?.email ?? "",
    customer_note: o.customer_note ?? "",
    date_paid: o.date_paid ?? null,
  };
}
