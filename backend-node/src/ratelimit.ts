type BucketState = {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterSec: number;
  retryAfterSec: number;
};

type TokenBucketOptions = {
  capacity: number;
  refillPerSec: number;
  ttlMs?: number;
  maxKeys?: number;
  now?: () => number;
};

const CLEANUP_EVERY = 256;

function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function cleanupBuckets(
  buckets: Map<string, BucketState>,
  nowMs: number,
  ttlMs: number,
  maxKeys: number
) {
  for (const [key, value] of buckets.entries()) {
    if (nowMs - value.lastSeenMs > ttlMs) buckets.delete(key);
  }

  if (buckets.size <= maxKeys) return;

  const evict = buckets.size - maxKeys;
  const keysByAge = [...buckets.entries()]
    .sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs)
    .slice(0, evict);

  for (const [key] of keysByAge) buckets.delete(key);
}

export function makeTokenBucket(opts: TokenBucketOptions) {
  assertPositive("capacity", opts.capacity);
  assertPositive("refillPerSec", opts.refillPerSec);

  const capacity = opts.capacity;
  const refillPerSec = opts.refillPerSec;
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
  const maxKeys = opts.maxKeys ?? 50_000;
  const now = opts.now ?? Date.now;

  assertPositive("ttlMs", ttlMs);
  assertPositive("maxKeys", maxKeys);

  const buckets = new Map<string, BucketState>();
  let calls = 0;

  return function allow(key: string): RateLimitDecision {
    const nowMs = now();
    calls += 1;

    if (calls % CLEANUP_EVERY === 0) {
      cleanupBuckets(buckets, nowMs, ttlMs, maxKeys);
    }

    const state = buckets.get(key) ?? {
      tokens: capacity,
      lastRefillMs: nowMs,
      lastSeenMs: nowMs,
    };

    const elapsedSec = Math.max(0, (nowMs - state.lastRefillMs) / 1000);
    state.tokens = Math.min(capacity, state.tokens + elapsedSec * refillPerSec);
    state.lastRefillMs = nowMs;
    state.lastSeenMs = nowMs;

    if (state.tokens < 1) {
      buckets.set(key, state);
      const retryAfterSec = Math.max(1, Math.ceil((1 - state.tokens) / refillPerSec));
      const resetAfterSec = Math.max(0, Math.ceil((capacity - state.tokens) / refillPerSec));
      return {
        allowed: false,
        limit: capacity,
        remaining: 0,
        resetAfterSec,
        retryAfterSec,
      };
    }

    state.tokens -= 1;
    buckets.set(key, state);

    const remaining = Math.max(0, Math.floor(state.tokens));
    const resetAfterSec = Math.max(0, Math.ceil((capacity - state.tokens) / refillPerSec));
    return {
      allowed: true,
      limit: capacity,
      remaining,
      resetAfterSec,
      retryAfterSec: 0,
    };
  };
}
