import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEncKey, open, seal } from "../src/gateway/crypto";

const key = crypto.randomBytes(32);

describe("gateway credential encryption (AES-256-GCM)", () => {
  it("round-trips and never stores the plaintext", () => {
    const sealed = seal(key, "woo-mcp-token-123", "server-a");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("woo-mcp-token-123");
    expect(open(key, sealed, "server-a")).toBe("woo-mcp-token-123");
  });

  it("uses a fresh IV each time", () => {
    expect(seal(key, "same", "a")).not.toBe(seal(key, "same", "a"));
  });

  it("refuses a credential moved to another server row", () => {
    const sealed = seal(key, "secret", "server-a");
    expect(() => open(key, sealed, "server-b")).toThrow(/failed authentication/);
  });

  it("refuses the wrong key and tampered data", () => {
    const sealed = seal(key, "secret", "a");
    expect(() => open(crypto.randomBytes(32), sealed, "a")).toThrow(/failed authentication/);
    const raw = Buffer.from(sealed.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => open(key, `v1:${raw.toString("base64")}`, "a")).toThrow(/failed authentication/);
  });

  it("requires a 32-byte base64 key and names the Secret when it is missing", () => {
    expect(loadEncKey({ GATEWAY_ENC_KEY: key.toString("base64") }).equals(key)).toBe(true);
    expect(() => loadEncKey({})).toThrow(/gateway-enc-key/);
    expect(() => loadEncKey({ GATEWAY_ENC_KEY: crypto.randomBytes(16).toString("base64") })).toThrow(/32 bytes/);
  });
});
