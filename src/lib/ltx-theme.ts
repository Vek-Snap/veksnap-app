/**
 * LTX-2 Studio: centralized theme tokens (single source of truth).
 *
 * Every section card in `LTX2Studio.tsx` pulls its surface styling from here,
 * so the entire page can be re-skinned by editing this one file. Class strings
 * MUST be written as complete literals (no runtime interpolation of Tailwind
 * class fragments) so the Tailwind JIT compiler can detect and emit them.
 *
 * Current scheme: "Unified Glass" - one cohesive, gently elevated surface for
 * every card; the section's hue lives in a thin border accent (and the header
 * icon) rather than a full background tint. This reads as a single dark surface
 * while staying in the Catppuccin family, distinct from Continuum's flat
 * per-hue tinted cards.
 *
 * To re-skin the page:
 *   - Change the shared body once via `SURFACE`.
 *   - Change accent intensity by editing the `BORDER` entries (kept per-hue
 *     because Tailwind needs literal class names).
 */

export type LtxHue =
  | "orange"
  | "cyan"
  | "violet"
  | "fuchsia"
  | "rose"
  | "blue"
  | "indigo"
  | "purple"
  | "emerald"
  | "teal"
  | "sky";

// Hue-independent card body. Edit this once to restyle every section card.
const SURFACE = "rounded-xl bg-muted/20 backdrop-blur-sm shadow-sm border";

// Per-hue border accent. Literal strings are required for the Tailwind JIT.
const BORDER: Record<LtxHue, string> = {
  orange: "border-orange-500/15",
  cyan: "border-cyan-500/15",
  violet: "border-violet-500/15",
  fuchsia: "border-fuchsia-500/15",
  rose: "border-rose-500/15",
  blue: "border-blue-500/15",
  indigo: "border-indigo-500/15",
  purple: "border-purple-500/15",
  emerald: "border-emerald-500/15",
  teal: "border-teal-500/15",
  sky: "border-sky-500/15",
};

/** Full surface class string for a section card of the given hue. */
export function ltxCard(hue: LtxHue): string {
  return `${SURFACE} ${BORDER[hue]}`;
}
