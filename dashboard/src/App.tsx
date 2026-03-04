import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

type Store = {
  id: string;
  engine: string;
  status: string;
  namespace: string;
  url?: string | null;
  created_at: string;
  last_error?: string | null;
};

type EventRow = {
  id: number;
  store_id: string;
  ts: string;
  type: string;
  message?: string | null;
};

const POLL_INTERVAL_MS = 10_000;

function unique(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const v = (value ?? "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function deriveApiHostFromLocation() {
  if (typeof window === "undefined") return null;
  const { protocol, hostname } = window.location;
  if (!hostname.startsWith("dashboard.")) return null;
  return `${protocol}//api.${hostname.slice("dashboard.".length)}`;
}

function withPath(base: string, path: string) {
  if (base === "/api") return `${base}${path}`;
  return `${base.replace(/\/$/, "")}${path}`;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function formatDate(raw: string) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString();
}

export default function App() {
  const configuredApiBase = (import.meta.env.VITE_API_BASE as string | undefined)?.trim();

  const apiCandidates = useMemo(
    () =>
      unique([
        configuredApiBase,
        "/api",
        deriveApiHostFromLocation(),
        "http://127.0.0.1:8080",
        "http://localhost:8080",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
      ]),
    [configuredApiBase]
  );

  const [apiBase, setApiBase] = useState<string>(() => apiCandidates[0] ?? "http://127.0.0.1:8080");
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const showPortForwardHint = Boolean(error?.startsWith("API unreachable."));

  const selected = useMemo(() => stores.find((s) => s.id === selectedId) ?? null, [stores, selectedId]);

  const counts = useMemo(() => {
    let ready = 0;
    let provisioning = 0;
    let failed = 0;
    for (const store of stores) {
      if (store.status === "Ready") ready += 1;
      else if (store.status === "Provisioning") provisioning += 1;
      else if (store.status === "Failed") failed += 1;
    }
    return { ready, provisioning, failed };
  }, [stores]);

  const apiRequest = useCallback(
    async (path: string, init?: RequestInit) => {
      const attempts = [apiBase, ...apiCandidates.filter((candidate) => candidate !== apiBase)];
      let lastError: unknown;

      for (const candidate of attempts) {
        try {
          const response = await fetchWithTimeout(withPath(candidate, path), init);
          if (candidate !== apiBase) setApiBase(candidate);
          setApiReachable(true);
          return response;
        } catch (err) {
          lastError = err;
        }
      }

      setApiReachable(false);
      throw lastError ?? new Error("api request failed");
    },
    [apiBase, apiCandidates]
  );

  const refresh = useCallback(async () => {
    try {
      const res = await apiRequest("/stores");
      if (!res.ok) throw new Error(`stores fetch failed: ${res.status}`);
      const data = (await res.json()) as Store[];
      const filtered = data.filter((s) => s.status !== "Deleting");

      setStores(filtered);
      if (selectedId && !filtered.some((s) => s.id === selectedId)) {
        setSelectedId(null);
      }

      setLastSyncAt(new Date());
      setError(null);
    } catch (err) {
      console.error(err);
      setError(`API unreachable. Current target: ${apiBase}. Tried: ${apiCandidates.join(", ")}`);
    } finally {
      setBootstrapping(false);
    }
  }, [apiBase, apiCandidates, apiRequest, selectedId]);

  const loadEvents = useCallback(
    async (storeId: string) => {
      try {
        const res = await apiRequest(`/stores/${storeId}/events`);
        if (!res.ok) throw new Error(`events fetch failed: ${res.status}`);
        setEvents(await res.json());
      } catch (err) {
        console.error(err);
        setError("Failed to load events. Showing last known events.");
      }
    },
    [apiRequest]
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) {
      setEvents([]);
      return;
    }
    void loadEvents(selectedId);
  }, [loadEvents, selectedId]);

  const statusBadge = (status: string) => {
    if (status === "Ready") return <span className="badge badgeReady">Ready</span>;
    if (status === "Provisioning") return <span className="badge badgeProvisioning">Provisioning</span>;
    if (status === "Deleting") return <span className="badge badgeDeleting">Deleting</span>;
    return <span className="badge badgeOther">{status}</span>;
  };

  async function createStore() {
    if (creating) return;

    setCreating(true);
    setLoading(true);
    try {
      const res = await apiRequest("/stores", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engine: "woocommerce" }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string; retry_after_sec?: number; max_stores?: number }
          | null;

        if (res.status === 429 && payload?.error === "max_stores_reached") {
          throw new Error(
            `Max stores reached (${payload.max_stores ?? "limit"}). Delete a ready/provisioning store and retry.`
          );
        }

        if (res.status === 429 && (payload?.error === "create_rate_limited" || payload?.error === "rate_limited")) {
          throw new Error(`Rate limited. Retry in about ${payload.retry_after_sec ?? 10} seconds.`);
        }

        if (res.status >= 500) {
          throw new Error("Platform API failed while creating the store. Please retry.");
        }

        throw new Error(payload?.error ? `Create failed: ${payload.error}` : `Create failed (${res.status}).`);
      }

      await refresh();
      setError(null);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to create store. Please retry.");
    } finally {
      setLoading(false);
      setTimeout(() => setCreating(false), 1500);
    }
  }

  async function deleteStore(id: string) {
    const prev = stores;
    setStores((curr) => curr.filter((s) => s.id !== id));
    if (selectedId === id) setSelectedId(null);

    try {
      const res = await apiRequest(`/stores/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(`deleteStore failed: ${res.status}${bodyText ? ` ${bodyText}` : ""}`);
      }
      await refresh();
    } catch (err) {
      console.error(err);
      setStores(prev);
      setError("Delete failed. Store list rolled back.");
    }
  }

  return (
    <div className="shell">
      <div className="glow glowA" />
      <div className="glow glowB" />

      <header className="hero">
        <div>
          <p className="eyebrow">Store Control Plane</p>
          <h1>Provisioning Dashboard</h1>
          <p className="heroSubtitle">
            Create and monitor isolated commerce stores with live status and event timelines.
          </p>
        </div>

        <div className="heroActions">
          <span className={`apiState ${apiReachable === false ? "apiOffline" : "apiOnline"}`}>
            {apiReachable === null ? "API checking..." : apiReachable ? "API online" : "API offline"}
          </span>
          <button className="btn btnPrimary" disabled={loading || creating} onClick={createStore}>
            {creating ? "Creating..." : "+ Create WooCommerce Store"}
          </button>
        </div>
      </header>

      <section className="statsStrip">
        <article className="statCard">
          <span>Total Stores</span>
          <strong>{stores.length}</strong>
        </article>
        <article className="statCard">
          <span>Ready</span>
          <strong>{counts.ready}</strong>
        </article>
        <article className="statCard">
          <span>Provisioning</span>
          <strong>{counts.provisioning}</strong>
        </article>
        <article className="statCard">
          <span>Failed</span>
          <strong>{counts.failed}</strong>
        </article>
        <article className="statCard statWide">
          <span>Connected Endpoint</span>
          <code>{apiBase}</code>
        </article>
        <article className="statCard statWide">
          <span>Last Sync</span>
          <strong>{lastSyncAt ? lastSyncAt.toLocaleTimeString() : "--"}</strong>
        </article>
      </section>

      {error && (
        <section className="alert">
          <p>{error}</p>
          {showPortForwardHint && (
            <p className="hint">
              Local Minikube setup usually needs this while running dashboard on port 5173:
              <code>kubectl -n platform port-forward svc/platform-api 8080:80</code>
            </p>
          )}
        </section>
      )}

      <main className="layout">
        <section className="panel">
          <div className="panelHeader">
            <h2>Stores</h2>
            <span>{stores.length} active</span>
          </div>

          {bootstrapping && <p className="muted">Loading stores...</p>}

          {!bootstrapping && stores.length === 0 && (
            <div className="empty">
              <p>No stores yet.</p>
              <p>Use the create button to provision your first WooCommerce instance.</p>
            </div>
          )}

          {stores.map((store, index) => (
            <article
              key={store.id}
              className={`storeCard ${selectedId === store.id ? "storeCardSelected" : ""}`}
              onClick={() => setSelectedId(store.id)}
              style={{ animationDelay: `${index * 60}ms` }}
            >
              <div className="storeHead">
                <div>
                  <p className="storeName">store-{store.id}</p>
                  <p className="storeMeta">Created {formatDate(store.created_at)}</p>
                </div>
                {statusBadge(store.status)}
              </div>

              <dl className="storeFacts">
                <div>
                  <dt>Namespace</dt>
                  <dd>{store.namespace}</dd>
                </div>
                <div>
                  <dt>Engine</dt>
                  <dd>{store.engine}</dd>
                </div>
                <div>
                  <dt>URL</dt>
                  <dd>{store.url ?? "--"}</dd>
                </div>
              </dl>

              {store.last_error && <p className="storeError">{store.last_error}</p>}

              <div className="storeActions">
                {store.url && (
                  <a
                    className="btn btnGhost"
                    href={store.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Open
                  </a>
                )}
                <button
                  className="btn btnDanger"
                  disabled={loading}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteStore(store.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </section>

        <section className="panel">
          <div className="panelHeader">
            <h2>Activity</h2>
            <span>{selected ? `store-${selected.id}` : "No store selected"}</span>
          </div>

          {!selected && (
            <div className="empty">
              <p>Select a store to inspect deployment events.</p>
            </div>
          )}

          {selected && (
            <>
              <div className="selectedSummary">
                <div>
                  <p className="summaryLabel">Namespace</p>
                  <p>{selected.namespace}</p>
                </div>
                <div>
                  <p className="summaryLabel">Status</p>
                  <p>{selected.status}</p>
                </div>
                <div>
                  <p className="summaryLabel">Storefront</p>
                  <p>{selected.url ? <a href={selected.url}>{selected.url}</a> : "--"}</p>
                </div>
              </div>

              <div className="timeline">
                {events.map((event, index) => (
                  <article key={event.id} className="timelineItem" style={{ animationDelay: `${index * 40}ms` }}>
                    <div className="timelineHead">
                      <strong>{event.type}</strong>
                      <time>{formatDate(event.ts)}</time>
                    </div>
                    {event.message && <p>{event.message}</p>}
                  </article>
                ))}
                {events.length === 0 && <p className="muted">No events yet.</p>}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
