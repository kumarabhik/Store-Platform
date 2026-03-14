import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  authenticateUser,
  createSession,
  createUser,
  deleteSession,
  findUserByEmail,
  getUserBySessionToken,
  type PublicUser,
} from "./auth";
import {
  ensureBillingAccount,
  getBillingAccount,
  listBillingInvoices,
  summarizeUsage,
  upsertBillingAccount,
  upsertBillingInvoice,
} from "./billing";
import { addEvent, openDb } from "./db";
import { applyMysqlBackupJob, findJobPodName, makeKubeClients, readPodLogs, waitForJob } from "./kube";
import { computeMetrics, renderPrometheus } from "./metrics.js";
import { startReconciler } from "./provisioner";
import { makeTokenBucket } from "./ratelimit";
import { suggestContent } from "./ai";

type CurrentUser = PublicUser & {
  role: "admin" | "member";
};

type StoreRow = {
  id: string;
  name: string | null;
  engine: string;
  status: string;
  namespace: string;
  url: string | null;
  custom_domain: string | null;
  domain_status: string | null;
  domain_last_error: string | null;
  last_backup_at: string | null;
  created_at: string;
  updated_at: string;
  last_error: string | null;
  created_by: string | null;
  user_id: string | null;
};

const DASHBOARD_FALLBACK_URL = "http://127.0.0.1:5173";

const parsePositiveInt = (raw: string | undefined, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const parsePositiveFloat = (raw: string | undefined, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const parseBoolean = (raw: string | undefined, fallback: boolean) => {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const parseCorsOrigins = (raw: string | undefined, defaults: string[]) => {
  if (!raw?.trim()) return defaults as boolean | string[];
  if (raw.trim() === "*") return true;
  const items = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return items.length > 0 ? items : defaults;
};

const parseStringSet = (raw: string | undefined) =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

const pathnameOf = (rawUrl: string) => rawUrl.split("?")[0] || "/";
const sanitizeStoreName = (raw: string) => raw.trim().replace(/\s+/g, " ");
const sanitizeDomain = (raw: string) => raw.trim().toLowerCase().replace(/\.+$/, "");
const toIsoOrNull = (unixSeconds: number | null | undefined) =>
  unixSeconds && Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null;

function timingSafeEquals(a: string, b: string) {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

function extractApiKey(req: FastifyRequest) {
  return typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"].trim() : "";
}

function extractSessionToken(req: FastifyRequest) {
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
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
  const ADMIN_EMAILS = parseStringSet(process.env.ADMIN_EMAILS);
  const BACKUP_DIR = process.env.BACKUP_DIR ?? "/data/backups";
  const DASHBOARD_PUBLIC_URL = process.env.DASHBOARD_PUBLIC_URL?.trim() || DASHBOARD_FALLBACK_URL;
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID?.trim() ?? "";
  const STRIPE_PLAN_LABEL = process.env.STRIPE_PLAN_LABEL?.trim() || "Growth";
  const isProduction = (process.env.NODE_ENV ?? "development") === "production";
  const trustProxy = parseBoolean(process.env.TRUST_PROXY, isProduction);
  const rateLimitEnabled = parseBoolean(process.env.RATE_LIMIT_ENABLED, true);

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

  const app = Fastify({
    logger: true,
    trustProxy,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  await app.register(cors, {
    origin: parseCorsOrigins(process.env.CORS_ORIGINS, [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      `http://dashboard.${BASE_DOMAIN}`,
    ]),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    credentials: false,
  });

  const db = openDb(DB_PATH);
  const kube = makeKubeClients();
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const decorateUser = (user: PublicUser): CurrentUser => ({
    ...user,
    role: ADMIN_EMAILS.has(user.email.toLowerCase()) ? "admin" : "member",
  });

  const isAdminRequest = (req: FastifyRequest) =>
    !!ADMIN_API_KEY && !!extractApiKey(req) && timingSafeEquals(extractApiKey(req), ADMIN_API_KEY);

  const currentUserOf = (req: FastifyRequest) => {
    const user = getUserBySessionToken(db, extractSessionToken(req));
    return user ? decorateUser(user) : null;
  };

  const requireUser = (req: FastifyRequest, reply: FastifyReply) => {
    const user = currentUserOf(req);
    if (user) return user;
    reply.code(401).send({ error: "unauthorized" });
    return null;
  };

  const storeById = (id: string) =>
    ((db
      .prepare(
        `select id, name, engine, status, namespace, url, custom_domain, domain_status, domain_last_error,
                last_backup_at, created_at, updated_at, last_error, created_by, user_id
         from stores where id=?`
      )
      .get(id) as StoreRow | undefined) ?? null);

  const publicOriginOf = (req: FastifyRequest) =>
    (typeof req.headers.origin === "string" && req.headers.origin.trim()
      ? req.headers.origin.trim()
      : DASHBOARD_PUBLIC_URL
    ).replace(/\/$/, "");

  const platformHostFor = (storeId: string) => `store-${storeId}.${BASE_DOMAIN}`;

  async function stripeRequest(pathname: string, method: "GET" | "POST", body?: URLSearchParams) {
    if (!STRIPE_SECRET_KEY) throw new Error("Stripe is not configured.");
    const res = await fetch(`https://api.stripe.com/v1${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: body?.toString(),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new Error(payload?.error?.message ?? `Stripe request failed (${res.status})`);
    return payload;
  }

  function requireStoreAccess(req: FastifyRequest, reply: FastifyReply, id: string) {
    const row = storeById(id);
    if (!row) {
      reply.code(404).send({ error: "not_found" });
      return null;
    }
    if (isAdminRequest(req)) return { row, user: null as CurrentUser | null, actor: "admin" };
    const user = requireUser(req, reply);
    if (!user) return null;
    if (user.role === "admin" || row.user_id === user.id) return { row, user, actor: user.email };
    reply.code(404).send({ error: "not_found" });
    return null;
  }

  async function monitoringFor(store: StoreRow) {
    const selector = `app.kubernetes.io/instance=wc-${store.id}`;
    const [podsRes, deploymentsRes, servicesRes, pvcsRes, ingressesRes] = await Promise.all([
      kube.core.listNamespacedPod(store.namespace, undefined, undefined, undefined, undefined, selector),
      kube.apps.listNamespacedDeployment(store.namespace, undefined, undefined, undefined, undefined, selector),
      kube.core.listNamespacedService(store.namespace, undefined, undefined, undefined, undefined, selector),
      kube.core.listNamespacedPersistentVolumeClaim(store.namespace, undefined, undefined, undefined, undefined, selector),
      kube.net.listNamespacedIngress(store.namespace, undefined, undefined, undefined, undefined, selector),
    ]);

    const pods = ((podsRes as any).body?.items ?? []).map((pod: any) => ({
      name: pod.metadata?.name ?? "",
      phase: pod.status?.phase ?? "Unknown",
      readyContainers: (pod.status?.containerStatuses ?? []).filter((status: any) => status.ready).length,
      totalContainers: (pod.status?.containerStatuses ?? []).length,
      restarts: (pod.status?.containerStatuses ?? []).reduce(
        (sum: number, status: any) => sum + (status.restartCount ?? 0),
        0
      ),
    }));

    const deployments = ((deploymentsRes as any).body?.items ?? []).map((deployment: any) => ({
      name: deployment.metadata?.name ?? "",
      replicas: deployment.status?.replicas ?? 0,
      readyReplicas: deployment.status?.readyReplicas ?? 0,
      availableReplicas: deployment.status?.availableReplicas ?? 0,
    }));

    const services = ((servicesRes as any).body?.items ?? []).map((service: any) => ({
      name: service.metadata?.name ?? "",
      type: service.spec?.type ?? "ClusterIP",
      ports: (service.spec?.ports ?? []).map((port: any) => port.port),
    }));

    const persistentVolumeClaims = ((pvcsRes as any).body?.items ?? []).map((pvc: any) => ({
      name: pvc.metadata?.name ?? "",
      phase: pvc.status?.phase ?? "Unknown",
      storage: pvc.spec?.resources?.requests?.storage ?? null,
    }));

    const ingresses = ((ingressesRes as any).body?.items ?? []).map((ingress: any) => ({
      name: ingress.metadata?.name ?? "",
      hosts: (ingress.spec?.rules ?? []).map((rule: any) => rule.host).filter(Boolean),
    }));

    return {
      healthy:
        deployments.length > 0 &&
        deployments.every((deployment: any) => deployment.readyReplicas >= 1) &&
        pods.every((pod: any) => pod.phase === "Running"),
      deployments,
      pods,
      services,
      persistentVolumeClaims,
      ingresses,
      checkedAt: new Date().toISOString(),
    };
  }

  async function createBackup(store: StoreRow, actor: string) {
    const inserted = db
      .prepare(`insert into store_backups(store_id,status,started_at,created_by) values (?, 'Running', datetime('now'), ?)`)
      .run(store.id, actor);
    const backupId = Number(inserted.lastInsertRowid);
    const jobName = `db-backup-${store.id}-${backupId}`;

    addEvent(db, store.id, "backup_requested", `job=${jobName}`, actor);

    try {
      await applyMysqlBackupJob(kube.batch, store.namespace, jobName, {
        release: `wc-${store.id}`,
        secretName: `store-secrets-${store.id}`,
      });

      const result = await waitForJob(kube.batch, store.namespace, jobName, 5 * 60 * 1000);
      if (!result.ok) throw new Error(result.reason);

      const podName = await findJobPodName(kube.core, store.namespace, jobName);
      if (!podName) throw new Error("backup pod not found");

      const raw = (await readPodLogs(kube.core, store.namespace, podName)).trim();
      if (!raw) throw new Error("backup payload was empty");

      const content = Buffer.from(raw, "base64");
      const fileName = `backup-${store.id}-${backupId}.sql.gz`;
      const targetDir = path.join(BACKUP_DIR, store.id);
      const filePath = path.join(targetDir, fileName);

      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(filePath, content);

      db.prepare(
        `update store_backups
         set status='Completed', file_path=?, file_name=?, size_bytes=?, completed_at=datetime('now')
         where id=?`
      ).run(filePath, fileName, content.byteLength, backupId);
      db.prepare(`update stores set last_backup_at=datetime('now'), updated_at=datetime('now') where id=?`).run(store.id);
      addEvent(db, store.id, "backup_completed", fileName, actor);
    } catch (err: any) {
      const message = String(err?.message ?? err);
      db.prepare(`update store_backups set status='Failed', error=?, completed_at=datetime('now') where id=?`).run(
        message,
        backupId
      );
      addEvent(db, store.id, "backup_failed", message, actor);
      throw err;
    }

    return db
      .prepare(`select id, status, file_name, size_bytes, error, started_at, completed_at from store_backups where id=?`)
      .get(backupId);
  }

  const stopReconciler = startReconciler(db, kube, {
    baseDomain: BASE_DOMAIN,
    ingressClassName: INGRESS_CLASS,
    chartRef: STORE_CHART_REF,
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!rateLimitEnabled || req.method === "OPTIONS") return;
    if (["/healthz", "/metrics"].includes(pathnameOf(req.url))) return;

    const decision = globalLimiter(req.ip);
    reply.header("x-ratelimit-limit", String(decision.limit));
    reply.header("x-ratelimit-remaining", String(decision.remaining));
    reply.header("x-ratelimit-reset", String(decision.resetAfterSec));

    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSec));
      return reply.code(429).send({ error: "rate_limited", retry_after_sec: decision.retryAfterSec });
    }
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return renderPrometheus(computeMetrics(db));
  });

  app.post("/auth/signup", async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: z.string().trim().email(),
        password: z.string().min(8).max(128),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
    if (findUserByEmail(db, parsed.data.email)) return reply.code(409).send({ error: "email_taken" });

    const user = createUser(db, parsed.data);
    ensureBillingAccount(db, user);
    return { token: createSession(db, user.id), user: decorateUser(user) };
  });

  app.post("/auth/login", async (req, reply) => {
    const parsed = z
      .object({
        email: z.string().trim().email(),
        password: z.string().min(8).max(128),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(parsed.error.flatten());

    const user = authenticateUser(db, parsed.data.email, parsed.data.password);
    if (!user) return reply.code(401).send({ error: "invalid_credentials" });

    ensureBillingAccount(db, user);
    return { token: createSession(db, user.id), user: decorateUser(user) };
  });

  app.get("/auth/me", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    ensureBillingAccount(db, user);
    return { user };
  });

  app.post("/auth/logout", async (req) => {
    deleteSession(db, extractSessionToken(req));
    return { ok: true };
  });

  app.get("/billing/summary", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    ensureBillingAccount(db, user);

    return {
      configured: Boolean(STRIPE_SECRET_KEY && STRIPE_PRICE_ID),
      provider: "stripe",
      planLabel: STRIPE_PLAN_LABEL,
      priceId: STRIPE_PRICE_ID || null,
      account: getBillingAccount(db, user.id),
      usage: summarizeUsage(db, user.id),
      invoices: listBillingInvoices(db, user.id),
    };
  });

  app.post("/billing/checkout-session", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) return reply.code(400).send({ error: "stripe_not_configured" });

    const base = publicOriginOf(req);
    const form = new URLSearchParams();
    form.set("mode", "subscription");
    form.set("success_url", `${base}/?billing=success&session_id={CHECKOUT_SESSION_ID}`);
    form.set("cancel_url", `${base}/?billing=cancelled`);
    form.set("customer_email", user.email);
    form.set("client_reference_id", user.id);
    form.set("line_items[0][price]", STRIPE_PRICE_ID);
    form.set("line_items[0][quantity]", "1");
    form.set("metadata[user_id]", user.id);

    const session = await stripeRequest("/checkout/sessions", "POST", form);
    upsertBillingAccount(db, user.id, {
      provider: "stripe",
      planKey: "growth",
      status: "pending",
      billingEmail: user.email,
      stripeCheckoutSessionId: session.id ?? null,
      stripePriceId: STRIPE_PRICE_ID,
    });

    return { id: session.id ?? null, url: session.url ?? null };
  });

  app.get("/billing/confirm", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;

    const sessionId = String((req.query as { session_id?: string }).session_id ?? "").trim();
    if (!sessionId) return reply.code(400).send({ error: "missing_session_id" });

    const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`, "GET");
    if (
      String(session.client_reference_id ?? "") &&
      String(session.client_reference_id) !== user.id &&
      String(session.customer_email ?? "").toLowerCase() !== user.email.toLowerCase()
    ) {
      return reply.code(403).send({ error: "billing_session_forbidden" });
    }

    const subscription = session.subscription
      ? await stripeRequest(`/subscriptions/${encodeURIComponent(String(session.subscription))}`, "GET")
      : null;
    const invoice = session.invoice
      ? await stripeRequest(`/invoices/${encodeURIComponent(String(session.invoice))}`, "GET")
      : null;

    upsertBillingAccount(db, user.id, {
      provider: "stripe",
      planKey: "growth",
      status: String(subscription?.status ?? session.status ?? "active"),
      billingEmail: user.email,
      stripeCustomerId: String(session.customer ?? "") || null,
      stripeSubscriptionId: String(subscription?.id ?? session.subscription ?? "") || null,
      stripeCheckoutSessionId: String(session.id ?? "") || null,
      stripePriceId: String(subscription?.items?.data?.[0]?.price?.id ?? STRIPE_PRICE_ID) || STRIPE_PRICE_ID || null,
      currentPeriodEnd: toIsoOrNull(subscription?.current_period_end),
    });

    if (invoice) {
      upsertBillingInvoice(db, user.id, {
        provider: "stripe",
        externalId: String(invoice.id ?? "") || null,
        amountCents: Number(invoice.total ?? 0),
        currency: String(invoice.currency ?? "usd"),
        status: String(invoice.status ?? "open"),
        hostedUrl: String(invoice.hosted_invoice_url ?? "") || null,
        invoicePdf: String(invoice.invoice_pdf ?? "") || null,
        periodStart: toIsoOrNull(invoice.period_start),
        periodEnd: toIsoOrNull(invoice.period_end),
      });
    }

    return { ok: true, account: getBillingAccount(db, user.id), invoices: listBillingInvoices(db, user.id) };
  });

  app.post("/billing/portal", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;

    const account = getBillingAccount(db, user.id);
    if (!STRIPE_SECRET_KEY || !account?.stripe_customer_id) {
      return reply.code(409).send({ error: "stripe_customer_missing" });
    }

    const form = new URLSearchParams();
    form.set("customer", account.stripe_customer_id);
    form.set("return_url", `${publicOriginOf(req)}/`);

    const session = await stripeRequest("/billing_portal/sessions", "POST", form);
    return { url: session.url ?? null };
  });

  app.get("/stores", async (req, reply) => {
    const user = isAdminRequest(req) ? null : requireUser(req, reply);
    if (!isAdminRequest(req) && !user) return;

    const query =
      isAdminRequest(req) || user?.role === "admin"
        ? `select s.id, s.name, s.engine, s.status, s.namespace, s.url, s.custom_domain, s.domain_status,
                  s.last_backup_at, s.created_at, s.updated_at, s.last_error, u.name as owner_name, u.email as owner_email
           from stores s
           left join users u on u.id=s.user_id
           order by s.created_at desc`
        : `select s.id, s.name, s.engine, s.status, s.namespace, s.url, s.custom_domain, s.domain_status,
                  s.last_backup_at, s.created_at, s.updated_at, s.last_error, u.name as owner_name, u.email as owner_email
           from stores s
           left join users u on u.id=s.user_id
           where s.user_id=?
           order by s.created_at desc`;

    return isAdminRequest(req) || user?.role === "admin"
      ? db.prepare(query).all()
      : db.prepare(query).all(user!.id);
  });

  app.get("/stores/:id/events", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;
    return db.prepare(`select * from store_events where store_id=? order by ts desc, id desc limit 200`).all(access.row.id);
  });

  app.get("/stores/:id/credentials", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;

    const secret = await kube.core.readNamespacedSecret(`store-secrets-${access.row.id}`, access.row.namespace);
    const data = secret.body.data ?? {};
    const get = (key: string) => (data[key] ? Buffer.from(data[key], "base64").toString("utf8") : null);

    return {
      wordpressUsername: "admin",
      wordpressPassword: get("wp_admin_password"),
      mariadbRootPassword: get("mariadb_root_password"),
      mariadbPassword: get("mariadb_password"),
    };
  });

  app.get("/stores/:id/summary", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;

    const secret = await kube.core.readNamespacedSecret(`store-secrets-${access.row.id}`, access.row.namespace);
    const data = secret.body.data ?? {};
    const owner = db
      .prepare(
        `select u.name as owner_name, u.email as owner_email
         from stores s
         left join users u on u.id=s.user_id
         where s.id=?`
      )
      .get(access.row.id) as { owner_name: string | null; owner_email: string | null } | undefined;
    const get = (key: string) => (data[key] ? Buffer.from(data[key], "base64").toString("utf8") : null);

    return {
      id: access.row.id,
      name: access.row.name,
      status: access.row.status,
      namespace: access.row.namespace,
      url: access.row.url,
      customDomain: access.row.custom_domain,
      domainStatus: access.row.domain_status ?? "Platform subdomain",
      domainLastError: access.row.domain_last_error,
      lastBackupAt: access.row.last_backup_at,
      wordpressUsername: "admin",
      wordpressPassword: get("wp_admin_password"),
      ownerName: owner?.owner_name ?? null,
      ownerEmail: owner?.owner_email ?? null,
    };
  });

  app.get("/stores/:id/links", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;
    if (!access.row.url) return { storefront: null, admin: null };
    return { storefront: access.row.url, admin: `${access.row.url.replace(/\/$/, "")}/wp-admin` };
  });

  app.patch("/stores/:id", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;

    const parsed = z.object({ name: z.string().trim().min(2).max(80) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(parsed.error.flatten());

    const name = sanitizeStoreName(parsed.data.name);
    db.prepare(`update stores set name=?, updated_at=datetime('now') where id=?`).run(name, access.row.id);
    addEvent(db, access.row.id, "renamed", `name=${name}`, access.actor);

    return { ok: true, id: access.row.id, name };
  });

  app.get("/stores/:id/domain", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;

    return {
      customDomain: access.row.custom_domain,
      domainStatus: access.row.domain_status ?? "Platform subdomain",
      domainLastError: access.row.domain_last_error,
      targetHost: platformHostFor(access.row.id),
      currentUrl: access.row.url ?? `http://${access.row.custom_domain?.trim() || platformHostFor(access.row.id)}`,
    };
  });

  app.post("/stores/:id/domain", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;

    const parsed = z
      .object({
        domain: z.string().trim().min(4).max(255).regex(/^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(parsed.error.flatten());

    const customDomain = sanitizeDomain(parsed.data.domain);
    const reconfiguring = access.row.status === "Ready";
    db.prepare(
      `update stores
       set custom_domain=?, domain_status='Awaiting DNS', domain_last_error=null,
           status=case when status='Ready' then 'Provisioning' else status end,
           updated_at=datetime('now')
       where id=?`
    ).run(customDomain, access.row.id);

    addEvent(db, access.row.id, "custom_domain_requested", `domain=${customDomain}`, access.actor);
    return { ok: true, customDomain, targetHost: platformHostFor(access.row.id), reconfiguring };
  });

  app.delete("/stores/:id/domain", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;

    const reconfiguring = access.row.status === "Ready";
    db.prepare(
      `update stores
       set custom_domain=null, domain_status='Platform subdomain', domain_last_error=null,
           status=case when status='Ready' then 'Provisioning' else status end,
           updated_at=datetime('now')
       where id=?`
    ).run(access.row.id);

    addEvent(db, access.row.id, "custom_domain_removed", undefined, access.actor);
    return { ok: true, reconfiguring, targetHost: platformHostFor(access.row.id) };
  });

  app.get("/stores/:id/monitoring", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;
    return await monitoringFor(access.row);
  });

  app.get("/stores/:id/backups", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;
    return db
      .prepare(
        `select id, status, file_name, size_bytes, error, started_at, completed_at
         from store_backups where store_id=? order by started_at desc limit 20`
      )
      .all(access.row.id);
  });

  app.post("/stores/:id/backups", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;
    return { ok: true, backup: await createBackup(access.row, access.actor) };
  });

  app.get("/stores/:id/backups/:backupId/download", async (req, reply) => {
    const params = req.params as { id: string; backupId: string };
    const access = requireStoreAccess(req, reply, params.id);
    if (!access) return;

    const backup = db
      .prepare(`select file_path, file_name, status from store_backups where id=? and store_id=?`)
      .get(Number(params.backupId), access.row.id) as
      | { file_path: string | null; file_name: string | null; status: string }
      | undefined;

    if (!backup) return reply.code(404).send({ error: "backup_not_found" });
    if (backup.status !== "Completed" || !backup.file_path || !backup.file_name) {
      return reply.code(409).send({ error: "backup_not_ready" });
    }

    reply.header("content-type", "application/gzip");
    reply.header("content-disposition", `attachment; filename="${backup.file_name}"`);
    return reply.send(await fs.readFile(backup.file_path));
  });

  app.post("/stores/:id/upgrade", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;

    db.prepare(`update stores set status='Provisioning', updated_at=datetime('now') where id=?`).run(access.row.id);
    addEvent(db, access.row.id, "upgrade_requested", undefined, access.actor);

    return {
      ok: true,
      jobName: `helm-upgrade-${access.row.id}`,
      release: `wc-${access.row.id}`,
      namespace: access.row.namespace,
    };
  });

  app.post("/stores", async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;

    const parsed = z
      .object({
        name: z.string().trim().min(2).max(80),
        engine: z.enum(["woocommerce", "medusa"]).default("woocommerce"),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(parsed.error.flatten());

    const decision = createStoreLimiter(req.ip);
    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSec));
      return reply.code(429).send({ error: "create_rate_limited", retry_after_sec: decision.retryAfterSec });
    }

    const count = db
      .prepare(`select count(*) as c from stores where user_id=? and status in ('Provisioning','Ready')`)
      .get(user.id) as { c: number } | undefined;
    if ((count?.c ?? 0) >= MAX_STORES) {
      return reply.code(429).send({ error: "max_stores_reached", max_stores: MAX_STORES });
    }

    const id = crypto.randomBytes(4).toString("hex");
    const ns = `store-${id}`;
    const name = sanitizeStoreName(parsed.data.name);

    db.prepare(
      `insert into stores(
         id, name, engine, status, namespace, url, user_id, custom_domain, domain_status,
         domain_last_error, last_backup_at, created_at, last_error, updated_at, created_by
       )
       values (
         ?, ?, ?, 'Provisioning', ?, null, ?, null, 'Provisioning platform subdomain',
         null, null, datetime('now'), null, datetime('now'), ?
       )`
    ).run(id, name, parsed.data.engine, ns, user.id, req.ip);

    if (parsed.data.engine === "medusa") {
      db.prepare(`update stores set status='Failed', last_error=?, updated_at=datetime('now') where id=?`).run(
        "medusa engine stubbed (not implemented in Round 1)",
        id
      );
      addEvent(db, id, "failed", "medusa engine stubbed (not implemented in Round 1)", user.email);
      return { id, name, namespace: ns, status: "Failed" };
    }

    addEvent(db, id, "created", `engine=${parsed.data.engine} name=${name} host=${platformHostFor(id)}`, user.email);
    return { id, name, namespace: ns, status: "Provisioning" };
  });

  app.post("/stores/:id/content-suggestions", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;
    return await suggestContent(access.row.id);
  });

  app.delete("/stores/:id", async (req, reply) => {
    const access = requireStoreAccess(req, reply, (req.params as { id: string }).id);
    if (!access) return;

    db.prepare(`update stores set status='Deleting', updated_at=datetime('now') where id=?`).run(access.row.id);
    addEvent(db, access.row.id, "delete_requested", `ns=${access.row.namespace}`, access.actor);
    try {
      await kube.core.deleteNamespace(access.row.namespace);
    } catch {}
    try {
      await kube.core.readNamespace(access.row.namespace);
    } catch {
      db.prepare(`delete from stores where id=?`).run(access.row.id);
      return { ok: true, deleted: true };
    }
    return { ok: true, deleted: false };
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
    reply.code(status).send({ error: err.message || "internal_error" });
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
