// Clip effects registry: the single source of truth for VEK-Snap's effect pack.
//
// Each effect is authored in-house (no third-party preset files), so it carries:
//  - param metadata (sliders) for the Inspector,
//  - a CSS approximation for the live preview,
//  - an ffmpeg filter fragment for the burned-in export.
// This module is framework-agnostic (no React) so the export route can import it too.

export type EffectType = "glitch" | "chroma" | "bw" | "blur" | "vignette" | "eq" | "sharpen";

export interface ClipEffect {
  id: string;
  type: EffectType;
  enabled: boolean;
  params: Record<string, number>;
}

export interface EffectParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export interface EffectDef {
  type: EffectType;
  label: string;
  params: EffectParamDef[];
  /** CSS `filter` fragment(s) for the live preview (may be empty). */
  cssFilter: (p: Record<string, number>) => string;
  /** Vignette strength 0..1 for the preview overlay (0 = none). */
  cssVignette?: (p: Record<string, number>) => number;
  /** A single ffmpeg filter fragment for the export filtergraph. */
  ffmpeg: (p: Record<string, number>) => string;
}

const f2 = (n: number): string => Number(n).toFixed(3);

export const EFFECTS: Record<EffectType, EffectDef> = {
  glitch: {
    type: "glitch",
    label: "Glitch (datamosh)",
    params: [
      { key: "amount", label: "Displace", min: 2, max: 120, step: 1, default: 40, unit: "px" },
      { key: "frequency", label: "Frequency", min: 1, max: 30, step: 1, default: 14, unit: "hz" },
      { key: "burst", label: "Burst", min: 1, max: 100, step: 1, default: 45, unit: "%" },
      { key: "block", label: "Block Size", min: 8, max: 240, step: 2, default: 72, unit: "px" },
      { key: "split", label: "RGB Split", min: 0, max: 32, step: 1, default: 7, unit: "px" },
    ],
    // CSS cannot do per-block spatial displacement; the live preview only hints at the
    // RGB-split fringe. The true blocky datamosh look is produced by the ffmpeg geq path
    // (burned-in export + the paused single-frame preview route).
    cssFilter: (p) => {
      const a = Math.max(2, p.split ?? 7);
      return `saturate(1.25) drop-shadow(${a}px 0 0 rgba(255,0,40,0.45)) drop-shadow(${-a}px 0 0 rgba(0,200,255,0.45))`;
    },
    // Datamosh-style digital glitch: the frame is diced into blocks (Block Size); each
    // block is displaced in X and Y by a per-block, per-time-bucket pseudo-random amount,
    // gated by Burst so only some blocks tear at any instant, and the sampled colour is
    // RGB-split (R/B fetched from opposite horizontal offsets) for the chromatic fringe.
    // This mimics the block-tiling + slice-shear + channel-split glitch look.
    ffmpeg: (p) => {
      const maxoff = Math.round(p.amount ?? 40);
      const voff = Math.round((p.amount ?? 40) / 2);
      const rate = Math.max(1, Math.round(p.frequency ?? 14));
      const prob = Math.min(1, Math.max(0.01, (p.burst ?? 45) / 100));
      const thr = (1 - prob).toFixed(3);
      const bs = Math.max(4, Math.round(p.block ?? 72));
      const cs = Math.round(p.split ?? 7);
      const tb = `floor(T*${rate})`;
      const bx = `floor(X/${bs})`;
      const by = `floor(Y/${bs})`;
      // frac(sin(bx*a+by*b+bucket*c+seed)*m) → per-block, per-time pseudo-random [0,1).
      const rnd = (a: number, b: number, c: number, seed: number) => {
        const e = `sin(${bx}*${a}+${by}*${b}+${tb}*${c}+${seed})*43758.5453`;
        return `(${e}-floor(${e}))`;
      };
      const gate = `gt(${rnd(93.989, 47.331, 24.117, 5.7)},${thr})`;
      const dx = `(${maxoff}*(${rnd(12.9898, 78.233, 37.719, 1.3)}*2-1)*${gate})`;
      const dy = `(${voff}*(${rnd(39.346, 11.135, 83.155, 9.1)}*2-1)*${gate})`;
      const sy = `clip(Y+${dy},0,H-1)`;
      const sx = (extra: string) => `clip(X+${dx}${extra},0,W-1)`;
      // geq needs planar RGB; the single quotes protect the commas at BOTH the
      // graph level and the option level, so no backslash escaping is needed.
      return (
        `format=gbrp,geq=` +
        `r='r(${sx(`+${cs}`)},${sy})':` +
        `g='g(${sx("")},${sy})':` +
        `b='b(${sx(`-${cs}`)},${sy})'`
      );
    },
  },
  chroma: {
    type: "chroma",
    label: "Chromatic Aberration",
    params: [{ key: "amount", label: "Amount", min: 0, max: 24, step: 1, default: 8, unit: "px" }],
    cssFilter: (p) => {
      const a = p.amount ?? 8;
      return `saturate(1.25) drop-shadow(${a}px 0 0 rgba(255,0,40,0.45)) drop-shadow(${-a}px 0 0 rgba(0,200,255,0.45))`;
    },
    // Static RGB channel split: the steady chromatic-aberration look.
    ffmpeg: (p) => {
      const a = Math.round(p.amount ?? 8);
      return `rgbashift=rh=${a}:bh=${-a}:gv=${Math.round(a / 2)}`;
    },
  },
  bw: {
    type: "bw",
    label: "Black & White",
    params: [{ key: "intensity", label: "Amount", min: 0, max: 100, step: 1, default: 100, unit: "%" }],
    cssFilter: (p) => `grayscale(${(p.intensity ?? 100) / 100})`,
    ffmpeg: (p) => `hue=s=${f2(1 - (p.intensity ?? 100) / 100)}`,
  },
  blur: {
    type: "blur",
    label: "Gaussian Blur",
    params: [{ key: "radius", label: "Radius", min: 0, max: 30, step: 1, default: 6 }],
    cssFilter: (p) => `blur(${((p.radius ?? 6) / 3).toFixed(2)}px)`,
    ffmpeg: (p) => `gblur=sigma=${f2(p.radius ?? 6)}`,
  },
  vignette: {
    type: "vignette",
    label: "Vignette",
    params: [{ key: "amount", label: "Amount", min: 0, max: 100, step: 1, default: 60, unit: "%" }],
    cssFilter: () => "",
    cssVignette: (p) => (p.amount ?? 60) / 100,
    // angle in radians: stronger as amount grows (default look ≈ PI/5 ≈ 0.63).
    ffmpeg: (p) => `vignette=a=${f2(0.2 + ((p.amount ?? 60) / 100) * 1.1)}`,
  },
  eq: {
    type: "eq",
    label: "Brightness / Contrast",
    params: [
      { key: "brightness", label: "Bright", min: -100, max: 100, step: 1, default: 0 },
      { key: "contrast", label: "Contrast", min: 0, max: 200, step: 1, default: 100, unit: "%" },
      { key: "saturation", label: "Sat", min: 0, max: 200, step: 1, default: 100, unit: "%" },
    ],
    cssFilter: (p) =>
      `brightness(${(1 + (p.brightness ?? 0) / 100).toFixed(2)}) contrast(${((p.contrast ?? 100) / 100).toFixed(2)}) saturate(${((p.saturation ?? 100) / 100).toFixed(2)})`,
    ffmpeg: (p) =>
      `eq=brightness=${f2((p.brightness ?? 0) / 100)}:contrast=${f2((p.contrast ?? 100) / 100)}:saturation=${f2((p.saturation ?? 100) / 100)}`,
  },
  sharpen: {
    type: "sharpen",
    label: "Sharpen",
    params: [{ key: "amount", label: "Amount", min: 0, max: 200, step: 1, default: 100, unit: "%" }],
    // CSS can't sharpen; a touch of contrast hints at it in preview.
    cssFilter: (p) => `contrast(${(1 + (p.amount ?? 100) / 400).toFixed(2)})`,
    ffmpeg: (p) => `unsharp=5:5:${f2((p.amount ?? 100) / 100)}:5:5:0`,
  },
};

export const EFFECT_ORDER: EffectType[] = ["glitch", "chroma", "bw", "blur", "vignette", "eq", "sharpen"];

/** Default param map for a freshly added effect. */
export function defaultParams(type: EffectType): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of EFFECTS[type].params) out[def.key] = def.default;
  return out;
}

/** Combined CSS `filter` string for a clip's enabled effects (live preview). */
export function effectsCssFilter(effects: ClipEffect[] | undefined): string {
  if (!effects?.length) return "";
  return effects
    .filter((e) => e.enabled)
    .map((e) => EFFECTS[e.type].cssFilter(e.params))
    .filter(Boolean)
    .join(" ");
}

/** Strongest vignette amount (0..1) among a clip's enabled effects, for the overlay. */
export function effectsVignette(effects: ClipEffect[] | undefined): number {
  if (!effects?.length) return 0;
  return effects
    .filter((e) => e.enabled)
    .reduce((max, e) => Math.max(max, EFFECTS[e.type].cssVignette?.(e.params) ?? 0), 0);
}

/** ffmpeg filter fragments (comma-joinable) for a clip's enabled effects. */
export function effectsFfmpeg(effects: ClipEffect[] | undefined): string[] {
  if (!effects?.length) return [];
  return effects.filter((e) => e.enabled).map((e) => EFFECTS[e.type].ffmpeg(e.params));
}
