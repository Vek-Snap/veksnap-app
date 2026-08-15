/**
 * Centralized UI class tokens for all studio panels.
 * Change a value here → every panel updates instantly.
 * All classes use Tailwind semantic tokens (bg-muted, text-foreground, etc.)
 * which resolve to CSS variables in globals.css, so switching themes
 * only requires editing globals.css, never touching component files.
 */

// ── Form inputs ──
export const inputBase =
  "w-full bg-muted border border-border rounded px-2 py-1.5 text-xs text-foreground placeholder-muted-foreground/50 focus:outline-none focus:border-primary/50";

export const inputSmall =
  "w-full bg-muted border border-border rounded px-2 py-1 text-xs text-foreground";

export const inputMono =
  "w-full bg-muted border border-border rounded px-1.5 py-1 text-xs text-foreground text-center font-mono focus:outline-none focus:border-primary/50";

export const selectBase =
  "w-full bg-muted border border-border rounded px-2 py-1 text-xs text-foreground";

export const textareaBase =
  "w-full bg-muted border border-border rounded px-2 py-1.5 text-xs text-foreground placeholder-muted-foreground/50 resize-none focus:outline-none focus:border-primary/50";

// ── Labels ──
export const labelMuted =
  "text-[10px] text-muted-foreground";

export const labelSmall =
  "text-[9px] text-muted-foreground";

export const hintText =
  "text-[8px] text-muted-foreground/70";

// ── Buttons / tags ──
export const presetBtn =
  "text-[9px] text-muted-foreground hover:text-foreground bg-muted/60 hover:bg-muted px-1.5 py-0.5 rounded transition-colors";

export const toggleInactive =
  "text-muted-foreground hover:text-foreground border border-border";

export const toggleActive = (color: string) =>
  `bg-${color}-500/30 text-${color}-300 border border-${color}-500/50`;

// ── Progress bars ──
export const progressTrack =
  "w-full h-1.5 bg-muted rounded-full overflow-hidden";

// ── Containers ──
export const infoFooter =
  "text-[9px] text-muted-foreground/70 space-y-0.5 pt-1 border-t border-border/50";

// ── Upload / action buttons ──
export const uploadBtn =
  "flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer bg-muted/60 border border-border rounded px-2 py-1";

// ── Misc ──
export const advancedToggle =
  "flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-muted-foreground transition-colors";

export const resetBtn =
  "h-9 text-xs text-muted-foreground";
