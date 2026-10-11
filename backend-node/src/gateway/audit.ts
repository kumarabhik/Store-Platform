import type { Db } from "../db";

// Append-only audit log (DESIGN §5, SYSTEM.md I2). This module only ever INSERTs into audit_log.

export type Outcome = "ok" | "tool_error" | "timeout" | "unreachable" | "denied" | "not_found" | "bad_request";

export interface AuditEntry {
  requestId: string;
  userId: string;
  userEmail: string;
  apiKeyId: string | null;
  source: "mcp" | "chat";
  serverId: string | null;
  serverSlug: string | null;
  toolName: string;
  exposedName: string;
  durationMs: number;
  outcome: Outcome;
  error: string | null;
  args: unknown;
}

const PREVIEW_MAX = 512;
const ERROR_MAX = 500;
const SENSITIVE_KEY = /pass|secret|token|key|auth|cookie|credential/i;

// Arguments are kept for "who did what", but values under secret-looking keys are masked and the
// whole preview is capped, so the log can't become a store of credentials or huge payloads.
export function argsPreview(args: unknown): string {
  const json = JSON.stringify(args ?? {}, (key, value) => (key && SENSITIVE_KEY.test(key) ? "[redacted]" : value)) ?? "";
  return json.length > PREVIEW_MAX ? `${json.slice(0, PREVIEW_MAX - 1)}…` : json;
}

export interface AuditFilter {
  userId?: string; // forced to the caller's id for members (DESIGN §8.1)
  userEmail?: string;
  server?: string; // server slug
  tool?: string; // substring of the exposed name
  outcome?: Outcome;
  source?: "mcp" | "chat";
  from?: string; // ISO time, inclusive
  to?: string; // ISO time, exclusive
  beforeId?: number; // cursor: rows older than this id
  limit: number;
}

export interface AuditRow {
  id: number;
  ts: string;
  user_id: string;
  user_email: string;
  api_key_id: string | null;
  source: "mcp" | "chat";
  server_slug: string | null;
  tool_name: string;
  exposed_name: string;
  duration_ms: number;
  outcome: Outcome;
  error: string | null;
  args_preview: string | null;
}

// Newest first, paged by id ("before_id") so new rows arriving during auto-refresh don't shift pages.
export function queryAudit(db: Db, f: AuditFilter): { rows: AuditRow[]; nextBeforeId: number | null } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, v: string | number | undefined) => {
    if (v === undefined || v === "") return;
    where.push(sql);
    args.push(v);
  };
  add("user_id = ?", f.userId);
  add("user_email = ?", f.userEmail?.toLowerCase());
  add("server_slug = ?", f.server);
  add("instr(exposed_name, ?) > 0", f.tool);
  add("outcome = ?", f.outcome);
  add("source = ?", f.source);
  add("ts >= ?", f.from);
  add("ts < ?", f.to);
  add("id < ?", f.beforeId);
  const rows = db
    .prepare(
      `select id, ts, user_id, user_email, api_key_id, source, server_slug, tool_name, exposed_name, duration_ms, outcome, error, args_preview
       from audit_log ${where.length ? `where ${where.join(" and ")}` : ""} order by id desc limit ?`,
    )
    .all(...args, f.limit) as AuditRow[];
  return { rows, nextBeforeId: rows.length === f.limit ? rows[rows.length - 1].id : null };
}

export function writeAudit(db: Db, e: AuditEntry): void {
  db.prepare(
    `insert into audit_log (request_id, user_id, user_email, api_key_id, source, server_id, server_slug,
       tool_name, exposed_name, duration_ms, outcome, error, args_preview)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.requestId, e.userId, e.userEmail, e.apiKeyId, e.source, e.serverId, e.serverSlug,
    e.toolName, e.exposedName, Math.round(e.durationMs), e.outcome,
    e.error ? e.error.slice(0, ERROR_MAX) : null,
    argsPreview(e.args),
  );
}
