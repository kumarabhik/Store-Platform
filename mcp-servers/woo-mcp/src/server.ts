import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createWooClient } from "./woo";

async function main() {
  const cfg = loadConfig();
  const app = buildApp({ token: cfg.WOO_MCP_TOKEN, woo: createWooClient(cfg), logger: true });
  await app.listen({ host: "0.0.0.0", port: cfg.PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
