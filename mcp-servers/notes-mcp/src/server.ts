import { z } from "zod";
import { buildApp } from "./app";
import { openStore } from "./store";

const env = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    NOTES_DB_PATH: z.string().min(1).default("/data/notes.db"),
    NOTES_MCP_TOKEN: z.string().min(16),
  })
  .safeParse(process.env);

async function main() {
  if (!env.success) {
    // Names and rules only; never echo values, the token is a secret.
    throw new Error(`notes-mcp config is invalid: ${env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const store = openStore(env.data.NOTES_DB_PATH);
  const app = buildApp({ token: env.data.NOTES_MCP_TOKEN, store, logger: true });
  app.addHook("onClose", async () => store.close());
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void app.close().then(() => process.exit(0)));
  await app.listen({ host: "0.0.0.0", port: env.data.PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
