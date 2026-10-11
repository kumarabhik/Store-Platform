import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PublicUser } from "../auth";
import { runChat, type ChatDeps, type ChatEvent } from "./agent";

// POST /api/chat: one user turn, answered as a Server-Sent Events stream of tool_call / tool_result /
// message events (DESIGN §7.4). History lives in the browser and is sent with each turn.

export interface ChatRoutesDeps {
  deps: Omit<ChatDeps, "llm"> & { llm: ChatDeps["llm"] | null };
  currentUser: (req: FastifyRequest) => PublicUser | null;
}

const body = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8_000) })).min(1).max(40),
});

export function registerChatRoutes(app: FastifyInstance, { deps, currentUser }: ChatRoutesDeps) {
  app.post("/api/chat", async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!deps.llm) {
      return reply.code(503).send({ error: "chat_unavailable", message: "Chat: no LLM configured (set LLM_API_KEY in Secret platform-api-env)" });
    }
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });

    // Stop the loop (and the LLM request) when the browser goes away.
    const abort = new AbortController();
    reply.raw.on("close", () => abort.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx: don't buffer this response even if the Ingress annotation is missing (SYSTEM.md G5).
      "x-accel-buffering": "no",
    });
    const emit = (e: ChatEvent) => {
      if (!reply.raw.writableEnded) reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    await runChat({ ...deps, llm: deps.llm }, { id: user.id, email: user.email, name: user.name, role: user.role }, parsed.data.messages, emit, abort.signal);
    reply.raw.end();
  });

  // The answer to an approval_required event (P10). Only the user whose chat is waiting can answer;
  // an unknown, expired or someone else's id is 404.
  app.post("/api/chat/approvals/:id", async (req, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const parsed = z.object({ approve: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid", message: "Chat: body must be {\"approve\": true|false}" });
    const found = deps.approvals?.store.decide((req.params as { id: string }).id, user.id, parsed.data.approve) ?? false;
    if (!found) return reply.code(404).send({ error: "not_found", message: "Chat: no pending approval with this id (answered, expired, or not yours)" });
    return { ok: true };
  });
}
