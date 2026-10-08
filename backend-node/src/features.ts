import type { FastifyInstance } from "fastify";

// Pre-MCP SaaS features (Stripe billing, custom domains, DB backups, AI content suggestions).
// Frozen behind FEATURE_LEGACY_SAAS: not part of the gateway scope, and every exposed route is attack surface.
export const LEGACY_SAAS_ROUTES = new Set([
  "/billing/summary",
  "/billing/checkout-session",
  "/billing/confirm",
  "/billing/portal",
  "/stores/:id/domain",
  "/stores/:id/backups",
  "/stores/:id/backups/:backupId/download",
  "/stores/:id/content-suggestions",
]);

export function registerLegacySaasGate(app: FastifyInstance, enabled: boolean) {
  app.addHook("onRequest", async (req, reply) => {
    if (enabled) return;
    if (req.routeOptions.url && LEGACY_SAAS_ROUTES.has(req.routeOptions.url)) {
      return reply.code(404).send({ error: "feature_disabled" });
    }
  });
}
