import crypto from "node:crypto";
import type { Db } from "../db";
import { allows, loadPolicy, type Role } from "./policy";
import { parseDbTime } from "./time";

// The aggregated tool list (DESIGN §6.3). Built from the cached mcp_tools table, never from a live
// upstream call, so a slow or dead upstream can't block tools/list (SYSTEM.md I9).

export const SEPARATOR = "__";
const MAX_NAME = 64;
const VALID_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const DESCRIPTION_MAX = 1024;
// A server that just failed one probe keeps its tools for this long, so one blip doesn't make tools flicker.
export const STALE_GRACE_MS = 60_000;

export interface CatalogEntry {
  exposedName: string;
  serverId: string;
  serverSlug: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

// Always "<slug>__<tool>" (I8). Tool names that are too long or contain characters some clients
// reject (dots, spaces) are cleaned and get a 4-hex hash of the original, so two names can't collide.
export function exposedName(slug: string, tool: string): string {
  const plain = `${slug}${SEPARATOR}${tool}`;
  if (VALID_NAME.test(plain)) return plain;
  const hash = crypto.createHash("sha256").update(tool).digest("hex").slice(0, 4);
  const room = MAX_NAME - slug.length - SEPARATOR.length - 5;
  return `${slug}${SEPARATOR}${tool.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, room)}_${hash}`;
}

// Control characters (except tab/newline), zero-width and bidi-override characters: invisible to a
// human reviewing a description, but read by the model. Built from code points to keep the source ASCII.
const INVISIBLE = new RegExp(
  `[${[[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]]
    .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`)
    .join("")}]`,
  "g",
);

// Removes control and zero-width characters (used to hide instructions from human reviewers) and
// labels the description with the server it came from (DESIGN §8.6).
export function sanitizeDescription(serverName: string, description: string | null): string {
  const clean = (description ?? "").replace(INVISIBLE, "").trim();
  const text = `[${serverName}] ${clean}`;
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}

interface ToolRow {
  definition_hash: string;
  approved_hash: string | null;
  server_id: string;
  name: string;
  description: string | null;
  input_schema: string;
  annotations: string | null;
  slug: string;
  server_name: string;
  status: string;
  last_ok_at: string | null;
}

// Every tool this role may see, sorted by exposed name (stable order helps clients' prompt caching).
// role = null skips the policy filter; callTool uses that to tell "denied" from "not found" in the audit log.
// pin: hide tools whose definition changed since an admin (or first sight) approved it (S6).
export async function buildCatalog(db: Db, role: Role | null, opts: { pin?: boolean; now?: number } = {}): Promise<CatalogEntry[]> {
  const { pin = true, now = Date.now() } = opts;
  const policy = await loadPolicy(db);
  const rows = await db.all<ToolRow>(
    `select t.server_id, t.name, t.description, t.input_schema, t.annotations, t.definition_hash, t.approved_hash,
            s.slug, s.name as server_name, s.status, s.last_ok_at
     from mcp_tools t join mcp_servers s on s.id = t.server_id
     where s.enabled = 1`,
  );

  return rows
    .filter((r) => r.status === "Connected" || now - (parseDbTime(r.last_ok_at) ?? 0) < STALE_GRACE_MS)
    .filter((r) => !pin || r.definition_hash === r.approved_hash)
    .map((r) => ({ r, annotations: r.annotations ? (JSON.parse(r.annotations) as Record<string, unknown>) : undefined }))
    .filter(({ r, annotations }) => role === null || allows(role, policy.minRole(r.server_id, r.name, annotations)))
    .map(({ r, annotations }) => ({
      exposedName: exposedName(r.slug, r.name),
      serverId: r.server_id,
      serverSlug: r.slug,
      serverName: r.server_name,
      toolName: r.name,
      description: sanitizeDescription(r.server_name, r.description),
      inputSchema: JSON.parse(r.input_schema) as Record<string, unknown>,
      annotations,
    }))
    .sort((a, b) => (a.exposedName < b.exposedName ? -1 : a.exposedName > b.exposedName ? 1 : 0));
}
