import crypto from "node:crypto";
import type { Db } from "./db";

const SESSION_TTL_DAYS = 30;

export type Role = "admin" | "member";

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  // Stored in users.role (DESIGN §8.1). Every admin check reads it on the server (SYSTEM.md I13).
  role: Role;
};

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function timingSafeEqualsHex(aHex: string, bHex: string) {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string) {
  const [salt, expected] = storedHash.split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  return timingSafeEqualsHex(actual, expected);
}

export async function createUser(db: Db, input: { name: string; email: string; password: string }, role: Role = "member"): Promise<PublicUser> {
  const id = crypto.randomBytes(8).toString("hex");
  const email = normalizeEmail(input.email);
  const user = {
    id,
    name: input.name.trim(),
    email,
    role,
  };

  await db.run(
    `insert into users(id, name, email, password_hash, role, created_at, updated_at)
     values (?, ?, ?, ?, ?, ${db.now}, ${db.now})`,
    user.id, user.name, user.email, hashPassword(input.password), role,
  );

  return user;
}

export function findUserByEmail(db: Db, email: string) {
  return db.get<PublicUser & { password_hash: string; disabled_at: string | null }>(
    `select id, name, email, role, password_hash, disabled_at from users where email=? limit 1`,
    normalizeEmail(email),
  );
}

export async function authenticateUser(db: Db, email: string, password: string): Promise<PublicUser | null> {
  const row = await findUserByEmail(db, email);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  // A disabled user can't log in; same answer as a wrong password, so it reveals nothing.
  if (row.disabled_at) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

export async function createSession(db: Db, userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  await db.run(
    `insert into user_sessions(token, user_id, created_at, expires_at) values (?, ?, ${db.now}, ${db.inSeconds})`,
    token, userId, SESSION_TTL_DAYS * 86_400,
  );
  return token;
}

export async function getUserBySessionToken(db: Db, token: string | null | undefined): Promise<PublicUser | null> {
  if (!token) return null;

  const row = await db.get<PublicUser>(
    `select u.id, u.name, u.email, u.role
     from user_sessions s
     join users u on u.id = s.user_id
     where s.token=?
       and s.expires_at > ${db.now}
       and u.disabled_at is null
     limit 1`,
    token,
  );

  if (row) return row;

  await db.run(`delete from user_sessions where token=? and expires_at <= ${db.now}`, token);
  return null;
}

export async function deleteSession(db: Db, token: string | null | undefined) {
  if (!token) return;
  await db.run(`delete from user_sessions where token=?`, token);
}
