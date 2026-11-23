export const EXPIRY_PRESETS = [
  { id: "none", label: "No time limit", summary: "Never", durationMs: null },
  { id: "1h", label: "1 hour", summary: "in 1 hour", durationMs: 3_600_000 },
  { id: "24h", label: "24 hours", summary: "in 24 hours", durationMs: 86_400_000 },
  { id: "7d", label: "7 days", summary: "in 7 days", durationMs: 604_800_000 },
] as const;

export type ExpiryPresetId = (typeof EXPIRY_PRESETS)[number]["id"];

export const DEFAULT_EXPIRY: ExpiryPresetId = "24h";

export const VIEW_OPTIONS = ["1", "2", "3"] as const;

function presetOf(id: ExpiryPresetId) {
  return EXPIRY_PRESETS.find((preset) => preset.id === id) ?? EXPIRY_PRESETS[0];
}

export function expiresAtFor(id: ExpiryPresetId, now: number): number | null {
  const { durationMs } = presetOf(id);
  return durationMs === null ? null : now + durationMs;
}

export function expirySummary(id: ExpiryPresetId): string {
  return presetOf(id).summary;
}

export function viewsLabel(views: string): string {
  return views === "1" ? "1 view" : `${views} views`;
}

export function tokenFromShareUrl(url: string): string | null {
  const match = /\/s\/([A-Za-z0-9_-]+)\/?$/.exec(url);
  return match ? match[1] : null;
}
