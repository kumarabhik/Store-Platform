import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../src/gateway/catalog";
import { parseToolMode, searchTools } from "../src/gateway/toolSearch";

const tool = (exposedName: string, description: string): CatalogEntry => ({
  exposedName,
  description,
  serverId: "s",
  serverSlug: exposedName.split("__")[0],
  serverName: "S",
  toolName: exposedName.split("__")[1],
  inputSchema: { type: "object" },
});

const catalog = [
  tool("woo__list_orders", "[Store] List orders, optionally only those created on a date such as today."),
  tool("woo__create_product", "[Store] Create a simple product with a price."),
  tool("woo__get_store_info", "[Store] Store name, currency and timezone."),
  tool("notes__add_note", "[Notes] Save a team note, e.g. a follow-up for a customer."),
  tool("notes__search_notes", "[Notes] Find notes containing words."),
  tool("store_ab12__list_orders", "[Store: Anku] List orders, optionally only those created on a date such as today."),
];

describe("BM25 tool search (S4)", () => {
  it("ranks by the words in names and descriptions", () => {
    expect(searchTools(catalog, "orders today", 2).map((t) => t.exposedName).sort()).toEqual(["store_ab12__list_orders", "woo__list_orders"]);
    expect(searchTools(catalog, "create product")[0].exposedName).toBe("woo__create_product");
    expect(searchTools(catalog, "save a follow-up note")[0].exposedName).toBe("notes__add_note");
    expect(searchTools(catalog, "timezone")[0].exposedName).toBe("woo__get_store_info");
  });

  it("returns nothing for no match or an empty query, and caps the limit at 10", () => {
    expect(searchTools(catalog, "kubernetes")).toEqual([]);
    expect(searchTools(catalog, "  ")).toEqual([]);
    expect(searchTools(catalog, "store", 99).length).toBeLessThanOrEqual(10);
  });

  it("reads the mode from env, defaulting to direct", () => {
    expect([undefined, "", "DIRECT", "weird"].map(parseToolMode)).toEqual(["direct", "direct", "direct", "direct"]);
    expect(parseToolMode(" Search ")).toBe("search");
    expect(parseToolMode("auto")).toBe("auto");
  });
});
