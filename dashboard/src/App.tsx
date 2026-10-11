import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import "./gateway.css";
import type { Api, ApiOptions, AuthUser } from "./lib/api";
import { AuditPage } from "./pages/Audit";
import { ChatPage } from "./pages/Chat";
import { ConnectPage } from "./pages/Connect";
import { KeysPage } from "./pages/Keys";
import { MembersPage } from "./pages/Members";
import { ServersPage } from "./pages/Servers";
import { StoresPage } from "./pages/Stores";

type AuthResponse = {
  token: string;
  user: AuthUser;
};

type PlatformConfig = {
  features?: { legacySaas?: boolean };
  gateway?: { url?: string };
};

type Page = "servers" | "chat" | "keys" | "audit" | "members" | "stores" | "connect";

// Navigation order follows DESIGN §7.6. Members is admin-only (the API enforces it as well).
const PAGES: Array<{ id: Page; label: string; adminOnly?: boolean }> = [
  { id: "servers", label: "Servers" },
  { id: "chat", label: "Chat" },
  { id: "keys", label: "API keys" },
  { id: "audit", label: "Audit" },
  { id: "members", label: "Members", adminOnly: true },
  { id: "stores", label: "Stores" },
  { id: "connect", label: "Connect" },
];

const SESSION_STORAGE_KEY = "store-platform-session";
const DEFAULT_TIMEOUT_MS = 10_000;

function unique(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function deriveApiHostFromLocation() {
  if (typeof window === "undefined") return null;
  const { protocol, hostname, port } = window.location;
  if (!hostname.startsWith("dashboard.")) return null;
  return `${protocol}//api.${hostname.slice("dashboard.".length)}${port ? `:${port}` : ""}`;
}

// "/api" is the same-origin prefix: the Vite dev proxy and the dashboard's nginx both strip it
// before forwarding to platform-api, whose own routes may also start with /api (/api/servers).
function withPath(base: string, route: string) {
  if (base === "/api") return `${base}${route}`;
  return `${base.replace(/\/$/, "")}${route}`;
}

async function fetchWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Let the caller cancel too (the chat's Stop button), for the whole streamed body.
  init?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function readStoredSession() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "";
}

function writeStoredSession(token: string) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(SESSION_STORAGE_KEY, token);
  else window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

function pageFromHash(): Page {
  const id = window.location.hash.replace(/^#\/?/, "");
  return PAGES.some((p) => p.id === id) ? (id as Page) : "servers";
}

function readInviteToken() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("invite") ?? "";
}

function clearInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  params.delete("invite");
  window.history.replaceState({}, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`);
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
      ]),
    [configuredApiBase]
  );

  const [apiBase, setApiBase] = useState<string>(() => apiCandidates[0] ?? "http://127.0.0.1:8080");
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const [sessionToken, setSessionToken] = useState<string>(() => readStoredSession());
  const [authReady, setAuthReady] = useState(false);
  const [inviteToken, setInviteToken] = useState(() => readInviteToken());
  const [authMode, setAuthMode] = useState<"signup" | "login">(() => (readStoredSession() ? "login" : "signup"));
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [config, setConfig] = useState<PlatformConfig>({});
  const [page, setPage] = useState<Page>(() => pageFromHash());

  // Billing, custom domains and backups are frozen behind FEATURE_LEGACY_SAAS on the API.
  const legacySaas = Boolean(config.features?.legacySaas);
  const gatewayUrl = useMemo(() => {
    if (config.gateway?.url) return config.gateway.url;
    const base = apiBase.startsWith("http") ? apiBase : `${window.location.origin}${apiBase}`;
    return `${base.replace(/\/$/, "")}/mcp`;
  }, [apiBase, config.gateway?.url]);

  const updateSessionToken = useCallback((token: string) => {
    writeStoredSession(token);
    setSessionToken(token);
  }, []);

  const handleSessionExpired = useCallback(() => {
    updateSessionToken("");
    setCurrentUser(null);
    setAuthReady(true);
    setAuthMode("login");
    setAuthError("Your session expired. Sign in again.");
  }, [updateSessionToken]);

  const apiRequest = useCallback(
    async (route: string, init?: RequestInit, options?: ApiOptions) => {
      const attempts = [apiBase, ...apiCandidates.filter((candidate) => candidate !== apiBase)];
      let lastError: unknown;

      for (const candidate of attempts) {
        try {
          const headers = new Headers(init?.headers ?? undefined);
          if (sessionToken && !options?.omitSession && !headers.has("authorization")) {
            headers.set("authorization", `Bearer ${sessionToken}`);
          }
          const response = await fetchWithTimeout(withPath(candidate, route), { ...init, headers }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
          if (candidate !== apiBase) setApiBase(candidate);
          setApiReachable(true);
          return response;
        } catch (err) {
          // A cancelled request is not a reason to try the next API address.
          if (init?.signal?.aborted) throw err;
          lastError = err;
        }
      }

      setApiReachable(false);
      throw lastError ?? new Error("api request failed");
    },
    [apiBase, apiCandidates, sessionToken]
  );

  // What pages use: a 401 anywhere means the session is gone, so go back to the login screen.
  const api: Api = useCallback(
    async (route, init, options) => {
      const res = await apiRequest(route, init, options);
      if (res.status === 401 && !options?.omitSession) handleSessionExpired();
      return res;
    },
    [apiRequest, handleSessionExpired]
  );

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadConfig() {
      try {
        const res = await apiRequest("/config", undefined, { omitSession: true });
        if (!res.ok) return;
        const data = (await res.json()) as PlatformConfig;
        if (!cancelled) setConfig(data);
      } catch {
        // Older API without /config: legacy panels stay hidden and the gateway URL is derived.
      }
    }
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, [apiRequest]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrapAuth() {
      if (!sessionToken) {
        if (!cancelled) {
          setAuthReady(true);
          setCurrentUser(null);
        }
        return;
      }
      try {
        const res = await apiRequest("/auth/me");
        if (res.status === 401) {
          if (!cancelled) handleSessionExpired();
          return;
        }
        if (!res.ok) throw new Error(`auth bootstrap failed: ${res.status}`);
        const data = (await res.json()) as { user: AuthUser };
        if (cancelled) return;
        setCurrentUser(data.user);
        setAuthReady(true);
        setAuthError(null);
      } catch (err) {
        console.error(err);
        if (cancelled) return;
        updateSessionToken("");
        setCurrentUser(null);
        setAuthReady(true);
      }
    }
    void bootstrapAuth();
    return () => {
      cancelled = true;
    };
  }, [apiRequest, handleSessionExpired, sessionToken, updateSessionToken]);

  useEffect(() => {
    let cancelled = false;
    async function checkHealth() {
      try {
        const res = await apiRequest("/healthz", undefined, { omitSession: true });
        if (!cancelled) setApiReachable(res.ok);
      } catch {
        if (!cancelled) setApiReachable(false);
      }
    }
    void checkHealth();
    return () => {
      cancelled = true;
    };
  }, [apiRequest]);

  function navigate(next: Page) {
    window.location.hash = `/${next}`;
    setPage(next);
  }

  async function submitAuth() {
    if (authSubmitting) return;
    setAuthSubmitting(true);
    try {
      const accepting = Boolean(inviteToken);
      const endpoint = accepting ? "/auth/accept-invite" : authMode === "signup" ? "/auth/signup" : "/auth/login";
      const payload = accepting
        ? { token: inviteToken, name: authForm.name.trim(), password: authForm.password }
        : authMode === "signup"
          ? { name: authForm.name.trim(), email: authForm.email.trim(), password: authForm.password }
          : { email: authForm.email.trim(), password: authForm.password };
      const res = await apiRequest(
        endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
        { omitSession: true }
      );
      const body = (await res.json().catch(() => null)) as (AuthResponse & { error?: string; message?: string }) | null;
      if (!res.ok) {
        if (body?.message) throw new Error(body.message);
        if (res.status === 409) throw new Error("That email is already in use.");
        if (res.status === 401) throw new Error("Invalid email or password.");
        throw new Error(body?.error ?? "Authentication failed.");
      }
      const data = body as AuthResponse;
      if (accepting) {
        clearInviteFromUrl();
        setInviteToken("");
      }
      updateSessionToken(data.token);
      setCurrentUser(data.user);
      setAuthReady(true);
      setAuthError(null);
    } catch (err) {
      console.error(err);
      setAuthError(err instanceof Error ? err.message : "Authentication failed.");
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function logout() {
    try {
      await apiRequest("/auth/logout", { method: "POST" });
    } catch (err) {
      console.error(err);
    }
    updateSessionToken("");
    setCurrentUser(null);
    setAuthReady(true);
    setAuthMode("login");
  }

  if (!authReady) {
    return (
      <div className="shell shellCentered">
        <div className="authCard">
          <p className="eyebrow">MCP Gateway</p>
          <h1>Loading workspace</h1>
          <p className="lede">Restoring your account and checking the platform connection.</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    const accepting = Boolean(inviteToken);
    return (
      <div className="shell shellCentered">
        <section className="authLayout">
          <article className="authCard authStory">
            <div className="authBrand">
              <div className="authBrandMark">G</div>
              <div>
                <p className="eyebrow">Team MCP Gateway</p>
                <h1>One URL for every tool your team uses.</h1>
              </div>
            </div>
            <p className="lede">
              Admins register MCP servers once. Everyone gets a personal API key, a chat agent that acts as them, and an audit log of every tool call.
            </p>
            <ul className="featureList">
              <li>WooCommerce store, notes and reference servers behind one endpoint</li>
              <li>Per-user hashed API keys with instant revocation</li>
              <li>Admin and member roles, invites, and a full audit trail</li>
            </ul>
          </article>

          <article className="authCard authFormCard">
            {!accepting && (
              <div className="authTabs authTabsWide">
                <button className={`tab ${authMode === "signup" ? "tabActive" : ""}`} onClick={() => setAuthMode("signup")}>
                  Sign up
                </button>
                <button className={`tab ${authMode === "login" ? "tabActive" : ""}`} onClick={() => setAuthMode("login")}>
                  Log in
                </button>
              </div>
            )}

            <div className="authHeading">
              <h2>{accepting ? "Join your team" : authMode === "signup" ? "Create the first account" : "Welcome back"}</h2>
              <p className="subtle">
                {accepting
                  ? "You were invited. Choose your name and a password; your email comes from the invite."
                  : authMode === "signup"
                    ? "The first account becomes the admin. After that, people join through invite links."
                    : "Sign in to manage servers, keys and the audit log."}
              </p>
            </div>

            <form
              className="fieldStack"
              onSubmit={(e) => {
                e.preventDefault();
                void submitAuth();
              }}
            >
              {(accepting || authMode === "signup") && (
                <label className="floatingField">
                  <input
                    placeholder=" "
                    autoComplete="name"
                    value={authForm.name}
                    onChange={(e) => setAuthForm((current) => ({ ...current, name: e.target.value }))}
                  />
                  <span>Full name</span>
                </label>
              )}
              {!accepting && (
                <label className="floatingField">
                  <input
                    type="email"
                    placeholder=" "
                    autoComplete="email"
                    value={authForm.email}
                    onChange={(e) => setAuthForm((current) => ({ ...current, email: e.target.value }))}
                  />
                  <span>Email address</span>
                </label>
              )}
              <label className="floatingField">
                <input
                  type="password"
                  placeholder=" "
                  autoComplete={authMode === "login" && !accepting ? "current-password" : "new-password"}
                  value={authForm.password}
                  onChange={(e) => setAuthForm((current) => ({ ...current, password: e.target.value }))}
                />
                <span>Password (8+ characters)</span>
              </label>
              <button type="submit" className="btn btnPrimary btnWide" disabled={authSubmitting}>
                {authSubmitting ? "Working..." : accepting ? "Accept invite" : authMode === "signup" ? "Create account" : "Sign in"}
              </button>
              {authError && <p className="message messageError">{authError}</p>}
              {apiReachable === false && <p className="message messageWarn">API is currently unreachable at {apiBase}.</p>}
              {accepting && (
                <p className="authFootnote">
                  Already have an account?{" "}
                  <button
                    type="button"
                    className="inlineLink"
                    onClick={() => {
                      clearInviteFromUrl();
                      setInviteToken("");
                      setAuthMode("login");
                    }}
                  >
                    Log in instead
                  </button>
                </p>
              )}
            </form>
          </article>
        </section>
      </div>
    );
  }

  const admin = currentUser.role === "admin";
  const visiblePages = PAGES.filter((p) => !p.adminOnly || admin);
  const activePage = visiblePages.some((p) => p.id === page) ? page : "servers";

  return (
    <div className="shell">
      <header className="appBar">
        <div className="appBrand">
          <div className="authBrandMark appBrandMark">G</div>
          <div>
            <strong>MCP Gateway</strong>
            <span className="subtle">{admin ? "Admin" : "Member"} workspace</span>
          </div>
        </div>
        <nav className="appNav" aria-label="Main">
          {visiblePages.map((p) => (
            <a key={p.id} href={`#/${p.id}`} className={`navLink ${activePage === p.id ? "navLinkActive" : ""}`} aria-current={activePage === p.id ? "page" : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <div className="appUser">
          <span className={`dot ${apiReachable === false ? "dotBad" : "dotGood"}`} title={apiReachable === false ? `API offline (${apiBase})` : `API online (${apiBase})`} />
          <span className="pill pillRole">{currentUser.role}</span>
          <span className="appEmail">{currentUser.email}</span>
          <button className="btn btnSecondary btnSmall" onClick={logout}>
            Logout
          </button>
        </div>
      </header>

      <main className="appMain">
        {activePage === "servers" && <ServersPage api={api} user={currentUser} />}
        {/* Kept mounted so the conversation survives switching pages; it lives only in memory. */}
        <div hidden={activePage !== "chat"}>
          <ChatPage api={api} />
        </div>
        {activePage === "keys" && <KeysPage api={api} user={currentUser} gatewayUrl={gatewayUrl} />}
        {activePage === "audit" && <AuditPage api={api} user={currentUser} />}
        {activePage === "members" && admin && <MembersPage api={api} user={currentUser} />}
        {activePage === "stores" && <StoresPage api={api} currentUser={currentUser} legacySaas={legacySaas} />}
        {activePage === "connect" && <ConnectPage gatewayUrl={gatewayUrl} onOpenKeys={() => navigate("keys")} />}
      </main>
    </div>
  );
}
