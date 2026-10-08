import { describe, expect, it } from "vitest";
import { makeTokenBucket } from "../src/ratelimit";

describe("token bucket rate limiter", () => {
  it("allows up to capacity, then rejects with a retry hint", () => {
    let now = 0;
    const allow = makeTokenBucket({ capacity: 2, refillPerSec: 1, now: () => now });
    expect(allow("ip").allowed).toBe(true);
    expect(allow("ip").allowed).toBe(true);
    const third = allow("ip");
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBe(1);
  });

  it("refills over time", () => {
    let now = 0;
    const allow = makeTokenBucket({ capacity: 1, refillPerSec: 1, now: () => now });
    expect(allow("ip").allowed).toBe(true);
    expect(allow("ip").allowed).toBe(false);
    now += 1000;
    expect(allow("ip").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const allow = makeTokenBucket({ capacity: 1, refillPerSec: 1, now: () => 0 });
    expect(allow("a").allowed).toBe(true);
    expect(allow("b").allowed).toBe(true);
    expect(allow("a").allowed).toBe(false);
  });
});
