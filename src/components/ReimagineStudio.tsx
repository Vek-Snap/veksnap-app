"use client";

// ── Re-Imagine Studio (Studio v2) ─────────────────────────────────────────────
// Ports the classic "Re-Imagine" compose pipeline into a modern studio: refine or
// inpaint an existing image with a checkpoint model. Its control surface projects
// into the shell's right-hand "Workflow Controls" panel; the gallery fills the
// center. Uses the shared builder: buildWorkflow(params, "compose", subMode) with
// composeOutputType "image".
//
// Two paths (mirrors classic):
//   • Whole-image refine: upload a source, low-denoise img2img (no mask).
//   • Custom inpaint: paint a mask; the Vek-Snap intelligent crop pipeline builds
//     a content-aware region (context crop + mask + fill + soft mask) exactly like
//     the classic UI, then only the masked area is regenerated and composited back.

import { useCallback, useEffect, useRef, useState } from "react";
import { Wand2, Sparkles, X, Upload, Download, Square, Dice5, Plus, Trash2, ChevronLeft, ChevronRight, Maximize2, LayoutGrid, Info, Eraser, Paintbrush, RefreshCw, ImagePlus, FolderOpen, Check, CheckSquare, Send } from "lucide-react";
import {
  DEFAULT_PARAMS,
  INPAINT_DEFAULTS,
  CONTENT_AWARE_ENGINES,
  getCheckpointArch,
  type ContentAwareEngine,
  type GenerationParams,
  type ComfyUIProgress,
  type LoraEntry,
  type RegionInfo,
  type InpaintMethod,
  type ComposeSubMode,
} from "@/lib/types";
import { buildWorkflow } from "@/lib/workflow-builder";
import {
  queuePrompt,
  getHistory,
  getImageUrl,
  getCheckpoints,
  getCheckpointSizes,
  uploadImage,
  connectComfyStream,
  interruptGeneration,
} from "@/lib/comfyui-api";
import { useRegisterComfyWorkflow } from "@/components/ComfyOpenProvider";
import SendToQueueButton from "@/components/SendToQueueButton";
import { useRenderStatus } from "@/lib/render-status-context";
import LoraSelect from "@/components/LoraSelect";
import MaskPainter from "@/components/MaskPainter";
import ConfirmDialog from "@/components/ConfirmDialog";
import { WorkflowControls } from "@/components/WorkflowControlsSlot";
import {
  useGalleryResults,
  useGalleryView,
  makeImportedImages,
  revokeIfBlob,
  galleryKey,
  GALLERY_MAX,
  type GalleryImage,
} from "@/lib/image-gallery-store";
import { useGalleryActions } from "@/lib/use-gallery-actions";
import { useGalleryDnd, useImageDropTarget } from "@/lib/use-gallery-dnd";
import GalleryContextMenu from "@/components/GalleryContextMenu";
import { useToast } from "@/components/ToastProvider";
import { applyOutputMetadata, buildOutputSummary } from "@/lib/output-metadata";

const SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "dpmpp_sde", "ddim"] as const;
const SCHEDULERS = ["normal", "karras", "simple", "sgm_uniform", "beta", "exponential"] as const;

// Gallery image shape is shared across all image studios (shared gallery store).
type ResultImage = GalleryImage;

const SUB_MODES: { id: ComposeSubMode; label: string; hint: string }[] = [
  { id: "inpaint", label: "Inpaint", hint: "Regenerate only the masked area, blended back into the original." },
  { id: "overlay", label: "Overlay", hint: "Generate the masked subject and remove its background (RMBG)." },
  { id: "combined", label: "Combined", hint: "Inpaint the region and also emit a background-removed version." },
];

const METHODS: { id: InpaintMethod; label: string; hint: string }[] = [
  { id: "default", label: "Default", hint: "Full inpaint (denoise 1.0, respective field 0.618)." },
  { id: "detail", label: "Improve Detail", hint: "Low-denoise refinement of existing content (denoise 0.5)." },
  { id: "modify", label: "Modify", hint: "Full regen using an additional prompt (denoise 1.0)." },
];

// ── Vek-Snap intelligent crop helpers (copied verbatim from the classic page) ──
function computeMaskBbox(canvas: HTMLCanvasElement): { a: number; b: number; c: number; d: number } | null {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  let minR = H, maxR = 0, minC = W, maxC = 0;
  let found = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4] > 127) {
        found = true;
        if (y < minR) minR = y;
        if (y > maxR) maxR = y;
        if (x < minC) minC = x;
        if (x > maxC) maxC = x;
      }
    }
  }
  if (!found) return null;
  const abp = (maxR + minR) >> 1;
  const abm = (maxR - minR) >> 1;
  const cdp = (maxC + minC) >> 1;
  const cdm = (maxC - minC) >> 1;
  const l = Math.round(Math.max(abm, cdm) * 1.15);
  const a = abp - l, b = abp + l + 1, c = cdp - l, d = cdp + l + 1;
  return { a: Math.max(0, Math.min(H, a)), b: Math.max(0, Math.min(H, b)), c: Math.max(0, Math.min(W, c)), d: Math.max(0, Math.min(W, d)) };
}

function vekSnapSolveAbcd(H: number, W: number, a: number, b: number, c: number, d: number, k: number): { a: number; b: number; c: number; d: number } {
  if (k >= 1.0) return { a: 0, b: H, c: 0, d: W };
  for (let iter = 0; iter < 100000; iter++) {
    if (b - a >= H * k && d - c >= W * k) break;
    let addH = (b - a) < (d - c);
    let addW = !addH;
    if (b - a >= H) addW = true;
    if (d - c >= W) addH = true;
    if (addH) { a -= 1; b += 1; }
    if (addW) { c -= 1; d += 1; }
    a = Math.max(0, Math.min(H, a));
    b = Math.max(0, Math.min(H, b));
    c = Math.max(0, Math.min(W, c));
    d = Math.max(0, Math.min(W, d));
    if (b - a >= H && d - c >= W) break;
  }
  return { a: Math.round(a), b: Math.round(b), c: Math.round(c), d: Math.round(d) };
}

function vekSnapGetShapeCeil(h: number, w: number): number {
  return Math.ceil(Math.sqrt(h * w) / 64) * 64;
}

function vekSnapTargetDims(cropH: number, cropW: number, targetCeil: number = 1024): { h: number; w: number } {
  let H = cropH, W = cropW;
  for (let i = 0; i < 256; i++) {
    const cur = vekSnapGetShapeCeil(H, W);
    if (Math.abs(cur - targetCeil) < 0.1) break;
    const k = targetCeil / cur;
    H = Math.round((H * k) / 64) * 64;
    W = Math.round((W * k) / 64) * 64;
  }
  if (H < 64) H = 64;
  if (W < 64) W = 64;
  return { h: H, w: W };
}

interface ReimagineState {
  checkpoint: string;
  subMode: ComposeSubMode;
  positivePrompt: string;
  negativePrompt: string;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  clipSkip: number;
  seed: number;
  randomSeed: boolean;
  loras: LoraEntry[];
  // Source + region
  sourceImage: string | null;      // ComfyUI-uploaded filename
  regionInfo: RegionInfo | null;
  contentAware: boolean;
  width: number;
  height: number;
  // Inpaint controls
  inpaintMethod: InpaintMethod;
  inpaintStrength: number;
  inpaintRespectiveField: number;
  inpaintMaskGrow: number;
  inpaintErodeDilate: number;
  inpaintInvertMask: boolean;
  inpaintAdditionalPrompt: string;
  contentAwareEngine: ContentAwareEngine;
  objectRemoval: boolean;
  brushnetScale: number;
}

const INITIAL: ReimagineState = {
  checkpoint: "",
  subMode: "inpaint",
  positivePrompt: "",
  negativePrompt: "blurry, low quality, worst quality, jpeg artifacts, deformed",
  steps: 28,
  cfg: 6.0,
  sampler: "dpmpp_2m",
  scheduler: "karras",
  clipSkip: 2,
  seed: -1,
  randomSeed: true,
  loras: [],
  sourceImage: null,
  regionInfo: null,
  contentAware: false,
  width: 1024,
  height: 1024,
  ...INPAINT_DEFAULTS,
};

const SESSION: { state: ReimagineState; lastSeed: number | null } = {
  state: INITIAL,
  lastSeed: null,
};

export default function ReimagineStudio() {
  const [s, setS] = useState<ReimagineState>(() => SESSION.state);
  const update = useCallback(<K extends keyof ReimagineState>(k: K, v: ReimagineState[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
  }, []);
  // Copy a finished image's seed into the Workflow Controls (turns random off).
  // Drives the "Use Same Seed" right-click action and the clickable seed.
  const applySeed = useCallback((seed: number) => {
    setS((prev) => ({ ...prev, seed, randomSeed: false }));
  }, []);
  useEffect(() => { SESSION.state = s; }, [s]);

  // ── Checkpoints (all non-Klien; compose works with any SD/SDXL arch) ──
  const [ckpts, setCkpts] = useState<string[]>([]);
  const [ckptSizes, setCkptSizes] = useState<Record<string, number>>({});
  const [loadingCkpts, setLoadingCkpts] = useState(true);
  const [ckptError, setCkptError] = useState<string | null>(null);
  const scanCheckpoints = useCallback(async () => {
    setLoadingCkpts(true);
    setCkptError(null);
    try {
      const [names, sizes] = await Promise.all([getCheckpoints(), getCheckpointSizes()]);
      setCkptSizes(sizes);
      setCkpts(names.filter((n) => String(getCheckpointArch(sizes[n], n)) !== "klien"));
    } catch {
      setCkptError("Could not reach ComfyUI: start it, then Rescan.");
    } finally {
      setLoadingCkpts(false);
    }
  }, []);
  useEffect(() => { void scanCheckpoints(); }, [scanCheckpoints]);
  useEffect(() => {
    if (ckpts.length > 0 && !ckpts.includes(s.checkpoint)) update("checkpoint", ckpts[0]);
  }, [ckpts]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── LoRAs ──
  const [loraOptions, setLoraOptions] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/lora-scan")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.catalog) setLoraOptions(d.catalog.map((e: { name: string }) => e.name)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const addLora = useCallback(() => setS((prev) => ({ ...prev, loras: [...prev.loras, { enabled: true, name: "", strengthModel: 1, strengthClip: 1 }] })), []);
  const updateLora = useCallback((i: number, patch: Partial<LoraEntry>) => setS((prev) => ({ ...prev, loras: prev.loras.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) })), []);
  const removeLora = useCallback((i: number) => setS((prev) => ({ ...prev, loras: prev.loras.filter((_, idx) => idx !== i) })), []);

  // Method presets adjust inpaint strength and respective-field defaults.
  const setMethod = useCallback((m: InpaintMethod) => {
    setS((prev) => {
      if (m === "detail") return { ...prev, inpaintMethod: m, inpaintStrength: 0.5, inpaintRespectiveField: 0.0 };
      if (m === "modify") return { ...prev, inpaintMethod: m, inpaintStrength: 1.0, inpaintRespectiveField: 0.0 };
      return { ...prev, inpaintMethod: m, inpaintStrength: 1.0, inpaintRespectiveField: 0.618 };
    });
  }, []);

  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [maskPreview, setMaskPreview] = useState<string | null>(null);
  const [showMaskPainter, setShowMaskPainter] = useState(false);
  const [maskFeather, setMaskFeather] = useState(0);

  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  // Gallery results + view come from the SHARED store (one pool across all three
  // image studios; persists across tab switches).
  const [results, setResults] = useGalleryResults();
  const { cols: previewCols, setCols: setPreviewCols, details: showDetails, setDetails: setShowDetails } = useGalleryView();
  const [lastSeed, setLastSeed] = useState<number | null>(() => SESSION.lastSeed);
  useEffect(() => { SESSION.lastSeed = lastSeed; }, [lastSeed]);

  const [lightbox, setLightbox] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const clearResults = useCallback(() => { setResults((prev) => { prev.forEach((r) => revokeIfBlob(r.url)); return []; }); setLightbox(null); }, [setResults]);

  // ── Import existing images (files or a whole folder) into the shared gallery ──
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importDirRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = importDirRef.current;
    if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); }
  }, []);
  const importFiles = useCallback((fileList: FileList | null) => {
    const imported = makeImportedImages(fileList);
    if (imported.length === 0) { toast("No image files found in that selection", "warning"); return; }
    setResults((prev) => [...imported, ...prev].slice(0, GALLERY_MAX));
    toast(`Imported ${imported.length} image${imported.length > 1 ? "s" : ""} into the gallery`, "success");
  }, [toast, setResults]);

  // Gallery multi-select: powers the header All/None button, per-item checkboxes,
  // and the bulk-action bar; also feeds the shared right-click actions hook.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }, []);
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => (prev.size >= results.length ? new Set<string>() : new Set<string>(results.map(galleryKey))));
  }, [results]);
  const {
    menu, closeMenu, openMenu,
    confirmState, setConfirmState,
    clearFromPanel, deleteFromDisk, sendToTimeline, reorder,
    refreshPresence, refreshing,
  } = useGalleryActions({ results, selected, setSelected, setLightbox, fromStudio: "ReimagineStudio" });
  const { dragActive, dragOverIndex, containerProps, getItemProps } = useGalleryDnd({ importFiles, reorder });

  const showPrev = useCallback(() => setLightbox((i) => (i === null ? null : (i - 1 + results.length) % results.length)), [results.length]);
  const showNext = useCallback(() => setLightbox((i) => (i === null ? null : (i + 1) % results.length)), [results.length]);
  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      else if (e.key === "ArrowLeft") { e.preventDefault(); showPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); showNext(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, showPrev, showNext]);
  useEffect(() => {
    if (lightbox !== null && lightbox >= results.length) setLightbox(results.length ? results.length - 1 : null);
    setSelected((prev) => { const valid = new Set(results.map(galleryKey)); const next = new Set([...prev].filter((k) => valid.has(k))); return next.size === prev.size ? prev : next; });
  }, [results, lightbox]);

  const clientIdRef = useRef<string>("");
  if (!clientIdRef.current) {
    clientIdRef.current = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `vs2reimg-${Date.now()}`;
  }
  const esRef = useRef<EventSource | null>(null);
  const cancelRef = useRef(false);

  // Upload a plain source image for whole-image refine (no mask / no region).
  const onPickSource = useCallback(async (file: File) => {
    try {
      setError(null);
      setStage("Uploading source image…");
      const name = await uploadImage(file);
      // Read intrinsic dimensions for the generation resolution.
      const dims = await new Promise<{ w: number; h: number }>((res) => {
        const img = new window.Image();
        img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => res({ w: 1024, h: 1024 });
        img.src = URL.createObjectURL(file);
      });
      const w = Math.max(256, Math.round(dims.w / 8) * 8);
      const h = Math.max(256, Math.round(dims.h / 8) * 8);
      setS((prev) => ({ ...prev, sourceImage: name, regionInfo: null, contentAware: false, width: w, height: h }));
      setSourcePreview(URL.createObjectURL(file));
      setMaskPreview(null);
      setStage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Image upload failed");
      setStage("");
    }
  }, []);

  const clearSource = useCallback(() => {
    setS((prev) => ({ ...prev, sourceImage: null, regionInfo: null, contentAware: false }));
    setSourcePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setMaskPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, []);

  // Drop a gallery thumbnail (or OS image) onto the source field to re-imagine it.
  const sourceDrop = useImageDropTarget(onPickSource);

  const { startRender, updateRenderProgress, endRender, completeRender } = useRenderStatus();
  useEffect(() => () => { esRef.current?.close(); }, []);

  const buildParams = useCallback((seedOverride?: number): GenerationParams => {
    const seed = seedOverride ?? (s.randomSeed || s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed);
    return {
      ...DEFAULT_PARAMS,
      checkpoint: s.checkpoint,
      checkpointSizeBytes: ckptSizes[s.checkpoint],
      positivePrompt: s.positivePrompt,
      negativePrompt: s.negativePrompt,
      width: s.width,
      height: s.height,
      steps: s.steps,
      cfg: s.cfg,
      sampler: s.sampler,
      scheduler: s.scheduler,
      clipSkip: s.clipSkip,
      seed,
      randomSeed: false,
      composeOutputType: "image",
      sourceImage: s.sourceImage,
      regionInfo: s.regionInfo,
      contentAware: s.contentAware,
      loras: s.loras,
      inpaintMethod: s.inpaintMethod,
      inpaintStrength: s.inpaintStrength,
      inpaintRespectiveField: s.inpaintRespectiveField,
      inpaintMaskGrow: s.inpaintMaskGrow,
      inpaintErodeDilate: s.inpaintErodeDilate,
      inpaintInvertMask: s.inpaintInvertMask,
      inpaintAdditionalPrompt: s.inpaintAdditionalPrompt,
      contentAwareEngine: s.contentAwareEngine,
      objectRemoval: s.objectRemoval,
      brushnetScale: s.brushnetScale,
    };
  }, [s, ckptSizes]);

  useRegisterComfyWorkflow(
    useCallback(
      () => ({ workflow: buildWorkflow(buildParams(), "compose", s.subMode) as Record<string, unknown>, name: "Vek-Snap Re-Imagine" }),
      [buildParams, s.subMode],
    ),
  );

  const stop = useCallback(() => {
    cancelRef.current = true;
    interruptGeneration().catch(() => {});
    esRef.current?.close();
  }, []);

  const runOne = useCallback(async (params: GenerationParams, subMode: ComposeSubMode): Promise<ResultImage[]> => {
    const workflow = buildWorkflow(params, "compose", subMode) as Record<string, unknown>;
    const clientId = clientIdRef.current;
    esRef.current?.close();
    esRef.current = connectComfyStream(
      clientId,
      (msg: ComfyUIProgress) => {
        if (msg.type === "progress" && msg.data) {
          const v = msg.data.value ?? 0;
          const m = msg.data.max ?? 0;
          setProgress(v);
          setProgressMax(m);
          setStage(`Sampling: step ${v}/${m}`);
          updateRenderProgress(v, m, `Re-Imagine ${v}/${m}`, Date.now());
        }
      },
      () => {},
      () => {},
    );
    const queueRes = await queuePrompt(workflow, clientId);
    const promptId = queueRes.prompt_id;
    for (let i = 0; i < 900; i++) {
      if (cancelRef.current) break;
      await new Promise((r) => setTimeout(r, 1000));
      const hist = await getHistory(promptId);
      if (hist?.status?.status_str === "error") throw new Error("ComfyUI reported an execution error: check the ComfyUI logs.");
      if (hist?.outputs) {
        const imgs: ResultImage[] = [];
        for (const nodeOut of Object.values(hist.outputs)) {
          const node = nodeOut as { images?: Array<{ filename: string; subfolder?: string; type?: string }> };
          if (node.images) for (const im of node.images) imgs.push({ url: getImageUrl(im.filename, im.subfolder ?? "", im.type ?? "output"), filename: im.filename, subfolder: im.subfolder ?? "", type: im.type ?? "output" });
        }
        if (imgs.length > 0) return imgs;
      }
    }
    return [];
  }, [updateRenderProgress]);

  const generate = useCallback(async () => {
    if (!s.checkpoint) { setError("Select a checkpoint first"); return; }
    if (!s.sourceImage) { setError("Upload a source image (and optionally paint a mask) first"); return; }
    if (!s.positivePrompt.trim() && s.subMode !== "inpaint") { setError("Enter a prompt"); return; }
    setError(null);
    setGenerating(true);
    cancelRef.current = false;
    setProgress(0);
    setProgressMax(0);
    setStage("Building workflow…");
    startRender("Re-Imagine", "Building workflow…");
    const modelName = s.checkpoint.replace(/\.[^.]+$/, "");
    try {
      const seed = s.randomSeed || s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed;
      setLastSeed(seed);
      const params = buildParams(seed);
      const imgs = await runOne(params, s.subMode);
      if (cancelRef.current) { setStage("Stopped"); endRender(); return; }
      if (imgs.length === 0) throw new Error("Generation finished but produced no image.");
      const withMeta: ResultImage[] = imgs.map((im) => ({ ...im, meta: { seed, model: modelName } }));
      setResults((prev) => [...withMeta, ...prev].slice(0, GALLERY_MAX));
      void applyOutputMetadata({
        files: withMeta.map((im) => ({ filename: im.filename, subfolder: im.subfolder, type: im.type })),
        workflow: buildWorkflow(params, "compose", s.subMode) as Record<string, unknown>,
        summary: buildOutputSummary({ model: modelName, seed, loras: s.loras }),
      });
      esRef.current?.close();
      setStage("Complete");
      completeRender();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
      setStage("Failed");
      endRender();
    } finally {
      setGenerating(false);
    }
  }, [s.checkpoint, s.sourceImage, s.positivePrompt, s.subMode, s.seed, s.randomSeed, s.loras, buildParams, runOne, startRender, completeRender, endRender]);

  const pct = progressMax > 0 ? Math.round((progress / progressMax) * 100) : 0;
  const ready = !!s.checkpoint && !!s.sourceImage;

  return (
    <div className="h-full flex flex-col lg:flex-row gap-4 min-h-0 overflow-y-auto lg:overflow-hidden">
      {/* ── Controls column: projected into the shell's Workflow Controls panel ── */}
      <WorkflowControls>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Wand2 className="w-4 h-4 text-fuchsia-400" />
          Re-Imagine
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground">
            {s.contentAware ? "masked inpaint" : "refine"}
          </span>
        </div>

        {/* Checkpoint */}
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-muted-foreground">Checkpoint</label>
          <button type="button" onClick={() => void scanCheckpoints()} className="inline-flex items-center gap-1 text-[10px] text-fuchsia-400 hover:text-fuchsia-300" title="Rescan checkpoints">
            <RefreshCw className={`w-3 h-3 ${loadingCkpts ? "animate-spin" : ""}`} /> Rescan
          </button>
        </div>
        <select
          value={s.checkpoint}
          onChange={(e) => update("checkpoint", e.target.value)}
          disabled={loadingCkpts || ckpts.length === 0}
          className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-fuchsia-500/50 disabled:opacity-50"
        >
          {ckpts.length === 0 ? <option value="">{loadingCkpts ? "Scanning…" : "No checkpoints found"}</option>
            : ckpts.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {ckptError && <p className="text-[10px] text-amber-400">{ckptError}</p>}

        {/* Source image */}
        <div
          {...sourceDrop.dropProps}
          className={`rounded-lg border bg-foreground/5 p-2 space-y-2 transition-colors ${sourceDrop.isOver ? "border-fuchsia-500 ring-2 ring-fuchsia-500/40 bg-fuchsia-500/5" : "border-border/60"}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium flex items-center gap-1.5"><Upload className="w-3.5 h-3.5 text-fuchsia-400" /> Source image <span className="text-muted-foreground/60">(drop here)</span></span>
            {s.sourceImage && <button type="button" onClick={clearSource} className="text-muted-foreground hover:text-destructive" title="Remove source"><X className="w-3.5 h-3.5" /></button>}
          </div>
          {sourcePreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={maskPreview || sourcePreview} alt="Source" className="max-h-40 mx-auto rounded" />
          ) : (
            <label className="flex items-center justify-center gap-2 h-16 rounded-md border border-dashed border-border cursor-pointer text-[11px] text-muted-foreground hover:bg-foreground/5">
              <Upload className="w-4 h-4" /> Upload an image to re-imagine
              <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickSource(f); }} />
            </label>
          )}
          {s.sourceImage && (
            <button
              type="button"
              onClick={() => setShowMaskPainter(true)}
              className="w-full h-8 rounded-md border border-fuchsia-500/40 bg-fuchsia-600/20 text-fuchsia-100 text-[11px] font-medium hover:bg-fuchsia-600/30 flex items-center justify-center gap-1.5"
            >
              <Paintbrush className="w-3.5 h-3.5" /> {s.contentAware ? "Edit Mask" : "Paint Mask (custom inpaint)"}
            </button>
          )}
          {s.contentAware && <p className="text-[9px] text-emerald-400/80">Masked inpaint active: only the painted area regenerates ({s.width}×{s.height}).</p>}
        </div>

        {/* Sub-mode */}
        <label className="text-[11px] text-muted-foreground">Mode</label>
        <div className="flex gap-1 p-1 rounded-lg bg-muted/40 border border-border/50">
          {SUB_MODES.map((m) => (
            <button key={m.id} type="button" onClick={() => update("subMode", m.id)} title={m.hint}
              className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors ${s.subMode === m.id ? "bg-fuchsia-500/20 text-fuchsia-200" : "text-muted-foreground/70 hover:text-foreground hover:bg-foreground/5"}`}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="text-[9px] text-muted-foreground/60 -mt-1">{SUB_MODES.find((m) => m.id === s.subMode)!.hint}</p>

        {/* Prompt */}
        <label className="text-[11px] text-muted-foreground mt-1">Prompt</label>
        <textarea value={s.positivePrompt} onChange={(e) => update("positivePrompt", e.target.value)} placeholder="Describe the result you want…" rows={3}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs resize-y focus:outline-none focus:ring-1 focus:ring-fuchsia-500/50" />
        <label className="text-[11px] text-muted-foreground">Negative prompt</label>
        <textarea value={s.negativePrompt} onChange={(e) => update("negativePrompt", e.target.value)} rows={2}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs resize-y focus:outline-none focus:ring-1 focus:ring-fuchsia-500/50" />

        {/* Inpaint method + controls */}
        <div className="rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/5 p-2 space-y-2">
          <div className="text-[11px] font-medium text-fuchsia-300 flex items-center gap-1.5"><Wand2 className="w-3.5 h-3.5" /> Inpaint Method</div>
          <select value={s.inpaintMethod} onChange={(e) => setMethod(e.target.value as InpaintMethod)}
            className="w-full h-8 rounded-md border border-fuchsia-500/30 bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-fuchsia-500/50">
            {METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <p className="text-[9px] text-muted-foreground/70">{METHODS.find((m) => m.id === s.inpaintMethod)!.hint}</p>
          {(s.inpaintMethod === "detail" || s.inpaintMethod === "modify") && (
            <textarea value={s.inpaintAdditionalPrompt} onChange={(e) => update("inpaintAdditionalPrompt", e.target.value)} placeholder="Additional prompt for the masked area…" rows={2}
              className="w-full rounded-md border border-fuchsia-500/30 bg-background px-2 py-1.5 text-[11px] resize-y focus:outline-none focus:ring-1 focus:ring-fuchsia-500/50" />
          )}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-20">Strength</span>
            <input type="range" min={0.1} max={1} step={0.01} value={s.inpaintStrength} onChange={(e) => update("inpaintStrength", parseFloat(e.target.value))} className="flex-1 h-1 accent-fuchsia-500" />
            <span className="text-[10px] font-mono text-fuchsia-400 w-8 text-right">{s.inpaintStrength.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-20">Respect field</span>
            <input type="range" min={0} max={1} step={0.001} value={s.inpaintRespectiveField} onChange={(e) => update("inpaintRespectiveField", parseFloat(e.target.value))} className="flex-1 h-1 accent-fuchsia-500" />
            <span className="text-[10px] font-mono text-fuchsia-400 w-10 text-right">{s.inpaintRespectiveField.toFixed(3)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-20">Mask grow</span>
            <input type="range" min={0} max={64} step={1} value={s.inpaintMaskGrow} onChange={(e) => update("inpaintMaskGrow", parseInt(e.target.value))} className="flex-1 h-1 accent-fuchsia-500" />
            <span className="text-[10px] font-mono text-fuchsia-400 w-8 text-right">{s.inpaintMaskGrow}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-20">Erode/Dilate</span>
            <input type="range" min={-64} max={64} step={1} value={s.inpaintErodeDilate} onChange={(e) => update("inpaintErodeDilate", parseInt(e.target.value))} className="flex-1 h-1 accent-fuchsia-500" />
            <span className="text-[10px] font-mono text-fuchsia-400 w-8 text-right">{s.inpaintErodeDilate}</span>
          </div>
          <label className="flex items-center gap-1.5 text-[10px] text-fuchsia-200/90 cursor-pointer select-none">
            <input type="checkbox" checked={s.inpaintInvertMask} onChange={(e) => update("inpaintInvertMask", e.target.checked)} className="accent-fuchsia-500" />
            Invert mask
          </label>
        </div>

        {/* Content-Aware Engine */}
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2 space-y-2">
          <div className="text-[11px] font-medium text-emerald-300 flex items-center gap-1.5"><Eraser className="w-3.5 h-3.5" /> Content-Aware Engine</div>
          <select value={s.contentAwareEngine} onChange={(e) => update("contentAwareEngine", e.target.value as ContentAwareEngine)}
            className="w-full h-8 rounded-md border border-emerald-500/30 bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500/50">
            {CONTENT_AWARE_ENGINES.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
          </select>
          <p className="text-[9px] text-muted-foreground/70">{CONTENT_AWARE_ENGINES.find((e) => e.value === s.contentAwareEngine)!.description}</p>
          {s.contentAwareEngine !== "diffdiff" && (
            <p className="text-[9px] text-amber-300/70">Requires the {s.contentAwareEngine === "powerpaint" ? "PowerPaint" : "BrushNet"} weights (download in the installer&apos;s model card). If missing, generation will error, switch back to Standard.</p>
          )}
          <label className="flex items-center gap-1.5 text-[10px] text-emerald-200/90 cursor-pointer select-none">
            <input type="checkbox" checked={s.objectRemoval} onChange={(e) => update("objectRemoval", e.target.checked)} className="accent-emerald-500" />
            Object removal (erase subject: seeds an empty scene)
          </label>
          {s.contentAwareEngine !== "diffdiff" && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-24">Content-aware fill</span>
                <input type="range" min={0.1} max={1} step={0.05} value={s.brushnetScale} onChange={(e) => update("brushnetScale", parseFloat(e.target.value))} className="flex-1 h-1 accent-emerald-500" />
                <span className="text-[10px] font-mono text-emerald-400 w-9 text-right">{Math.round(s.brushnetScale * 100)}%</span>
              </div>
              <p className="text-[9px] text-muted-foreground/60">How strongly the engine blends the new area into the existing image. Lower = gentler; 100% = strongest fill.</p>
            </div>
          )}
        </div>

        {/* Steps + CFG */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground"><span>Steps</span><span className="font-mono">{s.steps}</span></div>
            <input type="range" min={1} max={60} step={1} value={s.steps} onChange={(e) => update("steps", parseInt(e.target.value))} className="w-full h-1 accent-fuchsia-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground"><span>CFG</span><span className="font-mono">{s.cfg.toFixed(1)}</span></div>
            <input type="range" min={1} max={20} step={0.1} value={s.cfg} onChange={(e) => update("cfg", parseFloat(e.target.value))} className="w-full h-1 accent-fuchsia-500" />
          </div>
        </div>

        {/* Sampler + Scheduler */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-muted-foreground">Sampler</label>
            <select value={s.sampler} onChange={(e) => update("sampler", e.target.value)} className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-fuchsia-500/50">
              {SAMPLERS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Scheduler</label>
            <select value={s.scheduler} onChange={(e) => update("scheduler", e.target.value)} className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-fuchsia-500/50">
              {SCHEDULERS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        </div>

        {/* Seed */}
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => update("randomSeed", !s.randomSeed)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border transition-colors ${s.randomSeed ? "border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300" : "border-border text-muted-foreground hover:bg-foreground/5"}`}
            title="Randomize the seed each run"><Dice5 className="w-3.5 h-3.5" /> Random</button>
          <input type="number" value={s.randomSeed ? "" : s.seed} disabled={s.randomSeed} placeholder={s.randomSeed ? "random" : "seed"}
            onChange={(e) => update("seed", parseInt(e.target.value) || 0)}
            className="flex-1 h-8 rounded-lg border border-border bg-background px-2 text-xs disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-fuchsia-500/50" />
          {lastSeed != null && (
            <button type="button" onClick={() => { update("randomSeed", false); update("seed", lastSeed); }} className="text-[10px] text-muted-foreground hover:text-fuchsia-400" title="Reuse the last seed">↺ {lastSeed}</button>
          )}
        </div>

        {/* LoRAs */}
        <div className="rounded-lg border border-border/60 bg-foreground/5 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-fuchsia-400" /> LoRAs</span>
            <button type="button" onClick={addLora} className="inline-flex items-center gap-1 text-[10px] text-fuchsia-400 hover:text-fuchsia-300"><Plus className="w-3 h-3" /> Add</button>
          </div>
          {s.loras.length === 0 && <p className="text-[10px] text-muted-foreground/60">No LoRAs: runs with the base checkpoint.</p>}
          {s.loras.map((l, i) => (
            <div key={i} className="space-y-1 border-t border-border/40 pt-1.5 first:border-t-0 first:pt-0">
              <div className="flex items-center gap-1.5">
                <input type="checkbox" checked={l.enabled} onChange={(e) => updateLora(i, { enabled: e.target.checked })} className="accent-fuchsia-500" title="Enable this LoRA" />
                <LoraSelect value={l.name} options={loraOptions} onChange={(name) => updateLora(i, { name })} compatMode="image" />
                <button type="button" onClick={() => removeLora(i)} className="text-muted-foreground hover:text-destructive" title="Remove LoRA"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-muted-foreground w-14">Strength</span>
                <input type="range" min={-2} max={2} step={0.05} value={l.strengthModel} onChange={(e) => { const v = parseFloat(e.target.value); updateLora(i, { strengthModel: v, strengthClip: v }); }} className="flex-1 h-1 accent-fuchsia-500" />
                <span className="text-[9px] font-mono text-fuchsia-400 w-8 text-right">{l.strengthModel.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Generate / Stop: locked footer: pinned to the bottom of the dock so the action
            + live progress stay visible no matter which sections are scrolled. */}
        <div className="sticky bottom-0 z-10 mt-1 rounded-xl border border-blue-500/25 bg-[var(--sidebar)]/95 backdrop-blur p-2.5 space-y-2 shadow-[0_-4px_12px_rgba(0,0,0,0.25)]">
        {generating ? (
          <button onClick={stop} className="w-full h-10 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium flex items-center justify-center gap-2">
            <Square className="w-4 h-4" /> Stop
          </button>
        ) : (
          <button onClick={() => void generate()}
            className={`w-full h-10 rounded-lg text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors ${ready ? "vek-generate-glow bg-fuchsia-600/80 hover:bg-fuchsia-500" : "bg-fuchsia-600/40"}`}>
            <Wand2 className="w-4 h-4" /> Re-Imagine
          </button>
        )}
        {!generating && (
          <SendToQueueButton
            className="w-full"
            disabled={!ready}
            getJob={() => ({ workflow: buildWorkflow(buildParams(), "compose", s.subMode) as Record<string, unknown>, name: "Re-Imagine", outputKind: "image" })}
          />
        )}

        {(generating || stage) && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground"><span>{stage}</span>{progressMax > 0 && <span className="font-mono">{pct}%</span>}</div>
            <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
              <div className="h-full bg-fuchsia-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        {error && <p className="text-[11px] text-rose-400 whitespace-pre-wrap">{error}</p>}
        </div>
      </div>
      </WorkflowControls>

      {/* ── Results column ── */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col rounded-lg border border-border/60 bg-foreground/5">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 shrink-0">
          <span className="text-[11px] text-muted-foreground">{results.length > 0 ? `${results.length} image${results.length > 1 ? "s" : ""}` : "Gallery"}</span>
          <button type="button" onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-border text-muted-foreground hover:text-fuchsia-300 hover:border-fuchsia-500/40 transition-colors"
            title="Load image files into the shared gallery"><ImagePlus className="w-3.5 h-3.5" /> Import</button>
          <button type="button" onClick={() => importDirRef.current?.click()}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border text-muted-foreground hover:text-fuchsia-300 hover:border-fuchsia-500/40 transition-colors"
            title="Load a whole folder of images"><FolderOpen className="w-3.5 h-3.5" /></button>
          {results.length > 0 && (
            <button type="button" onClick={toggleSelectAll} className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-border text-muted-foreground hover:bg-foreground/5 transition-colors" title="Select or deselect all">
              <CheckSquare className="w-3.5 h-3.5" /> {selected.size >= results.length ? "None" : "All"}
            </button>
          )}
          {results.length > 0 && (
            <button type="button" onClick={() => void refreshPresence()} disabled={refreshing} className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-border text-muted-foreground hover:bg-foreground/5 disabled:opacity-40 transition-colors" title="Remove previews whose file was deleted or moved on disk">
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
            </button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <div className="flex items-center gap-1 text-muted-foreground" title="Preview size">
              <LayoutGrid className="w-3.5 h-3.5" />
              {[2, 3, 4, 5].map((c) => (
                <button key={c} type="button" onClick={() => setPreviewCols(c)}
                  className={`w-5 h-5 rounded text-[10px] font-mono border transition-colors ${previewCols === c ? "border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-300" : "border-border text-muted-foreground hover:bg-foreground/5"}`}
                  title={`${c} per row`}>{c}</button>
              ))}
            </div>
            <button type="button" onClick={() => setShowDetails((v) => !v)}
              className={`inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border transition-colors ${showDetails ? "border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-300" : "border-border text-muted-foreground hover:bg-foreground/5"}`}
              title="Show image details"><Info className="w-3.5 h-3.5" /> Details</button>
            <button type="button" onClick={() => setConfirmClear(true)} disabled={results.length === 0}
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40 transition-colors"
              title="Clear all images from the gallery"><Eraser className="w-3.5 h-3.5" /> Clear All</button>
          </div>
        </div>

        <div {...containerProps} className={`flex-1 min-h-0 overflow-y-auto p-3 transition-colors ${dragActive ? "ring-2 ring-inset ring-fuchsia-500/60 bg-fuchsia-500/5" : ""}`}>
          {results.length === 0 ? (
            <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-muted-foreground/50 gap-2">
              <Wand2 className="w-10 h-10" />
              <p className="text-xs">Re-imagined images appear here</p>
              <p className="text-[10px] text-muted-foreground/40">Upload a source, paint a mask, and Re-Imagine, or drag &amp; drop images here</p>
            </div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${previewCols}, minmax(0, 1fr))` }}>
              {results.map((r, i) => (
                <div key={`${r.filename}-${i}`} {...getItemProps(i, r)} onContextMenu={(e) => openMenu(e, galleryKey(r))} className={`group relative rounded-lg overflow-hidden border bg-background cursor-grab active:cursor-grabbing ${selected.has(galleryKey(r)) ? "border-fuchsia-500 ring-2 ring-fuchsia-500/50" : dragOverIndex === i ? "border-fuchsia-400 ring-2 ring-fuchsia-400" : "border-border/60"}`}>
                  <button type="button" onClick={(e) => { e.stopPropagation(); toggleSelect(galleryKey(r)); }}
                    className={`absolute top-2 right-2 z-10 inline-flex items-center justify-center w-6 h-6 rounded-md border transition-colors ${selected.has(galleryKey(r)) ? "bg-fuchsia-600 border-fuchsia-500 text-white" : "bg-black/50 border-white/50 text-transparent hover:text-white/70"}`}
                    title={selected.has(galleryKey(r)) ? "Deselect" : "Select"}><Check className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={() => setLightbox(i)} className="block w-full cursor-zoom-in" title="Click to view fullscreen">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.url} alt={r.filename} draggable={false} className="w-full h-auto" />
                    <span className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center w-6 h-6 rounded-md bg-black/60 text-white"><Maximize2 className="w-3 h-3" /></span>
                  </button>
                  <a href={r.url} download={r.filename} className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 px-2 py-1 rounded-md bg-black/70 text-white text-[10px]"><Download className="w-3 h-3" /> Save</a>
                  {showDetails && r.meta && (
                    <div className="px-2 py-1 text-[9px] text-muted-foreground border-t border-border/40 space-y-0.5">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); applySeed(r.meta!.seed); }}
                        className="font-mono text-fuchsia-400/80 hover:text-fuchsia-300 hover:underline cursor-pointer"
                        title="Use this seed (copies it to Workflow Controls and turns random off)"
                      >
                        seed {r.meta.seed}
                      </button>
                      <div className="truncate" title={r.meta.model}>{r.meta.model}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {selected.size > 0 && (
          <div className="shrink-0 border-t border-border/50 p-2.5 flex items-center gap-2 flex-wrap bg-background/40">
            <span className="text-[11px] text-fuchsia-300 font-medium">{selected.size} selected</span>
            <button type="button" onClick={() => setSelected(new Set())} className="inline-flex items-center gap-1 h-7 px-2 rounded-md border border-border text-muted-foreground hover:bg-foreground/5 text-[11px]">Deselect</button>
            <button type="button" onClick={() => sendToTimeline([...selected])} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 text-[11px]"><Send className="w-3.5 h-3.5" /> Send to Timeline</button>
            <button type="button" onClick={() => clearFromPanel([...selected])} className="ml-auto inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 text-[11px]"><Eraser className="w-3.5 h-3.5" /> Remove from gallery</button>
            <button type="button" onClick={() => deleteFromDisk([...selected])} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-rose-600/50 text-rose-400 hover:bg-rose-600/15 text-[11px]"><Trash2 className="w-3.5 h-3.5" /> Delete from disk</button>
          </div>
        )}
      </div>

      {/* ── Mask painter (content-aware region builder) ── */}
      {showMaskPainter && sourcePreview && (
        <div className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-auto">
          <div className="w-full max-w-5xl">
            <MaskPainter
              initialImageUrl={sourcePreview}
              initialMaskUrl={maskPreview || undefined}
              initialFeather={maskFeather}
              onFeatherChange={setMaskFeather}
              onCancel={() => setShowMaskPainter(false)}
              onMaskComplete={async (maskBlob, sourceBlob, srcW, srcH) => {
                try {
                  setStage("Preparing mask…");
                  // Upload original source (post-composite destination).
                  const srcName = await uploadImage(new File([sourceBlob], "mask_source.png", { type: "image/png" }));
                  // Full-size mask canvas for bbox.
                  const mskBmp = await createImageBitmap(maskBlob);
                  const fullMskCanvas = document.createElement("canvas");
                  fullMskCanvas.width = srcW; fullMskCanvas.height = srcH;
                  const fullMskCtx = fullMskCanvas.getContext("2d")!;
                  fullMskCtx.drawImage(mskBmp, 0, 0, srcW, srcH);
                  // Vek-Snap intelligent crop.
                  const bbox = computeMaskBbox(fullMskCanvas);
                  const crop = bbox
                    ? vekSnapSolveAbcd(srcH, srcW, bbox.a, bbox.b, bbox.c, bbox.d, s.inpaintRespectiveField)
                    : { a: 0, b: srcH, c: 0, d: srcW };
                  const cropX = crop.c, cropY = crop.a;
                  const cropW = crop.d - crop.c, cropH = crop.b - crop.a;
                  const { h: genH, w: genW } = vekSnapTargetDims(cropH, cropW, 1024);
                  // Crop + scale source to gen resolution.
                  const srcBmp = await createImageBitmap(sourceBlob);
                  const ctxCanvas = document.createElement("canvas");
                  ctxCanvas.width = genW; ctxCanvas.height = genH;
                  ctxCanvas.getContext("2d")!.drawImage(srcBmp, cropX, cropY, cropW, cropH, 0, 0, genW, genH);
                  const ctxBlob = await new Promise<Blob>((res) => ctxCanvas.toBlob((b) => res(b!), "image/png"));
                  const ctxName = await uploadImage(new File([ctxBlob], "context_crop.png", { type: "image/png" }));
                  // Crop + scale mask to gen resolution.
                  const mskCanvas = document.createElement("canvas");
                  mskCanvas.width = genW; mskCanvas.height = genH;
                  mskCanvas.getContext("2d")!.drawImage(fullMskCanvas, cropX, cropY, cropW, cropH, 0, 0, genW, genH);
                  const mskBlob2 = await new Promise<Blob>((res) => mskCanvas.toBlob((b) => res(b!), "image/png"));
                  const maskName = await uploadImage(new File([mskBlob2], "painted_mask.png", { type: "image/png" }));
                  // Vek-Snap fill + soft mask.
                  let filledName: string | undefined;
                  let softMaskName: string | undefined;
                  try {
                    const { vekSnapFill, morphologicalOpen } = await import("@/lib/vek-snap-fill");
                    const filled = vekSnapFill(ctxCanvas, mskCanvas);
                    const filledBlob = await new Promise<Blob>((res) => filled.toBlob((b) => res(b!), "image/png"));
                    filledName = await uploadImage(new File([filledBlob], "veksnap_filled.png", { type: "image/png" }));
                    const softMask = morphologicalOpen(fullMskCanvas);
                    const softBlob = await new Promise<Blob>((res) => softMask.toBlob((b) => res(b!), "image/png"));
                    softMaskName = await uploadImage(new File([softBlob], "soft_mask.png", { type: "image/png" }));
                  } catch (fillErr) {
                    console.warn("Vek-Snap preprocessing failed:", fillErr);
                  }
                  const fullInfo: RegionInfo = {
                    x: 0, y: 0,
                    width: genW, height: genH,
                    sourceWidth: srcW, sourceHeight: srcH,
                    sourceImageFile: srcName,
                    contextImageFile: ctxName,
                    maskImageFile: maskName,
                    padLeft: 0, padTop: 0,
                    contextWidth: genW, contextHeight: genH,
                    filledImageFile: filledName,
                    softMaskFile: softMaskName,
                    cropX, cropY, cropW, cropH,
                  };
                  setS((prev) => ({ ...prev, sourceImage: srcName, regionInfo: fullInfo, contentAware: true, width: genW, height: genH }));
                  setMaskPreview(URL.createObjectURL(maskBlob));
                  setShowMaskPainter(false);
                  setStage("");
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Mask preparation failed");
                  setStage("");
                }
              }}
            />
          </div>
        </div>
      )}

      {/* ── Fullscreen lightbox ── */}
      {lightbox !== null && results[lightbox] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm" onClick={() => setLightbox(null)}>
          <button type="button" onClick={() => setLightbox(null)} className="absolute top-16 left-1/2 -translate-x-1/2 inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors" title="Close (Esc)"><X className="w-5 h-5" /></button>
          <div className="absolute top-16 left-4 flex items-center gap-3 text-white/80 text-xs">
            <span className="font-mono px-2 py-1 rounded-md bg-white/10">{lightbox + 1} / {results.length}</span>
            {results[lightbox].meta && <span className="font-mono px-2 py-1 rounded-md bg-white/10 text-white/70">seed {results[lightbox].meta!.seed}</span>}
            <a href={results[lightbox].url} download={results[lightbox].filename} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 hover:bg-white/20 transition-colors" title="Download this image"><Download className="w-4 h-4" /> Save</a>
          </div>
          {results.length > 1 && (
            <button type="button" onClick={(e) => { e.stopPropagation(); showPrev(); }} className="absolute left-4 inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors" title="Previous (left arrow)"><ChevronLeft className="w-7 h-7" /></button>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={results[lightbox].url} alt={results[lightbox].filename} onClick={(e) => e.stopPropagation()} className="max-h-[92vh] max-w-[90vw] object-contain rounded-lg shadow-2xl" />
          {results.length > 1 && (
            <button type="button" onClick={(e) => { e.stopPropagation(); showNext(); }} className="absolute right-4 inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors" title="Next (right arrow)"><ChevronRight className="w-7 h-7" /></button>
          )}
        </div>
      )}

      {/* Hidden pickers for Import (files) and folder import. */}
      <input ref={importInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { importFiles(e.target.files); e.target.value = ""; }} />
      <input ref={importDirRef} type="file" className="hidden" onChange={(e) => { importFiles(e.target.files); e.target.value = ""; }} />

      {/* Shared right-click context menu */}
      <GalleryContextMenu
        menu={menu}
        onClose={closeMenu}
        onClearFromPanel={clearFromPanel}
        onDeleteFromDisk={deleteFromDisk}
        onSendToTimeline={sendToTimeline}
        seedValue={menu && menu.targets.length === 1 ? (results.find((r) => galleryKey(r) === menu.targets[0])?.meta?.seed ?? null) : null}
        onUseSeed={() => { const sd = menu && menu.targets.length === 1 ? results.find((r) => galleryKey(r) === menu.targets[0])?.meta?.seed : undefined; if (sd != null) applySeed(sd); }}
      />

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear all images?"
        description="This removes every image from the gallery. Your saved files on disk are not deleted."
        confirmLabel="Clear all"
        variant="destructive"
        onConfirm={clearResults}
      />

      {/* Destructive-action confirmation from the context menu (Delete from Disk). */}
      <ConfirmDialog
        open={confirmState !== null}
        onOpenChange={(v) => { if (!v) setConfirmState(null); }}
        title={confirmState?.title ?? ""}
        description={confirmState?.description ?? ""}
        confirmLabel={confirmState?.confirmLabel ?? "Confirm"}
        variant="destructive"
        onConfirm={() => confirmState?.onConfirm()}
      />
    </div>
  );
}
