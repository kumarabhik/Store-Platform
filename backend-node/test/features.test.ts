import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { LEGACY_SAAS_ROUTES, registerLegacySaasGate } from "../src/features";

function buildApp(enabled: boolean) {
  const app = Fastify();
  registerLegacySaasGate(app, enabled);
  for (const route of LEGACY_SAAS_ROUTES) app.get(route, async () => ({ ok: true }));
  app.get("/stores/:id/events", async () => ({ ok: true }));
  return app;
}

describe("legacy SaaS gate", () => {
  it("hides every legacy route when disabled", async () => {
    const app = buildApp(false);
    for (const url of ["/billing/summary", "/stores/abc/domain", "/stores/abc/backups", "/stores/abc/backups/1/download"]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: "feature_disabled" });
    }
  });

  it("leaves non-legacy routes alone when disabled", async () => {
    const res = await buildApp(false).inject({ url: "/stores/abc/events" });
    expect(res.statusCode).toBe(200);
  });

  it("serves legacy routes when enabled", async () => {
    const res = await buildApp(true).inject({ url: "/billing/summary" });
    expect(res.statusCode).toBe(200);
  });

  it("keeps Fastify's normal 404 for unknown routes", async () => {
    const res = await buildApp(false).inject({ url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).not.toBe("feature_disabled");
  });
});
