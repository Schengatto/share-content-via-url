export const NIGHT = "#0e0f0d";
export const AMBER = "#e8b44a";

export function LockMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <path d="M11 14.5V11a5 5 0 0 1 10 0v3.5" fill="none" stroke={AMBER} strokeWidth="2.6" strokeLinecap="round" />
      <rect x="7.5" y="14.5" width="17" height="12" rx="2.5" fill={AMBER} />
      <circle cx="16" cy="19.6" r="1.7" fill={NIGHT} />
      <rect x="15.2" y="20.4" width="1.6" height="3.3" rx="0.8" fill={NIGHT} />
    </svg>
  );
}
