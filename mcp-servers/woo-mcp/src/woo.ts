import { signRequest } from "./oauth1";
import type { Config } from "./config";

const REST_PREFIX = "/wp-json/wc/v3";
const STORE_INDEX_TTL_MS = 60_000;

// Errors here are shown to the model and the gateway audit log, so they name the component and
// the reason, and never contain credentials.
export class WooError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "WooError";
  }
}

export interface StoreIndex {
  name: string;
  description: string;
  home: string;
  timezone: string;
}

export interface WooClient {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  // Public WordPress index (/wp-json/): site name and timezone, no auth needed.
  storeIndex(): Promise<StoreIndex>;
  // Readiness: does WordPress answer at all? Throws WooError if not.
  ping(timeoutMs: number): Promise<void>;
}

type Fetch = typeof fetch;

export function createWooClient(cfg: Config, fetchImpl: Fetch = fetch): WooClient {
  const base = new URL(cfg.WOO_BASE_URL);
  const home = new URL(cfg.WOO_HOME_URL);
  const homePath = home.pathname.replace(/\/$/, "");
  const where = `WooCommerce at ${base.origin}`;

  async function send(url: URL, init: RequestInit, timeoutMs = cfg.WOO_TIMEOUT_MS): Promise<Response> {
    try {
      return await fetchImpl(url, {
        ...init,
        // A redirect means a wrong base URL; following it would also send the signed request elsewhere.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      if (e.name === "TimeoutError") throw new WooError(`${where} timed out after ${timeoutMs} ms`);
      throw new WooError(`${where} is unreachable: ${e.cause?.code ?? e.message}`);
    }
  }

  async function parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new WooError(`${where} returned ${res.status} with a non-JSON body`, res.status);
    }
    if (!res.ok) {
      const { code, message } = (body ?? {}) as { code?: string; message?: string };
      throw new WooError(`${where} returned ${res.status} ${code ?? ""}: ${message ?? res.statusText}`.trim(), res.status, code);
    }
    return body as T;
  }

  async function request<T>(method: string, path: string, query: Record<string, string> = {}, body?: unknown): Promise<T> {
    const restPath = `${REST_PREFIX}${path}`;
    const url = new URL(restPath, base);
    // WooCommerce signs against home_url() with the scheme of the incoming request (SYSTEM.md L18).
    const signedQuery = signRequest({
      method,
      baseUrl: `${base.protocol}//${home.host}${homePath}${restPath}`,
      query,
      consumerKey: cfg.WOO_CONSUMER_KEY,
      consumerSecret: cfg.WOO_CONSUMER_SECRET,
    });
    for (const [k, v] of Object.entries(signedQuery)) url.searchParams.set(k, v);
    // URLSearchParams encodes spaces as "+", which PHP decodes as a space, so the signature still matches.
    const res = await send(url, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parse<T>(res);
  }

  let cachedIndex: { at: number; value: StoreIndex } | undefined;

  return {
    get: (path, query) => request("GET", path, query),
    post: (path, body) => request("POST", path, {}, body),
    put: (path, body) => request("PUT", path, {}, body),
    async storeIndex() {
      if (cachedIndex && Date.now() - cachedIndex.at < STORE_INDEX_TTL_MS) return cachedIndex.value;
      const res = await send(new URL(`${homePath}/wp-json/`, base), { headers: { Accept: "application/json" } });
      const raw = await parse<{ name?: string; description?: string; home?: string; timezone_string?: string; gmt_offset?: number | string }>(res);
      const value: StoreIndex = {
        name: raw.name ?? "",
        description: raw.description ?? "",
        home: raw.home ?? cfg.WOO_HOME_URL,
        // WordPress leaves timezone_string empty when the site uses a raw UTC offset instead of a city.
        timezone: raw.timezone_string || offsetToZone(Number(raw.gmt_offset ?? 0)),
      };
      cachedIndex = { at: Date.now(), value };
      return value;
    },
    async ping(timeoutMs) {
      const res = await send(new URL(`${homePath}/wp-json/`, base), { method: "HEAD" }, timeoutMs);
      // 2xx-4xx means PHP is answering; only 5xx or no answer means not ready (SYSTEM.md L11).
      if (res.status >= 500) throw new WooError(`${where} returned ${res.status}`, res.status);
    },
  };
}

// Etc/GMT zones have inverted signs (Etc/GMT-5 is UTC+5) and only whole hours.
function offsetToZone(hours: number): string {
  if (!Number.isInteger(hours) || hours === 0) return "UTC";
  return `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
}
