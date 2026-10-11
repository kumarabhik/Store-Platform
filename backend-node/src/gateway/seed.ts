import { z } from "zod";
import type { HealthChecker } from "./health";
import type { Registry } from "./registry";

// Default upstreams declared in Helm values (GATEWAY_SEED_SERVERS, DESIGN §10.1). Upserted on every
// start with managed_by='helm'. The JSON holds only a *reference* to the credential (a Secret in the
// upstream's own namespace), never the credential itself, so values files stay secret-free (I6).

const secretRef = z.object({ namespace: z.string().min(1), name: z.string().min(1), key: z.string().min(1) });

const seedEntry = z.object({
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  auth_type: z.enum(["none", "bearer", "header"]).default("none"),
  auth_header_name: z.string().optional(),
  credential_secret: secretRef.optional(),
  timeout_ms: z.number().int().optional(),
});
export type SeedEntry = z.infer<typeof seedEntry>;

export type ReadSecret = (ref: z.infer<typeof secretRef>) => Promise<string>;

export function parseSeedServers(raw: string | undefined): SeedEntry[] {
  if (!raw?.trim()) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Gateway seed: GATEWAY_SEED_SERVERS is not valid JSON");
  }
  const parsed = z.array(seedEntry).safeParse(json);
  if (!parsed.success) throw new Error(`Gateway seed: GATEWAY_SEED_SERVERS is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

// Upserts one entry. An admin can disable a seeded server (enabled is never touched here), but not
// take over its slug: an existing admin-created server with the same slug is left alone.
export async function seedOne(registry: Registry, entry: SeedEntry, readSecret: ReadSecret): Promise<"created" | "updated" | "skipped"> {
  const credential = entry.credential_secret ? await readSecret(entry.credential_secret) : undefined;
  const fields = {
    name: entry.name,
    url: entry.url,
    auth_type: entry.auth_type,
    auth_header_name: entry.auth_header_name,
    credential,
    timeout_ms: entry.timeout_ms,
  };
  const existing = registry.getBySlug(entry.slug);
  if (existing && existing.managed_by !== "helm") return "skipped";
  if (existing) {
    await registry.update(existing.id, fields);
    return "updated";
  }
  await registry.create({ slug: entry.slug, ...fields }, "helm");
  return "created";
}

// Retries entries that failed (e.g. the store chart is installed after the platform, so its Secret
// doesn't exist yet) with capped exponential backoff and jitter (SYSTEM.md I12).
export function startSeeding(
  registry: Registry,
  health: HealthChecker,
  entries: SeedEntry[],
  readSecret: ReadSecret,
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
  backoff = { baseMs: 5_000, capMs: 300_000 },
): () => void {
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();

  const attempt = async (entry: SeedEntry, n: number) => {
    if (stopped) return;
    try {
      const result = await seedOne(registry, entry, readSecret);
      const server = registry.getBySlug(entry.slug);
      if (server) health.reschedule(server.id);
      log.info({ slug: entry.slug, result }, "gateway seed server");
    } catch (err) {
      const delay = Math.round(Math.min(backoff.baseMs * 2 ** n, backoff.capMs) * (0.8 + Math.random() * 0.4));
      log.warn({ slug: entry.slug, attempt: n + 1, retryInMs: delay, err: (err as Error).message }, "gateway seed failed, will retry");
      const t = setTimeout(() => {
        timers.delete(t);
        void attempt(entry, n + 1);
      }, delay);
      t.unref();
      timers.add(t);
    }
  };

  for (const entry of entries) void attempt(entry, 0);
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
  };
}
