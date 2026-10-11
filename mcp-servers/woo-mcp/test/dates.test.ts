import { describe, expect, it } from "vitest";
import { dayRange, isDay, todayIn } from "../src/dates";

describe("store-timezone dates", () => {
  it("resolves today in the store timezone, not UTC", () => {
    // 20:00 UTC on Oct 9 is already Oct 10 in India (UTC+5:30).
    const now = new Date("2026-10-09T20:00:00Z");
    expect(todayIn("UTC", now)).toBe("2026-10-09");
    expect(todayIn("Asia/Kolkata", now)).toBe("2026-10-10");
  });

  it("builds an exclusive range covering the whole day, across month ends", () => {
    expect(dayRange("2026-10-01")).toEqual({ after: "2026-09-30T23:59:59", before: "2026-10-02T00:00:00" });
    expect(dayRange("2026-12-31")).toEqual({ after: "2026-12-30T23:59:59", before: "2027-01-01T00:00:00" });
  });

  it("validates YYYY-MM-DD", () => {
    expect(isDay("2026-10-09")).toBe(true);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay("today")).toBe(false);
  });
});
