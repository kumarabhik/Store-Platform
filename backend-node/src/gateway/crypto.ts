import crypto from "node:crypto";

// Upstream credentials are encrypted at rest (DESIGN §8.3): the SQLite file alone does not reveal them.
// Format: "v1:" + base64(iv[12] | tag[16] | ciphertext). The version prefix allows a future key rotation.

const VERSION = "v1";
const IV_BYTES = 12; // 96-bit IV, the size GCM is designed for
const TAG_BYTES = 16;

export function loadEncKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.GATEWAY_ENC_KEY ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("Gateway crypto: GATEWAY_ENC_KEY must be 32 bytes, base64-encoded (from Secret gateway-enc-key)");
  }
  return key;
}

// `aad` binds the ciphertext to its row (the server id), so a sealed credential copied onto
// another server's row fails to open instead of being used for the wrong upstream.
export function seal(key: Buffer, plaintext: string, aad: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

export function open(key: Buffer, sealed: string, aad: string): string {
  const [version, body] = sealed.split(":", 2);
  if (version !== VERSION || !body) throw new Error("Gateway crypto: unknown credential format");
  const buf = Buffer.from(body, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("Gateway crypto: credential is truncated");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, wrong row, or tampered data. The reason is deliberately not more specific.
    throw new Error("Gateway crypto: credential failed authentication (wrong key or tampered)");
  }
}
