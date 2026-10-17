import type { Db } from "../db";
import type { CatalogEntry } from "../gateway/catalog";

// Human approval for risky tool calls in the dashboard chat (ROADMAP P10). The model proposes a
// call, the person watching the chat approves or declines it, and only then does it run. External
// MCP clients (Claude Code, Cursor) are not affected: they ask their own user before every call.

// "writes": anything not marked read-only asks first (default). "destructive": only tools that
// declare destructiveHint. "off": never ask.
export type ApprovalMode = "writes" | "destructive" | "off";
export type ApprovalOutcome = "approved" | "declined" | "timeout";

// Inside the 120 s chat budget, so the turn can still finish after a late "yes".
export const APPROVAL_TIMEOUT_MS = 60_000;

export function parseApprovalMode(raw: string | undefined): ApprovalMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "destructive" || v === "off" ? v : "writes";
}

// Why a call needs approval, in words for the approval card; null = run it straight away.
// The tool's own MCP annotations decide, the same hints the permission defaults use (S2).
export function approvalReason(tool: Pick<CatalogEntry, "annotations"> | undefined, mode: ApprovalMode): string | null {
  if (mode === "off" || !tool) return null;
  const a = tool.annotations ?? {};
  if (a.destructiveHint === true) return "This tool can overwrite or delete data.";
  if (mode === "writes" && a.readOnlyHint !== true) return "This tool changes data.";
  return null;
}

// Approvals waiting for an answer (DESIGN §13.3). In the database, not in memory: with two API
// replicas the chat stream runs on one pod and the Approve click may reach the other. The waiting
// stream polls its row with backoff (100 ms doubling to 500 ms, jittered), so an answer shows within
// half a second.
export function createApprovals(db: Db, timeoutMs = APPROVAL_TIMEOUT_MS, poll = { firstMs: 100, capMs: 500 }) {
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });

  return {
    // Creates the pending question. Call it before telling the browser, so an answer can't arrive
    // before there is a row to record it in.
    async open(id: string, userId: string): Promise<void> {
      // Rows left behind by a pod that died while waiting are swept here.
      const stale = new Date(Date.now() - 10 * 60_000).toISOString().replace("T", " ").slice(0, 19);
      await db.run(`delete from chat_approvals where created_at < ?`, stale);
      await db.run(`insert into chat_approvals (id, user_id) values (?, ?)`, id, userId);
    },

    // Resolves when the user answers, after timeoutMs (timeout), or when the chat stream closes (declined).
    async wait(id: string, signal?: AbortSignal): Promise<ApprovalOutcome> {
      const deadline = Date.now() + timeoutMs;
      let delay = poll.firstMs;
      try {
        for (;;) {
          const row = await db.get<{ decision: "approved" | "declined" | null }>(`select decision from chat_approvals where id = ?`, id);
          if (row?.decision) return row.decision;
          if (signal?.aborted) return "declined";
          const left = deadline - Date.now();
          if (left <= 0) return "timeout";
          await sleep(Math.min(delay * (0.8 + Math.random() * 0.4), left), signal);
          delay = Math.min(delay * 2, poll.capMs);
        }
      } finally {
        await db.run(`delete from chat_approvals where id = ?`, id);
      }
    },

    // Only the user whose chat asked can answer, once; anyone else gets "not found", like an unknown id.
    async decide(id: string, userId: string, approve: boolean): Promise<boolean> {
      const r = await db.run(
        `update chat_approvals set decision = ?, decided_at = ${db.now} where id = ? and user_id = ? and decision is null`,
        approve ? "approved" : "declined", id, userId,
      );
      return r.changes === 1;
    },
  };
}

export type Approvals = ReturnType<typeof createApprovals>;
