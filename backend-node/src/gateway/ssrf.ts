import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

// SSRF guard for admin-registered upstream URLs (DESIGN §8.4). An admin (or a stolen admin session)
// must not be able to point the gateway at cloud metadata, the Kubernetes API, or loopback.
// Checked twice: when a URL is saved (early, readable feedback) and on every TCP connect (the
// real enforcement, which also defeats DNS rebinding: a name that resolved to a public IP at save
// time but points at 169.254.169.254 later).

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export interface SsrfPolicy {
  // Private addresses are allowed only for hostnames matching one of these globs ("*" = one DNS label part).
  internalHosts: string[];
  // Extra addresses that are always refused (the Kubernetes API Service IP).
  deniedIps: string[];
}

export function ssrfPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SsrfPolicy {
  const hosts = (env.GATEWAY_INTERNAL_HOST_ALLOWLIST ?? "*.mcp-servers.svc.cluster.local,*.store-*.svc.cluster.local")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return { internalHosts: hosts, deniedIps: env.KUBERNETES_SERVICE_HOST ? [env.KUBERNETES_SERVICE_HOST] : [] };
}

const blocked = new net.BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this network"
blocked.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. cloud metadata 169.254.169.254
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + broadcast
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast
blocked.addAddress("fd00:ec2::254", "ipv6"); // AWS metadata over IPv6

const privateRanges = new net.BlockList();
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
privateRanges.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT, used by some CNIs
privateRanges.addSubnet("fc00::", 7, "ipv6"); // unique local

const ALLOWED_PORTS = (port: number) => port === 80 || port === 443 || (port >= 3000 && port <= 9999);

export type AddressClass = "blocked" | "private" | "public";

export function classifyAddress(ip: string): AddressClass {
  // ::ffff:127.0.0.1 is IPv4 loopback in IPv6 clothing.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? mapped[1] : ip;
  const family = net.isIPv4(addr) ? "ipv4" : net.isIPv6(addr) ? "ipv6" : null;
  if (!family) return "blocked";
  if (blocked.check(addr, family)) return "blocked";
  if (privateRanges.check(addr, family)) return "private";
  return "public";
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[a-z0-9-]+");
  return new RegExp(`^${body}$`);
}

export function isInternalHost(hostname: string, policy: SsrfPolicy): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return policy.internalHosts.some((glob) => globToRegExp(glob).test(host));
}

// Checks that need no network: scheme, embedded credentials, port.
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError(`Gateway SSRF guard: '${raw}' is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Gateway SSRF guard: scheme '${url.protocol}' is not allowed, use http or https`);
  }
  if (url.username || url.password) {
    throw new SsrfError("Gateway SSRF guard: credentials in the URL are not allowed; use the credential field");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS(port)) {
    throw new SsrfError(`Gateway SSRF guard: port ${port} is not allowed (80, 443, 3000-9999)`);
  }
  return url;
}

export function checkAddress(hostname: string, ip: string, policy: SsrfPolicy): void {
  if (policy.deniedIps.includes(ip)) {
    throw new SsrfError(`Gateway SSRF guard: ${hostname} resolves to ${ip}, the Kubernetes API, which is not allowed`);
  }
  const cls = classifyAddress(ip);
  if (cls === "blocked") {
    throw new SsrfError(`Gateway SSRF guard: ${hostname} resolves to ${ip} (loopback, link-local, metadata or reserved), which is not allowed`);
  }
  if (cls === "private" && !isInternalHost(hostname, policy)) {
    throw new SsrfError(
      `Gateway SSRF guard: ${hostname} resolves to private address ${ip}; private targets must use an allowed in-cluster name (${policy.internalHosts.join(", ")})`,
    );
  }
}

type LookupAll = (hostname: string) => Promise<{ address: string; family: number }[]>;
const systemLookupAll: LookupAll = (hostname) => dns.promises.lookup(hostname, { all: true });

// Save-time check. A name that doesn't resolve yet is accepted (the upstream may not be deployed
// yet); the connect-time check still applies and the health checker will report it Unreachable.
export async function checkUpstreamUrl(raw: string, policy: SsrfPolicy, lookupAll: LookupAll = systemLookupAll): Promise<URL> {
  const url = checkUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    checkAddress(host, host, policy);
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookupAll(host);
  } catch {
    return url;
  }
  for (const a of addresses) checkAddress(host, a.address, policy);
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

// Drop-in for dns.lookup inside the HTTP client: every address of every connection is checked.
export function guardedLookup(policy: SsrfPolicy, lookupAll: LookupAll = systemLookupAll) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    lookupAll(hostname).then(
      (addresses) => {
        try {
          for (const a of addresses) checkAddress(hostname, a.address, policy);
        } catch (err) {
          callback(err as SsrfError, "");
          return;
        }
        // Node's connect asks for every address (all: true) when it races IPv4/IPv6; honour both forms.
        if (options.all) callback(null, addresses as dns.LookupAddress[]);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err, ""),
    );
  };
}

// fetch for upstream MCP traffic: URL checks, address checks on every connect, no redirects.
export function createGuardedFetch(policy: SsrfPolicy, lookupAll: LookupAll = systemLookupAll) {
  const agent = new Agent({ connect: { lookup: guardedLookup(policy, lookupAll) } });
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = checkUrl(String(input));
    // Connecting to a literal IP skips DNS, so the lookup hook never runs for it: check it here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) checkAddress(host, host, policy);
    const res = await undiciFetch(input, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      // A redirect could send the request (and the injected credential) to an unchecked host.
      redirect: "manual",
      dispatcher: agent,
    });
    return res as unknown as Response;
  };
}
