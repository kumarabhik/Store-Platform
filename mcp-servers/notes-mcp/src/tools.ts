import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { NoteStore } from "./store";

const note = z.object({ id: z.number(), title: z.string(), body: z.string(), tags: z.array(z.string()), created_at: z.string() });
const limit = z.number().int().min(1).max(50).default(20).describe("Maximum notes to return, 1-50");

function ok<T extends Record<string, unknown>>(data: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

// A new McpServer per request: the HTTP layer is stateless, like woo-mcp.
export function buildMcpServer(store: NoteStore): McpServer {
  const server = new McpServer({ name: "notes-mcp", version: "0.1.0" });

  server.registerTool(
    "add_note",
    {
      title: "Add note",
      description: "Save a team note, e.g. a follow-up for a customer. Optional tags make it easy to list later.",
      inputSchema: {
        title: z.string().trim().min(1).max(200),
        body: z.string().max(5000),
        tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]).describe("e.g. [\"follow-up\", \"order-14\"]"),
      },
      outputSchema: { note },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => ok({ note: store.add(args.title, args.body, args.tags) }),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "Most recent notes first, optionally only those with a given tag.",
      inputSchema: { tag: z.string().max(40).optional(), limit },
      outputSchema: { notes: z.array(note) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => ok({ notes: store.list(args.limit, args.tag) }),
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description: "Find notes whose title or body contains the text (case-insensitive for ASCII).",
      inputSchema: { query: z.string().trim().min(1).max(200), limit },
      outputSchema: { notes: z.array(note) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => ok({ notes: store.search(args.query, args.limit) }),
  );

  return server;
}
