import { describe, expect, it } from "vitest";
import { rfc3986, signRequest, signature } from "../src/oauth1";

// Expected signatures were produced by WooCommerce 11.2's own algorithm (wc_rest_urlencode_rfc3986,
// normalize_parameters, join_with_equals_sign, check_oauth_signature) run with PHP 8.3 in the store pod.
const oauth = {
  oauth_consumer_key: "ck_test",
  oauth_nonce: "abc123",
  oauth_signature_method: "HMAC-SHA256",
  oauth_timestamp: "1760000000",
};

describe("OAuth 1.0a signer (WooCommerce over HTTP)", () => {
  it("encodes like PHP rawurlencode", () => {
    expect(rfc3986("a b!*'()~ü+&=")).toBe("a%20b%21%2A%27%28%29~%C3%BC%2B%26%3D");
  });

  it("matches WooCommerce for a GET with awkward query characters", () => {
    const sig = signature({
      method: "GET",
      baseUrl: "http://store.127.0.0.1.nip.io:8088/wp-json/wc/v3/products",
      params: { ...oauth, per_page: "5", search: "tee & mug!*'()~ ü+" },
      consumerSecret: "cs_secret",
    });
    expect(sig).toBe("SA6Or1RX+PivQsMcvVpdT9lV9+JSh+IObsskzx3HnLg=");
  });

  it("matches WooCommerce for a PUT with only oauth params (JSON body is not signed)", () => {
    const sig = signature({
      method: "put",
      baseUrl: "http://store.127.0.0.1.nip.io:8088/wp-json/wc/v3/orders/42",
      params: oauth,
      consumerSecret: "cs_secret",
    });
    expect(sig).toBe("kc7hh8M8sQZXwBqzOX3hRtX23fyBgZec2cekOpvmgNo=");
  });

  it("signRequest adds the oauth params and a signature, and keeps the query", () => {
    const params = signRequest({
      method: "GET",
      baseUrl: "http://store.127.0.0.1.nip.io:8088/wp-json/wc/v3/products",
      query: { per_page: "5", search: "tee & mug!*'()~ ü+" },
      consumerKey: "ck_test",
      consumerSecret: "cs_secret",
      timestamp: 1760000000,
      nonce: "abc123",
    });
    expect(params).toMatchObject({ per_page: "5", oauth_consumer_key: "ck_test", oauth_signature_method: "HMAC-SHA256" });
    expect(params.oauth_signature).toBe("SA6Or1RX+PivQsMcvVpdT9lV9+JSh+IObsskzx3HnLg=");
  });

  it("uses a fresh nonce per request", () => {
    const input = { method: "GET", baseUrl: "http://x/wp-json/wc/v3/orders", query: {}, consumerKey: "ck_a", consumerSecret: "cs_b" };
    expect(signRequest(input).oauth_nonce).not.toBe(signRequest(input).oauth_nonce);
  });
});
