import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildEngineValues } from "../src/engine";
import { parseApiServerEndpoints } from "../src/kube";
import { sqliteAvailable } from "./sqlite";
import { testDb } from "./testDb";

describe("per-store Helm values (DESIGN §11)", () => {
  it("carries only what differs per store, and survives hostile store names", async () => {
    const built = buildEngineValues({
      engine: "woocommerce",
      ingressClassName: "nginx",
      host: "store-ab12cd34.127.0.0.1.nip.io",
      publicUrl: "http://store-ab12cd34.127.0.0.1.nip.io:8088",
      storeName: `Bob's "Best": Shop\nexistingSecret: stolen`,
    });
    expect(built.stubbed).toBe(false);
    const yaml = built.valuesYaml;
    // The name is one quoted scalar: the newline can't start a new YAML key.
    expect(yaml).toContain(`title: "Bob's \\"Best\\": Shop\\nexistingSecret: stolen"`);
    expect(yaml.split("\n").filter((l) => l.startsWith("existingSecret:"))).toEqual([`existingSecret: ""`]);
    expect(yaml).toContain(`publicUrl: "http://store-ab12cd34.127.0.0.1.nip.io:8088"`);
    expect(yaml).toContain(`  host: "store-ab12cd34.127.0.0.1.nip.io"`);
    expect(yaml).toContain("backup:\n  enabled: false"); // only on when the upload Secret was copied
    expect(buildEngineValues({ engine: "woocommerce", ingressClassName: "nginx", host: "h", publicUrl: "u", storeName: "n", backup: true }).valuesYaml).toContain("backup:\n  enabled: true");
  });

  it("keeps medusa stubbed", async () => {
    expect(buildEngineValues({ engine: "medusa", ingressClassName: "nginx", host: "h", publicUrl: "u", storeName: "n" }).stubbed).toBe(true);
  });
});

describe("seed tool_policies (S2)", () => {
  it("parses default per-tool rules and rejects unknown roles", async () => {
    const { parseSeedServers } = await import("../src/gateway/seed");
    const entry = (extra: string) => `[{"slug":"woo","name":"W","url":"http://w.store-x.svc.cluster.local/mcp"${extra}}]`;
    expect(parseSeedServers(entry(`,"tool_policies":{"create_product":"admin"}`))[0].tool_policies).toEqual({ create_product: "admin" });
    expect(parseSeedServers(entry(""))[0].tool_policies).toEqual({});
    expect(() => parseSeedServers(entry(`,"tool_policies":{"x":"owner"}`))).toThrow(/tool_policies/);
  });
});

describe("KUBE_API_ENDPOINTS parsing", () => {
  it("reads ip:port pairs and drops anything else", async () => {
    expect(parseApiServerEndpoints("192.168.49.2:8443, 10.0.0.5:6443,junk,1.2.3.4:x")).toEqual([
      { ip: "192.168.49.2", port: 8443 },
      { ip: "10.0.0.5", port: 6443 },
    ]);
    expect(parseApiServerEndpoints(undefined)).toEqual([]);
  });
});

const load = async () => {
  const { openDb } = await import("../src/db");
  const { createRegistry } = await import("../src/gateway/registry");
  const ss = await import("../src/gateway/storeServers");
  return { openDb, createRegistry, ...ss };
};

const policy = { internalHosts: ["*.mcp-servers.svc.cluster.local", "*.store-*.svc.cluster.local"], deniedIps: [] };
const resolvesTo = (ip: string) => async () => [{ address: ip, family: 4 }];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-store-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!sqliteAvailable)("store MCP registration", () => {
  const setup = async () => {
    const m = await load();
    const db = await testDb("stores");
    const registry = m.createRegistry(db, crypto.randomBytes(32), policy, resolvesTo("10.96.20.20"));
    const dropped: string[] = [];
    const rescheduled: string[] = [];
    const secrets: Record<string, string> = { "store-ab12cd34/wc-ab12cd34-credentials/mcp-token": "token-1" };
    const deps = {
      db,
      registry,
      pool: { drop: (id: string) => void dropped.push(id) } as never,
      health: { reschedule: (id: string) => void rescheduled.push(id) } as never,
      readSecret: async (ns: string, name: string, key: string) => {
        const v = secrets[`${ns}/${name}/${key}`];
        if (!v) throw new Error(`Secret ${ns}/${name} has no key '${key}'`);
        return v;
      },
    };
    await db.run(`insert into stores (id, name, engine, status, namespace, created_at, updated_at) values ('ab12cd34', 'Anku', 'woocommerce', 'Ready', 'store-ab12cd34', ${db.now}, ${db.now})`);
    const store = { id: "ab12cd34", name: "Anku", namespace: "store-ab12cd34", release: "wc-ab12cd34" };
    return { ...m, db, registry, deps, store, secrets, dropped, rescheduled };
  };

  it("registers store_<id> with the store's woo-mcp URL and token, as provisioner-managed", async () => {
    const t = await setup();
    const id = await t.registerStoreServer(t.deps, t.store);
    const s = (await t.registry.get(id))!;
    expect(s.slug).toBe("store_ab12cd34");
    expect(s.url).toBe("http://wc-ab12cd34-woo-mcp.store-ab12cd34.svc.cluster.local/mcp");
    expect(s).toMatchObject({ managed_by: "provisioner", store_id: "ab12cd34", auth_type: "bearer", has_credential: true, name: "Store: Anku" });
    expect(await t.registry.authHeadersFor(id)).toEqual({ Authorization: "Bearer token-1" });
    expect(t.rescheduled).toEqual([id]);
    // Same S2 defaults as the default store: members read, admins change.
    const rules = await t.db.all(`select tool_name, min_role from tool_policies where server_id = ? order by tool_name`, id);
    expect(rules).toEqual([
      { tool_name: "create_product", min_role: "admin" },
      { tool_name: "update_order_status", min_role: "admin" },
    ]);
  });

  it("is idempotent: registering again updates the same row (new token, pooled client dropped)", async () => {
    const t = await setup();
    const first = await t.registerStoreServer(t.deps, t.store);
    t.secrets["store-ab12cd34/wc-ab12cd34-credentials/mcp-token"] = "token-2";
    const second = await t.registerStoreServer(t.deps, t.store);
    expect(second).toBe(first);
    expect((await t.registry.list()).filter((s) => s.slug === "store_ab12cd34")).toHaveLength(1);
    expect(await t.registry.authHeadersFor(first)).toEqual({ Authorization: "Bearer token-2" });
    expect(t.dropped).toEqual([first]);
    // An admin's choice made after the first registration survives re-registration.
    (await t.registry.setToolPolicy(first, "create_product", null));
    await t.registerStoreServer(t.deps, t.store);
    expect(await t.db.get(`select count(*) as n from tool_policies where server_id = ? and tool_name = 'create_product'`, first)).toEqual({ n: 0 });
  });

  it("never takes over a slug that belongs to something else", async () => {
    const t = await setup();
    await t.registry.create({ slug: "store_ab12cd34", name: "Admin's", url: "http://x.mcp-servers.svc.cluster.local/mcp" });
    await expect(t.registerStoreServer(t.deps, t.store)).rejects.toThrow(/already used by a server that doesn't belong to store ab12cd34/);
  });

  it("fails clearly when the store's Secret has no token yet", async () => {
    const t = await setup();
    delete t.secrets["store-ab12cd34/wc-ab12cd34-credentials/mcp-token"];
    await expect(t.registerStoreServer(t.deps, t.store)).rejects.toThrow(/wc-ab12cd34-credentials has no key 'mcp-token'/);
  });

  it("remove deletes the store's servers first, so the store row can go (foreign key)", async () => {
    const t = await setup();
    const id = await t.registerStoreServer(t.deps, t.store);
    // SQLite: "FOREIGN KEY constraint failed"; Postgres: "violates foreign key constraint".
    await expect(t.db.run(`delete from stores where id = 'ab12cd34'`)).rejects.toThrow(/FOREIGN KEY|foreign key/);
    expect(await t.removeStoreServers(t.deps, "ab12cd34")).toBe(1);
    expect(await t.registry.get(id)).toBeUndefined();
    expect(t.dropped).toContain(id);
    await t.db.run(`delete from stores where id = 'ab12cd34'`);
    expect(await t.removeStoreServers(t.deps, "ab12cd34")).toBe(0);
  });
});
