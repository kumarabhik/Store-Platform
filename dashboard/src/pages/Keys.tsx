import { useCallback, useEffect, useState } from "react";
import { Banner, CodeBlock, StatusPill } from "../components";
import { apiJson, errorText, formatDate, timeAgo, type Api, type AuthUser } from "../lib/api";
import { claudeCodeCommand } from "../lib/snippets";

// API keys page (DESIGN §7.6 / §8.2). The full key exists only in the POST response, so it is
// held in memory for this one dialog and never stored in the browser.

type KeyInfo = {
  id: string;
  user_id: string;
  user_email: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export function KeysPage({ api, user, gatewayUrl }: { api: Api; user: AuthUser; gatewayUrl: string }) {
  const admin = user.role === "admin";
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiJson<{ keys: KeyInfo[] }>(api, `/api/keys${showAll ? "?all=1" : ""}`);
      setKeys(data.keys);
    } catch (err) {
      setError(errorText(err, "API keys could not be loaded."));
    }
  }, [api, showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createKey() {
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const r = await apiJson<{ key: string; name: string }>(api, "/api/keys", { method: "POST", json: { name: name.trim() } });
      setCreated({ name: r.name, key: r.key });
      setName("");
      await load();
    } catch (err) {
      setError(errorText(err, "The key could not be created."));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(k: KeyInfo) {
    const whose = k.user_id === user.id ? "your" : `${k.user_email}'s`;
    if (!window.confirm(`Revoke ${whose} key '${k.name}' (mcpgw_${k.prefix}_…)? Clients using it get 401 on their next request.`)) return;
    setBusy(k.id);
    setError(null);
    try {
      await apiJson(api, `/api/keys/${k.id}`, { method: "DELETE" });
      setNotice(`Key '${k.name}' revoked.`);
      await load();
    } catch (err) {
      setError(errorText(err, "The key could not be revoked."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Gateway access</p>
          <h2>API keys</h2>
          <p className="subtle">One key per client (laptop, editor). Every call made with a key is audited under your name.</p>
        </div>
        {admin && (
          <label className="toggle">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show everyone's keys
          </label>
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

      {created && (
        <div className="modalBackdrop" role="dialog" aria-modal="true" aria-labelledby="new-key-title">
          <div className="modal">
            <h3 id="new-key-title">Key '{created.name}' created</h3>
            <p>
              <strong>Copy it now.</strong> Only its SHA-256 hash is stored, so it can never be shown again.
            </p>
            <CodeBlock code={created.key} />
            <p className="subtle">Add the gateway to Claude Code with this key:</p>
            <CodeBlock code={claudeCodeCommand(gatewayUrl, created.key)} />
            <div className="buttonRow">
              <button className="btn btnPrimary" onClick={() => setCreated(null)}>
                I have copied it
              </button>
            </div>
          </div>
        </div>
      )}

      <article className="card formCard">
        <div className="inlineRow">
          <label className="field grow">
            <span>New key name</span>
            <input value={name} maxLength={60} placeholder="Claude Code on my laptop" onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn btnPrimary" disabled={!name.trim() || busy === "create"} onClick={() => void createKey()}>
            Create key
          </button>
        </div>
      </article>

      <article className="card">
        {keys.length === 0 ? (
          <div className="emptyState">No keys yet.</div>
        ) : (
          <table className="dataTable">
            <thead>
              <tr>
                <th>Name</th>
                {showAll && <th>Owner</th>}
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={k.revoked_at ? "rowMuted" : undefined}>
                  <td>{k.name}</td>
                  {showAll && <td>{k.user_email}</td>}
                  <td className="mono">mcpgw_{k.prefix}_…</td>
                  <td>{formatDate(k.created_at)}</td>
                  <td title={formatDate(k.last_used_at)}>{timeAgo(k.last_used_at)}</td>
                  <td>
                    <StatusPill value={k.revoked_at ? "revoked" : "active"} />
                  </td>
                  <td>
                    {!k.revoked_at && (
                      <button className="btn btnDanger btnSmall" disabled={busy === k.id} onClick={() => void revoke(k)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>
    </section>
  );
}
