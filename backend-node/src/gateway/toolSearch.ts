import type { CatalogEntry } from "./catalog";

// Many-tools mode (DESIGN §7.5, ROADMAP S4). Sending every tool schema to the model on every turn
// costs tokens and hurts tool choice once there are dozens of tools (RAG-MCP). In search mode a
// client sees only two meta-tools: find tools by keywords, then call one by name. Both act as the
// user: search only looks at tools this user may see, and the call goes through the normal policy,
// timeout and audit path.

export type ToolMode = "direct" | "search" | "auto";
export const SEARCH_TOOL = "gateway__search_tools";
export const CALL_TOOL = "gateway__call_tool";

export function parseToolMode(raw: string | undefined): ToolMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "search" || v === "auto" ? v : "direct";
}

// The two meta-tools, shaped like catalog entries so /mcp and the chat can list them the same way.
// Slug "gateway" can't collide with an upstream: the registry refuses it as a server slug.
export const META_TOOLS: CatalogEntry[] = [
  {
    exposedName: SEARCH_TOOL,
    serverId: "gateway",
    serverSlug: "gateway",
    serverName: "Gateway",
    toolName: "search_tools",
    description:
      "[Gateway] Find tools by keywords (e.g. 'orders today', 'create product', 'save note'). Returns matching tool names with their descriptions and input schemas. Then call one with gateway__call_tool.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "What you want to do, in a few words" },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    exposedName: CALL_TOOL,
    serverId: "gateway",
    serverSlug: "gateway",
    serverName: "Gateway",
    toolName: "call_tool",
    description:
      "[Gateway] Call a tool found with gateway__search_tools. 'name' is the exact tool name (server__tool); 'arguments' must match that tool's input schema.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64 },
        arguments: { type: "object", default: {} },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { openWorldHint: true },
  },
];

// snake_case and server__tool names become separate words: "woo__list_orders" -> woo, list, orders.
function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

// BM25 (k1 = 1.2, b = 0.75) over each tool's exposed name + description. No embeddings, no extra
// service: good enough for tens to hundreds of tools, and every score is explainable.
export function searchTools(catalog: CatalogEntry[], query: string, limit = 5): CatalogEntry[] {
  const q = [...new Set(tokens(query))];
  if (q.length === 0 || catalog.length === 0) return [];
  const docs = catalog.map((e) => tokens(`${e.exposedName} ${e.description}`));
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const k1 = 1.2;
  const b = 0.75;
  const scored = catalog.map((entry, i) => {
    const d = docs[i];
    let score = 0;
    for (const t of q) {
      const tf = d.filter((w) => w === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (catalog.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avgLen));
    }
    return { entry, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b2) => b2.score - a.score || (a.entry.exposedName < b2.entry.exposedName ? -1 : 1))
    .slice(0, Math.max(1, Math.min(limit, 10)))
    .map((s) => s.entry);
}
