import { Fragment, useEffect, useRef, useState } from "react";
import { Banner, StatusPill } from "../components";
import { apiJson, errorText, formatDate, type Api, type AuthUser } from "../lib/api";

// Audit page (DESIGN §7.6). Admins see every row; for members the API forces the filter to their
// own rows, whatever the UI sends.

type AuditRow = {
  id: number;
  ts: string;
  user_email: string;
  api_key_id: string | null;
  source: "mcp" | "chat";
  server_slug: string | null;
  exposed_name: string;
  duration_ms: number;
  outcome: string;
  error: string | null;
  args_preview: string | null;
};

type Filters = { user: string; server: string; tool: string; outcome: string; source: string; from: string; to: string };

const EMPTY: Filters = { user: "", server: "", tool: "", outcome: "", source: "", from: "", to: "" };
const OUTCOMES = ["ok", "tool_error", "timeout", "unreachable", "denied", "not_found", "bad_request"];
const PAGE = 50;
const REFRESH_MS = 5_000;

// datetime-local gives local time without a zone; the API wants ISO-8601 (UTC).
const toIso = (local: string) => (local ? new Date(local).toISOString() : "");

// The same filters drive the table (/api/audit, paged) and the CSV export (/api/audit.csv).
function query(f: Filters, beforeId?: number, path = "/api/audit") {
  const q = new URLSearchParams(path === "/api/audit" ? { limit: String(PAGE) } : {});
  const add = (k: string, v: string) => v.trim() && q.set(k, v.trim());
  add("user", f.user);
  add("server", f.server);
  add("tool", f.tool);
  add("outcome", f.outcome);
  add("source", f.source);
  add("from", toIso(f.from));
  add("to", toIso(f.to));
  if (beforeId) q.set("before_id", String(beforeId));
  return `${path}?${q}`;
}

export function AuditPage({ api, user }: { api: Api; user: AuthUser }) {
  const admin = user.role === "admin";
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [olderRows, setOlderRows] = useState<AuditRow[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  // Once older pages are loaded, the cursor belongs to them, not to the auto-refreshed first page.
  const pagedRef = useRef(false);

  const firstPageUrl = query(filters);

  // Loads the newest page now and every 5 s. Rows fetched with "Load older" are kept, since paging
  // is by id. A result that arrives after the filters changed is dropped (cancelled).
  useEffect(() => {
    let cancelled = false;
    async function loadFirst() {
      try {
        const r = await apiJson<{ rows: AuditRow[]; next_before_id: number | null }>(api, firstPageUrl);
        if (cancelled) return;
        setRows(r.rows);
        setError(null);
        if (!pagedRef.current) setNextBefore(r.next_before_id);
      } catch (err) {
        if (!cancelled) setError(errorText(err, "The audit log could not be loaded."));
      }
    }
    void loadFirst();
    const timer = autoRefresh ? window.setInterval(() => void loadFirst(), REFRESH_MS) : undefined;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, autoRefresh, firstPageUrl]);

  // New filters start a new listing: drop older pages fetched under the previous ones.
  function applyFilters(next: Filters) {
    pagedRef.current = false;
    setOlderRows([]);
    setNextBefore(null);
    setFilters(next);
  }

  async function loadOlder() {
    const all = [...rows, ...olderRows];
    const before = all.length ? all[all.length - 1].id : nextBefore;
    if (!before) return;
    pagedRef.current = true;
    try {
      const r = await apiJson<{ rows: AuditRow[]; next_before_id: number | null }>(api, query(filters, before));
      setOlderRows((current) => [...current, ...r.rows]);
      setNextBefore(r.next_before_id);
    } catch (err) {
      setError(errorText(err, "Older rows could not be loaded."));
    }
  }

  // Downloads the CSV through `api` (it carries the session header, which a plain link can't).
  async function exportCsv() {
    setExporting(true);
    try {
      const res = await api(query(filters, undefined, "/api/audit.csv"));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? `Audit export failed with HTTP ${res.status}`);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "audit.csv";
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
      const count = res.headers.get("x-audit-rows") ?? "?";
      setNotice(
        res.headers.get("x-audit-truncated") === "true"
          ? `Exported the newest ${count} rows only. Narrow From/To to export the rest.`
          : `Exported ${count} rows to ${name}.`,
      );
    } catch (err) {
      setError(errorText(err, "The audit log could not be exported."));
    } finally {
      setExporting(false);
    }
  }

  const set = (patch: Partial<Filters>) => setDraft((current) => ({ ...current, ...patch }));
  const firstIds = new Set(rows.map((r) => r.id));
  const shown = [...rows, ...olderRows.filter((r) => !firstIds.has(r.id))];

  return (
    <section className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Every tool call, including failures</p>
          <h2>Audit log</h2>
          <p className="subtle">{admin ? "All users." : "Your calls only."} Arguments under secret-looking keys are redacted.</p>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> Auto-refresh (5 s)
        </label>
      </header>

      <Banner error={error} onClose={() => setError(null)} />
      <Banner notice={notice} onClose={() => setNotice(null)} />

      <article className="card formCard">
        <div className="filterGrid">
          {admin && (
            <label className="field">
              <span>User email</span>
              <input value={draft.user} onChange={(e) => set({ user: e.target.value })} />
            </label>
          )}
          <label className="field">
            <span>Server slug</span>
            <input value={draft.server} placeholder="woo" onChange={(e) => set({ server: e.target.value })} />
          </label>
          <label className="field">
            <span>Tool contains</span>
            <input value={draft.tool} placeholder="list_orders" onChange={(e) => set({ tool: e.target.value })} />
          </label>
          <label className="field">
            <span>Outcome</span>
            <select value={draft.outcome} onChange={(e) => set({ outcome: e.target.value })}>
              <option value="">any</option>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Source</span>
            <select value={draft.source} onChange={(e) => set({ source: e.target.value })}>
              <option value="">any</option>
              <option value="mcp">mcp (API key)</option>
              <option value="chat">chat</option>
            </select>
          </label>
          <label className="field">
            <span>From</span>
            <input type="datetime-local" value={draft.from} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="datetime-local" value={draft.to} onChange={(e) => set({ to: e.target.value })} />
          </label>
        </div>
        <div className="buttonRow">
          <button className="btn btnPrimary btnSmall" onClick={() => applyFilters(draft)}>
            Apply filters
          </button>
          <button
            className="btn btnSecondary btnSmall"
            onClick={() => {
              setDraft(EMPTY);
              applyFilters(EMPTY);
            }}
          >
            Clear
          </button>
          <button className="btn btnSecondary btnSmall" disabled={exporting} onClick={() => void exportCsv()} title="Applied filters, newest first">
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </article>

      <article className="card">
        {shown.length === 0 ? (
          <div className="emptyState">No calls match.</div>
        ) : (
          <table className="dataTable auditTable">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Source</th>
                <th>Tool</th>
                <th>Outcome</th>
                <th>ms</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <Fragment key={r.id}>
                  <tr className="clickRow" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td>{formatDate(r.ts)}</td>
                    <td>{r.user_email}</td>
                    <td>{r.source}</td>
                    <td className="mono">{r.exposed_name}</td>
                    <td>
                      <StatusPill value={r.outcome} />
                    </td>
                    <td>{r.duration_ms}</td>
                  </tr>
                  {open === r.id && (
                    <tr className="detailRow">
                      <td colSpan={6}>
                        {r.error && <p className="inlineError">{r.error}</p>}
                        <p className="mono">args: {r.args_preview ?? "{}"}</p>
                        <p className="subtle">
                          request #{r.id} · server {r.server_slug ?? "--"} · {r.api_key_id ? `API key ${r.api_key_id}` : "dashboard session"}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {nextBefore !== null && (
          <div className="buttonRow">
            <button className="btn btnSecondary btnSmall" onClick={() => void loadOlder()}>
              Load older
            </button>
          </div>
        )}
      </article>
    </section>
  );
}
