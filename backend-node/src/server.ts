import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import crypto from "node:crypto";
import { openDb, addEvent } from "./db";
import { makeKubeClients } from "./kube";
import { startReconciler } from "./provisioner";
import { computeMetrics, renderPrometheus } from "./metrics.js";
import { makeTokenBucket } from "./ratelimit";
import { suggestContent } from "./ai";

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: [
      "http://127.0.0.1:5173",
      "http://localhost:5173",
      "http://dashboard.127.0.0.1.nip.io",
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  });

const DB_PATH = process.env.DB_PATH ?? "./platform.db";
const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "127.0.0.1.nip.io";
const INGRESS_CLASS = process.env.INGRESS_CLASS_NAME ?? "nginx";
const STORE_CHART_REF = process.env.STORE_CHART_REF ?? "bitnami/wordpress";

const isLocal =
  BASE_DOMAIN.includes("nip.io") ||
  process.env.NODE_ENV !== "production";

const allow = isLocal
  ? () => true
  : makeTokenBucket({ capacity: 10, refillPerSec: 0.5 });

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


startReconciler(db, kube, {
  baseDomain: BASE_DOMAIN,
  ingressClassName: INGRESS_CLASS,
  chartRef: STORE_CHART_REF,
});

app.addHook("onRequest", async (req, reply) => {
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)
      ?.split(",")[0]
      ?.trim() ?? req.ip;

  const key = `${ip}:${req.method}:${(req as any).routerPath ?? req.url}`;
  if (!allow(key)) {
    return reply.code(429).send({ error: "rate_limited" });
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


  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)
      ?.split(",")[0]
      ?.trim() ?? req.ip;

  const c = db
    .prepare(`select count(*) as c from stores where created_by=? and status in ('Creating','Ready','Reconciling')`)
    .get(ip) as { c: number } | undefined;

  if ((c?.c ?? 0) >= 3) return reply.code(429).send({ error: "max_stores_reached" });

  const id = crypto.randomBytes(4).toString("hex");
  const ns = `store-${id}`;


  db.prepare(
    `insert into stores(id, engine, status, namespace, url, created_at, last_error, updated_at, created_by)
      values (?, ?, 'Provisioning', ?, null, datetime('now'), null, datetime('now'), ?)`
    ).run(id, parsed.data.engine, ns, ip);

  // Medusa is intentionally stubbed in Round 1
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

  const actor =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip;

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
  } catch (e) {}

  return reply.send({ ok: true, deleted: false });
});

  await app.listen({ port: 8000, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

