import crypto from "node:crypto";
import type { Db } from "../db";
import { createUser, findUserByEmail, normalizeEmail, type PublicUser, type Role } from "../auth";
import { parseDbTime } from "../gateway/time";
import { TeamError } from "./members";

// Invites (DESIGN §5 invites, §8.1). The token is shown once (in the link) and stored as SHA-256,
// like API keys: it is a 256-bit random value, so a fast hash is enough.

const INVITE_TTL_DAYS = 7;
const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  invited_by_email: string;
  expires_at: string;
  created_at: string;
}

export function createInvite(db: Db, input: { email: string; role: Role }, invitedBy: string): { id: string; token: string; expires_at: string } {
  const email = normalizeEmail(input.email);
  if (findUserByEmail(db, email)) throw new TeamError("conflict", `Team: ${email} already has an account`);
  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomBytes(8).toString("hex");
  db.transaction(() => {
    // One live invite per email: a new invite replaces older, unaccepted ones.
    db.prepare(`delete from invites where email = ? and accepted_at is null`).run(email);
    db.prepare(
      `insert into invites (id, email, role, token_hash, invited_by, expires_at)
       values (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))`,
    ).run(id, email, input.role, sha256(token), invitedBy, INVITE_TTL_DAYS);
  })();
  const { expires_at } = db.prepare(`select expires_at from invites where id = ?`).get(id) as { expires_at: string };
  return { id, token, expires_at };
}

export function listPendingInvites(db: Db): PendingInvite[] {
  return db
    .prepare(
      `select i.id, i.email, i.role, u.email as invited_by_email, i.expires_at, i.created_at
       from invites i join users u on u.id = i.invited_by
       where i.accepted_at is null and i.expires_at > datetime('now') order by i.created_at desc`,
    )
    .all() as PendingInvite[];
}

export function revokeInvite(db: Db, id: string): void {
  const r = db.prepare(`delete from invites where id = ? and accepted_at is null`).run(id);
  if (r.changes === 0) throw new TeamError("not_found", `Team: pending invite ${id} not found`);
}

// Creates the account with the invited email and role. The invite can be used once.
export function acceptInvite(db: Db, input: { token: string; name: string; password: string }): PublicUser {
  return db.transaction(() => {
    const invite = db.prepare(`select id, email, role, expires_at, accepted_at from invites where token_hash = ?`).get(sha256(input.token)) as
      | { id: string; email: string; role: Role; expires_at: string; accepted_at: string | null }
      | undefined;
    // One message for unknown, used and expired: the caller learns nothing about other invites.
    const usable = invite && !invite.accepted_at && (parseDbTime(invite.expires_at) ?? 0) > Date.now();
    if (!usable) throw new TeamError("invalid", "Team: this invite link is invalid, expired or already used");
    if (findUserByEmail(db, invite.email)) throw new TeamError("conflict", `Team: ${invite.email} already has an account`);
    const user = createUser(db, { name: input.name, email: invite.email, password: input.password }, invite.role);
    db.prepare(`update invites set accepted_at = datetime('now') where id = ?`).run(invite.id);
    return user;
  })();
}
