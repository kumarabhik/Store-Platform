import crypto from "node:crypto";
import type { Db } from "../db";
import { parseDbTime } from "./time";

// Per-user gateway API keys (DESIGN §8.2). Format: mcpgw_<8 hex prefix>_<43 base64url secret>.
// The prefix is stored in clear for lookup and display; only SHA-256 of the full key is stored.
// SHA-256 (not scrypt) is fine here: 256 random bits can't be brute-forced, and auth stays < 1 ms.

const KEY_PATTERN = /^mcpgw_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const TOUCH_INTERVAL_MS = 60_000;

export interface KeyOwner {
  keyId: string;
  userId: string;
  email: string;
  name: string;
}

export interface KeyInfo {
  id: string;
  user_id: string;
  user_email: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

// Returns the full key exactly once; it can't be recovered afterwards.
export function createApiKey(db: Db, userId: string, name: string): { id: string; key: string; prefix: string } {
  for (;;) {
    const prefix = crypto.randomBytes(4).toString("hex");
    if (db.prepare(`select 1 from api_keys where prefix = ?`).get(prefix)) continue;
    const key = `mcpgw_${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
    const id = crypto.randomBytes(8).toString("hex");
    db.prepare(`insert into api_keys (id, user_id, name, prefix, key_hash) values (?, ?, ?, ?, ?)`).run(id, userId, name, prefix, sha256(key));
    return { id, key, prefix };
  }
}

// Never returns the hash; the prefix is enough to recognise a key.
export function listApiKeys(db: Db, userId: string | null): KeyInfo[] {
  const sql = `select k.id, k.user_id, u.email as user_email, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at
               from api_keys k join users u on u.id = k.user_id`;
  return (userId === null
    ? db.prepare(`${sql} order by k.created_at desc`).all()
    : db.prepare(`${sql} where k.user_id = ? order by k.created_at desc`).all(userId)) as KeyInfo[];
}

export function getApiKey(db: Db, id: string): KeyInfo | undefined {
  return listApiKeys(db, null).find((k) => k.id === id);
}

// Idempotent: revoking an already revoked key keeps the first revocation's time and actor.
export function revokeApiKey(db: Db, id: string, revokedBy: string): void {
  db.prepare(`update api_keys set revoked_at = datetime('now'), revoked_by = ? where id = ? and revoked_at is null`).run(revokedBy, id);
}

// Looked up in the DB on every request (no cache), so a revoked key fails on the very next call.
export function verifyApiKey(db: Db, rawKey: string, now: Date = new Date()): KeyOwner | null {
  const match = KEY_PATTERN.exec(rawKey);
  if (!match) return null;
  const row = db
    .prepare(
      `select k.id, k.key_hash, k.revoked_at, k.expires_at, k.last_used_at, u.id as user_id, u.email, u.name, u.disabled_at
       from api_keys k join users u on u.id = k.user_id where k.prefix = ?`,
    )
    .get(match[1]) as
    | { id: string; key_hash: string; revoked_at: string | null; expires_at: string | null; last_used_at: string | null; user_id: string; email: string; name: string; disabled_at: string | null }
    | undefined;
  if (!row) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(sha256(rawKey), "hex"), Buffer.from(row.key_hash, "hex"));
  if (!ok || row.revoked_at || row.disabled_at) return null;
  const expires = parseDbTime(row.expires_at);
  if (expires !== null && expires <= now.getTime()) return null;

  // At most one write per minute per key, so a busy client doesn't turn every call into a DB write.
  if (now.getTime() - (parseDbTime(row.last_used_at) ?? 0) >= TOUCH_INTERVAL_MS) {
    db.prepare(`update api_keys set last_used_at = datetime('now') where id = ?`).run(row.id);
  }
  return { keyId: row.id, userId: row.user_id, email: row.email, name: row.name };
}
