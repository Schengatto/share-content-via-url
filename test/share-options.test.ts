import { describe, it, expect } from "vitest";
import {
  EXPIRY_PRESETS,
  DEFAULT_EXPIRY,
  expiresAtFor,
  expirySummary,
  viewsLabel,
  tokenFromShareUrl,
} from "../lib/share-options";

const NOW = 1_700_000_000_000;

describe("expiresAtFor", () => {
  it("returns null when there is no time limit", () => {
    expect(expiresAtFor("none", NOW)).toBeNull();
  });

  it("adds the preset duration to now", () => {
    expect(expiresAtFor("1h", NOW)).toBe(NOW + 3_600_000);
    expect(expiresAtFor("24h", NOW)).toBe(NOW + 86_400_000);
    expect(expiresAtFor("7d", NOW)).toBe(NOW + 7 * 86_400_000);
  });
});

describe("expirySummary", () => {
  it("describes each preset for the link summary", () => {
    expect(expirySummary("none")).toBe("Never");
    expect(expirySummary("24h")).toBe("in 24 hours");
  });

  it("defaults to a preset that exists", () => {
    expect(EXPIRY_PRESETS.map((preset) => preset.id)).toContain(DEFAULT_EXPIRY);
  });
});

describe("viewsLabel", () => {
  it("uses the singular only for one view", () => {
    expect(viewsLabel("1")).toBe("1 view");
    expect(viewsLabel("3")).toBe("3 views");
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
