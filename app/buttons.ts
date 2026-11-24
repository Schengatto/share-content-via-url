const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2.5 rounded-[10px] font-semibold transition active:translate-y-px disabled:opacity-50";
const REGULAR = `${BUTTON_BASE} min-h-12 px-5 text-[15px]`;
const COMPACT = `${BUTTON_BASE} min-h-10 shrink-0 px-4 text-sm`;

export const PRIMARY_BUTTON = `${REGULAR} bg-amber text-amber-ink hover:brightness-105`;
export const GHOST_BUTTON = `${REGULAR} border border-edge text-ink hover:border-dim`;
export const DANGER_BUTTON = `${REGULAR} border border-edge text-ember hover:border-ember`;
export const LOCKED_BUTTON =
  "inline-flex min-h-12 cursor-not-allowed items-center justify-center rounded-[10px] border border-edge-strong bg-raise px-5 text-[15px] font-semibold text-dim";
export const COMPACT_PRIMARY_BUTTON = `${COMPACT} bg-amber text-amber-ink hover:brightness-105`;
