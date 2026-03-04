import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import crypto from "node:crypto";
import { openDb, addEvent } from "./db";
import { makeKubeClients } from "./kube";
import { startReconciler } from "./provisioner";
import { computeMetrics, renderPrometheus } from "./metrics.js";
import { makeTokenBucket } from "./ratelimit";
import { suggestContent } from "./ai";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function parsePositiveFloat(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw?.trim()) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseCorsOrigins(raw: string | undefined, defaults: string[]): boolean | string[] {
  if (!raw?.trim()) return defaults;
  if (raw.trim() === "*") return true;
  const items = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return items.length > 0 ? items : defaults;
}

function getPathname(rawUrl: string): string {
  const q = rawUrl.indexOf("?");
  if (q === -1) return rawUrl || "/";
  return rawUrl.slice(0, q) || "/";
}

function timingSafeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function extractApiCredential(req: FastifyRequest): string | null {
  const key = req.headers["x-api-key"];
  if (typeof key === "string" && key.trim()) return key.trim();

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) return token;
  }

  return null;
}

async function main() {
  const DB_PATH = process.env.DB_PATH ?? "./platform.db";
  const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "127.0.0.1.nip.io";
  const INGRESS_CLASS = process.env.INGRESS_CLASS_NAME ?? "nginx";
  const STORE_CHART_REF = process.env.STORE_CHART_REF ?? "bitnami/wordpress";
  const HOST = process.env.HOST ?? "0.0.0.0";
  const PORT = parsePositiveInt(process.env.PORT, 8000);
  const MAX_STORES = parsePositiveInt(process.env.MAX_STORES, 3);
  const BODY_LIMIT_BYTES = parsePositiveInt(process.env.BODY_LIMIT_BYTES, 1_048_576);
  const ADMIN_API_KEY = process.env.ADMIN_API_KEY?.trim() ?? "";

  const isProduction = (process.env.NODE_ENV ?? "development") === "production";
  const trustProxy = parseBoolean(process.env.TRUST_PROXY, isProduction);

  const globalLimiter = makeTokenBucket({
    capacity: parsePositiveInt(process.env.RATE_LIMIT_CAPACITY, 60),
    refillPerSec: parsePositiveFloat(process.env.RATE_LIMIT_REFILL_PER_SEC, 1),
    ttlMs: parsePositiveInt(process.env.RATE_LIMIT_TTL_SEC, 300) * 1000,
    maxKeys: parsePositiveInt(process.env.RATE_LIMIT_MAX_KEYS, 50_000),
  });
  const createStoreLimiter = makeTokenBucket({
    capacity: parsePositiveInt(process.env.CREATE_RATE_LIMIT_CAPACITY, 4),
    refillPerSec: parsePositiveFloat(process.env.CREATE_RATE_LIMIT_REFILL_PER_SEC, 0.1),
    ttlMs: parsePositiveInt(process.env.CREATE_RATE_LIMIT_TTL_SEC, 900) * 1000,
    maxKeys: parsePositiveInt(process.env.RATE_LIMIT_MAX_KEYS, 50_000),
  });
  const rateLimitEnabled = parseBoolean(process.env.RATE_LIMIT_ENABLED, true);

  const app = Fastify({
    logger: true,
    trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  const defaultCorsOrigins = [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    `http://dashboard.${BASE_DOMAIN}`,
  ];
  const corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS, defaultCorsOrigins);

  await app.register(cors, {
    origin: corsOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    credentials: false,
  });

  const db = openDb(DB_PATH);
  try {
    db.exec(`alter table stores add column created_by text;`);
  } catch {}

  const kube = makeKubeClients();

  async function kubeNamespaceExists(ns: string): Promise<boolean> {
    try {
      await kube.core.readNamespace(ns);
      return true;
    } catch (e: any) {
      const code = e?.statusCode ?? e?.response?.statusCode ?? e?.response?.status;
      if (code === 404) return false;
      throw e;
    }
  }

  const stopReconciler = startReconciler(db, kube, {
    baseDomain: BASE_DOMAIN,
    ingressClassName: INGRESS_CLASS,
    chartRef: STORE_CHART_REF,
  });

  function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
    if (!ADMIN_API_KEY) return true;
    const provided = extractApiCredential(req);
    if (provided && timingSafeEquals(provided, ADMIN_API_KEY)) return true;
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }

  app.addHook("onRequest", async (req, reply) => {
    if (!rateLimitEnabled) return;
    if (req.method === "OPTIONS") return;

    const path = getPathname(req.url);
    if (path === "/healthz" || path === "/metrics") return;

    const decision = globalLimiter(req.ip);
    reply.header("x-ratelimit-limit", String(decision.limit));
    reply.header("x-ratelimit-remaining", String(decision.remaining));
    reply.header("x-ratelimit-reset", String(decision.resetAfterSec));

    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSec));
      return reply.code(429).send({
        error: "rate_limited",
        retry_after_sec: decision.retryAfterSec,
      });
    }
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/metrics", async (_req, reply) => {
    const m = computeMetrics(db);
    reply.header("content-type", "text/plain; version=0.0.4");
    return renderPrometheus(m);
  });

  app.get("/stores", async () => {
    return db.prepare(`select * from stores order by created_at desc`).all();
  });

  app.get("/stores/:id/events", async (req) => {
    const id = (req.params as any).id as string;
    return db
      .prepare(`select * from store_events where store_id=? order by ts desc, id desc limit 200`)
      .all(id);
  });

  app.get("/stores/:id/credentials", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const id = (req.params as any).id as string;
    const row = db.prepare(`select * from stores where id=?`).get(id);
    if (!row) return reply.code(404).send({ error: "not found" });

    const ns = row.namespace as string;
    const secretName = `store-secrets-${id}`;

    const sec = await kube.core.readNamespacedSecret(secretName, ns);
    const data = sec.body.data ?? {};

    const get = (k: string) => {
      const v = data[k];
      if (!v) return null;
      return Buffer.from(v, "base64").toString("utf8");
    };

    return {
      wordpressUsername: "admin",
      wordpressPassword: get("wp_admin_password"),
      mariadbRootPassword: get("mariadb_root_password"),
      mariadbPassword: get("mariadb_password"),
    };
  });

  app.get("/stores/:id/summary", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;

    const id = (req.params as any).id as string;
    const row = db.prepare(`select * from stores where id=?`).get(id);
    if (!row) return reply.code(404).send({ error: "not found" });

    const ns = row.namespace as string;
    const secretName = `store-secrets-${id}`;

    const sec = await kube.core.readNamespacedSecret(secretName, ns);
    const data = sec.body.data ?? {};

    const dec = (k: string) => {
      const v = data[k];
      if (!v) return null;
      return Buffer.from(v, "base64").toString("utf8");
    };

    return {
      id,
      status: row.status,
      namespace: ns,
      url: row.url ?? null,
      wordpressUsername: "admin",
      wordpressPassword: dec("wp_admin_password"),
    };
  });

  app.get("/stores/:id/links", async (req, reply) => {
    const id = (req.params as any).id as string;
    const row = db.prepare(`select * from stores where id=?`).get(id);
    if (!row) return reply.code(404).send({ error: "not found" });

    const url = row.url as string | null;
    if (!url) return { storefront: null, admin: null };

    return {
      storefront: url,
      admin: `${url.replace(/\/$/, "")}/wp-admin`,
    };
  });

  app.post("/stores/:id/upgrade", async (req, reply) => {
    const id = (req.params as any).id as string;
    const row = db.prepare(`select * from stores where id=?`).get(id);
    if (!row) return reply.code(404).send({ error: "not found" });

    const ns = row.namespace as string;
    const release = `wc-${id}`;
    const jobName = `helm-upgrade-${id}`;

    db.prepare(`update stores set status='Provisioning', updated_at=datetime('now') where id=?`).run(id);
    addEvent(db, id, "upgrade_requested");

    return { ok: true, jobName, release, namespace: ns };
  });

  app.post("/stores", async (req, reply) => {
    const schema = z.object({
      engine: z.enum(["woocommerce", "medusa"]).default("woocommerce"),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(parsed.error.flatten());

    const ip = req.ip;
    const createLimit = createStoreLimiter(ip);
    if (!createLimit.allowed) {
      reply.header("retry-after", String(createLimit.retryAfterSec));
      return reply.code(429).send({
        error: "create_rate_limited",
        retry_after_sec: createLimit.retryAfterSec,
      });
    }

    const c = db
      .prepare(`select count(*) as c from stores where created_by=? and status in ('Provisioning','Ready')`)
      .get(ip) as { c: number } | undefined;

    if ((c?.c ?? 0) >= MAX_STORES) {
      return reply.code(429).send({
        error: "max_stores_reached",
        max_stores: MAX_STORES,
      });
    }

    const id = crypto.randomBytes(4).toString("hex");
    const ns = `store-${id}`;

    db.prepare(
      `insert into stores(id, engine, status, namespace, url, created_at, last_error, updated_at, created_by)
       values (?, ?, 'Provisioning', ?, null, datetime('now'), null, datetime('now'), ?)`
    ).run(id, parsed.data.engine, ns, ip);

    if (parsed.data.engine === "medusa") {
      db.prepare(
        `update stores
         set status='Failed', last_error=?, updated_at=datetime('now')
         where id=?`
      ).run("medusa engine stubbed (not implemented in Round 1)", id);

      addEvent(db, id, "failed", "medusa engine stubbed (not implemented in Round 1)");
      return { id, namespace: ns, status: "Failed" };
    }

    addEvent(db, id, "created", `engine=${parsed.data.engine}`);
    return { id, namespace: ns, status: "Provisioning" };
  });

  app.post("/stores/:id/content-suggestions", async (req, reply) => {
    const id = (req.params as any).id as string;
    const row = db.prepare(`select * from stores where id=?`).get(id);
    if (!row) return reply.code(404).send({ error: "not found" });
    return await suggestContent(id);
  });

  app.delete("/stores/:id", async (req, reply) => {
    const id = (req.params as any).id as string;
    const actor = req.ip;

    const row = db.prepare(`select * from stores where id=?`).get(id) as any;
    if (!row) return reply.code(404).send({ error: "not_found" });

    const ns = row.namespace as string;

    db.prepare(`update stores set status='Deleting', updated_at=datetime('now') where id=?`).run(id);
    addEvent(db, id, "delete_requested", `ns=${ns}`, actor);

    try {
      await kube.core.deleteNamespace(ns);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const code = e?.statusCode ?? e?.response?.statusCode ?? e?.response?.status;
      if (code !== 404 && !msg.toLowerCase().includes("notfound")) {
        app.log.warn({ err: e }, "namespace delete error");
      }
    }

    try {
      const exists = await kubeNamespaceExists(ns);
      if (!exists) {
        db.prepare(`delete from stores where id=?`).run(id);
        return reply.send({ ok: true, deleted: true });
      }
    } catch {}

    return reply.send({ ok: true, deleted: false });
  });

  app.setErrorHandler((err, _req, reply) => {
    app.log.error({ err }, "request failed");
    if (reply.sent) return;

    const status =
      typeof (err as any).statusCode === "number" &&
      (err as any).statusCode >= 400 &&
      (err as any).statusCode < 500
        ? (err as any).statusCode
        : 500;

    if (status >= 500) {
      reply.code(status).send({ error: "internal_error" });
      return;
    }

    reply.code(status).send({ error: err.message });
  });

  app.addHook("onClose", async () => {
    stopReconciler();
    db.close();
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

