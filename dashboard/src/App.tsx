import { useEffect, useMemo, useState } from "react";
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

const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8080";

export default function App() {
  const [stores, setStores] = useState<Store[]>([]);
  const [selected, setSelected] = useState<Store | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);


  async function refresh() {
      try {
        const res = await fetch(`${API_BASE}/stores`);
        if (!res.ok) throw new Error(`stores fetch failed: ${res.status}`);
        const data = await res.json();
        const filtered = (data as Store[]).filter((s) => s.status !== "Deleting");
        setStores(data);
        setError(null);

        if (selected) {
          const s = filtered.find((x: Store) => x.id === selected.id) ?? null;
          setSelected(s);
        }
      } catch (e) {
        console.error(e);
        setError("API unreachable. Showing last known data.");
        
      }
    }



  async function loadEvents(storeId: string) {
      try {
        const res = await fetch(`${API_BASE}/stores/${storeId}/events`);
        if (!res.ok) throw new Error(`events fetch failed: ${res.status}`);
        setEvents(await res.json());
        setError(null);
      } catch (e) {
        console.error(e);
        setError("Failed to load events. Showing last known events.");
        // ✅ do NOT setEvents([])
      }
    }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selected) loadEvents(selected.id);
    else setEvents([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const statusBadge = (s: string) => {
    if (s === "Ready") return <span className="badge badgeReady">Ready</span>;
    if (s === "Provisioning") return <span className="badge badgeProvisioning">Provisioning</span>;
    if (s === "Deleting") return <span className="badge badgeDeleting">Deleting</span>;
    return <span className="badge badgeOther">{s}</span>;
  };



  async function createStore() {
      if (creating) return;
      setCreating(true);

      setLoading(true);
      try {
        const res = await fetch(`${API_BASE}/stores`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ engine: "woocommerce" }),
        });

        if (!res.ok) throw new Error(`createStore failed: ${res.status}`);

        await refresh();
      } finally {
        setLoading(false);
        setTimeout(() => setCreating(false), 2000);
      }
    }



  async function deleteStore(id: string) {
      setStores((prev) => prev.filter((s) => s.id !== id));
      if (selected?.id === id) setSelected(null);

      try {
        const res = await fetch(`${API_BASE}/stores/${id}`, { method: "DELETE" });
        if (!res.ok) {
          const msg = await res.text().catch(() => "");
          console.error("Delete failed", res.status, msg);
          await refresh();
          alert(`Delete failed: ${res.status}`);
          return;
        }
        await refresh();
      } catch (e) {
        console.error(e);
        await refresh();
        alert("Delete failed: network error");
      }
    }


  const selectedUrl = useMemo(() => selected?.url ?? "", [selected?.url]);

  return (
    <div className="app">
      <div className="grid">
      {error && (
        <div
          style={{
            background: "#FEF3C7",
            border: "1px solid #F59E0B",
            color: "#111827",
            padding: 10,
            borderRadius: 10,
            marginBottom: 12,
          }}
        >
          {error}
        </div>
      )}
      <div className="card">
        <div className="headerRow">
          <h2 className="sectionTitle">Stores</h2>
          <button disabled={loading || creating} onClick={createStore}>
            + Create WooCommerce Store
          </button>
        </div>

        <div className="mt12">
          {stores.filter((s) => s.status !== "Deleting").map((s) => (
            <div
              key={s.id}
              onClick={() => setSelected(s)}
              className={`storeItem ${selected?.id === s.id ? "storeItemSelected" : ""}`}
              style={{ background: "white", color: "#111827" }}
            >

              <div className="headerRow">
                <div className="storeMeta">
                  <div className="bold">store-{s.id}</div>
                  <div className="muted createdAt">{s.created_at}</div>
                </div>
                <div>{statusBadge(s.status)}</div>
              </div>

              <div className="details">
                <div>
                  <b>Namespace:</b> {s.namespace}
                </div>
                <div>
                  <b>Engine:</b> {s.engine}
                </div>

                {s.url && (
                  <div>
                    <b>URL:</b>{" "}
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.url}
                    </a>
                  </div>
                )}

                {s.last_error && (
                  <div className="error">
                    <b>Error:</b> {s.last_error}
                  </div>
                )}
              </div>

              <div className="actions">
                <button
                  disabled={loading}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteStore(s.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}

          {stores.length === 0 && <div className="muted">No stores yet.</div>}
          {stores.filter((s) => s.status !== "Deleting").length === 0 && (
            <div className="muted">No stores yet.</div>
          )}
        </div>
      </div>

      <div className="card">
        <h2 className="sectionTitle">Activity</h2>

        {!selected && <div className="muted mt12">Select a store to view events.</div>}

        {selected && (
          <>
            <div className="selectedInfo">
              <div>
                <b>Store:</b> store-{selected.id}
              </div>

              {selectedUrl && (
                <div>
                  <b>Open:</b>{" "}
                  <a href={selectedUrl} target="_blank" rel="noreferrer">
                    {selectedUrl}
                  </a>
                </div>
              )}
            </div>

            <div className="eventsList">
              {events.map((ev) => (
                <div key={ev.id} className="eventRow">
                  <div className="eventTop">
                    <span className="bold">{ev.type}</span>
                    <span className="muted">{ev.ts}</span>
                  </div>

                  {ev.message && <div className="eventMsg">{ev.message}</div>}
                </div>
              ))}

              {events.length === 0 && <div className="muted">No events yet.</div>}
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
