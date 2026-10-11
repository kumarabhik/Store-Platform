import { useCallback, useEffect, useState } from "react";
import { Banner, StatusPill } from "../components";
import { apiJson, errorText, formatDate, timeAgo, type Api, type AuthUser } from "../lib/api";

// Servers page (DESIGN §7.6). Admins manage upstream MCP servers; members get a read-only list of
// names and tools, because the API never sends them URLs or auth details.

type AuthType = "none" | "bearer" | "header";

type MinRole = "member" | "admin" | "nobody";
// min_role/policy_source come only in the admin view (ROADMAP S2).
type Tool = { name: string; description?: string | null; min_role?: MinRole; policy_source?: "tool" | "server" | "default"; changed?: boolean };

type Server = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  status: string;
  tools: Tool[];
  // Admin-only fields:
  url?: string;
  auth_type?: AuthType;
  auth_header_name?: string | null;
  has_credential?: boolean;
  timeout_ms?: number;
  managed_by?: "admin" | "helm" | "provisioner";
  last_error?: string | null;
  last_ok_at?: string | null;
  last_check_at?: string | null;
  last_latency_ms?: number | null;
  consecutive_failures?: number;
  // Tools whose definition changed since it was approved; hidden from everyone until approved (S6).
  changed_tools?: number;
};

type RawServer = Omit<Server, "tools"> & { tools: Array<Tool | string> };

type Form = {
  slug: string;
  name: string;
  url: string;
  auth_type: AuthType;
  auth_header_name: string;
  credential: string;
  timeout_ms: string;
};

const EMPTY_FORM: Form = { slug: "", name: "", url: "", auth_type: "none", auth_header_name: "", credential: "", timeout_ms: "15000" };
const REFRESH_MS = 10_000;

function normalize(raw: RawServer): Server {
  return { ...raw, tools: raw.tools.map((t) => (typeof t === "string" ? { name: t } : t)) };
}

export function ServersPage({ api, user }: { api: Api; user: AuthUser }) {
  const admin = user.role === "admin";
  const [servers, setServers] = useState<Server[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ servers: RawServer[] }>(api, "/api/servers");
      setServers(data.servers.map(normalize));
      setLoaded(true);
    } catch (err) {
      setError(errorText(err, "Servers could not be loaded."));
    }
  }, [api]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function run(id: string, action: () => Promise<string>) {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      setError(errorText(err, "The request failed."));
    } finally {
      setBusy(null);
    }
  }

  const testServer = (s: Server) =>
    run(s.id, async () => {
      const r = await apiJson<{ ok: boolean; server: Server }>(api, `/api/servers/${s.id}/test`, { method: "POST" });
      return r.ok
        ? `'${s.slug}' is Connected (${r.server.last_latency_ms ?? "?"} ms, ${r.server.tools.length} tools).`
        : `'${s.slug}' is ${r.server.status}: ${r.server.last_error ?? "no reason given"}`;
    });

  const toggleServer = (s: Server) =>
    run(s.id, async () => {
      await apiJson(api, `/api/servers/${s.id}`, { method: "PATCH", json: { enabled: !s.enabled } });
      return s.enabled ? `'${s.slug}' disabled: its tools are gone from every client and the chat.` : `'${s.slug}' enabled; it will be probed now.`;
    });

  const deleteServer = (s: Server) => {
    if (!window.confirm(`Delete '${s.slug}'? Clients lose its ${s.tools.length} tools immediately.`)) return;
    void run(s.id, async () => {
      await apiJson(api, `/api/servers/${s.id}`, { method: "DELETE" });
      return `'${s.slug}' deleted.`;
    });
  };

  function startEdit(s: Server) {
    setEditingId(s.id);
    setForm({
      slug: s.slug,
      name: s.name,
      url: s.url ?? "",
      auth_type: s.auth_type ?? "none",
      auth_header_name: s.auth_header_name ?? "",
      credential: "",
      timeout_ms: String(s.timeout_ms ?? 15000),
    });
  }

  function closeForm() {
    setForm(null);
    setEditingId(null);
  }

  async function submitForm() {
    if (!form) return;
    const base = {
      name: form.name.trim(),
      url: form.url.trim(),
      auth_type: form.auth_type,
      timeout_ms: Number(form.timeout_ms),
      ...(form.auth_type === "header" ? { auth_header_name: form.auth_header_name.trim() } : {}),
    };
    await run(editingId ?? "new", async () => {
      if (editingId) {
        // An empty credential field means "keep the stored one" (the API never sends it back to show).
        await apiJson(api, `/api/servers/${editingId}`, { method: "PATCH", json: { ...base, ...(form.credential ? { credential: form.credential } : {}) } });
        closeForm();
        return `'${form.slug}' updated; it will be probed again.`;
      }
      await apiJson(api, "/api/servers", {
        method: "POST",
        json: { ...base, slug: form.slug.trim(), ...(form.auth_type !== "none" ? { credential: form.credential } : {}) },
      });
      closeForm();
      return `'${form.slug}' added. Its tools appear as ${form.slug}__<tool> once it is Connected.`;
    });
  }

  const approveTools = (s: Server) => {
    if (!window.confirm(`Approve the new definitions of ${s.changed_tools} tool(s) on '${s.slug}'? Read the changed descriptions first: a description can carry instructions aimed at the model.`)) return;
    void run(s.id, async () => {
      const r = await apiJson<{ approved: number }>(api, `/api/servers/${s.id}/approve-tools`, { method: "POST", json: {} });
      return `${r.approved} tool(s) on '${s.slug}' approved and visible again.`;
    });
  };

  // "default" removes the tool's own rule, so the default applies again (destructive -> admin).
  const setPolicy = (s: Server, tool: Tool, value: string) =>
    run(s.id, async () => {
      await apiJson(api, `/api/servers/${s.id}/tools/${encodeURIComponent(tool.name)}/policy`, {
        method: "PUT",
        json: { min_role: value === "default" ? null : value },
      });
      return value === "default"
        ? `${s.slug}__${tool.name}: back to the default rule.`
        : `${s.slug}__${tool.name}: ${value === "nobody" ? "hidden from everyone" : `${value}s and up`}.`;
    });

  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const set = (patch: Partial<Form>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const connected = servers.filter((s) => s.status === "Connected").length;
  const toolCount = servers.filter((s) => s.enabled).reduce((n, s) => n + s.tools.length, 0);

  return (
    <section className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Upstream MCP servers</p>
          <h2>Servers</h2>
          <p className="subtle">
            {servers.length} registered · {connected} connected · {toolCount} tools exposed as <code>slug__tool</code>
          </p>
        </div>
        {admin && !form && (
          <button className="btn btnPrimary" onClick={() => setForm(EMPTY_FORM)}>
            Add server
          </button>
        )}
      </header>

      <Banner
        error={error}
        notice={notice}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />

      {admin && form && (
        <article className="card formCard">
          <h3>{editingId ? `Edit '${form.slug}'` : "Add an MCP server"}</h3>
          <div className="formGrid">
            <label className="field">
              <span>Slug (tool prefix)</span>
              <input value={form.slug} disabled={!!editingId} placeholder="crm" onChange={(e) => set({ slug: e.target.value })} />
            </label>
            <label className="field">
              <span>Name</span>
              <input value={form.name} placeholder="Team CRM" onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="field fieldWide">
              <span>URL (Streamable HTTP)</span>
              <input value={form.url} placeholder="http://crm-mcp.mcp-servers.svc.cluster.local/mcp" onChange={(e) => set({ url: e.target.value })} />
            </label>
            <label className="field">
              <span>Auth</span>
              <select value={form.auth_type} onChange={(e) => set({ auth_type: e.target.value as AuthType })}>
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="header">Custom header</option>
              </select>
            </label>
            {form.auth_type === "header" && (
              <label className="field">
                <span>Header name</span>
                <input value={form.auth_header_name} placeholder="X-API-Key" onChange={(e) => set({ auth_header_name: e.target.value })} />
              </label>
            )}
            {form.auth_type !== "none" && (
              <label className="field">
                <span>Credential (write-only)</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={form.credential}
                  placeholder={editingId ? "leave empty to keep the stored one" : ""}
                  onChange={(e) => set({ credential: e.target.value })}
                />
              </label>
            )}
            <label className="field">
              <span>Timeout (ms)</span>
              <input type="number" min={1000} max={120000} step={1000} value={form.timeout_ms} onChange={(e) => set({ timeout_ms: e.target.value })} />
            </label>
          </div>
          <p className="subtle">
            The credential is encrypted at rest and never shown again, not even to admins. Upstreams only receive their own credential, never a user's key.
          </p>
          <div className="buttonRow">
            <button className="btn btnPrimary" onClick={() => void submitForm()} disabled={busy !== null}>
              {editingId ? "Save" : "Add server"}
            </button>
            <button className="btn btnSecondary" onClick={closeForm}>
              Cancel
            </button>
          </div>
        </article>
      )}

      {loaded && servers.length === 0 && <div className="emptyState">No MCP servers registered yet.</div>}

      <div className="serverList">
        {servers.map((s) => (
          <article key={s.id} className={`card serverCard ${s.enabled ? "" : "serverCardDisabled"}`}>
            <div className="serverTop">
              <div>
                <h3>
                  {s.name} <code className="slug">{s.slug}__</code>
                </h3>
                {admin && <p className="mono subtle">{s.url}</p>}
              </div>
              <StatusPill value={s.status} />
            </div>

            {admin && (
              <dl className="factGrid">
                <div>
                  <dt>Latency</dt>
                  <dd>{s.last_latency_ms != null ? `${s.last_latency_ms} ms` : "--"}</dd>
                </div>
                <div>
                  <dt>Last check</dt>
                  <dd title={formatDate(s.last_check_at)}>{timeAgo(s.last_check_at)}</dd>
                </div>
                <div>
                  <dt>Last OK</dt>
                  <dd title={formatDate(s.last_ok_at)}>{timeAgo(s.last_ok_at)}</dd>
                </div>
                <div>
                  <dt>Auth</dt>
                  <dd>
                    {s.auth_type === "none" ? "none" : `${s.auth_type === "header" ? s.auth_header_name : "bearer"} · ${s.has_credential ? "set" : "missing"}`}
                  </dd>
                </div>
                <div>
                  <dt>Timeout</dt>
                  <dd>{s.timeout_ms} ms</dd>
                </div>
                <div>
                  <dt>Managed by</dt>
                  <dd>{s.managed_by}</dd>
                </div>
              </dl>
            )}

            {admin && s.last_error && s.status !== "Connected" && (
              <p className="inlineError">
                {s.last_error}
                {s.consecutive_failures ? ` (${s.consecutive_failures} failed probes)` : ""}
              </p>
            )}

            {admin && !!s.changed_tools && (
              <div className="pinWarning">
                <span>
                  ⚠ {s.changed_tools} tool(s) changed since they were approved and are hidden from everyone. Review the descriptions below.
                </span>
                <button className="btn btnSecondary btnSmall" disabled={busy === s.id} onClick={() => approveTools(s)}>
                  Approve changes
                </button>
              </div>
            )}

            <button className="inlineLink" onClick={() => toggleExpanded(s.id)}>
              {expanded.has(s.id) ? "Hide" : "Show"} {s.tools.length} tools
            </button>
            {expanded.has(s.id) && (
              <ul className="toolList">
                {s.tools.map((t) => (
                  <li key={t.name} className="toolRow">
                    <div>
                      <code>
                        {s.slug}__{t.name}
                      </code>
                      {t.changed && <span className="statusPill tone-warn">changed</span>}
                      {t.description && <span className="subtle"> {t.description}</span>}
                    </div>
                    {admin && t.min_role && (
                      <label className="policyPick" title="Who may see and call this tool (tools/list and tools/call)">
                        <span className="subtle">Who may use it</span>
                        <select
                          value={t.policy_source === "tool" ? t.min_role : "default"}
                          disabled={busy === s.id}
                          onChange={(e) => void setPolicy(s, t, e.target.value)}
                        >
                          <option value="default">
                            Default ({t.policy_source === "tool" ? "unset" : t.min_role === "member" ? "everyone" : `${t.min_role}s`})
                          </option>
                          <option value="member">Everyone</option>
                          <option value="admin">Admins only</option>
                          <option value="nobody">Nobody (hidden)</option>
                        </select>
                      </label>
                    )}
                  </li>
                ))}
                {s.tools.length === 0 && <li className="subtle">No tools cached yet (the server has not answered a probe).</li>}
              </ul>
            )}

            {admin && (
              <div className="buttonRow">
                <button className="btn btnSecondary btnSmall" disabled={busy === s.id || !s.enabled} onClick={() => void testServer(s)}>
                  {busy === s.id ? "Working..." : "Test connection"}
                </button>
                <button className="btn btnSecondary btnSmall" disabled={busy === s.id} onClick={() => void toggleServer(s)}>
                  {s.enabled ? "Disable" : "Enable"}
                </button>
                <button className="btn btnSecondary btnSmall" disabled={busy === s.id} onClick={() => startEdit(s)}>
                  Edit
                </button>
                <button
                  className="btn btnDanger btnSmall"
                  disabled={busy === s.id || s.managed_by === "helm"}
                  title={s.managed_by === "helm" ? "Managed by Helm: it would come back on the next start. Disable it instead." : undefined}
                  onClick={() => deleteServer(s)}
                >
                  Delete
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
