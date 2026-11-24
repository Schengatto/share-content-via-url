import { describe, it, expect } from "vitest";
import {
  DEFAULT_TTL_SECONDS,
  DEFAULT_TTL_STOP_INDEX,
  DEFAULT_VIEWS,
  LOCK_DURATION_LABEL,
  LOCK_DURATION_MS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  TTL_STOPS,
  formatCountdown,
  isValidPassword,
  isValidTtlSeconds,
  isValidViews,
  viewsLabel,
  tokenFromShareUrl,
} from "../lib/share-options";

describe("share limits", () => {
  it("accepts integer views from 1 to 100 only", () => {
    expect([1, 50, 100].every(isValidViews)).toBe(true);
    expect([0, 101, 1.5, Number.NaN].some(isValidViews)).toBe(false);
    expect(isValidViews(DEFAULT_VIEWS)).toBe(true);
  });

  it("accepts an integer lifetime from 1 hour to 365 days only", () => {
    expect(MIN_TTL_SECONDS).toBe(3600);
    expect(MAX_TTL_SECONDS).toBe(31_536_000);
    expect([MIN_TTL_SECONDS, DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS].every(isValidTtlSeconds)).toBe(true);
    expect([MIN_TTL_SECONDS - 1, MAX_TTL_SECONDS + 1, 3600.5].some(isValidTtlSeconds)).toBe(false);
  });

  it("accepts passwords from 8 to 128 characters", () => {
    expect(isValidPassword("x".repeat(8))).toBe(true);
    expect(isValidPassword("x".repeat(128))).toBe(true);
    expect(isValidPassword("x".repeat(7))).toBe(false);
    expect(isValidPassword("x".repeat(129))).toBe(false);
  });

  it("locks for 5 minutes", () => {
    expect(LOCK_DURATION_MS).toBe(300_000);
    expect(LOCK_DURATION_LABEL).toBe("5 minutes");
  });
});

describe("TTL_STOPS", () => {
  it("runs from 1 hour to 365 days in strictly increasing steps", () => {
    expect(TTL_STOPS[0]).toEqual({ seconds: 3600, label: "1 hour" });
    expect(TTL_STOPS.at(-1)).toEqual({ seconds: MAX_TTL_SECONDS, label: "365 days" });
    expect(TTL_STOPS.every((stop, index) => index === 0 || stop.seconds > TTL_STOPS[index - 1].seconds)).toBe(true);
    expect(TTL_STOPS.every((stop) => isValidTtlSeconds(stop.seconds))).toBe(true);
  });

  it("has every hour up to 24, then the day stops", () => {
    expect(TTL_STOPS.slice(0, 24).map((stop) => stop.seconds / 3600)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(TTL_STOPS.slice(24).map((stop) => stop.seconds / 86_400)).toEqual([
      2, 3, 4, 5, 6, 7, 14, 30, 60, 90, 180, 365,
    ]);
  });

  it("defaults to 24 hours", () => {
    expect(TTL_STOPS[DEFAULT_TTL_STOP_INDEX]).toEqual({ seconds: DEFAULT_TTL_SECONDS, label: "24 hours" });
  });
});

describe("viewsLabel", () => {
  it("uses the singular only for one view", () => {
    expect(viewsLabel(1)).toBe("1 view");
    expect(viewsLabel(3)).toBe("3 views");
  });
});

describe("formatCountdown", () => {
  it("formats the remaining time as minutes and seconds, rounding up", () => {
    expect(formatCountdown(LOCK_DURATION_MS)).toBe("05:00");
    expect(formatCountdown(299_001)).toBe("05:00");
    expect(formatCountdown(61_000)).toBe("01:01");
    expect(formatCountdown(1)).toBe("00:01");
  });

  it("never goes below zero", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(-5000)).toBe("00:00");
  });
});

describe("tokenFromShareUrl", () => {
  it("extracts the token from a share URL", () => {
    expect(
      tokenFromShareUrl("https://share-secret.schengatto.com/s/8eXy-OQK_NDJ"),
    ).toBe("8eXy-OQK_NDJ");
  });

  it("returns null for a URL that is not a share link", () => {
    expect(tokenFromShareUrl("https://share-secret.schengatto.com/")).toBeNull();
    expect(tokenFromShareUrl("https://example.com/s/a.b")).toBeNull();
  });
});
