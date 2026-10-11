import type { Db } from "../db";
import type { PublicUser, Role } from "../auth";

// Team membership rules (DESIGN §8.1). Roles live in users.role; these functions are the only
// places that change them.

export class TeamError extends Error {
  constructor(readonly code: "forbidden" | "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "TeamError";
  }
}

export const hasActiveAdmin = (db: Db) =>
  !!db.prepare(`select 1 from users where role = 'admin' and disabled_at is null limit 1`).get();

// Signup policy. Until the team has an admin, signup is open and the next account becomes admin:
// on a fresh install that is the first user. Afterwards signup is closed (invites only) unless
// auth.openSignup is set. "No active admin" instead of "no users" also covers an install upgraded
// from the ADMIN_EMAILS-only era, which may have members but no stored admin yet.
// Node runs this synchronously against SQLite, so two simultaneous first signups can't both win.
export function signupRole(db: Db, openSignup: boolean): Role | null {
  if (!hasActiveAdmin(db)) return "admin";
  return openSignup ? "member" : null;
}

// ADMIN_EMAILS still grants admin, and now it is stored, so it shows in the Members page.
export function applyAdminEmails(db: Db, user: PublicUser, adminEmails: Set<string>): PublicUser {
  if (user.role === "admin" || !adminEmails.has(user.email.toLowerCase())) return user;
  db.prepare(`update users set role = 'admin', updated_at = datetime('now') where id = ?`).run(user.id);
  return { ...user, role: "admin" };
}

export function roleOf(db: Db, userId: string): Role {
  const row = db.prepare(`select role from users where id = ?`).get(userId) as { role: Role } | undefined;
  return row?.role ?? "member";
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  disabled_at: string | null;
  created_at: string;
  active_keys: number;
}

export function listMembers(db: Db): Member[] {
  return db
    .prepare(
      `select u.id, u.name, u.email, u.role, u.disabled_at, u.created_at,
              (select count(*) from api_keys k where k.user_id = u.id and k.revoked_at is null) as active_keys
       from users u order by u.created_at`,
    )
    .all() as Member[];
}

// Change a member's role and/or disable/enable them. Refuses anything that would leave the team
// without an active admin, because then nobody could manage it (and signup would reopen).
export function updateMember(db: Db, id: string, change: { role?: Role; disabled?: boolean }): Member {
  return db.transaction(() => {
    const user = db.prepare(`select id, role, disabled_at from users where id = ?`).get(id) as
      | { id: string; role: Role; disabled_at: string | null }
      | undefined;
    if (!user) throw new TeamError("not_found", `Team: member ${id} not found`);

    const nextRole = change.role ?? user.role;
    const nextDisabled = change.disabled ?? !!user.disabled_at;
    const losesAdmin = user.role === "admin" && !user.disabled_at && (nextRole !== "admin" || nextDisabled);
    if (losesAdmin) {
      const others = db.prepare(`select count(*) n from users where role = 'admin' and disabled_at is null and id <> ?`).get(id) as { n: number };
      if (others.n === 0) throw new TeamError("conflict", "Team: this is the last active admin; make someone else admin first");
    }

    db.prepare(
      `update users set role = ?, disabled_at = ?, updated_at = datetime('now') where id = ?`,
    ).run(nextRole, nextDisabled ? (user.disabled_at ?? new Date().toISOString()) : null, id);
    // Disabling logs the user out everywhere now. Their API keys stop working too: verifyApiKey
    // checks disabled_at on every request.
    if (nextDisabled) db.prepare(`delete from user_sessions where user_id = ?`).run(id);
    return listMembers(db).find((m) => m.id === id)!;
  })();
}
