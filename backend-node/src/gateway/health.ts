import crypto from "node:crypto";
import type { Db } from "../db";
import type { Registry } from "./registry";
import type { UpstreamPool, UpstreamTarget } from "./upstreams";

// Upstream health checker (DESIGN §6.6). Probes each enabled server with tools/list, keeps the
// cached catalog (mcp_tools) fresh, and records a human-readable reason when a server is down.

export interface HealthOptions {
  intervalMs: number; // healthy servers: every 15 s
  timeoutMs: number; // probe timeout: 3 s
  capMs: number; // backoff cap: 5 min
  jitter: number; // ±20%
}

export const DEFAULT_HEALTH: HealthOptions = { intervalMs: 15_000, timeoutMs: 3_000, capMs: 300_000, jitter: 0.2 };

// min(interval · 2^(failures-1), cap) ± jitter (SYSTEM.md L1, I12). A dead upstream is not hammered,
// a recovered one is noticed within the cap, and many servers don't probe in lockstep.
export function nextProbeDelay(failures: number, o: HealthOptions = DEFAULT_HEALTH, random: () => number = Math.random): number {
  const base = failures <= 0 ? o.intervalMs : Math.min(o.intervalMs * 2 ** (failures - 1), o.capMs);
  return Math.round(base * (1 + (random() * 2 - 1) * o.jitter));
}

// Everything a model or the gateway's policy reads about a tool. Annotations are included: flipping
// destructiveHint to false would otherwise slip past the admin-only default (S2) unnoticed.
export function definitionHash(tool: { name: string; description?: string; inputSchema: unknown; annotations?: unknown }): string {
  return crypto
    .createHash("sha256")
    .update(`${tool.name}|${tool.description ?? ""}|${JSON.stringify(tool.inputSchema)}|${JSON.stringify(tool.annotations ?? null)}`)
    .digest("hex");
}

export function targetFor(registry: Registry, server: { id: string; slug: string; url: string; updated_at: string }): UpstreamTarget {
  return { id: server.id, slug: server.slug, url: server.url, version: server.updated_at, headers: () => registry.authHeadersFor(server.id) };
}

export function createHealthChecker(db: Db, registry: Registry, pool: UpstreamPool, opts: HealthOptions = DEFAULT_HEALTH) {
  const nextAt = new Map<string, number>();
  const running = new Set<string>();

  function markUnreachable(serverId: string, error: string) {
    db.prepare(
      `update mcp_servers set status = 'Unreachable', last_error = ?, last_check_at = datetime('now'),
         consecutive_failures = consecutive_failures + 1 where id = ? and enabled = 1`,
    ).run(error, serverId);
    const row = db.prepare(`select consecutive_failures from mcp_servers where id = ?`).get(serverId) as { consecutive_failures: number } | undefined;
    nextAt.set(serverId, Date.now() + nextProbeDelay(row?.consecutive_failures ?? 1, opts));
  }

  async function probe(serverId: string): Promise<void> {
    const server = registry.get(serverId);
    if (!server || !server.enabled) return;
    const started = Date.now();
    try {
      const tools = await pool.listTools(targetFor(registry, server), opts.timeoutMs);
      const latency = Date.now() - started;
      db.transaction(() => {
        db.prepare(
          `update mcp_servers set status = 'Connected', last_error = null, last_ok_at = datetime('now'), last_check_at = datetime('now'),
             last_latency_ms = ?, consecutive_failures = 0 where id = ?`,
        ).run(latency, serverId);
        // Replace the cached catalog. Pinning (S6, DESIGN §8.6): a tool's first definition is
        // approved on sight (trust on first use); later changes keep the old approved_hash, so the
        // catalog hides the tool until an admin approves the new definition.
        const upsert = db.prepare(
          `insert into mcp_tools (server_id, name, description, input_schema, annotations, definition_hash, approved_hash, seen_at)
           values (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           on conflict (server_id, name) do update set description = excluded.description, input_schema = excluded.input_schema,
             annotations = excluded.annotations, definition_hash = excluded.definition_hash, seen_at = excluded.seen_at,
             approved_hash = coalesce(mcp_tools.approved_hash, excluded.definition_hash)`,
        );
        for (const t of tools) {
          const hash = definitionHash(t);
          upsert.run(serverId, t.name, t.description ?? null, JSON.stringify(t.inputSchema), t.annotations ? JSON.stringify(t.annotations) : null, hash, hash);
        }
        const names = tools.map((t) => t.name);
        db.prepare(`delete from mcp_tools where server_id = ? and name not in (select value from json_each(?))`).run(serverId, JSON.stringify(names));
      })();
      nextAt.set(serverId, Date.now() + nextProbeDelay(0, opts));
    } catch (err) {
      markUnreachable(serverId, (err as Error).message);
    }
  }

  // Runs every server whose next probe is due. Disabled servers are skipped and shown as Disabled.
  async function runDue(now: number = Date.now()): Promise<void> {
    const rows = db.prepare(`select id, enabled from mcp_servers`).all() as { id: string; enabled: number }[];
    const due = rows.filter((r) => r.enabled === 1 && (nextAt.get(r.id) ?? 0) <= now && !running.has(r.id));
    await Promise.all(
      due.map(async (r) => {
        running.add(r.id);
        try {
          await probe(r.id);
        } finally {
          running.delete(r.id);
        }
      }),
    );
  }

  let timer: NodeJS.Timeout | undefined;
  return {
    probe,
    runDue,
    markUnreachable,
    // Probe this server on the next tick (after create/edit/enable).
    reschedule(serverId: string) {
      nextAt.set(serverId, 0);
    },
    start(tickMs = 1_000) {
      timer = setInterval(() => void runDue().catch(() => {}), tickMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

export type HealthChecker = ReturnType<typeof createHealthChecker>;
