import { createHmac, randomBytes } from "node:crypto";

// OAuth 1.0a one-legged signing, as WooCommerce checks it for REST calls over plain HTTP
// (WC_REST_Authentication::check_oauth_signature). Basic auth is rejected without HTTPS (SYSTEM.md G2).

// Same as PHP rawurlencode: encodeURIComponent leaves !'()* unescaped, RFC 3986 does not.
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignatureInput {
  method: string;
  // scheme://host[:port]/path exactly as WooCommerce rebuilds it, without the query string.
  baseUrl: string;
  // Every query parameter plus the oauth_* parameters, excluding oauth_signature.
  params: Record<string, string>;
  consumerSecret: string;
}

export function signature({ method, baseUrl, params, consumerSecret }: SignatureInput): string {
  // Sort by key, encode key and value, then encode "key=value" again and join with an encoded "&".
  const pairs = Object.keys(params)
    .sort()
    .map((key) => rfc3986(`${rfc3986(key)}=${rfc3986(params[key])}`));
  const stringToSign = `${method.toUpperCase()}&${rfc3986(baseUrl)}&${pairs.join("%26")}`;
  return createHmac("sha256", `${consumerSecret}&`).update(stringToSign).digest("base64");
}

export interface SignRequestInput {
  method: string;
  baseUrl: string;
  query: Record<string, string>;
  consumerKey: string;
  consumerSecret: string;
  // Injectable for tests; WooCommerce rejects timestamps more than 15 minutes off and reused nonces.
  timestamp?: number;
  nonce?: string;
}

// Returns the full query string parameters to send: the caller's query plus oauth_* and the signature.
export function signRequest(input: SignRequestInput): Record<string, string> {
  const params: Record<string, string> = {
    ...input.query,
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
  };
  const oauth_signature = signature({
    method: input.method,
    baseUrl: input.baseUrl,
    params,
    consumerSecret: input.consumerSecret,
  });
  return { ...params, oauth_signature };
}
