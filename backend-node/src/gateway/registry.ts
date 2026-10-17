import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "../db";
import { open, seal } from "./crypto";
import { MIN_ROLES, type MinRole } from "./policy";
import { checkUpstreamUrl, type SsrfPolicy } from "./ssrf";

// Registry of upstream MCP servers (DESIGN §5 mcp_servers, §7.3). The credential is write-only:
// it is sealed on the way in, and only authHeadersFor() (used by the upstream client) ever opens it.

export class RegistryError extends Error {
  constructor(readonly code: "invalid" | "not_found" | "conflict" | "forbidden", message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

// Slug = tool prefix ("woo" -> "woo__list_orders"). No "__" and no trailing "_", so splitting an
// exposed name on the first "__" is never ambiguous (DESIGN §6.5). Immutable after creation.
export const slugSchema = z
  .string()
  .max(24)
  .regex(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, "lowercase letters, digits and single underscores, starting with a letter")
  // The gateway's own meta-tools are gateway__search_tools / gateway__call_tool (search mode, S4).
  .refine((s) => s !== "gateway", "'gateway' is reserved for the gateway's own tools");

const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "a plain HTTP header name like X-API-Key");
const authType = z.enum(["none", "bearer", "header"]);

export const createServerSchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(80),
    url: z.string().max(2048),
    auth_type: authType.default("none"),
    auth_header_name: headerName.optional(),
    credential: z.string().min(1).max(4096).optional(),
    enabled: z.boolean().default(true),
    timeout_ms: z.number().int().min(1000).max(120_000).default(15_000),
  })
  .superRefine((v, ctx) => {
    if (v.auth_type !== "none" && !v.credential) ctx.addIssue({ code: "custom", path: ["credential"], message: `required for auth_type '${v.auth_type}'` });
    if (v.auth_type === "header" && !v.auth_header_name) ctx.addIssue({ code: "custom", path: ["auth_header_name"], message: "required for auth_type 'header'" });
  });

export const updateServerSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: z.string().max(2048).optional(),
  auth_type: authType.optional(),
  auth_header_name: headerName.nullable().optional(),
  // undefined = keep the stored credential, null = remove it, string = replace it.
  credential: z.string().min(1).max(4096).nullable().optional(),
  enabled: z.boolean().optional(),
  timeout_ms: z.number().int().min(1000).max(120_000).optional(),
});

export type CreateServerInput = z.input<typeof createServerSchema>;
export type UpdateServerInput = z.input<typeof updateServerSchema>;
export type ManagedBy = "admin" | "helm" | "provisioner";

interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: "none" | "bearer" | "header";
  auth_header_name: string | null;
  auth_secret_enc: string | null;
  enabled: number;
  timeout_ms: number;
  managed_by: ManagedBy;
  store_id: string | null;
  status: string;
  last_error: string | null;
  last_ok_at: string | null;
  last_check_at: string | null;
  last_latency_ms: number | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

// What the API may return. Never contains the credential, sealed or not (SYSTEM.md I4).
export type PublicServer = Omit<ServerRow, "auth_secret_enc" | "enabled"> & { enabled: boolean; has_credential: boolean };

function toPublic(row: ServerRow): PublicServer {
  const { auth_secret_enc, enabled, ...rest } = row;
  return { ...rest, enabled: enabled === 1, has_credential: auth_secret_enc !== null };
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new RegistryError("invalid", `Gateway registry: ${r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  }
  return r.data;
}

export function createRegistry(db: Db, encKey: Buffer, ssrf: SsrfPolicy, lookupAll?: Parameters<typeof checkUpstreamUrl>[2]) {
  const getRow = (id: string) => db.get<ServerRow>(`select * from mcp_servers where id = ?`, id);

  async function checkedUrl(raw: string): Promise<string> {
    try {
      return (await checkUpstreamUrl(raw, ssrf, lookupAll)).toString();
    } catch (err) {
      throw new RegistryError("invalid", (err as Error).message);
    }
  }

  return {
    async list(): Promise<PublicServer[]> {
      return (await db.all<ServerRow>(`select * from mcp_servers order by slug`)).map(toPublic);
    },

    async get(id: string): Promise<PublicServer | undefined> {
      const row = await getRow(id);
      return row && toPublic(row);
    },

    async getBySlug(slug: string): Promise<PublicServer | undefined> {
      const row = await db.get<ServerRow>(`select * from mcp_servers where slug = ?`, slug);
      return row && toPublic(row);
    },

    async create(input: unknown, managedBy: ManagedBy = "admin", storeId: string | null = null): Promise<PublicServer> {
      const v = parse(createServerSchema, input);
      const url = await checkedUrl(v.url);
      const id = crypto.randomBytes(8).toString("hex");
      // The unique slug decides, also when two replicas create the same slug at the same moment.
      const { changes } = await db.run(
        `insert into mcp_servers (id, slug, name, url, auth_type, auth_header_name, auth_secret_enc, enabled, timeout_ms, managed_by, store_id, status)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (slug) do nothing`,
        id, v.slug, v.name, url, v.auth_type,
        v.auth_type === "header" ? (v.auth_header_name ?? null) : null,
        v.auth_type === "none" || !v.credential ? null : seal(encKey, v.credential, id),
        v.enabled ? 1 : 0, v.timeout_ms, managedBy, storeId,
        v.enabled ? "Unknown" : "Disabled",
      );
      if (changes === 0) throw new RegistryError("conflict", `Gateway registry: slug '${v.slug}' is already used by another server`);
      return toPublic((await getRow(id))!);
    },

    async update(id: string, input: unknown): Promise<PublicServer> {
      const row = await getRow(id);
      if (!row) throw new RegistryError("not_found", `Gateway registry: server ${id} not found`);
      if ("slug" in (input as object) && (input as { slug?: unknown }).slug !== row.slug) {
        throw new RegistryError("invalid", "Gateway registry: slug cannot change; it is part of every tool name clients already use");
      }
      const v = parse(updateServerSchema, input);
      const authTypeNext = v.auth_type ?? row.auth_type;
      const headerNext = authTypeNext === "header" ? (v.auth_header_name ?? row.auth_header_name) : null;
      let secretNext = row.auth_secret_enc;
      if (v.credential === null || authTypeNext === "none") secretNext = null;
      else if (typeof v.credential === "string") secretNext = seal(encKey, v.credential, id);
      if (authTypeNext !== "none" && !secretNext) throw new RegistryError("invalid", `Gateway registry: credential: required for auth_type '${authTypeNext}'`);
      if (authTypeNext === "header" && !headerNext) throw new RegistryError("invalid", "Gateway registry: auth_header_name: required for auth_type 'header'");
      const enabledNext = v.enabled ?? row.enabled === 1;

      const urlNext = v.url === undefined ? row.url : await checkedUrl(v.url);
      await db.run(
        `update mcp_servers set name = ?, url = ?, auth_type = ?, auth_header_name = ?, auth_secret_enc = ?, enabled = ?,
           timeout_ms = ?, status = ?, updated_at = ${db.now} where id = ?`,
        v.name ?? row.name,
        urlNext,
        authTypeNext, headerNext, secretNext,
        enabledNext ? 1 : 0,
        v.timeout_ms ?? row.timeout_ms,
        // Re-enabling starts from Unknown until the health checker has probed it.
        enabledNext ? (row.enabled === 1 ? row.status : "Unknown") : "Disabled",
        id,
      );
      return toPublic((await getRow(id))!);
    },

    // Default per-tool rules declared where the server is registered (Helm seed, provisioner).
    // Only fills gaps: a rule an admin already set is never overwritten.
    async ensureToolPolicies(id: string, policies: Record<string, MinRole>): Promise<void> {
      for (const [tool, minRole] of Object.entries(policies)) {
        await db.run(`insert into tool_policies (server_id, tool_name, min_role) values (?, ?, ?) on conflict do nothing`, id, tool, minRole);
      }
    },

    // Admin reviewed the changed tool definitions of this server and accepts them (pinning, S6).
    async approveTools(id: string): Promise<number> {
      if (!(await getRow(id))) throw new RegistryError("not_found", `Gateway registry: server ${id} not found`);
      const r = await db.run(
        `update mcp_tools set approved_hash = definition_hash where server_id = ? and (approved_hash is null or approved_hash <> definition_hash)`,
        id,
      );
      return r.changes;
    },

    // Admin choice for one tool ('*' = whole server); null removes it, back to the default rule.
    async setToolPolicy(id: string, toolName: string, minRole: MinRole | null): Promise<void> {
      if (!(await getRow(id))) throw new RegistryError("not_found", `Gateway registry: server ${id} not found`);
      if (!/^(\*|[A-Za-z0-9_.:-]{1,128})$/.test(toolName)) throw new RegistryError("invalid", `Gateway registry: '${toolName}' is not a tool name`);
      if (minRole === null) {
        await db.run(`delete from tool_policies where server_id = ? and tool_name = ?`, id, toolName);
        return;
      }
      if (!MIN_ROLES.includes(minRole)) throw new RegistryError("invalid", `Gateway registry: min_role must be one of ${MIN_ROLES.join(", ")}`);
      await db.run(
        `insert into tool_policies (server_id, tool_name, min_role) values (?, ?, ?)
         on conflict (server_id, tool_name) do update set min_role = excluded.min_role`,
        id, toolName, minRole,
      );
    },

    async delete(id: string): Promise<void> {
      const row = await getRow(id);
      if (!row) throw new RegistryError("not_found", `Gateway registry: server ${id} not found`);
      // Helm re-seeds its servers on every start, so deleting one would only bring it back; disable it instead.
      if (row.managed_by === "helm") {
        throw new RegistryError("forbidden", `Gateway registry: '${row.slug}' is managed by Helm; disable it instead of deleting`);
      }
      await db.run(`delete from mcp_servers where id = ?`, id);
    },

    // Internal only: headers the gateway adds when calling this upstream. Never returned by an API.
    async authHeadersFor(id: string): Promise<Record<string, string>> {
      const row = await getRow(id);
      if (!row || row.auth_type === "none" || !row.auth_secret_enc) return {};
      const secret = open(encKey, row.auth_secret_enc, row.id);
      return row.auth_type === "bearer" ? { Authorization: `Bearer ${secret}` } : { [row.auth_header_name!]: secret };
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;
