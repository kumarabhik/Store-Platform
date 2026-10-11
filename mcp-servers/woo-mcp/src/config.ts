import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Where requests go: the store's in-cluster Service, e.g. http://store-default-wordpress.store-default.svc.cluster.local
  WOO_BASE_URL: z.string().url(),
  // The WordPress "home" option (the public store URL). WooCommerce rebuilds the OAuth base string
  // from it, not from the Host we connect to, so the signature must use it too (SYSTEM.md L18).
  WOO_HOME_URL: z.string().url(),
  WOO_CONSUMER_KEY: z.string().startsWith("ck_"),
  WOO_CONSUMER_SECRET: z.string().startsWith("cs_"),
  // Bearer token the gateway must present on /mcp. Shared only with the gateway (DESIGN §7.1).
  WOO_MCP_TOKEN: z.string().min(16),
  // Below the gateway's 15 s upstream timeout, so a slow store is reported by this layer (DESIGN §6.7).
  WOO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names and rules only; never echo values, some of them are secrets.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`woo-mcp config is invalid: ${problems}`);
  }
  return parsed.data;
}
