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

// Approvals waiting for an answer, for the open chat streams of this API process. In memory on
// purpose: the stream and the "approve" request reach the same pod while the API runs one replica
// (SQLite). With several replicas this would move to the shared database.
export function createApprovals(timeoutMs = APPROVAL_TIMEOUT_MS) {
  const pending = new Map<string, { userId: string; settle: (o: ApprovalOutcome) => void }>();

  return {
    // Resolves when the user answers, after timeoutMs (timeout), or when the chat stream closes (declined).
    wait(id: string, userId: string, signal?: AbortSignal): Promise<ApprovalOutcome> {
      return new Promise((resolve) => {
        const finish = (o: ApprovalOutcome) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(o);
        };
        const onAbort = () => finish("declined");
        const timer = setTimeout(() => finish("timeout"), timeoutMs);
        pending.set(id, { userId, settle: finish });
        if (signal?.aborted) finish("declined");
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    // Only the user whose chat asked can answer; anyone else gets "not found", like an unknown id.
    decide(id: string, userId: string, approve: boolean): boolean {
      const p = pending.get(id);
      if (!p || p.userId !== userId) return false;
      p.settle(approve ? "approved" : "declined");
      return true;
    },

    get size() {
      return pending.size;
    },
  };
}

export type Approvals = ReturnType<typeof createApprovals>;
