import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkAddress,
  checkUpstreamUrl,
  checkUrl,
  classifyAddress,
  createGuardedFetch,
  guardedLookup,
  isInternalHost,
  ssrfPolicyFromEnv,
} from "../src/gateway/ssrf";

const policy = ssrfPolicyFromEnv({ KUBERNETES_SERVICE_HOST: "10.96.0.1" });
const resolvesTo = (...ips: string[]) => async () => ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("SSRF guard: addresses", () => {
  it.each([
    ["127.0.0.1", "blocked"],
    ["169.254.169.254", "blocked"],
    ["0.0.0.0", "blocked"],
    ["224.0.0.1", "blocked"],
    ["::1", "blocked"],
    ["::ffff:127.0.0.1", "blocked"],
    ["fe80::1", "blocked"],
    ["fd00:ec2::254", "blocked"],
    ["10.244.0.5", "private"],
    ["172.20.1.1", "private"],
    ["192.168.49.2", "private"],
    ["fd12::1", "private"],
    ["93.184.215.14", "public"],
    ["not-an-ip", "blocked"],
  ])("%s is %s", (ip, expected) => {
    expect(classifyAddress(ip)).toBe(expected);
  });

  it("allows private addresses only for in-cluster names on the allowlist", () => {
    expect(isInternalHost("notes-mcp.mcp-servers.svc.cluster.local", policy)).toBe(true);
    expect(isInternalHost("store-default-woo-mcp.store-default.svc.cluster.local", policy)).toBe(true);
    expect(isInternalHost("evil.example.com", policy)).toBe(false);
    expect(isInternalHost("a.b.mcp-servers.svc.cluster.local", policy)).toBe(false);
    expect(() => checkAddress("notes-mcp.mcp-servers.svc.cluster.local", "10.96.4.2", policy)).not.toThrow();
    expect(() => checkAddress("evil.example.com", "10.96.4.2", policy)).toThrow(/private address/);
  });

  it("refuses the Kubernetes API Service IP even for an allowed name", () => {
    expect(() => checkAddress("x.mcp-servers.svc.cluster.local", "10.96.0.1", policy)).toThrow(/Kubernetes API/);
  });
});

describe("SSRF guard: URLs", () => {
  it("allows http(s) on allowed ports only, without credentials", () => {
    expect(checkUrl("http://notes-mcp.mcp-servers.svc.cluster.local:3000/mcp").port).toBe("3000");
    expect(() => checkUrl("file:///etc/passwd")).toThrow(/scheme/);
    expect(() => checkUrl("http://user:pw@example.com/mcp")).toThrow(/credentials/);
    expect(() => checkUrl("http://example.com:22/")).toThrow(/port 22/);
    expect(() => checkUrl("not a url")).toThrow(/not a valid URL/);
  });

  it("checks every resolved address at save time", async () => {
    await expect(checkUpstreamUrl("https://mcp.example.com/mcp", policy, resolvesTo("93.184.215.14"))).resolves.toBeInstanceOf(URL);
    await expect(checkUpstreamUrl("https://rebind.example.com/mcp", policy, resolvesTo("93.184.215.14", "169.254.169.254"))).rejects.toThrow(/169.254.169.254/);
    await expect(checkUpstreamUrl("http://169.254.169.254/latest", policy)).rejects.toThrow(/not allowed/);
  });

  it("accepts a name that does not resolve yet (the connect-time check still applies)", async () => {
    const nxdomain = async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); };
    await expect(checkUpstreamUrl("http://later.mcp-servers.svc.cluster.local/mcp", policy, nxdomain)).resolves.toBeInstanceOf(URL);
  });
});

describe("SSRF guard: connect time", () => {
  it("the lookup hook refuses a rebound name and supports both callback forms", async () => {
    const lookup = guardedLookup(policy, resolvesTo("127.0.0.1"));
    const err = await new Promise((resolve) => lookup("rebind.example.com", {}, (e) => resolve(e)));
    expect(String(err)).toMatch(/loopback/);

    const ok = guardedLookup(policy, resolvesTo("93.184.215.14"));
    const single = await new Promise((resolve) => ok("mcp.example.com", {}, (_e, address) => resolve(address)));
    expect(single).toBe("93.184.215.14");
    const all = await new Promise((resolve) => ok("mcp.example.com", { all: true }, (_e, address) => resolve(address)));
    expect(all).toEqual([{ address: "93.184.215.14", family: 4 }]);
  });

  let server: http.Server;
  let port: number;
  let hits = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.end("reached");
    });
    // Must be an allowed port (3000-9999), or the port check would fail first and prove nothing.
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = 3000 + Math.floor(Math.random() * 7000);
      const ok = await new Promise<boolean>((r) => {
        server.once("error", () => r(false));
        server.listen(candidate, "127.0.0.1", () => r(true));
      });
      if (ok) break;
    }
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("a real fetch to a name that resolves to loopback never connects", async () => {
    const guardedFetch = createGuardedFetch(policy, resolvesTo("127.0.0.1"));
    const err = await guardedFetch(`http://looks-public.example.com:${port}/`).catch((e: Error & { cause?: Error }) => e);
    expect(String((err as Error & { cause?: Error }).cause ?? err)).toMatch(/loopback/);
    expect(hits).toBe(0);
  });

  it("the same server is reachable without the guard (so the test above is meaningful)", async () => {
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("reached");
    hits = 0;
  });

  it("a real fetch to a literal loopback IP is refused before connecting", async () => {
    const guardedFetch = createGuardedFetch(policy);
    await expect(guardedFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/loopback/);
  });
});
