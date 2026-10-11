import type { Db } from "../db";

// Role x tool_policies (DESIGN §5, §8.6). A row for the exact tool wins over a row with tool_name
// '*' (the whole server). Without a row the tool's own MCP annotations decide: a tool that declares
// destructiveHint is admin-only, anything else is open to members (ROADMAP S2). The same decision
// is used for tools/list (hidden) and tools/call (rejected), so the two can't disagree.

export type Role = "admin" | "member";
export type MinRole = Role | "nobody";
export const MIN_ROLES: readonly MinRole[] = ["member", "admin", "nobody"];

// Where a tool's effective rule came from, shown to admins next to the setting.
export type PolicySource = "tool" | "server" | "default";

const RANK: Record<MinRole, number> = { member: 1, admin: 2, nobody: 3 };

export function allows(role: Role, minRole: MinRole): boolean {
  return RANK[role] >= RANK[minRole];
}

// The rule for a tool nobody has configured: trust the upstream's own "this destroys data" flag.
export function defaultMinRole(annotations: Record<string, unknown> | undefined | null): MinRole {
  return annotations?.destructiveHint === true ? "admin" : "member";
}

// Loads all policies once, so building a catalog of N tools is one query, not N.
export function loadPolicy(db: Db) {
  const rows = db.prepare(`select server_id, tool_name, min_role from tool_policies`).all() as {
    server_id: string;
    tool_name: string;
    min_role: MinRole;
  }[];
  const byKey = new Map(rows.map((r) => [`${r.server_id}\u0000${r.tool_name}`, r.min_role]));
  function decide(serverId: string, toolName: string, annotations?: Record<string, unknown> | null): { minRole: MinRole; source: PolicySource } {
    const exact = byKey.get(`${serverId}\u0000${toolName}`);
    if (exact) return { minRole: exact, source: "tool" };
    const server = byKey.get(`${serverId}\u0000*`);
    if (server) return { minRole: server, source: "server" };
    return { minRole: defaultMinRole(annotations), source: "default" };
  }
  return {
    decide,
    minRole: (serverId: string, toolName: string, annotations?: Record<string, unknown> | null) => decide(serverId, toolName, annotations).minRole,
  };
}
