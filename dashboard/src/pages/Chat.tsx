import { useEffect, useRef, useState } from "react";
import { errorText, type Api } from "../lib/api";

// Chat page (DESIGN §7.4, §7.6). The agent runs on the server and calls tools through the gateway
// as the logged-in user; this page only renders its SSE events. History stays in this tab's memory
// and only user/assistant text is sent back (the API ignores anything else anyway).

type ToolCard = { kind: "tool"; id: string; name: string; args: unknown; result?: { ok: boolean; ms: number; preview: string } };
// P10: the agent wants to run a tool that changes data and waits for the user's answer.
type ApprovalStatus = "pending" | "sending" | "approved" | "declined" | "timeout";
type ApprovalCard = { kind: "approval"; id: string; name: string; args: unknown; reason: string; status: ApprovalStatus; error?: string };
type Item = { kind: "user" | "assistant"; text: string } | { kind: "error"; text: string } | ToolCard | ApprovalCard;

type ChatEvent =
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; ms: number; preview: string }
  | { type: "approval_required"; id: string; call_id: string; name: string; args: unknown; reason: string; timeout_ms: number }
  | { type: "approval_result"; id: string; call_id: string; outcome: "approved" | "declined" | "timeout" }
  | { type: "message"; text: string }
  | { type: "error"; message: string }
  | { type: "done"; rounds: number };

// The server's chat budget is 120 s; give the response a little longer before the browser gives up.
const CHAT_TIMEOUT_MS = 150_000;

const EXAMPLES = [
  "What orders came in today?",
  "Create a product called Linen Shirt priced 499 rupees.",
  "List today's orders and save a follow-up note for each customer.",
];

// Minimal SSE reader for a POST response (EventSource can only do GET).
async function readEvents(res: Response, onEvent: (e: ChatEvent) => void) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as ChatEvent);
    }
  }
}

export function ChatPage({ api }: { api: Api }) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const setApproval = (id: string, patch: Partial<ApprovalCard>) =>
    setItems((current) => current.map((i) => (i.kind === "approval" && i.id === id ? { ...i, ...patch } : i)));

  // The answer goes in a separate request; the chat stream that asked is still open and continues.
  async function answer(id: string, approve: boolean) {
    setApproval(id, { status: "sending", error: undefined });
    try {
      const res = await api(`/api/chat/approvals/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setApproval(id, { status: "pending", error: body?.message ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      setApproval(id, { status: "pending", error: errorText(err, "Could not send the answer.") });
    }
  }

  async function send(text: string) {
    const question = text.trim();
    if (!question || running) return;
    const history = [...items, { kind: "user", text: question } as Item];
    setItems(history);
    setInput("");
    setRunning(true);
    const abort = new AbortController();
    abortRef.current = abort;

    const messages = history
      .filter((i): i is { kind: "user" | "assistant"; text: string } => i.kind === "user" || i.kind === "assistant")
      .map((i) => ({ role: i.kind, content: i.text }))
      .slice(-40);

    const push = (item: Item) => setItems((current) => [...current, item]);
    try {
      const res = await api(
        "/api/chat",
        { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ messages }), signal: abort.signal },
        { timeoutMs: CHAT_TIMEOUT_MS },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
        push({ kind: "error", text: body?.message ?? body?.error ?? `Chat failed with HTTP ${res.status}` });
        return;
      }
      await readEvents(res, (e) => {
        if (e.type === "tool_call") push({ kind: "tool", id: e.id, name: e.name, args: e.args });
        else if (e.type === "tool_result")
          setItems((current) => current.map((i) => (i.kind === "tool" && i.id === e.id ? { ...i, result: { ok: e.ok, ms: e.ms, preview: e.preview } } : i)));
        else if (e.type === "approval_required")
          push({ kind: "approval", id: e.id, name: e.name, args: e.args, reason: e.reason, status: "pending" });
        else if (e.type === "approval_result") setApproval(e.id, { status: e.outcome });
        else if (e.type === "message") push({ kind: "assistant", text: e.text });
        else if (e.type === "error") push({ kind: "error", text: e.message });
      });
    } catch (err) {
      push({ kind: "error", text: abort.signal.aborted ? "Stopped." : errorText(err, "Chat request failed.") });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  return (
    <section className="page chatPage">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Agent</p>
          <h2>Chat</h2>
          <p className="subtle">The agent can use every tool you can see. Each call runs as you and shows up in the audit log.</p>
        </div>
        {items.length > 0 && !running && (
          <button className="btn btnSecondary btnSmall" onClick={() => setItems([])}>
            New chat
          </button>
        )}
      </header>

      <article className="card chatCard">
        <div className="chatLog">
          {items.length === 0 && (
            <div className="chatEmpty">
              <p className="subtle">Try one of these:</p>
              {EXAMPLES.map((q) => (
                <button key={q} className="btn btnSecondary btnSmall" onClick={() => void send(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}
          {items.map((item, index) =>
            item.kind === "approval" ? (
              <div key={item.id} className={`approvalCard approval-${item.status}`}>
                <div className="approvalHead">
                  <strong>Approve this action?</strong>
                  <span className="subtle">{item.reason}</span>
                </div>
                <p className="mono">{item.name}</p>
                <pre className="toolPreview">{JSON.stringify(item.args, null, 2)}</pre>
                {item.status === "pending" || item.status === "sending" ? (
                  <div className="buttonRow">
                    <button className="btn btnPrimary btnSmall" disabled={item.status === "sending"} onClick={() => void answer(item.id, true)}>
                      Approve
                    </button>
                    <button className="btn btnSecondary btnSmall" disabled={item.status === "sending"} onClick={() => void answer(item.id, false)}>
                      Decline
                    </button>
                  </div>
                ) : (
                  <p className="subtle">{item.status === "approved" ? "Approved: running it." : item.status === "declined" ? "Declined: not done." : "No answer in time: not done."}</p>
                )}
                {item.error && <p className="inlineError">{item.error}</p>}
              </div>
            ) : item.kind === "tool" ? (
              <details key={`${item.id}-${index}`} className={`toolCard ${item.result ? (item.result.ok ? "toolOk" : "toolFail") : "toolRunning"}`}>
                <summary>
                  <span className="mono">{item.name}</span>
                  <span className="subtle">{item.result ? `${item.result.ok ? "ok" : "error"} · ${item.result.ms} ms` : "running..."}</span>
                </summary>
                <p className="mono">args: {JSON.stringify(item.args)}</p>
                {item.result && <pre className="toolPreview">{item.result.preview}</pre>}
              </details>
            ) : (
              <div key={index} className={`bubble bubble-${item.kind}`}>
                {item.text}
              </div>
            ),
          )}
          {running && <div className="subtle thinking">Working...</div>}
          <div ref={endRef} />
        </div>

        <form
          className="chatInput"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <input value={input} maxLength={8000} placeholder="Ask about orders, products or notes..." onChange={(e) => setInput(e.target.value)} disabled={running} />
          {running ? (
            <button type="button" className="btn btnDanger" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btnPrimary" disabled={!input.trim()}>
              Send
            </button>
          )}
        </form>
      </article>
    </section>
  );
}
