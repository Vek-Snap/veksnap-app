// Animated title presets: in-house, industry-standard title animations.
//
// Each preset animates one or two text lines IN at the clip's head and OUT at its
// tail. Like effects.ts this module is framework-agnostic so the export route can
// import the same timing/geometry math the live preview uses, keeping them in sync.

export type TitlePreset =
  | "none"
  | "fade"
  | "slideLeft"
  | "slideRight"
  | "slideUp"
  | "twoLineSlide";

export interface TitlePresetDef {
  type: TitlePreset;
  label: string;
  /** Whether this preset uses a second text line. */
  twoLines: boolean;
}

export const TITLE_PRESETS: TitlePresetDef[] = [
  { type: "none", label: "Static", twoLines: false },
  { type: "fade", label: "Fade On", twoLines: false },
  { type: "slideLeft", label: "Slide From Left", twoLines: false },
  { type: "slideRight", label: "Slide From Right", twoLines: false },
  { type: "slideUp", label: "Slide Up", twoLines: false },
  { type: "twoLineSlide", label: "Two-Line Slide", twoLines: true },
];

export const TITLE_PRESET_MAP: Record<TitlePreset, TitlePresetDef> =
  Object.fromEntries(TITLE_PRESETS.map((p) => [p.type, p])) as Record<TitlePreset, TitlePresetDef>;

/** In / out animation lengths (seconds), shared by preview + export. */
export const TITLE_IN = 0.7;
export const TITLE_OUT = 0.5;
/** Horizontal/vertical slide travel in px (preview scale; export scales by frame). */
const SLIDE_X = 140;
const SLIDE_Y = 48;

const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3);
const clamp01 = (p: number): number => Math.max(0, Math.min(1, p));

/** Animation progress 0..1 at a clip-local time (0 at the very edges, 1 while held). */
export function titleProgress(local: number, duration: number): number {
  let p = 1;
  if (local < TITLE_IN) p = local / TITLE_IN;
  else if (local > duration - TITLE_OUT) p = (duration - local) / TITLE_OUT;
  return easeOutCubic(clamp01(p));
}

export interface TitleLineCss {
  transform: string;
  opacity: number;
}

/** CSS transform/opacity for a given preset + line (1 or 2) at progress p (0..1). */
export function titleLineCss(preset: TitlePreset, line: 1 | 2, p: number): TitleLineCss {
  const d = 1 - p; // 1 at the edges, 0 while held
  switch (preset) {
    case "none":
      return { transform: "none", opacity: 1 };
    case "fade":
      return { transform: "none", opacity: p };
    case "slideLeft":
      return { transform: `translateX(${(-d * SLIDE_X).toFixed(1)}px)`, opacity: p };
    case "slideRight":
      return { transform: `translateX(${(d * SLIDE_X).toFixed(1)}px)`, opacity: p };
    case "slideUp":
      return { transform: `translateY(${(d * SLIDE_Y).toFixed(1)}px)`, opacity: p };
    case "twoLineSlide":
      return line === 2
        ? { transform: `translateX(${(d * SLIDE_X).toFixed(1)}px)`, opacity: p }
        : { transform: `translateX(${(-d * SLIDE_X).toFixed(1)}px)`, opacity: p };
  }
}

// ── Export: drawtext filter fragments ──

const f3 = (n: number): string => Number(n).toFixed(3);

export interface TitleDrawtextOpts {
  preset: TitlePreset;
  fontEsc: string;
  textEsc: string;
  text2Esc?: string;
  H: number;
  fontSize: number;
  start: number;
  duration: number;
}

/**
 * Build one or more `drawtext=...` filter bodies (no input/output labels) that
 * reproduce the preset's animation via per-frame x / y / alpha expressions.
 */
export function titleDrawtextFilters(o: TitleDrawtextOpts): string[] {
  const s = o.start;
  const e = o.start + o.duration;
  const si = s + TITLE_IN;
  const eo = e - TITLE_OUT;
  // Linear progress over absolute time t, clamped to 0..1.
  const prog = `clip(if(lt(t,${f3(si)}),(t-${f3(s)})/${TITLE_IN},if(gt(t,${f3(eo)}),(${f3(e)}-t)/${TITLE_OUT},1)),0,1)`;
  const d = `(1-(${prog}))`; // 1 at edges, 0 while held
  const enable = `between(t,${f3(s)},${f3(e)})`;

  const make = (textEsc: string, xExpr: string, yExpr: string, alphaExpr: string): string =>
    `drawtext=fontfile='${o.fontEsc}':text='${textEsc}':fontcolor=white:fontsize=${o.fontSize}` +
    `:x='${xExpr}':y='${yExpr}':alpha='${alphaExpr}':borderw=3:bordercolor=black@0.85:enable='${enable}'`;

  const cx = `(w-text_w)/2`;
  const cy = `(h-text_h)/2`;
  const gap = Math.round(o.fontSize * 0.75);

  switch (o.preset) {
    case "none":
      return [make(o.textEsc, cx, cy, "1")];
    case "fade":
      return [make(o.textEsc, cx, cy, prog)];
    case "slideLeft":
      return [make(o.textEsc, `${cx}-${d}*${SLIDE_X}`, cy, prog)];
    case "slideRight":
      return [make(o.textEsc, `${cx}+${d}*${SLIDE_X}`, cy, prog)];
    case "slideUp":
      return [make(o.textEsc, cx, `${cy}+${d}*${SLIDE_Y}`, prog)];
    case "twoLineSlide": {
      const y1 = `${cy}-${gap}`;
      const y2 = `${cy}+${gap}`;
      const out = [make(o.textEsc, `${cx}-${d}*${SLIDE_X}`, y1, prog)];
      if (o.text2Esc) out.push(make(o.text2Esc, `${cx}+${d}*${SLIDE_X}`, y2, prog));
      return out;
    }
  }
}
