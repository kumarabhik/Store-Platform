// Shared helpers for talking to platform-api. The fetch function itself (base-URL fallback,
// session header, 401 handling) lives in App.tsx; pages receive it as `api`.

export type Role = "admin" | "member";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
};

export type ApiOptions = { omitSession?: boolean; timeoutMs?: number };
export type Api = (route: string, init?: RequestInit, options?: ApiOptions) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// JSON request that throws ApiError with the server's own message ("Team: this is the last
// active admin…"), so pages can show exactly why something was refused.
export async function apiJson<T>(api: Api, route: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const headers = new Headers(rest.headers ?? undefined);
  if (json !== undefined) headers.set("content-type", "application/json");
  const res = await api(route, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  const body = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) {
    throw new ApiError(res.status, body?.message ?? body?.error ?? `${init?.method ?? "GET"} ${route} failed with HTTP ${res.status}`);
  }
  return body as T;
}

export function errorText(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

// SQLite's datetime('now') gives "YYYY-MM-DD HH:MM:SS" in UTC without a zone; browsers would
// read that as local time, so it is marked as UTC before parsing.
export function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "--";
  return parseTime(value)?.toLocaleString() ?? value;
}

export function timeAgo(value: string | null | undefined, now = Date.now()) {
  const date = parseTime(value);
  if (!date) return "never";
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return date.toLocaleDateString();
}

export async function copyToClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
