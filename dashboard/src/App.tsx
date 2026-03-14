import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

type Store = {
  id: string;
  name?: string | null;
  engine: string;
  status: string;
  namespace: string;
  url?: string | null;
  custom_domain?: string | null;
  domain_status?: string | null;
  last_backup_at?: string | null;
  created_at: string;
  last_error?: string | null;
  owner_name?: string | null;
  owner_email?: string | null;
};

type EventRow = {
  id: number;
  store_id: string;
  ts: string;
  type: string;
  message?: string | null;
};

type AuthUser = {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
};

type AuthResponse = {
  token: string;
  user: AuthUser;
};

type StoreSummary = {
  id: string;
  name?: string | null;
  status: string;
  namespace: string;
  url?: string | null;
  customDomain?: string | null;
  domainStatus?: string | null;
  domainLastError?: string | null;
  lastBackupAt?: string | null;
  wordpressUsername: string;
  wordpressPassword: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
};

type DomainInfo = {
  customDomain?: string | null;
  domainStatus: string;
  domainLastError?: string | null;
  targetHost: string;
  currentUrl: string;
};

type MonitoringSummary = {
  healthy: boolean;
  checkedAt: string;
  deployments: Array<{
    name: string;
    replicas: number;
    readyReplicas: number;
    availableReplicas: number;
  }>;
  pods: Array<{
    name: string;
    phase: string;
    readyContainers: number;
    totalContainers: number;
    restarts: number;
  }>;
  services: Array<{ name: string; type: string; ports: number[] }>;
  persistentVolumeClaims: Array<{ name: string; phase: string; storage: string | null }>;
  ingresses: Array<{ name: string; hosts: string[] }>;
};

type BackupRow = {
  id: number;
  status: string;
  file_name?: string | null;
  size_bytes?: number | null;
  error?: string | null;
  started_at: string;
  completed_at?: string | null;
};

type BillingAccount = {
  provider: string;
  plan_key: string;
  status: string;
  billing_email?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  stripe_checkout_session_id?: string | null;
  stripe_price_id?: string | null;
  current_period_end?: string | null;
};

type BillingInvoice = {
  id: number;
  external_id?: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  hosted_url?: string | null;
  invoice_pdf?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  created_at: string;
};

type BillingSummary = {
  configured: boolean;
  provider: string;
  planLabel: string;
  priceId?: string | null;
  account?: BillingAccount | null;
  usage: {
    totalStores: number;
    activeStores: number;
    readyStores: number;
    failedStores: number;
  };
  invoices: BillingInvoice[];
};

type QuickAction = {
  label: string;
  href: string;
};

const POLL_INTERVAL_MS = 10_000;
const SESSION_STORAGE_KEY = "store-platform-session";

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
  const { protocol, hostname } = window.location;
  if (!hostname.startsWith("dashboard.")) return null;
  return `${protocol}//api.${hostname.slice("dashboard.".length)}`;
}

function withPath(base: string, route: string) {
  if (base === "/api") return `${base}${route}`;
  return `${base.replace(/\/$/, "")}${route}`;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

function formatDate(value: string | null | undefined) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatCurrency(amountCents: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(amountCents / 100);
}

function formatBytes(value?: number | null) {
  if (!value || value <= 0) return "--";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function defaultStoreNameFor(user: AuthUser | null) {
  if (!user) return "";
  const firstName = user.name.trim().split(/\s+/)[0] ?? "My";
  return `${firstName}'s Store`;
}

function buildQuickActions(storeUrl: string | null | undefined): QuickAction[] {
  const normalizedUrl = storeUrl?.trim();
  if (!normalizedUrl) return [];
  const root = normalizedUrl.replace(/\/$/, "");
  const adminRoot = `${root}/wp-admin`;
  return [
    { label: "Storefront", href: root },
    { label: "Admin", href: adminRoot },
    { label: "Orders", href: `${adminRoot}/admin.php?page=wc-orders` },
    { label: "Products", href: `${adminRoot}/edit.php?post_type=product` },
    { label: "Add Product", href: `${adminRoot}/post-new.php?post_type=product` },
    { label: "Customers", href: `${adminRoot}/admin.php?page=wc-admin&path=%2Fcustomers` },
    { label: "Analytics", href: `${adminRoot}/admin.php?page=wc-admin&path=%2Fanalytics%2Foverview` },
    { label: "Settings", href: `${adminRoot}/admin.php?page=wc-settings` },
  ];
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
  const [authMode, setAuthMode] = useState<"signup" | "login">("signup");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);

  const [stores, setStores] = useState<Store[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [summary, setSummary] = useState<StoreSummary | null>(null);
  const [domainInfo, setDomainInfo] = useState<DomainInfo | null>(null);
  const [monitoring, setMonitoring] = useState<MonitoringSummary | null>(null);
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [billing, setBilling] = useState<BillingSummary | null>(null);

  const [createName, setCreateName] = useState("");
  const [renameName, setRenameName] = useState("");
  const [domainName, setDomainName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [savingDomain, setSavingDomain] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [loadingStores, setLoadingStores] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);

  const selected = useMemo(() => stores.find((store) => store.id === selectedId) ?? null, [stores, selectedId]);
  const quickActions = useMemo(() => buildQuickActions(summary?.url ?? selected?.url ?? null), [selected?.url, summary?.url]);
  const adminMode = currentUser?.role === "admin";
  const roleExplanation = adminMode
    ? "Admin means platform operator. You can see every store, owner, and tenant status across the system."
    : "You are in member mode. You can see and manage only the stores owned by your account.";
  const billingStateLabel = billing?.configured
    ? billing?.account?.status ?? "ready"
    : "needs setup";

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

  const updateSessionToken = useCallback((token: string) => {
    writeStoredSession(token);
    setSessionToken(token);
  }, []);

  const clearWorkspace = useCallback(() => {
    setStores([]);
    setSelectedId(null);
    setEvents([]);
    setSummary(null);
    setDomainInfo(null);
    setMonitoring(null);
    setBackups([]);
    setBilling(null);
    setCopiedField(null);
  }, []);

  const handleSessionExpired = useCallback(() => {
    updateSessionToken("");
    setCurrentUser(null);
    setAuthReady(true);
    setAuthMode("login");
    setAuthError("Your session expired. Sign in again.");
    clearWorkspace();
  }, [clearWorkspace, updateSessionToken]);

  const apiRequest = useCallback(
    async (route: string, init?: RequestInit, options?: { omitSession?: boolean }) => {
      const attempts = [apiBase, ...apiCandidates.filter((candidate) => candidate !== apiBase)];
      let lastError: unknown;

      for (const candidate of attempts) {
        try {
          const headers = new Headers(init?.headers ?? undefined);
          if (sessionToken && !options?.omitSession && !headers.has("authorization")) {
            headers.set("authorization", `Bearer ${sessionToken}`);
          }
          const response = await fetchWithTimeout(withPath(candidate, route), { ...init, headers });
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
    [apiBase, apiCandidates, sessionToken]
  );

  const loadStores = useCallback(async () => {
    if (!currentUser) {
      clearWorkspace();
      return;
    }
    setLoadingStores(true);
    try {
      const res = await apiRequest("/stores");
      if (res.status === 401) return handleSessionExpired();
      if (!res.ok) throw new Error(`stores fetch failed: ${res.status}`);
      const data = ((await res.json()) as Store[]).filter((store) => store.status !== "Deleting");
      setStores(data);
      setLastSyncAt(new Date());
      setError(null);
      setNotice(null);
      if (selectedId && !data.some((store) => store.id === selectedId)) setSelectedId(null);
    } catch (err) {
      console.error(err);
      setError(`API unreachable. Current target: ${apiBase}`);
    } finally {
      setLoadingStores(false);
    }
  }, [apiBase, apiRequest, clearWorkspace, currentUser, handleSessionExpired, selectedId]);

  const loadBilling = useCallback(async () => {
    if (!currentUser) return;
    try {
      const res = await apiRequest("/billing/summary");
      if (res.status === 401) return handleSessionExpired();
      if (!res.ok) throw new Error(`billing fetch failed: ${res.status}`);
      setBilling((await res.json()) as BillingSummary);
    } catch (err) {
      console.error(err);
      setError("Billing summary could not be loaded.");
    }
  }, [apiRequest, currentUser, handleSessionExpired]);

  const loadWorkspace = useCallback(async () => {
    if (!selected) {
      setEvents([]);
      setSummary(null);
      setDomainInfo(null);
      setMonitoring(null);
      setBackups([]);
      return;
    }

    try {
      const [eventsRes, summaryRes, domainRes, monitoringRes, backupsRes] = await Promise.all([
        apiRequest(`/stores/${selected.id}/events`),
        apiRequest(`/stores/${selected.id}/summary`),
        apiRequest(`/stores/${selected.id}/domain`),
        apiRequest(`/stores/${selected.id}/monitoring`),
        apiRequest(`/stores/${selected.id}/backups`),
      ]);

      if ([eventsRes, summaryRes, domainRes, monitoringRes, backupsRes].some((res) => res.status === 401)) {
        handleSessionExpired();
        return;
      }

      setEvents(eventsRes.ok ? ((await eventsRes.json()) as EventRow[]) : []);
      setSummary(summaryRes.ok ? ((await summaryRes.json()) as StoreSummary) : null);
      setDomainInfo(domainRes.ok ? ((await domainRes.json()) as DomainInfo) : null);
      setMonitoring(monitoringRes.ok ? ((await monitoringRes.json()) as MonitoringSummary) : null);
      setBackups(backupsRes.ok ? ((await backupsRes.json()) as BackupRow[]) : []);
    } catch (err) {
      console.error(err);
      setError("Store workspace data could not be loaded.");
    }
  }, [apiRequest, handleSessionExpired, selected]);

  useEffect(() => {
    let cancelled = false;
    async function bootstrapAuth() {
      if (!sessionToken) {
        if (!cancelled) {
          setAuthReady(true);
          setCurrentUser(null);
          clearWorkspace();
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
        setCreateName((current) => current || defaultStoreNameFor(data.user));
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
  }, [apiRequest, clearWorkspace, handleSessionExpired, sessionToken, updateSessionToken]);

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

  useEffect(() => {
    if (!authReady || !currentUser) return;
    void loadStores();
    void loadBilling();
    const timer = setInterval(() => {
      void loadStores();
      void loadBilling();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [authReady, currentUser, loadBilling, loadStores]);

  useEffect(() => {
    setRenameName(selected?.name?.trim() ?? "");
    setDomainName(selected?.custom_domain?.trim() ?? "");
    void loadWorkspace();
  }, [loadWorkspace, selected]);

  useEffect(() => {
    if (!currentUser || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("billing");
    const sessionId = params.get("session_id");
    if (status === "cancelled") {
      setNotice("Stripe checkout was cancelled.");
      params.delete("billing");
      window.history.replaceState({}, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}`);
      return;
    }
    if (status !== "success" || !sessionId) return;
    const confirmedSessionId = sessionId;

    let cancelled = false;
    async function confirmBilling() {
      try {
        const res = await apiRequest(`/billing/confirm?session_id=${encodeURIComponent(confirmedSessionId)}`);
        if (res.status === 401) return handleSessionExpired();
        if (!res.ok) throw new Error(`billing confirm failed: ${res.status}`);
        const payload = (await res.json()) as { account?: BillingAccount; invoices?: BillingInvoice[] };
        if (cancelled) return;
        setBilling((current) =>
          current
            ? { ...current, account: payload.account ?? current.account ?? null, invoices: payload.invoices ?? current.invoices }
            : current
        );
        setNotice("Billing is active. Stripe checkout completed successfully.");
      } catch (err) {
        console.error(err);
        if (!cancelled) setError("Stripe checkout completed, but billing confirmation failed.");
      } finally {
        params.delete("billing");
        params.delete("session_id");
        window.history.replaceState({}, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}`);
      }
    }
    void confirmBilling();
    return () => {
      cancelled = true;
    };
  }, [apiRequest, currentUser, handleSessionExpired]);

  async function submitAuth() {
    if (authSubmitting) return;
    setAuthSubmitting(true);
    try {
      const endpoint = authMode === "signup" ? "/auth/signup" : "/auth/login";
      const payload =
        authMode === "signup"
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
      const body = (await res.json().catch(() => null)) as AuthResponse | { error?: string } | null;
      if (!res.ok) {
        if (res.status === 409) throw new Error("That email is already in use.");
        if (res.status === 401) throw new Error("Invalid email or password.");
        throw new Error(body && "error" in body && body.error ? body.error : "Authentication failed.");
      }
      const data = body as AuthResponse;
      updateSessionToken(data.token);
      setCurrentUser(data.user);
      setCreateName(defaultStoreNameFor(data.user));
      setAuthReady(true);
      setAuthError(null);
      setNotice(null);
      setError(null);
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
    setCreateName("");
    setNotice(null);
    clearWorkspace();
  }

  async function createStore() {
    if (!createName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await apiRequest("/stores", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: createName.trim(), engine: "woocommerce" }),
      });
      const body = (await res.json().catch(() => null)) as { id?: string; error?: string; max_stores?: number } | null;
      if (res.status === 401) return handleSessionExpired();
      if (!res.ok) {
        if (res.status === 429 && body?.error === "max_stores_reached") {
          throw new Error(`Max stores reached (${body.max_stores ?? "limit"}).`);
        }
        throw new Error(body?.error ?? `Create failed (${res.status}).`);
      }
      setNotice("Store provisioning started.");
      setCreateName(defaultStoreNameFor(currentUser));
      await loadStores();
      if (body?.id) setSelectedId(body.id);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Store creation failed.");
    } finally {
      setCreating(false);
    }
  }

  async function renameStore() {
    if (!selected || !renameName.trim() || renaming) return;
    setRenaming(true);
    try {
      const res = await apiRequest(`/stores/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: renameName.trim() }),
      });
      const body = (await res.json().catch(() => null)) as { name?: string; error?: string } | null;
      if (res.status === 401) return handleSessionExpired();
      if (!res.ok) throw new Error(body?.error ?? `Rename failed (${res.status}).`);
      setNotice("Store name updated.");
      setStores((current) => current.map((store) => (store.id === selected.id ? { ...store, name: body?.name ?? renameName.trim() } : store)));
      await loadWorkspace();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Store rename failed.");
    } finally {
      setRenaming(false);
    }
  }

  async function saveDomain() {
    if (!selected || !domainName.trim() || savingDomain) return;
    setSavingDomain(true);
    try {
      const res = await apiRequest(`/stores/${selected.id}/domain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: domainName.trim() }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.status === 401) return handleSessionExpired();
      if (!res.ok) throw new Error(body?.error ?? `Domain update failed (${res.status}).`);
      setNotice("Custom domain saved. Reconciliation is updating the ingress.");
      await loadStores();
      await loadWorkspace();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Custom domain update failed.");
    } finally {
      setSavingDomain(false);
    }
  }

  async function clearDomain() {
    if (!selected || savingDomain) return;
    setSavingDomain(true);
    try {
      const res = await apiRequest(`/stores/${selected.id}/domain`, { method: "DELETE" });
      if (res.status === 401) return handleSessionExpired();
      if (!res.ok) throw new Error(`Domain reset failed (${res.status}).`);
      setDomainName("");
      setNotice("Custom domain removed. The platform hostname is active again.");
      await loadStores();
      await loadWorkspace();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Custom domain reset failed.");
    } finally {
      setSavingDomain(false);
    }
  }

  async function startBackup() {
    if (!selected || backingUp) return;
    setBackingUp(true);
    try {
      const res = await apiRequest(`/stores/${selected.id}/backups`, { method: "POST" });
      if (res.status === 401) return handleSessionExpired();
      if (!res.ok) throw new Error(`Backup failed (${res.status}).`);
      setNotice("Backup completed and added to the backup list.");
      await loadWorkspace();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Backup failed.");
    } finally {
      setBackingUp(false);
    }
  }

  async function downloadBackup(backupId: number) {
    if (!selected) return;
    try {
      const res = await apiRequest(`/stores/${selected.id}/backups/${backupId}/download`);
      if (res.status === 401) return handleSessionExpired();
      if (!res.ok) throw new Error(`Backup download failed (${res.status}).`);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `backup-${selected.id}-${backupId}.sql.gz`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Backup download failed.");
    }
  }

  async function startCheckout() {
    if (billingBusy) return;
    setBillingBusy(true);
    try {
      const res = await apiRequest("/billing/checkout-session", { method: "POST" });
      if (res.status === 401) return handleSessionExpired();
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) throw new Error(body?.error ?? "Stripe checkout could not be started.");
      window.location.href = body.url;
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Stripe checkout could not be started.");
      setBillingBusy(false);
    }
  }

  async function openBillingPortal() {
    if (billingBusy) return;
    setBillingBusy(true);
    try {
      const res = await apiRequest("/billing/portal", { method: "POST" });
      if (res.status === 401) return handleSessionExpired();
      const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (!res.ok || !body?.url) throw new Error(body?.error ?? "Stripe billing portal is not ready yet.");
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Stripe billing portal is not ready yet.");
    } finally {
      setBillingBusy(false);
    }
  }

  async function deleteStore(id: string) {
    try {
      const res = await apiRequest(`/stores/${id}`, { method: "DELETE" });
      if (res.status === 401) return handleSessionExpired();
      if (!res.ok) throw new Error(`Delete failed (${res.status}).`);
      setNotice("Store deletion requested.");
      await loadStores();
      if (selectedId === id) setSelectedId(null);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Store deletion failed.");
    }
  }

  async function copyText(label: string, value: string | null | undefined) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(label);
      window.setTimeout(() => setCopiedField((current) => (current === label ? null : current)), 1400);
    } catch {
      setCopiedField(null);
    }
  }

  const statusBadge = (status: string) => (
    <span className={`statusBadge status${status.replace(/\s+/g, "")}`}>{status}</span>
  );

  if (!authReady) {
    return (
      <div className="shell shellCentered">
        <div className="authCard">
          <p className="eyebrow">Store Platform</p>
          <h1>Loading workspace</h1>
          <p className="lede">Restoring your account and checking the platform connection.</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="shell shellCentered">
        <section className="authLayout">
          <article className="authCard authStory">
            <div className="authBrand">
              <div className="authBrandMark">S</div>
              <div>
                <p className="eyebrow">Store SaaS Workspace</p>
                <h1>Run the entire store platform from one place.</h1>
              </div>
            </div>
            <p className="lede">
              Sign in to provision WooCommerce stores, manage billing, attach custom domains, review monitoring, and
              create backups without leaving the workspace.
            </p>
            <div className="guideMeta">
              <div>
                <span>Provisioning</span>
                <strong>Namespace, Helm, and WooCommerce</strong>
              </div>
              <div>
                <span>Role model</span>
                <strong>Members and platform admins</strong>
              </div>
            </div>
            <ul className="featureList">
              <li>Account-scoped store ownership and login</li>
              <li>Stripe billing for the SaaS account</li>
              <li>Custom domains, backups, and Kubernetes health views</li>
            </ul>
          </article>

          <article className="authCard authFormCard">
            <div className="authTabs authTabsWide">
              <button className={`tab ${authMode === "signup" ? "tabActive" : ""}`} onClick={() => setAuthMode("signup")}>
                Sign up
              </button>
              <button className={`tab ${authMode === "login" ? "tabActive" : ""}`} onClick={() => setAuthMode("login")}>
                Log in
              </button>
            </div>

            <div className="authHeading">
              <h2>{authMode === "signup" ? "Create your workspace account" : "Welcome back"}</h2>
              <p className="subtle">
                {authMode === "signup"
                  ? "Start with account ownership first. Stores, billing, and operations attach to this identity."
                  : "Use your account to access your stores and workspace settings."}
              </p>
            </div>

            <div className="fieldStack">
              {authMode === "signup" && (
                <label className="floatingField">
                  <input
                    placeholder=" "
                    value={authForm.name}
                    onChange={(e) => setAuthForm((current) => ({ ...current, name: e.target.value }))}
                  />
                  <span>Full name</span>
                </label>
              )}
              <label className="floatingField">
                <input
                  type="email"
                  placeholder=" "
                  value={authForm.email}
                  onChange={(e) => setAuthForm((current) => ({ ...current, email: e.target.value }))}
                />
                <span>Email address</span>
              </label>
              <label className="floatingField">
                <input
                  type="password"
                  placeholder=" "
                  value={authForm.password}
                  onChange={(e) => setAuthForm((current) => ({ ...current, password: e.target.value }))}
                />
                <span>Password</span>
              </label>
              <button className="btn btnPrimary btnWide" onClick={submitAuth} disabled={authSubmitting}>
                {authSubmitting ? "Working..." : authMode === "signup" ? "Create account" : "Sign in"}
              </button>
              {authError && <p className="message messageError">{authError}</p>}
              {apiReachable === false && <p className="message messageWarn">API is currently unreachable at {apiBase}.</p>}
              <p className="authFootnote">
                {authMode === "signup" ? "Already have an account?" : "Need a new workspace?"}{" "}
                <button className="inlineLink" onClick={() => setAuthMode(authMode === "signup" ? "login" : "signup")}>
                  {authMode === "signup" ? "Log in" : "Create one"}
                </button>
              </p>
            </div>
          </article>
        </section>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="topbar topbarHero">
        <div className="topbarAura" aria-hidden="true">
          <span className="topbarAuraPulse" />
          <span className="topbarAuraWave" />
          <span className="topbarAuraRing" />
        </div>
        <div className="topbarLead">
          <p className="eyebrow">Store SaaS Workspace</p>
          <h1>{adminMode ? "Admin control plane" : `Welcome back, ${currentUser.name}.`}</h1>
          <p className="lede">{roleExplanation}</p>
        </div>
        <div className="topbarMetaWrap">
          <div className="topbarMeta">
            <span className={`pill ${apiReachable === false ? "pillOffline" : "pillOnline"}`}>
              {apiReachable === null ? "API checking" : apiReachable ? "API online" : "API offline"}
            </span>
            <span className="pill pillRole">{currentUser.role}</span>
            <span className="pill">{currentUser.email}</span>
          </div>
          <button className="btn btnSecondary" onClick={logout}>
            Logout
          </button>
        </div>
      </header>

      {(notice || error) && (
        <section className={`banner ${error ? "bannerError" : "bannerInfo"}`}>
          <p>{error ?? notice}</p>
        </section>
      )}

      <section className="overviewGrid">
        <article className="card createCard featureCard">
          <div className="cardHeader">
            <div>
              <p className="eyebrow">Launch store</p>
              <h2>Name the business, not the namespace.</h2>
            </div>
            {currentUser.role === "admin" && <span className="pill pillRole">Admin sees all stores</span>}
          </div>
          <div className="inlineForm">
            <label className="field">
              <span>Store name</span>
              <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="Dashify Commerce" />
            </label>
            <button className="btn btnPrimary" onClick={createStore} disabled={creating}>
              {creating ? "Provisioning..." : "Create store"}
            </button>
          </div>
          <div className="guideMeta guideMetaCompact">
            <div>
              <span>Provisioner</span>
              <strong>Namespace + Helm + WooCommerce</strong>
            </div>
            <div>
              <span>When ready</span>
              <strong>Admin links appear automatically</strong>
            </div>
          </div>
        </article>

        <article className="card billingCard featureCard">
          <div className="cardHeader">
            <div>
              <p className="eyebrow">Billing</p>
              <h2>{billing?.planLabel ?? "Growth"} on Stripe</h2>
            </div>
            <span className="pill">{billingStateLabel}</span>
          </div>
          <div className={`billingCallout ${billing?.configured ? "billingCalloutReady" : "billingCalloutMuted"}`}>
            <strong>{billing?.configured ? "Stripe is configured for this workspace." : "Stripe is not configured yet."}</strong>
            <p>
              {billing?.configured
                ? "Use checkout to start a subscription, then use the portal for payment method and invoice management."
                : "The UI is ready, but the API still needs Stripe env values before checkout can open."}
            </p>
          </div>
          <div className="billingStats">
            <div>
              <span>Active stores</span>
              <strong>{billing?.usage.activeStores ?? counts.ready + counts.provisioning}</strong>
            </div>
            <div>
              <span>Ready stores</span>
              <strong>{billing?.usage.readyStores ?? counts.ready}</strong>
            </div>
            <div>
              <span>Failed stores</span>
              <strong>{billing?.usage.failedStores ?? counts.failed}</strong>
            </div>
          </div>
          <div className="buttonRow">
            <button className="btn btnPrimary" onClick={startCheckout} disabled={billingBusy || !billing?.configured}>
              Start Stripe checkout
            </button>
            <button className="btn btnSecondary" onClick={openBillingPortal} disabled={billingBusy}>
              Open portal
            </button>
          </div>
          {!billing?.configured && (
            <p className="subtle">
              Add `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` to the repo `.env.local`, then rerun `ops/resume.ps1`.
            </p>
          )}
        </article>
      </section>

      <section className="statsRow">
        <article className="statCard">
          <span>{adminMode ? "Visible stores" : "Your stores"}</span>
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
          <span>Connected API</span>
          <strong>{apiBase}</strong>
        </article>
        <article className="statCard statWide">
          <span>Last sync</span>
          <strong>{lastSyncAt ? lastSyncAt.toLocaleTimeString() : "--"}</strong>
        </article>
      </section>

      <main className="workspaceLayout">
        <section className="card storeListCard panelCard">
          <div className="cardHeader">
            <div>
              <p className="eyebrow">Stores</p>
              <h2>{adminMode ? "All stores" : "Your stores"}</h2>
            </div>
            <span className="subtle">{loadingStores ? "Refreshing..." : `${stores.length} listed`}</span>
          </div>

          {stores.length === 0 && <div className="emptyState">No stores yet. Create one from the launch panel above.</div>}

          <div className="storeList">
            {stores.map((store) => (
              <article
                key={store.id}
                className={`storeCard ${selectedId === store.id ? "storeCardActive" : ""}`}
                onClick={() => setSelectedId(store.id)}
              >
                <div className="storeHeader">
                  <div>
                    <h3>{store.name?.trim() || `Store ${store.id}`}</h3>
                    <p>
                      {store.id} - {formatDate(store.created_at)}
                    </p>
                  </div>
                  {statusBadge(store.status)}
                </div>
                <div className="detailGrid">
                  <div>
                    <span>Namespace</span>
                    <strong>{store.namespace}</strong>
                  </div>
                  <div>
                    <span>Domain</span>
                    <strong>{(store.custom_domain?.trim() || store.url) ?? "--"}</strong>
                  </div>
                  {adminMode && (
                    <div>
                      <span>Owner</span>
                      <strong>{store.owner_email ?? "--"}</strong>
                    </div>
                  )}
                </div>
                {store.last_error && <p className="inlineError">{store.last_error}</p>}
                <div className="buttonRow">
                  {store.url && (
                    <>
                      <a className="btn btnSecondary" href={store.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        Open store
                      </a>
                      <a
                        className="btn btnSecondary"
                        href={`${store.url.replace(/\/$/, "")}/wp-admin`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Admin
                      </a>
                    </>
                  )}
                  <button
                    className="btn btnDanger"
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
          </div>
        </section>

        <section className="detailColumn">
          <article className="card panelCard accountCard">
            <div className="cardHeader">
              <div>
                <p className="eyebrow">Account billing</p>
                <h2>Invoices and subscription state</h2>
              </div>
            </div>
            {billing?.invoices?.length ? (
              <div className="invoiceList">
                {billing.invoices.map((invoice) => (
                  <article key={invoice.id} className="invoiceRow">
                    <div>
                      <strong>{formatCurrency(invoice.amount_cents, invoice.currency)}</strong>
                      <p>{invoice.status}</p>
                    </div>
                    <div className="invoiceLinks">
                      <span>{formatDate(invoice.created_at)}</span>
                      {invoice.hosted_url && (
                        <a href={invoice.hosted_url} target="_blank" rel="noreferrer">
                          View
                        </a>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="emptyState">No invoices yet. Start Stripe checkout to activate billing.</div>
            )}
          </article>

          <article className="card panelCard selectedStoreCard">
            <div className="cardHeader">
              <div>
                <p className="eyebrow">Selected store</p>
                <h2>{selected ? selected.name?.trim() || `Store ${selected.id}` : "Choose a store"}</h2>
              </div>
            </div>

              {!selected && (
                <div className="emptyState">
                  Select a store to manage domains, backups, monitoring, and WooCommerce access. The normal flow is:
                  create store, wait for `Ready`, then open the workspace tools below.
                </div>
              )}

            {selected && (
              <>
                <div className="detailGrid summaryGrid">
                  <div>
                    <span>Namespace</span>
                    <strong>{selected.namespace}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong>{selected.status}</strong>
                  </div>
                  <div>
                    <span>Owner</span>
                    <strong>{summary?.ownerEmail ?? selected.owner_email ?? currentUser.email}</strong>
                  </div>
                  <div>
                    <span>URL</span>
                    <strong>{summary?.url ?? selected.url ?? "--"}</strong>
                  </div>
                </div>

                <div className="inlineForm compactForm">
                  <label className="field">
                    <span>Store name</span>
                    <input value={renameName} onChange={(e) => setRenameName(e.target.value)} />
                  </label>
                  <button className="btn btnSecondary" onClick={renameStore} disabled={renaming}>
                    {renaming ? "Saving..." : "Save name"}
                  </button>
                </div>

                <div className="twoUp">
                  <article className="subCard">
                    <div className="cardHeader">
                      <div>
                        <p className="eyebrow">Custom domain</p>
                        <h3>Bring your own DNS</h3>
                      </div>
                      <span className="pill">{domainInfo?.domainStatus ?? summary?.domainStatus ?? "Platform subdomain"}</span>
                    </div>
                    <p className="subtle">Point a CNAME from your domain to the platform hostname.</p>
                    <div className="fieldStack">
                      <label className="field">
                        <span>Target hostname</span>
                        <input value={domainInfo?.targetHost ?? `store-${selected.id}.domain`} disabled />
                      </label>
                      <label className="field">
                        <span>Custom domain</span>
                        <input value={domainName} onChange={(e) => setDomainName(e.target.value)} placeholder="shop.example.com" />
                      </label>
                    </div>
                    <div className="buttonRow">
                      <button className="btn btnPrimary" onClick={saveDomain} disabled={savingDomain}>
                        {savingDomain ? "Saving..." : "Save domain"}
                      </button>
                      <button className="btn btnSecondary" onClick={clearDomain} disabled={savingDomain}>
                        Remove
                      </button>
                    </div>
                    {(domainInfo?.domainLastError || summary?.domainLastError) && (
                      <p className="inlineError">{domainInfo?.domainLastError ?? summary?.domainLastError}</p>
                    )}
                  </article>

                  <article className="subCard">
                    <div className="cardHeader">
                      <div>
                        <p className="eyebrow">Monitoring</p>
                        <h3>Kubernetes health</h3>
                      </div>
                      <span className={`pill ${monitoring?.healthy ? "pillOnline" : "pillOffline"}`}>
                        {monitoring?.healthy ? "Healthy" : "Needs attention"}
                      </span>
                    </div>
                    <div className="detailGrid">
                      <div>
                        <span>Deployments</span>
                        <strong>{monitoring?.deployments.length ?? 0}</strong>
                      </div>
                      <div>
                        <span>Pods</span>
                        <strong>{monitoring?.pods.length ?? 0}</strong>
                      </div>
                      <div>
                        <span>PVCs</span>
                        <strong>{monitoring?.persistentVolumeClaims.length ?? 0}</strong>
                      </div>
                      <div>
                        <span>Last check</span>
                        <strong>{formatDate(monitoring?.checkedAt)}</strong>
                      </div>
                    </div>
                    <div className="microList">
                      {(monitoring?.pods ?? []).slice(0, 3).map((pod) => (
                        <div key={pod.name} className="microRow">
                          <span>{pod.name}</span>
                          <strong>
                            {pod.phase} - {pod.restarts} restarts
                          </strong>
                        </div>
                      ))}
                    </div>
                  </article>
                </div>

                <article className="subCard">
                  <div className="cardHeader">
                    <div>
                      <p className="eyebrow">Backups</p>
                      <h3>On-demand MariaDB dumps</h3>
                    </div>
                    <button className="btn btnPrimary" onClick={startBackup} disabled={backingUp}>
                      {backingUp ? "Backing up..." : "Create backup"}
                    </button>
                  </div>
                  {backups.length === 0 ? (
                    <div className="emptyState">No backups yet.</div>
                  ) : (
                    <div className="backupList">
                      {backups.map((backup) => (
                        <article key={backup.id} className="backupRow">
                          <div>
                            <strong>{backup.file_name ?? `Backup ${backup.id}`}</strong>
                            <p>
                              {backup.status} - {formatBytes(backup.size_bytes)} - {formatDate(backup.completed_at ?? backup.started_at)}
                            </p>
                            {backup.error && <p className="inlineError">{backup.error}</p>}
                          </div>
                          <button className="btn btnSecondary" onClick={() => void downloadBackup(backup.id)} disabled={backup.status !== "Completed"}>
                            Download
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </article>

                <article className="subCard">
                  <div className="cardHeader">
                    <div>
                      <p className="eyebrow">WooCommerce</p>
                      <h3>Admin console and credentials</h3>
                    </div>
                  </div>
                  <div className="buttonRow wrapRow">
                    {quickActions.map((action) => (
                      <a key={action.label} className="btn btnSecondary" href={action.href} target="_blank" rel="noreferrer">
                        {action.label}
                      </a>
                    ))}
                  </div>
                  <div className="detailGrid summaryGrid">
                    <div>
                      <span>Username</span>
                      <strong>{summary?.wordpressUsername ?? "admin"}</strong>
                    </div>
                    <div>
                      <span>Password</span>
                      <strong>{summary?.wordpressPassword ?? "Unavailable"}</strong>
                    </div>
                  </div>
                  <div className="buttonRow">
                    <button className="btn btnSecondary" onClick={() => void copyText("username", summary?.wordpressUsername)}>
                      {copiedField === "username" ? "Copied" : "Copy username"}
                    </button>
                    <button className="btn btnSecondary" onClick={() => void copyText("password", summary?.wordpressPassword)}>
                      {copiedField === "password" ? "Copied" : "Copy password"}
                    </button>
                  </div>
                </article>

                <article className="subCard">
                  <div className="cardHeader">
                    <div>
                      <p className="eyebrow">Timeline</p>
                      <h3>Lifecycle events</h3>
                    </div>
                  </div>
                  <div className="timeline">
                    {events.length === 0 && <div className="emptyState">No events yet.</div>}
                    {events.map((event) => (
                      <article key={event.id} className="timelineItem">
                        <div className="timelineTop">
                          <strong>{event.type}</strong>
                          <span>{formatDate(event.ts)}</span>
                        </div>
                        {event.message && <p>{event.message}</p>}
                      </article>
                    ))}
                  </div>
                </article>
              </>
            )}
          </article>
        </section>
      </main>
    </div>
  );
}
