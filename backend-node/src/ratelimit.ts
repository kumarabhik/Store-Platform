type Bucket = { tokens: number; last: number };

const isLocal =
  process.env.BASE_DOMAIN?.includes("nip.io") ||
  process.env.NODE_ENV !== "production";

export function makeTokenBucket(opts: { capacity: number; refillPerSec: number }) {
  const m = new Map<string, Bucket>();

  return function allow(key: string) {
    if (isLocal) return true;

    const now = Date.now();
    const b = m.get(key) ?? { tokens: opts.capacity, last: now };

    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(opts.capacity, b.tokens + elapsed * opts.refillPerSec);
    b.last = now;

    if (b.tokens < 1) {
      m.set(key, b);
      return false;
    }

    b.tokens -= 1;
    m.set(key, b);
    return true;
  };
}
