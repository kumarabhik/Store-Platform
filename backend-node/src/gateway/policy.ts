import type { Db } from "../db";

// Role x tool_policies (DESIGN §5, §8.6). A row with tool_name '*' covers the whole server; a row
// for the exact tool wins over it. No row means every member may use the tool.

export type Role = "admin" | "member";
export type MinRole = Role | "nobody";

const RANK: Record<MinRole, number> = { member: 1, admin: 2, nobody: 3 };

export function allows(role: Role, minRole: MinRole): boolean {
  return RANK[role] >= RANK[minRole];
}

// Loads all policies once, so building a catalog of N tools is one query, not N.
export function loadPolicy(db: Db) {
  const rows = db.prepare(`select server_id, tool_name, min_role from tool_policies`).all() as {
    server_id: string;
    tool_name: string;
    min_role: MinRole;
  }[];
  const byKey = new Map(rows.map((r) => [`${r.server_id}\u0000${r.tool_name}`, r.min_role]));
  return {
    minRole(serverId: string, toolName: string): MinRole {
      return byKey.get(`${serverId}\u0000${toolName}`) ?? byKey.get(`${serverId}\u0000*`) ?? "member";
    },
  };
}
