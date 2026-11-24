const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

export const MIN_VIEWS = 1;
export const MAX_VIEWS = 100;
export const DEFAULT_VIEWS = 1;

export const MIN_TTL_SECONDS = SECONDS_PER_HOUR;
export const MAX_TTL_SECONDS = 365 * SECONDS_PER_DAY;
export const DEFAULT_TTL_SECONDS = SECONDS_PER_DAY;

export const LOCK_DURATION_MS = 5 * 60 * 1000;
export const LOCK_DURATION_LABEL = `${LOCK_DURATION_MS / 60_000} minutes`;

export const MIN_PASSWORD_LENGTH = 4;
export const MAX_PASSWORD_LENGTH = 128;

export interface TtlStop {
  seconds: number;
  label: string;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${singular}s`;
}

const HOUR_STOPS: TtlStop[] = Array.from({ length: 24 }, (_, index) => ({
  seconds: (index + 1) * SECONDS_PER_HOUR,
  label: pluralize(index + 1, "hour"),
}));

const DAY_STOPS: TtlStop[] = [2, 3, 4, 5, 6, 7, 14, 30, 60, 90, 180, 365].map((days) => ({
  seconds: days * SECONDS_PER_DAY,
  label: pluralize(days, "day"),
}));

export const TTL_STOPS: TtlStop[] = [...HOUR_STOPS, ...DAY_STOPS];

export const DEFAULT_TTL_STOP_INDEX = TTL_STOPS.findIndex((stop) => stop.seconds === DEFAULT_TTL_SECONDS);

export function isValidViews(views: number): boolean {
  return Number.isInteger(views) && views >= MIN_VIEWS && views <= MAX_VIEWS;
}

export function isValidTtlSeconds(ttlSeconds: number): boolean {
  return Number.isInteger(ttlSeconds) && ttlSeconds >= MIN_TTL_SECONDS && ttlSeconds <= MAX_TTL_SECONDS;
}

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

export function viewsLabel(views: number): string {
  return pluralize(views, "view");
}

export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function tokenFromShareUrl(url: string): string | null {
  const match = /\/s\/([A-Za-z0-9_-]+)\/?$/.exec(url);
  return match ? match[1] : null;
}
