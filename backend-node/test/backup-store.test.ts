import { describe, expect, it } from "vitest";
import { createGarageAdmin } from "../src/backupStore";

// A tiny in-memory Garage admin API (v1): keys, buckets, bucket permissions.
function fakeGarage() {
  const keys = new Map<string, { name: string; secret: string }>();
  const buckets = new Map<string, string>(); // alias -> id
  const allowed: { bucketId: string; accessKeyId: string }[] = [];
  const calls: string[] = [];
  let n = 0;
  const json = (status: number, body?: unknown) => new Response(status === 204 || body === undefined ? null : JSON.stringify(body), { status });

  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (init?.headers && (init.headers as Record<string, string>).Authorization !== "Bearer t0ken") return json(401);
    const q = url.searchParams;
    if (url.pathname === "/v1/key" && method === "GET" && q.get("id")) {
      const k = keys.get(q.get("id")!);
      return k ? json(200, { accessKeyId: q.get("id"), secretAccessKey: k.secret, name: k.name }) : json(404);
    }
    if (url.pathname === "/v1/key" && method === "GET") return json(200, [...keys].map(([id, k]) => ({ id, name: k.name })));
    if (url.pathname === "/v1/key" && method === "POST") {
      const id = `GK${String(++n).padStart(24, "0")}`;
      keys.set(id, { name: body.name, secret: `s${n}` });
      return json(200, { accessKeyId: id, secretAccessKey: `s${n}`, name: body.name });
    }
    if (url.pathname === "/v1/key" && method === "DELETE") return keys.delete(q.get("id")!) ? json(204) : json(404);
    if (url.pathname === "/v1/bucket" && method === "GET") {
      const id = buckets.get(q.get("globalAlias")!);
      return id ? json(200, { id }) : json(404, { message: "Bucket not found" });
    }
    if (url.pathname === "/v1/bucket" && method === "POST") {
      const id = `b${buckets.size + 1}`;
      buckets.set(body.globalAlias, id);
      return json(200, { id });
    }
    if (url.pathname === "/v1/bucket/allow" && method === "POST") {
      allowed.push({ bucketId: body.bucketId, accessKeyId: body.accessKeyId });
      return json(200, {});
    }
    return json(500, { message: `unexpected ${method} ${url.pathname}` });
  }) as typeof fetch;
  return { f, keys, buckets, allowed, calls };
}

describe("per-store backup keys on Garage (DESIGN §13.6)", () => {
  it("creates a key and a bucket named after the store, and lets only that key use that bucket", async () => {
    const g = fakeGarage();
    const admin = createGarageAdmin({ baseUrl: "http://garage/v1", token: "t0ken", fetch: g.f });
    const k = await admin.ensureStoreKey("ab12cd34");
    expect(k).toEqual({ bucket: "store-ab12cd34", accessKeyId: "GK000000000000000000000001", secretAccessKey: "s1" });
    expect([...g.keys.values()].map((x) => x.name)).toEqual(["store-ab12cd34"]);
    expect(g.allowed).toEqual([{ bucketId: g.buckets.get("store-ab12cd34"), accessKeyId: k.accessKeyId }]);
  });

  it("is idempotent: a retried provisioning reuses the same key and bucket", async () => {
    const g = fakeGarage();
    const admin = createGarageAdmin({ baseUrl: "http://garage/v1", token: "t0ken", fetch: g.f });
    const first = await admin.ensureStoreKey("ab12cd34");
    const again = await admin.ensureStoreKey("ab12cd34");
    expect(again).toEqual(first);
    expect(g.keys.size).toBe(1);
    expect(g.buckets.size).toBe(1);
  });

  it("two stores get different keys and buckets", async () => {
    const g = fakeGarage();
    const admin = createGarageAdmin({ baseUrl: "http://garage/v1", token: "t0ken", fetch: g.f });
    const a = await admin.ensureStoreKey("aaaa1111");
    const b = await admin.ensureStoreKey("bbbb2222");
    expect(a.accessKeyId).not.toBe(b.accessKeyId);
    expect(a.bucket).not.toBe(b.bucket);
    expect(g.allowed.map((x) => x.accessKeyId)).toEqual([a.accessKeyId, b.accessKeyId]);
  });

  it("revoke deletes only that store's key and keeps its bucket (its last backups)", async () => {
    const g = fakeGarage();
    const admin = createGarageAdmin({ baseUrl: "http://garage/v1", token: "t0ken", fetch: g.f });
    await admin.ensureStoreKey("aaaa1111");
    await admin.ensureStoreKey("bbbb2222");
    expect(await admin.revokeStoreKey("aaaa1111")).toBe(true);
    expect([...g.keys.values()].map((x) => x.name)).toEqual(["store-bbbb2222"]);
    expect(g.buckets.has("store-aaaa1111")).toBe(true);
    expect(await admin.revokeStoreKey("aaaa1111")).toBe(false); // already gone: nothing to do
  });

  it("errors name the component and the status", async () => {
    const g = fakeGarage();
    const admin = createGarageAdmin({ baseUrl: "http://garage/v1", token: "wrong", fetch: g.f });
    await expect(admin.ensureStoreKey("ab12cd34")).rejects.toThrow(/^Backup store: GET \/key returned 401/);
  });
});
