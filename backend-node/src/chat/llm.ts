// Minimal OpenAI-compatible /chat/completions client with tool calling (DESIGN §7.4). Works with
// Groq, OpenRouter or a local Ollama: only the base URL, model and key change (all from env/values).

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LlmError";
  }
}

export interface Llm {
  readonly model: string;
  complete(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<{ content: string | null; toolCalls: ToolCall[] }>;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  // GROQ_API_KEY is accepted so the existing platform-api-env Secret keeps working (DESIGN §7.4).
  const apiKey = env.LLM_API_KEY?.trim() || env.GROQ_API_KEY?.trim() || "";
  if (!apiKey) return null;
  const timeout = Number(env.LLM_TIMEOUT_MS);
  return {
    baseUrl: (env.LLM_BASE_URL?.trim() || "https://api.groq.com/openai/v1").replace(/\/$/, ""),
    // Model names expire (SYSTEM.md G3), so this default is only a fallback for values.
    model: env.LLM_MODEL?.trim() || "openai/gpt-oss-120b",
    apiKey,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
  };
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// Groq's free tier limits tokens per minute, and its suggested retry time is often too short for
// the window to free up (SYSTEM.md L27). 3 retries of up to 20 s still fit the 120 s chat budget.
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 20_000;

export function createLlm(cfg: LlmConfig, fetchImpl: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Llm {
  const host = new URL(cfg.baseUrl).host;
  return {
    model: cfg.model,
    async complete(messages, tools, signal) {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({ model: cfg.model, messages, ...(tools.length ? { tools, tool_choice: "auto" } : {}), temperature: 0.2 }),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]) : AbortSignal.timeout(cfg.timeoutMs),
          });
        } catch (err) {
          const e = err as Error & { cause?: { code?: string } };
          if (e.name === "TimeoutError") throw new LlmError(`LLM at ${host} timed out after ${cfg.timeoutMs} ms`);
          if (e.name === "AbortError") throw new LlmError("LLM request cancelled");
          throw new LlmError(`LLM at ${host} is unreachable: ${e.cause?.code ?? e.message}`);
        }
        if (res.ok) {
          const data = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
          const msg = data.choices?.[0]?.message;
          if (!msg) throw new LlmError(`LLM at ${host} returned no choices`);
          return { content: msg.content ?? null, toolCalls: msg.tool_calls ?? [] };
        }
        // Rate limits and provider hiccups: back off exponentially with jitter, capped (SYSTEM.md I12).
        if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const base = Math.max(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0, 2_500 * 2 ** attempt);
          await sleep(Math.min(base, MAX_BACKOFF_MS) * (0.8 + Math.random() * 0.4));
          continue;
        }
        const body = await res.text().catch(() => "");
        let detail = body.slice(0, 300);
        try {
          detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? detail;
        } catch {
          /* not JSON: keep the text */
        }
        // The provider's message, never the request: it would contain the key in a header we don't log anyway.
        throw new LlmError(`LLM at ${host} returned ${res.status}: ${detail}`, res.status);
      }
    },
  };
}
