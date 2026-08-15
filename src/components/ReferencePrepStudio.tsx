"use client";

/**
 * ReferencePrepStudio: Standalone reference-image preparation tool.
 *
 * Spawned as a fullscreen-capable modal from LTX2Studio's header. Lets the user:
 *   1. Upload any source image (e.g., 5000×8000 fashion plate).
 *   2. Pick a target generation resolution from a dropdown, drives the crop AR.
 *   3. Auto-extract the subject via BRIA RMBG-2.0 (POST /api/preprocess/remove-bg).
 *   4. Composite the subject onto a chosen background color (default #808080 mid-gray).
 *   5. Drag a crop box (locked to target AR) to choose what survives center-crop.
 *   6. Apply basic adjustments (brightness / contrast / saturation).
 *   6b. Refine the matte edge (smooth / feather / contrast / shift edge) and
 *       decontaminate colors to kill the colored fringe RMBG leaves on edges.
 *   7. Download the processed PNG, or save it directly into ComfyUI input/.
 *
 * No workflow integration yet: this is purely a prep utility per the user's spec.
 * Per FUTURE_FEATURES.md item #4, this is the foundation for a future "Reference
 * Image Preprocessor" that auto-fires before V2V Inpaint reference uploads.
 *
 * Notes:
 *   - The crop box is stored in *source-image pixel coords* so resolution changes
 *     don't shift the user's selection.
 *   - The output is downsized to 2× the target long edge (e.g. 2560 px for 1280×720
 *     targets) per the lanczos-sweet-spot guidance in the manual.
 *   - Adjustments use canvas .filter, which is bakeable into the final PNG.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  X, Maximize2, Minimize2, Upload, Wand2, Download, Save, RotateCcw,
  Loader2, ChevronDown, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { LTX2_RESOLUTION_PRESETS } from "@/lib/types";
import { uploadImage } from "@/lib/comfyui-api";

type Preset = typeof LTX2_RESOLUTION_PRESETS[number];
type FitMode = "crop" | "fit";
type PadMethod = "gray" | "mirror" | "blur" | "custom" | "transparent";

const PAD_METHOD_LABELS: Record<PadMethod, string> = {
  gray: "Gray (#808080)",
  mirror: "Mirror",
  blur: "Blur Extend",
  custom: "Custom Color",
  transparent: "Transparent",
};

interface CropBox {
  x: number; y: number; w: number; h: number; // all in source-image pixel coords
}

interface FitOffset {
  x: number; // -1..1 range: horizontal offset within available padding space
  y: number; // -1..1 range: vertical offset within available padding space
}

interface Adjustments {
  brightness: number; // 1.0 = neutral
  contrast: number;
  saturation: number;
}

const ADJ_DEFAULT: Adjustments = { brightness: 1.0, contrast: 1.0, saturation: 1.0 };
const FIT_OFFSET_DEFAULT: FitOffset = { x: 0, y: 0 };

interface EdgeRefine {
  smooth: number;    // 0..100    - round jagged corners
  feather: number;   // 0..20 px  - soften the edge
  contrast: number;  // 0..100    - steepen the alpha transition
  shiftEdge: number; // -100..100 - grow(+) / shrink(-) the matte boundary
}

const EDGE_DEFAULT: EdgeRefine = { smooth: 0, feather: 0, contrast: 0, shiftEdge: 0 };

type MorphMode = "min" | "max";

/** Separable box blur on an alpha plane (O(N) per pass via a running sum). */
function boxBlurAlpha(a: Float32Array, w: number, h: number, radius: number, passes: number): Float32Array {
  if (radius <= 0) return a.slice();
  const win = 2 * radius + 1;
  let src = a;
  for (let pass = 0; pass < passes; pass++) {
    const tmp = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / win;
        const xout = Math.min(w - 1, Math.max(0, x - radius));
        const xin = Math.min(w - 1, Math.max(0, x + radius + 1));
        sum += src[row + xin] - src[row + xout];
      }
    }
    const out = new Float32Array(src.length);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / win;
        const yout = Math.min(h - 1, Math.max(0, y - radius));
        const yin = Math.min(h - 1, Math.max(0, y + radius + 1));
        sum += tmp[yin * w + x] - tmp[yout * w + x];
      }
    }
    src = out;
  }
  return src;
}

/** Separable morphological min (erode) / max (dilate) with a square kernel. */
function morphAlpha(a: Float32Array, w: number, h: number, radius: number, mode: MorphMode): Float32Array {
  if (radius <= 0) return a.slice();
  const pick = mode === "min" ? Math.min : Math.max;
  const seed = mode === "min" ? Infinity : -Infinity;
  const tmp = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = seed;
      for (let k = -radius; k <= radius; k++) v = pick(v, a[row + Math.min(w - 1, Math.max(0, x + k))]);
      tmp[row + x] = v;
    }
  }
  const out = new Float32Array(a.length);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = seed;
      for (let k = -radius; k <= radius; k++) v = pick(v, tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]);
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * Decontaminate matte edge colors IN PLACE (a pro "Decontaminate
 * Colors"). RMBG leaves semi-transparent edge pixels whose RGB is a blend of
 * the subject and the ORIGINAL background (or stage lasers), so compositing
 * onto a new background shows a colored halo. This grows the nearest opaque
 * foreground color outward into the soft edge band, then blends each edge
 * pixel's RGB toward that clean color by `amount` (0..1). Alpha is left
 * untouched; reads whatever alpha is already in `d` (runs AFTER edge refine).
 */
function decontaminateInPlace(d: Uint8ClampedArray, w: number, h: number, amount: number): void {
  const N = w * h;
  const SOLID = 200; // alpha ≥ ~0.78 counts as clean foreground color source
  const r = new Float32Array(N);
  const g = new Float32Array(N);
  const b = new Float32Array(N);
  const known = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    r[i] = d[p]; g[i] = d[p + 1]; b[i] = d[p + 2];
    known[i] = d[p + 3] >= SOLID ? 1 : 0;
  }
  const MAX_ITER = 16;
  for (let it = 0; it < MAX_ITER; it++) {
    let changed = 0;
    const nextKnown = known.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        if (d[i * 4 + 3] === 0) continue; // fully transparent, never shows
        let sr = 0, sg = 0, sb = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy; if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx; if (nx < 0 || nx >= w) continue;
            const ni = ny * w + nx;
            if (known[ni]) { sr += r[ni]; sg += g[ni]; sb += b[ni]; cnt++; }
          }
        }
        if (cnt > 0) {
          r[i] = sr / cnt; g[i] = sg / cnt; b[i] = sb / cnt;
          nextKnown[i] = 1; changed++;
        }
      }
    }
    known.set(nextKnown);
    if (!changed) break;
  }
  const t = Math.max(0, Math.min(1, amount));
  for (let i = 0; i < N; i++) {
    const p = i * 4;
    const a = d[p + 3];
    if (a > 0 && a < 255) {
      d[p]     = Math.round(d[p]     * (1 - t) + r[i] * t);
      d[p + 1] = Math.round(d[p + 1] * (1 - t) + g[i] * t);
      d[p + 2] = Math.round(d[p + 2] * (1 - t) + b[i] * t);
    }
  }
}

/**
 * Full matte-edge refinement pass (pro "Select & Mask"-style Global
 * Refinements + Decontaminate). Applies alpha ops in canonical order:
 * Smooth → Feather → Contrast → Shift Edge, then decontaminates edge color
 * using the refined alpha. Returns a new PNG data URL. Alpha only changes
 * where a slider is non-zero, so a clean RMBG cut is left untouched.
 */
function processCutout(
  dataUrl: string,
  edge: EdgeRefine,
  decontaminate: boolean,
  decontaminateAmount: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const ctx = cv.getContext("2d");
        if (!ctx) return reject(new Error("refine: no 2d context"));
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, w, h);
        const d = id.data;
        const N = w * h;

        const edgeActive =
          edge.smooth > 0 || edge.feather > 0 || edge.contrast > 0 || edge.shiftEdge !== 0;
        if (edgeActive) {
          let alpha: Float32Array = new Float32Array(N);
          for (let i = 0; i < N; i++) alpha[i] = d[i * 4 + 3];

          // Smooth: round jagged corners (morphological close then open).
          if (edge.smooth > 0) {
            const r = Math.round(edge.smooth / 25); // 0..4 px
            if (r > 0) {
              alpha = morphAlpha(alpha, w, h, r, "max"); // close = dilate…
              alpha = morphAlpha(alpha, w, h, r, "min"); //         …then erode
              alpha = morphAlpha(alpha, w, h, r, "min"); // open  = erode…
              alpha = morphAlpha(alpha, w, h, r, "max"); //         …then dilate
            }
          }
          // Feather: soften the edge (2-pass box blur ≈ gaussian).
          if (edge.feather > 0) {
            alpha = boxBlurAlpha(alpha, w, h, Math.max(1, Math.round(edge.feather)), 2);
          }
          // Contrast: steepen the alpha transition around the midpoint.
          if (edge.contrast > 0) {
            const factor = 1 + (edge.contrast / 100) * 3;
            for (let i = 0; i < N; i++) {
              alpha[i] = Math.max(0, Math.min(255, 128 + (alpha[i] - 128) * factor));
            }
          }
          // Shift Edge: grow(+) / shrink(-) the matte boundary.
          if (edge.shiftEdge !== 0) {
            const r = Math.round((Math.abs(edge.shiftEdge) / 100) * 5); // 0..5 px
            if (r > 0) alpha = morphAlpha(alpha, w, h, r, edge.shiftEdge > 0 ? "max" : "min");
          }

          for (let i = 0; i < N; i++) d[i * 4 + 3] = Math.round(alpha[i]);
        }

        if (decontaminate && decontaminateAmount > 0) {
          decontaminateInPlace(d, w, h, decontaminateAmount);
        }

        ctx.putImageData(id, 0, 0);
        resolve(cv.toDataURL("image/png"));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    img.onerror = () => reject(new Error("refine: image decode failed"));
    img.src = dataUrl;
  });
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Optional callback invoked after a successful "Save to ComfyUI input/" so the
   * caller can react (e.g., refresh a dropdown). Receives the saved filename. */
  onSavedToComfy?: (filename: string) => void;
}

export default function ReferencePrepStudio({ open, onClose, onSavedToComfy }: Props) {
  // ── Core state ────────────────────────────────────────────────────────────
  const [srcDataUrl, setSrcDataUrl] = useState<string | null>(null);
  const [srcDims, setSrcDims] = useState<{ w: number; h: number } | null>(null);
  const [cutoutDataUrl, setCutoutDataUrl] = useState<string | null>(null);
  const [bgColor, setBgColor] = useState<string>("#808080");
  const [useTransparentBg, setUseTransparentBg] = useState(false);
  const [presetIdx, setPresetIdx] = useState<number>(2); // default to 1280×720 Landscape
  const preset: Preset = LTX2_RESOLUTION_PRESETS[presetIdx];

  const [crop, setCrop] = useState<CropBox | null>(null);
  const [fitMode, setFitMode] = useState<FitMode>("crop");
  const [padMethod, setPadMethod] = useState<PadMethod>("gray");
  const [fitOffset, setFitOffset] = useState<FitOffset>(FIT_OFFSET_DEFAULT);
  const [adjustments, setAdjustments] = useState<Adjustments>(ADJ_DEFAULT);
  const [adjustmentsExpanded, setAdjustmentsExpanded] = useState(false);
  // Edge color decontamination (defringe): removes the colored halo RMBG
  // leaves on semi-transparent matte edges. Off by default; Amount = PS-style
  // blend strength. processedCutoutUrl caches the cleaned RGBA data URL.
  const [decontaminate, setDecontaminate] = useState(false);
  const [decontaminateAmount, setDecontaminateAmount] = useState(1.0); // 0..1 (100% = full defringe)
  const [edge, setEdge] = useState<EdgeRefine>(EDGE_DEFAULT);
  const [edgeExpanded, setEdgeExpanded] = useState(false);
  const [processedCutoutUrl, setProcessedCutoutUrl] = useState<string | null>(null);
  const [decontaminating, setDecontaminating] = useState(false);

  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractInfo, setExtractInfo] = useState<string | null>(null);
  // Reserved for future surface-level setup hints (kept for the redraw-deps
  // contract). Currently unused since RMBG dispatch goes through ComfyUI's
  // own RMBG node, which handles model presence/download internally.
  const [needsModelSetup, setNeedsModelSetup] = useState(false);
  const [savingToComfy, setSavingToComfy] = useState(false);
  const [comfySaveStatus, setComfySaveStatus] = useState<string | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);

  // Output downsize target (long edge): 2× target long edge by default,
  // capped at 4096 to avoid silly outputs from huge inputs.
  const [outputLongEdge, setOutputLongEdge] = useState(2 * Math.max(preset.width, preset.height));

  // ── Refs for canvas + crop interaction ────────────────────────────────────
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const cutoutImgRef = useRef<HTMLImageElement | null>(null);

  // Crop drag state (mouse/touch); stored in source-image pixel deltas
  const dragStateRef = useRef<{
    mode: "move" | "nw" | "ne" | "sw" | "se" | null;
    startMouseX: number;
    startMouseY: number;
    startCrop: CropBox;
  }>({ mode: null, startMouseX: 0, startMouseY: 0, startCrop: { x: 0, y: 0, w: 0, h: 0 } });

  // Mapping: source-image px → display canvas px (for hit-testing the overlay)
  const displayScaleRef = useRef<{ scale: number; offsetX: number; offsetY: number }>({
    scale: 1, offsetX: 0, offsetY: 0,
  });

  // ── Derived ───────────────────────────────────────────────────────────────
  const targetAR = preset.width / preset.height;

  // Reset crop whenever the source image OR target AR changes, center it,
  // sized to the largest box that fits inside the image at the target AR.
  useEffect(() => {
    if (!srcDims) { setCrop(null); return; }
    const { w, h } = srcDims;
    const imgAR = w / h;
    let cw: number, ch: number;
    if (imgAR > targetAR) {
      // image is wider than target → use full height
      ch = h; cw = h * targetAR;
    } else {
      cw = w; ch = w / targetAR;
    }
    setCrop({ x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch });
    setFitOffset(FIT_OFFSET_DEFAULT);
    // Update output long edge default when preset changes
    setOutputLongEdge((cur) => {
      const def = 2 * Math.max(preset.width, preset.height);
      // Only auto-update if user hadn't set something custom that's already larger
      return Math.max(def, cur >= 4096 ? cur : def);
    });
  }, [srcDims, targetAR, preset.width, preset.height]);

  // Load images once data URLs change
  useEffect(() => {
    if (!srcDataUrl) { imgElRef.current = null; return; }
    const im = new Image();
    im.onload = () => {
      imgElRef.current = im;
      setSrcDims({ w: im.naturalWidth, h: im.naturalHeight });
      drawCanvas();
    };
    im.src = srcDataUrl;
  }, [srcDataUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Active cutout = the refined version when any edge tool is active + ready,
  // else the raw RMBG output. Everything downstream (canvas, preview, export)
  // reads whichever is active via cutoutImgRef.
  const edgeActive =
    edge.smooth > 0 || edge.feather > 0 || edge.contrast > 0 || edge.shiftEdge !== 0;
  const refineActive = edgeActive || (decontaminate && decontaminateAmount > 0);
  const activeCutoutUrl = refineActive && processedCutoutUrl ? processedCutoutUrl : cutoutDataUrl;

  // Recompute the refined cutout whenever the raw cutout or any edge/defringe
  // setting changes. Debounced so dragging a slider doesn't reprocess on every
  // tick.
  useEffect(() => {
    if (!cutoutDataUrl || !refineActive) {
      setProcessedCutoutUrl(null);
      setDecontaminating(false);
      return;
    }
    let cancelled = false;
    setDecontaminating(true);
    const timer = setTimeout(() => {
      processCutout(cutoutDataUrl, edge, decontaminate, decontaminateAmount)
        .then((url) => { if (!cancelled) setProcessedCutoutUrl(url); })
        .catch(() => { if (!cancelled) setProcessedCutoutUrl(null); })
        .finally(() => { if (!cancelled) setDecontaminating(false); });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [cutoutDataUrl, decontaminate, decontaminateAmount, edge.smooth, edge.feather, edge.contrast, edge.shiftEdge]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeCutoutUrl) { cutoutImgRef.current = null; drawCanvas(); return; }
    const im = new Image();
    im.onload = () => {
      cutoutImgRef.current = im;
      drawCanvas();
    };
    im.src = activeCutoutUrl;
  }, [activeCutoutUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Redraw orchestration ──────────────────────────────────────────────────
  // Two-pass redraw: immediate + rAF. The rAF pass is critical when the
  // trigger event also causes a layout change above the canvas (amber setup
  // panel appearing, accordion expanding): the immediate pass reads
  // pre-layout dimensions, the rAF pass reads post-layout dimensions.
  // Without it the canvas buffer keeps the OLD size while CSS shrinks the
  // displayed element, producing the image-squish artifact.
  //
  // IMPORTANT: do NOT wrap this in useCallback with empty deps:
  // drawCanvas/drawPreview are function declarations re-created each render
  // and they close over fresh state (srcDims, crop, etc.). A stale
  // useCallback closure captures the first render's drawCanvas which sees
  // srcDims === null forever and bails out at its early-return guard,
  // so the image never paints. Just call them directly in each effect.
  useEffect(() => {
    drawCanvas();
    drawPreview();
    const id = requestAnimationFrame(() => {
      drawCanvas();
      drawPreview();
    });
    return () => cancelAnimationFrame(id);
  }, [
    crop, adjustments, bgColor, useTransparentBg, cutoutDataUrl, isFullscreen,
    extractError, extractInfo, comfySaveStatus, needsModelSetup, adjustmentsExpanded,
    srcDims, fitMode, padMethod, fitOffset,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw on window resize AND on container size changes.
  useEffect(() => {
    const redraw = () => {
      drawCanvas();
      drawPreview();
      requestAnimationFrame(() => {
        drawCanvas();
        drawPreview();
      });
    };
    window.addEventListener("resize", redraw);

    let ro: ResizeObserver | null = null;
    const cont = containerRef.current;
    const prev = previewCanvasRef.current?.parentElement ?? null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(redraw);
      if (cont) ro.observe(cont);
      if (prev) ro.observe(prev);
    }

    return () => {
      window.removeEventListener("resize", redraw);
      ro?.disconnect();
    };
    // Re-arm on srcDims so the observer sees a non-null container after the
    // first image upload triggers the first real layout.
  }, [srcDims]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drawing ───────────────────────────────────────────────────────────────
  const filterString = useCallback((adj: Adjustments) =>
    `brightness(${adj.brightness}) contrast(${adj.contrast}) saturate(${adj.saturation})`,
    []);

  // Helper: compute the fitted subject rect within a given frame (both in px)
  function computeFitRect(
    frameW: number, frameH: number, imgW: number, imgH: number, offset: FitOffset
  ): { x: number; y: number; w: number; h: number } {
    const imgAR = imgW / imgH;
    const frameAR = frameW / frameH;
    let fitW: number, fitH: number;
    if (imgAR > frameAR) {
      fitW = frameW; fitH = frameW / imgAR;
    } else {
      fitH = frameH; fitW = frameH * imgAR;
    }
    // Available slack for positioning
    const slackX = frameW - fitW;
    const slackY = frameH - fitH;
    // offset is -1..1; 0 = centered
    const x = (slackX / 2) + (offset.x * slackX / 2);
    const y = (slackY / 2) + (offset.y * slackY / 2);
    return { x, y, w: fitW, h: fitH };
  }

  function drawCanvas() {
    const cnv = canvasRef.current;
    const cont = containerRef.current;
    if (!cnv || !cont) return;
    const img = cutoutImgRef.current ?? imgElRef.current;
    if (!img || !srcDims) {
      const ctx = cnv.getContext("2d");
      if (ctx) {
        cnv.width = cnv.clientWidth || 1;
        cnv.height = cnv.clientHeight || 1;
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, cnv.width, cnv.height);
      }
      return;
    }

    const cw = cont.clientWidth;
    const ch = cont.clientHeight;
    cnv.width = cw;
    cnv.height = ch;
    const ctx = cnv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, cw, ch);

    if (fitMode === "fit") {
      // ── Fit mode: show target-AR frame with subject fitted inside + padding ──
      const ar = preset.width / preset.height;
      // Scale the target frame to fit inside the container
      let frameDispW: number, frameDispH: number;
      if (cw / ch > ar) {
        frameDispH = ch * 0.9; frameDispW = frameDispH * ar;
      } else {
        frameDispW = cw * 0.9; frameDispH = frameDispW / ar;
      }
      const frameX = (cw - frameDispW) / 2;
      const frameY = (ch - frameDispH) / 2;

      // Store for drag hit-testing: treat the frame as the "image" area
      displayScaleRef.current = { scale: frameDispW / preset.width, offsetX: frameX, offsetY: frameY };

      // Compute where the subject goes within the frame
      const fitRect = computeFitRect(frameDispW, frameDispH, srcDims.w, srcDims.h, fitOffset);
      const subjX = frameX + fitRect.x;
      const subjY = frameY + fitRect.y;
      const subjW = fitRect.w;
      const subjH = fitRect.h;

      // Draw padding background based on padMethod
      const effectiveBg = padMethod === "gray" ? "#808080"
        : padMethod === "custom" ? bgColor
        : padMethod === "transparent" ? "transparent"
        : "#808080"; // mirror/blur use gray as base

      if (padMethod === "transparent") {
        // Checkerboard
        const tile = 10;
        for (let yy = frameY; yy < frameY + frameDispH; yy += tile) {
          for (let xx = frameX; xx < frameX + frameDispW; xx += tile) {
            ctx.fillStyle = (Math.floor((xx - frameX) / tile) + Math.floor((yy - frameY) / tile)) % 2 === 0 ? "#222" : "#333";
            ctx.fillRect(xx, yy, Math.min(tile, frameX + frameDispW - xx), Math.min(tile, frameY + frameDispH - yy));
          }
        }
      } else if (padMethod === "blur") {
        // Draw blurred version of the image to fill the frame, then overlay sharp
        ctx.save();
        ctx.beginPath();
        ctx.rect(frameX, frameY, frameDispW, frameDispH);
        ctx.clip();
        ctx.filter = `blur(20px) ${filterString(adjustments)}`;
        ctx.drawImage(img, frameX, frameY, frameDispW, frameDispH);
        ctx.filter = "none";
        ctx.restore();
      } else if (padMethod === "mirror") {
        // Draw mirrored reflections of the subject to fill the frame
        ctx.save();
        ctx.beginPath();
        ctx.rect(frameX, frameY, frameDispW, frameDispH);
        ctx.clip();
        ctx.filter = filterString(adjustments);
        // Fill with flipped copies tiling outward from center
        // Left mirror
        if (fitRect.x > 0) {
          ctx.save();
          ctx.translate(subjX, subjY);
          ctx.scale(-1, 1);
          ctx.drawImage(img, -subjW, 0, subjW, subjH);
          ctx.restore();
        }
        // Right mirror
        if (fitRect.x + fitRect.w < frameDispW) {
          ctx.save();
          ctx.translate(subjX + subjW, subjY);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0, subjW, subjH);
          ctx.restore();
        }
        // Top mirror
        if (fitRect.y > 0) {
          ctx.save();
          ctx.translate(subjX, subjY);
          ctx.scale(1, -1);
          ctx.drawImage(img, 0, -subjH, subjW, subjH);
          ctx.restore();
        }
        // Bottom mirror
        if (fitRect.y + fitRect.h < frameDispH) {
          ctx.save();
          ctx.translate(subjX, subjY + subjH);
          ctx.scale(1, -1);
          ctx.drawImage(img, 0, 0, subjW, subjH);
          ctx.restore();
        }
        ctx.filter = "none";
        ctx.restore();
      } else {
        // Gray or custom solid color
        ctx.fillStyle = effectiveBg;
        ctx.fillRect(frameX, frameY, frameDispW, frameDispH);
      }

      // Draw the sharp subject
      ctx.filter = filterString(adjustments);
      ctx.drawImage(img, subjX, subjY, subjW, subjH);
      ctx.filter = "none";

      // Frame border
      ctx.strokeStyle = "rgba(96, 165, 250, 0.7)";
      ctx.lineWidth = 2;
      ctx.strokeRect(frameX, frameY, frameDispW, frameDispH);

      // Subject outline (dashed) to show drag area
      ctx.strokeStyle = "rgba(250, 204, 21, 0.5)"; // amber hint
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(subjX, subjY, subjW, subjH);
      ctx.setLineDash([]);

      // Center crosshair in subject area
      const cx = subjX + subjW / 2;
      const cy = subjY + subjH / 2;
      ctx.strokeStyle = "rgba(250, 204, 21, 0.3)";
      ctx.beginPath();
      ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy);
      ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8);
      ctx.stroke();

    } else {
      // ── Crop mode (original behavior) ──
      const scale = Math.min(cw / srcDims.w, ch / srcDims.h);
      const dispW = srcDims.w * scale;
      const dispH = srcDims.h * scale;
      const offsetX = (cw - dispW) / 2;
      const offsetY = (ch - dispH) / 2;
      displayScaleRef.current = { scale, offsetX, offsetY };

      // If we have a cutout AND a background color, paint the bg behind
      if (cutoutImgRef.current && !useTransparentBg) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(offsetX, offsetY, dispW, dispH);
      }

      // Apply user filter while drawing the image
      ctx.filter = filterString(adjustments);
      ctx.drawImage(img, offsetX, offsetY, dispW, dispH);
      ctx.filter = "none";

      // Crop overlay
      if (crop) {
        const cx = offsetX + crop.x * scale;
        const cy = offsetY + crop.y * scale;
        const ccw = crop.w * scale;
        const cch = crop.h * scale;
        // Dim outside the crop box
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.beginPath();
        ctx.rect(offsetX, offsetY, dispW, dispH);
        ctx.rect(cx, cy, ccw, cch);
        ctx.fill("evenodd");
        ctx.restore();
        // Crop border + handles
        ctx.strokeStyle = "rgba(96, 165, 250, 0.95)"; // blue-400
        ctx.lineWidth = 2;
        ctx.strokeRect(cx, cy, ccw, cch);
        // Rule-of-thirds guides
        ctx.strokeStyle = "rgba(96, 165, 250, 0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 1; i <= 2; i++) {
          const xx = cx + (ccw * i) / 3;
          const yy = cy + (cch * i) / 3;
          ctx.moveTo(xx, cy); ctx.lineTo(xx, cy + cch);
          ctx.moveTo(cx, yy); ctx.lineTo(cx + ccw, yy);
        }
        ctx.stroke();
        // Corner handles
        const hs = 8;
        ctx.fillStyle = "#60a5fa";
        [
          [cx, cy],
          [cx + ccw, cy],
          [cx, cy + cch],
          [cx + ccw, cy + cch],
        ].forEach(([hx, hy]) => ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs));
      }
    }
  }

  // Right-side preview: show the *final* output as it would be exported,
  // boxed into a small preview canvas so user can sanity-check before download.
  function drawPreview() {
    const cnv = previewCanvasRef.current;
    if (!cnv) return;
    const ctx = cnv.getContext("2d");
    const needsCrop = fitMode === "crop" && !crop;
    if (!ctx || !srcDims || needsCrop) {
      if (ctx) {
        cnv.width = cnv.clientWidth || 1;
        cnv.height = cnv.clientHeight || 1;
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, cnv.width, cnv.height);
      }
      return;
    }
    const img = cutoutImgRef.current ?? imgElRef.current;
    if (!img) return;

    // Determine preview canvas size: fixed display height/width slot, fit to AR
    const slotW = cnv.clientWidth;
    const slotH = cnv.clientHeight;
    const ar = preset.width / preset.height;
    let pw: number, ph: number;
    if (slotW / slotH > ar) {
      ph = slotH; pw = ph * ar;
    } else {
      pw = slotW; ph = pw / ar;
    }
    const ox = (slotW - pw) / 2;
    const oy = (slotH - ph) / 2;

    cnv.width = slotW;
    cnv.height = slotH;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, slotW, slotH);

    if (fitMode === "fit") {
      // ── Fit mode preview ──
      const fitRect = computeFitRect(pw, ph, srcDims.w, srcDims.h, fitOffset);
      const subjX = ox + fitRect.x;
      const subjY = oy + fitRect.y;
      const subjW = fitRect.w;
      const subjH = fitRect.h;

      // Padding
      if (padMethod === "transparent") {
        const tile = 6;
        for (let yy = oy; yy < oy + ph; yy += tile) {
          for (let xx = ox; xx < ox + pw; xx += tile) {
            ctx.fillStyle = (Math.floor((xx - ox) / tile) + Math.floor((yy - oy) / tile)) % 2 === 0 ? "#222" : "#333";
            ctx.fillRect(xx, yy, Math.min(tile, ox + pw - xx), Math.min(tile, oy + ph - yy));
          }
        }
      } else if (padMethod === "blur") {
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, oy, pw, ph);
        ctx.clip();
        ctx.filter = `blur(12px) ${filterString(adjustments)}`;
        ctx.drawImage(img, ox, oy, pw, ph);
        ctx.filter = "none";
        ctx.restore();
      } else if (padMethod === "mirror") {
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, oy, pw, ph);
        ctx.clip();
        ctx.filter = filterString(adjustments);
        if (fitRect.x > 0) {
          ctx.save();
          ctx.translate(subjX, subjY);
          ctx.scale(-1, 1);
          ctx.drawImage(img, -subjW, 0, subjW, subjH);
          ctx.restore();
        }
        if (fitRect.x + fitRect.w < pw) {
          ctx.save();
          ctx.translate(subjX + subjW, subjY);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0, subjW, subjH);
          ctx.restore();
        }
        if (fitRect.y > 0) {
          ctx.save();
          ctx.translate(subjX, subjY);
          ctx.scale(1, -1);
          ctx.drawImage(img, 0, -subjH, subjW, subjH);
          ctx.restore();
        }
        if (fitRect.y + fitRect.h < ph) {
          ctx.save();
          ctx.translate(subjX, subjY + subjH);
          ctx.scale(1, -1);
          ctx.drawImage(img, 0, 0, subjW, subjH);
          ctx.restore();
        }
        ctx.filter = "none";
        ctx.restore();
      } else {
        // Gray or custom solid color
        const bg = padMethod === "gray" ? "#808080" : bgColor;
        ctx.fillStyle = bg;
        ctx.fillRect(ox, oy, pw, ph);
      }

      // Sharp subject on top
      ctx.filter = filterString(adjustments);
      ctx.drawImage(img, subjX, subjY, subjW, subjH);
      ctx.filter = "none";

    } else {
      // ── Crop mode preview (original) ──
      if (cutoutImgRef.current && !useTransparentBg) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(ox, oy, pw, ph);
      } else if (!cutoutImgRef.current) {
        // No cutout: preview shows cropped raw image; no bg fill needed
      } else {
        // Transparent bg: show a checkerboard
        const tile = 8;
        for (let yy = oy; yy < oy + ph; yy += tile) {
          for (let xx = ox; xx < ox + pw; xx += tile) {
            ctx.fillStyle = ((xx + yy) / tile) % 2 === 0 ? "#222" : "#333";
            ctx.fillRect(xx, yy, tile, tile);
          }
        }
      }

      ctx.filter = filterString(adjustments);
      ctx.drawImage(
        img,
        crop!.x, crop!.y, crop!.w, crop!.h,
        ox, oy, pw, ph,
      );
      ctx.filter = "none";
    }

    // Frame
    ctx.strokeStyle = "rgba(96, 165, 250, 0.4)";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, pw - 1, ph - 1);
  }

  // ── Drag handlers (crop mode + fit mode) ─────────────────────────────────
  const fitDragRef = useRef<{ dragging: boolean; startX: number; startY: number; startOffset: FitOffset }>({
    dragging: false, startX: 0, startY: 0, startOffset: FIT_OFFSET_DEFAULT,
  });

  function pickCropMode(mxCss: number, myCss: number): typeof dragStateRef.current.mode {
    if (!crop) return null;
    const { scale, offsetX, offsetY } = displayScaleRef.current;
    const cx = offsetX + crop.x * scale;
    const cy = offsetY + crop.y * scale;
    const cw = crop.w * scale;
    const ch = crop.h * scale;
    const handleR = 12; // a bit larger than visual size to make it forgiving
    const inHandle = (hx: number, hy: number) =>
      Math.abs(mxCss - hx) <= handleR && Math.abs(myCss - hy) <= handleR;
    if (inHandle(cx, cy)) return "nw";
    if (inHandle(cx + cw, cy)) return "ne";
    if (inHandle(cx, cy + ch)) return "sw";
    if (inHandle(cx + cw, cy + ch)) return "se";
    if (mxCss >= cx && mxCss <= cx + cw && myCss >= cy && myCss <= cy + ch) return "move";
    return null;
  }

  function onCanvasPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (fitMode === "fit") {
      // In fit mode: dragging anywhere repositions the subject
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      fitDragRef.current = { dragging: true, startX: mx, startY: my, startOffset: { ...fitOffset } };
      return;
    }

    // Crop mode
    if (!crop) return;
    const mode = pickCropMode(mx, my);
    if (!mode) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    dragStateRef.current = {
      mode,
      startMouseX: mx,
      startMouseY: my,
      startCrop: { ...crop },
    };
  }

  function onCanvasPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (fitMode === "fit") {
      const fd = fitDragRef.current;
      const cnv = e.target as HTMLCanvasElement;
      if (!fd.dragging) {
        cnv.style.cursor = "grab";
        return;
      }
      cnv.style.cursor = "grabbing";
      const rect = cnv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Convert CSS px drag to offset delta (-1..1)
      // The frame display area gives us the denominator
      const { scale, offsetX, offsetY } = displayScaleRef.current;
      const frameDispW = preset.width * scale;
      const frameDispH = preset.height * scale;
      if (!srcDims) return;
      const fitRect = computeFitRect(frameDispW, frameDispH, srcDims.w, srcDims.h, FIT_OFFSET_DEFAULT);
      const slackX = frameDispW - fitRect.w;
      const slackY = frameDispH - fitRect.h;
      const dxNorm = slackX > 0 ? ((mx - fd.startX) / (slackX / 2)) : 0;
      const dyNorm = slackY > 0 ? ((my - fd.startY) / (slackY / 2)) : 0;
      const newX = Math.max(-1, Math.min(1, fd.startOffset.x + dxNorm));
      const newY = Math.max(-1, Math.min(1, fd.startOffset.y + dyNorm));
      setFitOffset({ x: newX, y: newY });
      return;
    }

    // Crop mode
    const ds = dragStateRef.current;
    if (!ds.mode || !srcDims) {
      // Update cursor
      const cnv = e.target as HTMLCanvasElement;
      const rect = cnv.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const mode = pickCropMode(mx, my);
      cnv.style.cursor =
        mode === "move" ? "grab" :
        mode === "nw" || mode === "se" ? "nwse-resize" :
        mode === "ne" || mode === "sw" ? "nesw-resize" :
        "default";
      return;
    }
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dxCss = mx - ds.startMouseX;
    const dyCss = my - ds.startMouseY;
    const { scale } = displayScaleRef.current;
    const dx = dxCss / scale; // in source-image pixel space
    const dy = dyCss / scale;

    const startC = ds.startCrop;
    const ar = preset.width / preset.height;
    let next: CropBox = { ...startC };

    if (ds.mode === "move") {
      next.x = startC.x + dx;
      next.y = startC.y + dy;
    } else {
      // Corner resize: keep AR locked
      const anchorX =
        ds.mode === "nw" || ds.mode === "sw" ? startC.x + startC.w : startC.x;
      const anchorY =
        ds.mode === "nw" || ds.mode === "ne" ? startC.y + startC.h : startC.y;
      const cur = displayScaleRef.current;
      const mouseImgX = (mx - cur.offsetX) / cur.scale;
      const mouseImgY = (my - cur.offsetY) / cur.scale;
      let newW = Math.abs(mouseImgX - anchorX);
      let newH = Math.abs(mouseImgY - anchorY);
      if (newW / newH > ar) newH = newW / ar; else newW = newH * ar;
      const newX = ds.mode === "nw" || ds.mode === "sw" ? anchorX - newW : anchorX;
      const newY = ds.mode === "nw" || ds.mode === "ne" ? anchorY - newH : anchorY;
      next = { x: newX, y: newY, w: newW, h: newH };
    }

    // Clamp to image bounds
    const minSize = 32; // px
    next.w = Math.max(minSize, Math.min(srcDims.w, next.w));
    next.h = Math.max(minSize, Math.min(srcDims.h, next.h));
    if (next.w / next.h > ar) next.w = next.h * ar; else next.h = next.w / ar;
    next.x = Math.max(0, Math.min(srcDims.w - next.w, next.x));
    next.y = Math.max(0, Math.min(srcDims.h - next.h, next.y));

    setCrop(next);
  }

  function onCanvasPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    fitDragRef.current.dragging = false;
    dragStateRef.current.mode = null;
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  // ── File handling ─────────────────────────────────────────────────────────
  function onFilePicked(file: File) {
    setExtractError(null);
    setExtractInfo(null);
    setComfySaveStatus(null);
    setCutoutDataUrl(null);
    setProcessedCutoutUrl(null);
    cutoutImgRef.current = null;
    const reader = new FileReader();
    reader.onload = () => setSrcDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }

  /**
   * Run RMBG-2.0 background removal via Vek-Snap's standard ComfyUI dispatch.
   * The route uploads to ComfyUI's input/, queues a tiny RMBG workflow, and
   * returns the RGBA cutout. `alphaMean` is computed client-side here from
   * the decoded image so we don't need a server-side image-decode dep.
   */
  async function runRMBG() {
    if (!srcDataUrl) return;
    setIsExtracting(true);
    setExtractError(null);
    setExtractInfo(null);
    setNeedsModelSetup(false);
    try {
      const blob = await (await fetch(srcDataUrl)).blob();
      const fd = new FormData();
      fd.append("image", blob, "ref.png");
      const r = await fetch("/api/preprocess/remove-bg", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok || !data.ok) {
        setExtractError(data.error || "RMBG failed");
        return;
      }
      setCutoutDataUrl(data.rgbaDataUrl);
      // Decode the returned RGBA PNG and compute the alpha mean for the info
      // readout (0 = empty mask, 1 = whole-frame mask). Cheap canvas readback.
      let am = -1;
      try {
        am = await computeAlphaMean(data.rgbaDataUrl);
      } catch {
        /* ignore: fall back to the trimmed info string below */
      }
      setExtractInfo(
        am >= 0
          ? `Subject extracted (alpha mean ${am.toFixed(3)}). Background replaced with ${
              useTransparentBg ? "transparency" : bgColor
            }.`
          : `Subject extracted. Background replaced with ${useTransparentBg ? "transparency" : bgColor}.`,
      );
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExtracting(false);
    }
  }

  /** Decode a PNG data URL and return its alpha-channel mean in [0,1]. */
  function computeAlphaMean(dataUrl: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext("2d");
          if (!ctx) return resolve(-1);
          ctx.drawImage(img, 0, 0);
          const px = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          const total = c.width * c.height;
          for (let i = 3; i < px.length; i += 4) sum += px[i];
          resolve(total > 0 ? sum / (total * 255) : 0);
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error("alpha-mean decode failed"));
      img.src = dataUrl;
    });
  }

  function resetCutout() {
    setCutoutDataUrl(null);
    setProcessedCutoutUrl(null);
    cutoutImgRef.current = null;
    setExtractInfo(null);
  }

  // ── Output rendering (final PNG) ──────────────────────────────────────────
  function renderFinalToCanvas(): HTMLCanvasElement | null {
    if (!srcDims) return null;
    if (fitMode === "crop" && !crop) return null;
    const img = cutoutImgRef.current ?? imgElRef.current;
    if (!img) return null;

    // Final output size: snap long edge to outputLongEdge, preserve target AR
    const ar = preset.width / preset.height;
    let outW: number, outH: number;
    if (preset.width >= preset.height) {
      outW = outputLongEdge; outH = Math.round(outW / ar);
    } else {
      outH = outputLongEdge; outW = Math.round(outH * ar);
    }

    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (fitMode === "fit") {
      // ── Fit mode final render ──
      const fitRect = computeFitRect(outW, outH, srcDims.w, srcDims.h, fitOffset);
      const subjX = fitRect.x;
      const subjY = fitRect.y;
      const subjW = fitRect.w;
      const subjH = fitRect.h;

      // Padding
      if (padMethod === "transparent") {
        // Leave canvas alpha = 0 (transparent)
      } else if (padMethod === "blur") {
        // Stretch blurred image to fill entire output
        ctx.filter = `blur(30px) ${filterString(adjustments)}`;
        ctx.drawImage(img, 0, 0, outW, outH);
        ctx.filter = "none";
      } else if (padMethod === "mirror") {
        // Draw mirrored reflections
        ctx.filter = filterString(adjustments);
        // Left mirror
        if (subjX > 0) {
          ctx.save();
          ctx.translate(subjX, subjY);
          ctx.scale(-1, 1);
          ctx.drawImage(img, -subjW, 0, subjW, subjH);
          ctx.restore();
        }
        // Right mirror
        if (subjX + subjW < outW) {
          ctx.save();
          ctx.translate(subjX + subjW, subjY);
          ctx.scale(-1, 1);
          ctx.drawImage(img, 0, 0, subjW, subjH);
          ctx.restore();
        }
        // Top mirror
        if (subjY > 0) {
          ctx.save();
          ctx.translate(subjX, subjY);
          ctx.scale(1, -1);
          ctx.drawImage(img, 0, -subjH, subjW, subjH);
          ctx.restore();
        }
        // Bottom mirror
        if (subjY + subjH < outH) {
          ctx.save();
          ctx.translate(subjX, subjY + subjH);
          ctx.scale(1, -1);
          ctx.drawImage(img, 0, 0, subjW, subjH);
          ctx.restore();
        }
        ctx.filter = "none";
      } else {
        // Gray or custom solid fill
        const bg = padMethod === "gray" ? "#808080" : bgColor;
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, outW, outH);
      }

      // Sharp subject on top
      ctx.filter = filterString(adjustments);
      ctx.drawImage(img, subjX, subjY, subjW, subjH);
      ctx.filter = "none";

    } else {
      // ── Crop mode final render (original) ──
      // Background
      if (cutoutImgRef.current && !useTransparentBg) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, outW, outH);
      } else if (!cutoutImgRef.current) {
        // Source image has no cutout, output is just the cropped source. No bg.
      } // else transparent bg → leave alpha 0

      // Bake adjustments via canvas filter
      ctx.filter = filterString(adjustments);
      ctx.drawImage(img, crop!.x, crop!.y, crop!.w, crop!.h, 0, 0, outW, outH);
      ctx.filter = "none";
    }
    return out;
  }

  function downloadOutput() {
    const cnv = renderFinalToCanvas();
    if (!cnv) return;
    cnv.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `veksnap_ref_${preset.width}x${preset.height}_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }

  async function saveToComfyInput() {
    const cnv = renderFinalToCanvas();
    if (!cnv) return;
    setSavingToComfy(true);
    setComfySaveStatus(null);
    try {
      const blob: Blob = await new Promise((res, rej) =>
        cnv.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png")
      );
      const filename = `veksnap_ref_${preset.width}x${preset.height}_${Date.now()}.png`;
      const file = new File([blob], filename, { type: "image/png" });
      // Reuse the canonical uploadImage helper, posts directly to ComfyUI's
      // /upload/image endpoint (CORS enabled). Returns the saved filename.
      const savedName = await uploadImage(file);
      setComfySaveStatus(`Saved as ${savedName} in ComfyUI input/`);
      onSavedToComfy?.(savedName);
    } catch (err) {
      setComfySaveStatus(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingToComfy(false);
    }
  }

  // ── Header summary string ────────────────────────────────────────────────
  const summary = useMemo(() => {
    if (!srcDims) return "No image loaded";
    const modeTail = fitMode === "fit"
      ? ` · fit + ${padMethod}`
      : (crop ? ` · crop ${Math.round(crop.w)}×${Math.round(crop.h)}` : "");
    return `Source ${srcDims.w}×${srcDims.h} → target ${preset.width}×${preset.height}${modeTail}`;
  }, [srcDims, crop, preset, fitMode, padMethod]);

  // ── Reset all ─────────────────────────────────────────────────────────────
  function resetAll() {
    setSrcDataUrl(null);
    setSrcDims(null);
    setCutoutDataUrl(null);
    setProcessedCutoutUrl(null);
    cutoutImgRef.current = null;
    imgElRef.current = null;
    setCrop(null);
    setFitMode("crop");
    setPadMethod("gray");
    setFitOffset(FIT_OFFSET_DEFAULT);
    setAdjustments(ADJ_DEFAULT);
    setEdge(EDGE_DEFAULT);
    setDecontaminate(false);
    setDecontaminateAmount(1.0);
    setExtractError(null);
    setExtractInfo(null);
    setComfySaveStatus(null);
  }

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 z-[100] bg-black/85 flex items-center justify-center ${
        isFullscreen ? "p-0" : "p-3 sm:p-6"
      }`}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
      tabIndex={-1}
    >
      <div className={`bg-background border border-blue-500/30 rounded-lg shadow-2xl flex flex-col ${
        isFullscreen ? "w-full h-full rounded-none border-0" : "w-full max-w-7xl h-[90vh]"
      }`}>
        {/* ── Header bar ──────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-blue-500/20 bg-blue-500/5 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Wand2 className="w-4 h-4 text-blue-400 shrink-0" />
            <h2 className="text-sm font-semibold text-blue-400 shrink-0">Reference Prep</h2>
            <span className="text-[10px] text-blue-300/60 truncate">{summary}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[10px] px-2"
              onClick={() => setIsFullscreen((v) => !v)}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[10px] px-2 text-destructive"
              onClick={onClose}
              title="Close"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* ── Toolbar row ─────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-blue-500/10 bg-blue-500/[0.02] shrink-0">
          {/* Upload */}
          <label className="inline-flex items-center gap-1 text-[10px] text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 px-2 py-1 rounded cursor-pointer transition-colors">
            <Upload className="w-3 h-3" />
            {srcDataUrl ? "Replace image" : "Upload image"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFilePicked(f);
                e.currentTarget.value = "";
              }}
            />
          </label>

          {/* Resolution preset */}
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] text-blue-300/70">Target</Label>
            <select
              className="h-7 text-[10px] px-1.5 rounded bg-background border border-blue-500/30 text-blue-100"
              value={presetIdx}
              onChange={(e) => setPresetIdx(Number(e.target.value))}
            >
              {LTX2_RESOLUTION_PRESETS.map((p, i) => (
                <option key={i} value={i}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* Output long edge */}
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] text-blue-300/70" title="Output PNG long-edge: recommended ≈ 2× target long edge">
              Out long edge
            </Label>
            <input
              type="number"
              min={Math.max(preset.width, preset.height)}
              max={6144}
              step={64}
              value={outputLongEdge}
              onChange={(e) => setOutputLongEdge(Math.max(64, Number(e.target.value) || 0))}
              className="h-7 w-20 text-[10px] px-1 rounded bg-background border border-blue-500/30 text-blue-100"
            />
          </div>

          {/* Fit mode toggle */}
          <div className="flex items-center gap-1.5 border-l border-blue-500/20 pl-2">
            <Label className="text-[10px] text-blue-300/70">Mode</Label>
            <div className="flex rounded overflow-hidden border border-blue-500/30">
              <button
                type="button"
                className={`px-2 py-1 text-[10px] transition-colors ${
                  fitMode === "crop"
                    ? "bg-blue-500/30 text-blue-100"
                    : "bg-transparent text-blue-300/60 hover:bg-blue-500/10"
                }`}
                onClick={() => setFitMode("crop")}
                title="Crop to target aspect ratio: drag box to choose region"
              >
                Crop
              </button>
              <button
                type="button"
                className={`px-2 py-1 text-[10px] transition-colors ${
                  fitMode === "fit"
                    ? "bg-amber-500/30 text-amber-100"
                    : "bg-transparent text-blue-300/60 hover:bg-amber-500/10"
                }`}
                onClick={() => setFitMode("fit")}
                title="Fit entire image into target AR: pad remaining space"
              >
                Fit + Pad
              </button>
            </div>
            {fitMode === "fit" && (
              <select
                className="h-7 text-[10px] px-1.5 rounded bg-background border border-amber-500/30 text-amber-100"
                value={padMethod}
                onChange={(e) => setPadMethod(e.target.value as PadMethod)}
                title="How to fill the padding area around the fitted subject"
              >
                {(Object.keys(PAD_METHOD_LABELS) as PadMethod[]).map((m) => (
                  <option key={m} value={m}>{PAD_METHOD_LABELS[m]}</option>
                ))}
              </select>
            )}
            {fitMode === "fit" && (fitOffset.x !== 0 || fitOffset.y !== 0) ? (
              <button
                type="button"
                className="text-[9px] text-amber-400/70 hover:text-amber-300 px-1"
                onClick={() => setFitOffset(FIT_OFFSET_DEFAULT)}
                title="Reset subject position to center"
              >
                ↺ center
              </button>
            ) : null}
          </div>

          {/* Background */}
          <div className="flex items-center gap-1.5">
            <Label className="text-[10px] text-blue-300/70">BG</Label>
            <input
              type="color"
              className="h-6 w-7 rounded border border-blue-500/30 bg-background cursor-pointer disabled:opacity-50"
              value={bgColor}
              onChange={(e) => setBgColor(e.target.value)}
              disabled={useTransparentBg}
              title="Background color (default #808080 mid-gray)"
            />
            <input
              type="text"
              value={bgColor}
              onChange={(e) => setBgColor(e.target.value)}
              disabled={useTransparentBg}
              className="h-6 w-16 text-[10px] px-1 rounded bg-background border border-blue-500/30 text-blue-100 font-mono disabled:opacity-50"
            />
            <label className="inline-flex items-center gap-1 text-[10px] text-blue-300/70 select-none">
              <input
                type="checkbox"
                checked={useTransparentBg}
                onChange={(e) => setUseTransparentBg(e.target.checked)}
                className="accent-blue-500"
              />
              Transparent
            </label>
          </div>

          {/* Extract subject */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[10px] px-2 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
            onClick={() => runRMBG()}
            disabled={!srcDataUrl || isExtracting}
            title="Auto-extract subject with BRIA RMBG-2.0 and replace background"
          >
            {isExtracting ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Wand2 className="w-3 h-3 mr-1" />}
            {cutoutDataUrl ? "Re-extract" : "Auto-extract subject"}
          </Button>
          {cutoutDataUrl && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[10px] px-2 text-amber-400"
              onClick={resetCutout}
              title="Drop the cutout: work from the original image again"
            >
              Drop cutout
            </Button>
          )}

          {/* Output actions */}
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[10px] px-2 text-amber-300/80 hover:bg-amber-500/10"
              onClick={resetAll}
              disabled={!srcDataUrl}
              title="Clear and start over"
            >
              <RotateCcw className="w-3 h-3 mr-1" /> Reset
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[10px] px-2 border-blue-500/40 text-blue-300"
              onClick={downloadOutput}
              disabled={!srcDataUrl || (fitMode === "crop" && !crop)}
            >
              <Download className="w-3 h-3 mr-1" /> Download
            </Button>
            <Button
              size="sm"
              variant="default"
              className="h-7 text-[10px] px-2 bg-blue-500/80 hover:bg-blue-500 text-white"
              onClick={saveToComfyInput}
              disabled={!srcDataUrl || (fitMode === "crop" && !crop) || savingToComfy}
              title="Save processed PNG into ComfyUI/input/ for direct use as a reference image"
            >
              {savingToComfy ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
              Save to ComfyUI input/
            </Button>
          </div>
        </div>

        {/* ── Adjustments (collapsible) ─────────────────────────── */}
        <div className="border-b border-blue-500/10 shrink-0">
          <button
            type="button"
            onClick={() => setAdjustmentsExpanded((v) => !v)}
            className="w-full flex items-center gap-1 px-4 py-1.5 text-[10px] text-blue-300/70 hover:bg-blue-500/5"
          >
            {adjustmentsExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Basic adjustments
            {(adjustments.brightness !== 1 || adjustments.contrast !== 1 || adjustments.saturation !== 1) && (
              <span className="ml-1 text-amber-400/80">(modified)</span>
            )}
          </button>
          {adjustmentsExpanded && (
            <div className="px-4 pb-2 grid grid-cols-3 gap-3">
              {(["brightness", "contrast", "saturation"] as const).map((k) => (
                <div key={k} className="space-y-0.5">
                  <Label className="text-[9px] text-blue-300/60 capitalize flex items-center justify-between">
                    {k}
                    <span className="font-mono text-blue-200/70">{adjustments[k].toFixed(2)}</span>
                  </Label>
                  <Slider
                    min={0.3} max={2.0} step={0.01}
                    value={[adjustments[k]]}
                    onValueChange={([v]) => setAdjustments((prev) => ({ ...prev, [k]: v }))}
                  />
                </div>
              ))}
              <div className="col-span-3 flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[9px] px-2 text-blue-300/70"
                  onClick={() => setAdjustments(ADJ_DEFAULT)}
                >
                  <RotateCcw className="w-3 h-3 mr-1" /> Reset adjustments
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* ── Edge refinement (collapsible; needs a cutout) ─────── */}
        {cutoutDataUrl && (
          <div className="border-b border-blue-500/10 shrink-0">
            <button
              type="button"
              onClick={() => setEdgeExpanded((v) => !v)}
              className="w-full flex items-center gap-1 px-4 py-1.5 text-[10px] text-blue-300/70 hover:bg-blue-500/5"
            >
              {edgeExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              Edge refinement
              {(edge.smooth || edge.feather || edge.contrast || edge.shiftEdge || decontaminate) ? (
                <span className="ml-1 text-amber-400/80">(active)</span>
              ) : null}
              {decontaminating && <Loader2 className="w-3 h-3 animate-spin text-blue-400 ml-1" />}
            </button>
            {edgeExpanded && (
              <div className="px-4 pb-2 space-y-2">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                  <div className="space-y-0.5">
                    <Label className="text-[9px] text-blue-300/60 flex items-center justify-between">
                      Smooth
                      <span className="font-mono text-blue-200/70">{edge.smooth}</span>
                    </Label>
                    <Slider min={0} max={100} step={1} value={[edge.smooth]}
                      onValueChange={([v]) => setEdge((p) => ({ ...p, smooth: v }))} />
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[9px] text-blue-300/60 flex items-center justify-between">
                      Feather
                      <span className="font-mono text-blue-200/70">{edge.feather.toFixed(1)} px</span>
                    </Label>
                    <Slider min={0} max={20} step={0.5} value={[edge.feather]}
                      onValueChange={([v]) => setEdge((p) => ({ ...p, feather: v }))} />
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[9px] text-blue-300/60 flex items-center justify-between">
                      Contrast
                      <span className="font-mono text-blue-200/70">{edge.contrast}%</span>
                    </Label>
                    <Slider min={0} max={100} step={1} value={[edge.contrast]}
                      onValueChange={([v]) => setEdge((p) => ({ ...p, contrast: v }))} />
                  </div>
                  <div className="space-y-0.5">
                    <Label className="text-[9px] text-blue-300/60 flex items-center justify-between">
                      Shift edge
                      <span className="font-mono text-blue-200/70">{edge.shiftEdge > 0 ? "+" : ""}{edge.shiftEdge}%</span>
                    </Label>
                    <Slider min={-100} max={100} step={1} value={[edge.shiftEdge]}
                      onValueChange={([v]) => setEdge((p) => ({ ...p, shiftEdge: v }))} />
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-1 border-t border-blue-500/10">
                  <label
                    className="inline-flex items-center gap-1 text-[10px] text-blue-300/70 select-none cursor-pointer"
                    title="Remove the colored fringe/halo from the matte edges (pro-style Decontaminate Colors)"
                  >
                    <input type="checkbox" checked={decontaminate}
                      onChange={(e) => setDecontaminate(e.target.checked)} className="accent-blue-500" />
                    Decontaminate colors
                  </label>
                  {decontaminate && (
                    <div className="flex items-center gap-1.5 flex-1 max-w-[180px]">
                      <Slider min={0} max={1} step={0.01} value={[decontaminateAmount]}
                        onValueChange={([v]) => setDecontaminateAmount(v)} />
                      <span className="font-mono text-[9px] text-blue-200/70 w-8 text-right shrink-0">
                        {Math.round(decontaminateAmount * 100)}%
                      </span>
                    </div>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[9px] px-2 text-blue-300/70 ml-auto"
                    onClick={() => { setEdge(EDGE_DEFAULT); setDecontaminate(false); setDecontaminateAmount(1.0); }}
                  >
                    <RotateCcw className="w-3 h-3 mr-1" /> Reset edges
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Status ───────────────────────────────────────────── */}
        {(extractError || extractInfo || comfySaveStatus) && (
          <div className="px-4 py-1.5 text-[10px] border-b border-blue-500/10 shrink-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              {extractError && (
                <span className={needsModelSetup ? "text-amber-300" : "text-red-400"}>
                  {extractError}
                </span>
              )}
              {!extractError && extractInfo && (
                <span className="text-emerald-400/80">{extractInfo}</span>
              )}
              {comfySaveStatus && (
                <span className={`ml-3 ${comfySaveStatus.startsWith("Save failed") ? "text-red-400" : "text-emerald-400/80"}`}>
                  {comfySaveStatus}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ── Main work area ───────────────────────────────────── */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_280px] min-h-0">
          {/* Crop canvas */}
          <div ref={containerRef} className="relative bg-background min-h-0 overflow-hidden">
            {!srcDataUrl ? (
              <label className="absolute inset-0 flex flex-col items-center justify-center text-blue-300/50 cursor-pointer hover:bg-blue-500/[0.02]">
                <Upload className="w-10 h-10 mb-2" />
                <span className="text-sm">Click or drop an image to begin</span>
                <span className="text-[10px] mt-1">JPEG / PNG / WebP: any size; 5K+ inputs are fine</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFilePicked(f);
                    e.currentTarget.value = "";
                  }}
                />
              </label>
            ) : (
              <canvas
                ref={canvasRef}
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={onCanvasPointerUp}
                onPointerCancel={onCanvasPointerUp}
                className="absolute inset-0 w-full h-full"
              />
            )}
          </div>

          {/* Right rail: preview + tips */}
          <div className="border-t lg:border-t-0 lg:border-l border-blue-500/10 bg-background flex flex-col min-h-0">
            <div className="px-3 pt-2 pb-1 text-[10px] text-blue-300/70 flex items-center justify-between">
              <span>Output preview</span>
              <span className="font-mono text-blue-300/50">{preset.width}×{preset.height}</span>
            </div>
            <div className="px-3 pb-3 shrink-0">
              <div className="aspect-video rounded border border-blue-500/20 bg-black overflow-hidden">
                <canvas ref={previewCanvasRef} className="w-full h-full block" />
              </div>
            </div>
            <div className="px-3 pb-3 text-[10px] text-blue-300/60 space-y-2 overflow-y-auto">
              <div className="space-y-0.5">
                <div className="text-blue-200/80 font-medium">Tips</div>
                <ul className="list-disc pl-4 space-y-0.5 text-blue-300/60">
                  <li>Pick the resolution you plan to render at: the crop locks to its aspect ratio.</li>
                  <li><span className="font-mono text-blue-200/70">#808080</span> mid-gray is the recommended background; white or transparent are okay too.</li>
                  <li>Upload first, then click <span className="text-emerald-300">Auto-extract subject</span> to swap the background.</li>
                  <li><strong className="text-blue-200/80">Crop</strong>: drag corners to resize (AR locked); drag body to reposition.</li>
                  <li><strong className="text-amber-200/80">Fit + Pad</strong>: preserves entire image, ideal for portrait refs → landscape video. Drag to reposition subject within frame.</li>
                  <li>For LTX guides, <span className="font-mono text-blue-200/70">Gray (#808080)</span> pad is optimal: encodes to ≈ zero in latent space (null signal).</li>
                  <li>Output long-edge defaults to ≈ 2× target: sweet spot for lanczos quality without bloated files.</li>
                </ul>
              </div>
              <div className="pt-2 border-t border-blue-500/10 text-blue-300/50">
                First subject extraction downloads RMBG-2.0 (~880 MB) from <code className="text-blue-300/70">1038lab/RMBG-2.0</code> (Apache-2.0, no login). Subsequent extractions are fully offline.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
