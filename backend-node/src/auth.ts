import crypto from "node:crypto";
import type { Db } from "./db";

const SESSION_TTL_DAYS = 30;

export type PublicUser = {
  id: string;
  name: string;
  email: string;
};

function normalizeEmail(email: string) {
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

export function createUser(db: Db, input: { name: string; email: string; password: string }): PublicUser {
  const id = crypto.randomBytes(8).toString("hex");
  const email = normalizeEmail(input.email);
  const user = {
    id,
    name: input.name.trim(),
    email,
  };

  db.prepare(
    `insert into users(id, name, email, password_hash, created_at, updated_at)
     values (?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(user.id, user.name, user.email, hashPassword(input.password));

  return user;
}

export function findUserByEmail(db: Db, email: string) {
  return (
    db
      .prepare(`select id, name, email, password_hash from users where email=? limit 1`)
      .get(normalizeEmail(email)) as
      | (PublicUser & {
          password_hash: string;
        })
      | undefined
  );
}

export function authenticateUser(db: Db, email: string, password: string): PublicUser | null {
  const row = findUserByEmail(db, email);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, name: row.name, email: row.email };
}

export function createSession(db: Db, userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(
    `insert into user_sessions(token, user_id, created_at, expires_at)
     values (?, ?, datetime('now'), datetime('now', '+' || ? || ' days'))`
  ).run(token, userId, SESSION_TTL_DAYS);
  return token;
}

export function getUserBySessionToken(db: Db, token: string | null | undefined): PublicUser | null {
  if (!token) return null;

  const row = db
    .prepare(
      `select u.id, u.name, u.email
       from user_sessions s
       join users u on u.id = s.user_id
       where s.token=?
         and s.expires_at > datetime('now')
       limit 1`
    )
    .get(token) as PublicUser | undefined;

  if (row) return row;

  db.prepare(`delete from user_sessions where token=? and expires_at <= datetime('now')`).run(token);
  return null;
}

export function deleteSession(db: Db, token: string | null | undefined) {
  if (!token) return;
  db.prepare(`delete from user_sessions where token=?`).run(token);
}
