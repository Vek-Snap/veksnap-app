"use client";

// ── SDXL / SD1.5 / Pony Studio (Studio v2) ────────────────────────────────────
// A self-contained, professional industry standard-styled checkpoint image generator for the polished
// /studio-v2 shell. Ports the classic "Still Image" (SDXL / SD1.5 / Pony) txt2img
// pipeline into a modern studio: its control surface projects into the shell's
// right-hand "Workflow Controls" panel (like Continuum), and the gallery fills the
// center. Uses the shared builder: buildWorkflow(params, "image").
//
// Design note: this is a v2-NATIVE studio with its own local state. It reuses the
// shared library exactly like the other v2 studios (ImageStudio, LTX2Studio):
// buildWorkflow + @/lib/comfyui-api for queue/stream/history, and self-registers
// for the global "Open in ComfyUI" button.

import { useCallback, useEffect, useRef, useState } from "react";
import { Layers, Sparkles, X, Download, Square, Dice5, Plus, Trash2, ChevronLeft, ChevronRight, Maximize2, LayoutGrid, Info, Check, CheckSquare, Eraser, Wand2, RefreshCw, ImagePlus, FolderOpen } from "lucide-react";
import {
  DEFAULT_PARAMS,
  IMAGE_UPSCALE_MODELS,
  IMAGE_UPSCALE_FACTORS,
  getCheckpointArch,
  type GenerationParams,
  type ComfyUIProgress,
  type LoraEntry,
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
import { useGalleryDnd } from "@/lib/use-gallery-dnd";
import GalleryContextMenu from "@/components/GalleryContextMenu";
import { useToast } from "@/components/ToastProvider";
import { applyOutputMetadata, buildOutputSummary } from "@/lib/output-metadata";

const SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "dpmpp_sde", "ddim"] as const;
const SCHEDULERS = ["normal", "karras", "simple", "sgm_uniform", "beta", "exponential"] as const;

// ── Model families ──
// "Pony" is an SDXL fine-tune; we distinguish it by filename hint only (its file
// size classifies as sdxl). SD 1.5 vs SDXL is size-based via getCheckpointArch.
type Family = "sdxl" | "sd15" | "pony";
const FAMILIES: { id: Family; label: string; accent: string }[] = [
  { id: "sdxl", label: "SDXL", accent: "text-blue-300" },
  { id: "sd15", label: "SD 1.5", accent: "text-sky-300" },
  { id: "pony", label: "Pony", accent: "text-pink-300" },
];

function classifyFamily(name: string, sizeBytes: number | undefined): Family {
  if (name.toLowerCase().includes("pony")) return "pony";
  return getCheckpointArch(sizeBytes, name) === "sd15" ? "sd15" : "sdxl";
}

// Sensible per-family generation defaults.
const FAMILY_DEFAULTS: Record<Family, { width: number; height: number; steps: number; cfg: number }> = {
  sdxl: { width: 1024, height: 1024, steps: 30, cfg: 6.0 },
  pony: { width: 1024, height: 1024, steps: 28, cfg: 7.0 },
  sd15: { width: 512, height: 768, steps: 25, cfg: 7.0 },
};

const RES_PRESETS: Record<Family, { label: string; width: number; height: number }[]> = {
  sdxl: [
    { label: "1024×1024: Square", width: 1024, height: 1024 },
    { label: "832×1216: Portrait", width: 832, height: 1216 },
    { label: "1216×832: Landscape", width: 1216, height: 832 },
    { label: "896×1152: 3:4 Portrait", width: 896, height: 1152 },
    { label: "1152×896: 4:3 Landscape", width: 1152, height: 896 },
  ],
  pony: [
    { label: "1024×1024: Square", width: 1024, height: 1024 },
    { label: "832×1216: Portrait", width: 832, height: 1216 },
    { label: "1216×832: Landscape", width: 1216, height: 832 },
  ],
  sd15: [
    { label: "512×512: Square", width: 512, height: 512 },
    { label: "512×768: Portrait", width: 512, height: 768 },
    { label: "768×512: Landscape", width: 768, height: 512 },
    { label: "512×912: Tall", width: 512, height: 912 },
  ],
};

interface SdxlState {
  family: Family;
  checkpoint: string;
  positivePrompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  clipSkip: number;
  seed: number;
  randomSeed: boolean;
  loras: LoraEntry[];
  batch: number;
}

const INITIAL: SdxlState = {
  family: "sdxl",
  checkpoint: "",
  positivePrompt: "",
  negativePrompt: "blurry, low quality, worst quality, jpeg artifacts, watermark, text, deformed, extra limbs",
  width: 1024,
  height: 1024,
  steps: 30,
  cfg: 6.0,
  sampler: "dpmpp_2m",
  scheduler: "karras",
  clipSkip: 2,
  seed: -1,
  randomSeed: true,
  loras: [],
  batch: 1,
};

// Gallery image shape is shared across all image studios (shared gallery store).
type ResultImage = GalleryImage;

// Module-scope session cache: survives tab-switch remounts (studio-v2 unmounts
// inactive studios). Gallery results/view live in the SHARED store, not here.
const SESSION: { state: SdxlState; lastSeed: number | null } = {
  state: INITIAL,
  lastSeed: null,
};

export default function SdxlStudio() {
  const [s, setS] = useState<SdxlState>(() => SESSION.state);
  const update = useCallback(<K extends keyof SdxlState>(k: K, v: SdxlState[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
  }, []);
  // Copy a finished image's seed into the Workflow Controls (turns random off).
  // Drives the "Use Same Seed" right-click action and the clickable blue seed.
  const applySeed = useCallback((seed: number) => {
    setS((prev) => ({ ...prev, seed, randomSeed: false }));
  }, []);
  useEffect(() => { SESSION.state = s; }, [s]);

  // ── Checkpoints (scanned once, classified by family) ──
  const [ckpts, setCkpts] = useState<{ name: string; family: Family }[]>([]);
  const [ckptError, setCkptError] = useState<string | null>(null);
  const [loadingCkpts, setLoadingCkpts] = useState(true);
  const scanCheckpoints = useCallback(async () => {
    setLoadingCkpts(true);
    setCkptError(null);
    try {
      const [names, sizes] = await Promise.all([getCheckpoints(), getCheckpointSizes()]);
      const classified = names
        .map((name) => ({ name, family: classifyFamily(name, sizes[name]) }))
        // Exclude Flux/Klien-class checkpoints (handled by their own studios).
        // String-compared so this ports 1:1 to builds whose arch union lacks "klien".
        .filter((c) => String(getCheckpointArch(sizes[c.name], c.name)) !== "klien");
      setCkpts(classified);
    } catch {
      setCkptError("Could not reach ComfyUI: start it, then Rescan.");
    } finally {
      setLoadingCkpts(false);
    }
  }, []);
  useEffect(() => { void scanCheckpoints(); }, [scanCheckpoints]);

  const familyCkpts = ckpts.filter((c) => c.family === s.family);
  // Keep a valid checkpoint selected for the active family.
  useEffect(() => {
    if (familyCkpts.length === 0) return;
    if (!familyCkpts.some((c) => c.name === s.checkpoint)) {
      update("checkpoint", familyCkpts[0].name);
    }
  }, [s.family, ckpts]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchFamily = useCallback((family: Family) => {
    const d = FAMILY_DEFAULTS[family];
    setS((prev) => ({ ...prev, family, width: d.width, height: d.height, steps: d.steps, cfg: d.cfg, checkpoint: "" }));
  }, []);

  // ── LoRA manager ──
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

  // ── Lightbox + upscale selection ──
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [upModel, setUpModel] = useState<string>(IMAGE_UPSCALE_MODELS[0].value);
  const [upFactor, setUpFactor] = useState<number>(2);
  const [upscaling, setUpscaling] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

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
    toast(`Imported ${imported.length} image${imported.length > 1 ? "s" : ""}, select and Upscale`, "success");
  }, [toast, setResults]);

  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }, []);
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => (prev.size >= results.length ? new Set<string>() : new Set<string>(results.map(galleryKey))));
  }, [results]);
  const clearResults = useCallback(() => { setResults((prev) => { prev.forEach((r) => revokeIfBlob(r.url)); return []; }); setLightbox(null); setSelected(new Set()); }, [setResults]);

  // Shared right-click menu (Clear from Work Panel / Delete from Disk / Send to
  // Timeline Bin) + drag-and-drop (OS import, reorder, export to input fields).
  const {
    menu, closeMenu, openMenu,
    confirmState, setConfirmState,
    clearFromPanel, deleteFromDisk, sendToTimeline, reorder,
    refreshPresence, refreshing,
  } = useGalleryActions({ results, selected, setSelected, setLightbox, fromStudio: "SdxlStudio" });
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
  }, [results.length, lightbox]);

  const clientIdRef = useRef<string>("");
  if (!clientIdRef.current) {
    clientIdRef.current = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `vs2sdxl-${Date.now()}`;
  }
  const esRef = useRef<EventSource | null>(null);
  const cancelRef = useRef(false);

  const buildParams = useCallback((seedOverride?: number): GenerationParams => {
    const seed = seedOverride ?? (s.randomSeed || s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed);
    return {
      ...DEFAULT_PARAMS,
      checkpoint: s.checkpoint,
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
      denoise: 1.0,
      sourceImage: null,
      loras: s.loras,
      regionInfo: null,
    };
  }, [s]);

  useRegisterComfyWorkflow(
    useCallback(
      () => ({ workflow: buildWorkflow(buildParams(), "image") as Record<string, unknown>, name: "Vek-Snap SDXL" }),
      [buildParams],
    ),
  );

  const { startRender, updateRenderProgress, endRender, completeRender } = useRenderStatus();
  useEffect(() => () => { esRef.current?.close(); }, []);

  const stop = useCallback(() => {
    cancelRef.current = true;
    interruptGeneration().catch(() => {});
    esRef.current?.close();
  }, []);

  const runOne = useCallback(async (params: GenerationParams, label: string): Promise<ResultImage[]> => {
    const workflow = buildWorkflow(params, "image") as Record<string, unknown>;
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
          setStage(`${label}: step ${v}/${m}`);
          updateRenderProgress(v, m, `SDXL: ${label} ${v}/${m}`, Date.now());
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
    if (!s.positivePrompt.trim()) { setError("Enter a prompt to generate"); return; }
    setError(null);
    setGenerating(true);
    cancelRef.current = false;
    setProgress(0);
    setProgressMax(0);
    const total = Math.max(1, s.batch);
    setStage("Building workflow…");
    startRender("SDXL", "Building workflow…");
    const modelName = s.checkpoint.replace(/\.[^.]+$/, "");

    let produced = 0;
    try {
      for (let b = 0; b < total; b++) {
        if (cancelRef.current) break;
        const fixedBase = s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed;
        const seed = s.randomSeed ? Math.floor(Math.random() * 2 ** 32) : fixedBase + b;
        if (b === 0) setLastSeed(seed);
        const params = buildParams(seed);
        const imgs = await runOne(params, total > 1 ? `Image ${b + 1}/${total}` : "Sampling");
        if (cancelRef.current) break;
        if (imgs.length > 0) {
          const summary = buildOutputSummary({ model: modelName, seed, loras: s.loras });
          const withMeta: ResultImage[] = imgs.map((im) => ({ ...im, meta: { seed, model: modelName, loras: summary.loras } }));
          produced += withMeta.length;
          setResults((prev) => [...withMeta, ...prev].slice(0, GALLERY_MAX));
          void applyOutputMetadata({
            files: withMeta.map((im) => ({ filename: im.filename, subfolder: im.subfolder, type: im.type })),
            workflow: buildWorkflow(params, "image") as Record<string, unknown>,
            summary,
          });
        }
      }
      esRef.current?.close();
      if (cancelRef.current) { setStage("Stopped"); endRender(); return; }
      if (produced === 0) throw new Error("Generation finished but produced no image.");
      setStage("Complete");
      completeRender();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
      setStage("Failed");
      endRender();
    } finally {
      setGenerating(false);
    }
  }, [s.checkpoint, s.positivePrompt, s.batch, s.seed, s.randomSeed, s.loras, buildParams, runOne, startRender, completeRender, endRender]);

  const runUpscale = useCallback(async () => {
    const targets = results.filter((r) => selected.has(galleryKey(r))) as ResultImage[];
    if (targets.length === 0) return;
    setError(null);
    setUpscaling(true);
    const clientId = clientIdRef.current;
    const scaleBy = upFactor / 4;
    try {
      const produced: ResultImage[] = [];
      for (let t = 0; t < targets.length; t++) {
        const r = targets[t];
        setStage(`Upscaling ${t + 1}/${targets.length}…`);
        const resp = await fetch(r.url);
        if (!resp.ok) throw new Error(`Could not read image ${r.filename}`);
        const blob = await resp.blob();
        const inputName = await uploadImage(new File([blob], r.filename, { type: blob.type || "image/png" }));
        const wf: Record<string, unknown> = {
          "1": { class_type: "LoadImage", inputs: { image: inputName } },
          "2": { class_type: "UpscaleModelLoader", inputs: { model_name: upModel } },
          "3": { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
        };
        let outRef: [string, number] = ["3", 0];
        if (Math.abs(scaleBy - 1) > 0.001) {
          wf["4"] = { class_type: "ImageScaleBy", inputs: { image: ["3", 0], upscale_method: "lanczos", scale_by: scaleBy } };
          outRef = ["4", 0];
        }
        wf["9"] = { class_type: "SaveImage", inputs: { images: outRef, filename_prefix: "veksnap_upscaled" } };
        const queueRes = await queuePrompt(wf, clientId);
        const promptId = queueRes.prompt_id;
        const before = produced.length;
        let done = false;
        for (let i = 0; i < 300 && !done; i++) {
          await new Promise((res) => setTimeout(res, 1000));
          const hist = await getHistory(promptId);
          if (hist?.status?.status_str === "error") throw new Error("ComfyUI reported an error during upscale.");
          if (hist?.outputs) {
            for (const nodeOut of Object.values(hist.outputs)) {
              const node = nodeOut as { images?: Array<{ filename: string; subfolder?: string; type?: string }> };
              if (node.images) for (const im of node.images) produced.push({ url: getImageUrl(im.filename, im.subfolder ?? "", im.type ?? "output"), filename: im.filename, subfolder: im.subfolder ?? "", type: im.type ?? "output" });
            }
            if (produced.length > before) done = true;
          }
        }
      }
      if (produced.length > 0) {
        setResults((prev) => [...produced, ...prev].slice(0, GALLERY_MAX));
        setSelected(new Set());
      }
      setStage("Upscale complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upscale failed");
      setStage("Upscale failed");
    } finally {
      setUpscaling(false);
    }
  }, [selected, results, upFactor, upModel]);

  const pct = progressMax > 0 ? Math.round((progress / progressMax) * 100) : 0;
  const familyLabel = FAMILIES.find((f) => f.id === s.family)!.label;
  const ready = !!s.checkpoint && !!s.positivePrompt.trim();

  return (
    <div className="h-full flex flex-col lg:flex-row gap-4 min-h-0 overflow-y-auto lg:overflow-hidden">
      {/* ── Controls column: projected into the shell's Workflow Controls panel ── */}
      <WorkflowControls>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Layers className="w-4 h-4 text-blue-400" />
          {familyLabel}
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground">text → img</span>
        </div>

        {/* Model family */}
        <div className="flex gap-1 p-1 rounded-lg bg-muted/40 border border-border/50">
          {FAMILIES.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => switchFamily(f.id)}
              className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                s.family === f.id ? `bg-blue-500/20 ${f.accent}` : "text-muted-foreground/70 hover:text-foreground hover:bg-foreground/5"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Checkpoint */}
        <div className="flex items-center justify-between">
          <label className="text-[11px] text-muted-foreground">Checkpoint</label>
          <button type="button" onClick={() => void scanCheckpoints()} className="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300" title="Rescan checkpoints">
            <RefreshCw className={`w-3 h-3 ${loadingCkpts ? "animate-spin" : ""}`} /> Rescan
          </button>
        </div>
        <select
          value={s.checkpoint}
          onChange={(e) => update("checkpoint", e.target.value)}
          disabled={loadingCkpts || familyCkpts.length === 0}
          className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
        >
          {familyCkpts.length === 0 ? (
            <option value="">{loadingCkpts ? "Scanning…" : `No ${familyLabel} checkpoints found`}</option>
          ) : (
            familyCkpts.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)
          )}
        </select>
        {ckptError && <p className="text-[10px] text-amber-400">{ckptError}</p>}

        {/* Prompt */}
        <label className="text-[11px] text-muted-foreground mt-1">Prompt</label>
        <textarea
          value={s.positivePrompt}
          onChange={(e) => update("positivePrompt", e.target.value)}
          placeholder="Describe the image you want…"
          rows={4}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs resize-y focus:outline-none focus:ring-1 focus:ring-blue-500/50"
        />

        <label className="text-[11px] text-muted-foreground">Negative prompt</label>
        <textarea
          value={s.negativePrompt}
          onChange={(e) => update("negativePrompt", e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs resize-y focus:outline-none focus:ring-1 focus:ring-blue-500/50"
        />

        {/* Resolution */}
        <label className="text-[11px] text-muted-foreground">Resolution</label>
        <select
          value={`${s.width}x${s.height}`}
          onChange={(e) => {
            const preset = RES_PRESETS[s.family].find((p) => `${p.width}x${p.height}` === e.target.value);
            if (preset) { update("width", preset.width); update("height", preset.height); }
          }}
          className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50"
        >
          {!RES_PRESETS[s.family].some((p) => p.width === s.width && p.height === s.height) && (
            <option value={`${s.width}x${s.height}`}>{s.width}×{s.height}: Custom</option>
          )}
          {RES_PRESETS[s.family].map((p) => <option key={p.label} value={`${p.width}x${p.height}`}>{p.label}</option>)}
        </select>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-muted-foreground">Width</label>
            <input type="number" min={256} max={2048} step={8} value={s.width}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) update("width", v); }}
              onBlur={(e) => { const v = parseInt(e.target.value, 10); update("width", Math.min(2048, Math.max(256, Math.round((isNaN(v) ? 512 : v) / 8) * 8))); }}
              className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Height</label>
            <input type="number" min={256} max={2048} step={8} value={s.height}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) update("height", v); }}
              onBlur={(e) => { const v = parseInt(e.target.value, 10); update("height", Math.min(2048, Math.max(256, Math.round((isNaN(v) ? 512 : v) / 8) * 8))); }}
              className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50" />
          </div>
        </div>

        {/* Steps + CFG */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground"><span>Steps</span><span className="font-mono">{s.steps}</span></div>
            <input type="range" min={1} max={60} step={1} value={s.steps} onChange={(e) => update("steps", parseInt(e.target.value))} className="w-full h-1 accent-blue-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground"><span>CFG</span><span className="font-mono">{s.cfg.toFixed(1)}</span></div>
            <input type="range" min={1} max={20} step={0.1} value={s.cfg} onChange={(e) => update("cfg", parseFloat(e.target.value))} className="w-full h-1 accent-blue-500" />
          </div>
        </div>

        {/* Sampler + Scheduler */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-muted-foreground">Sampler</label>
            <select value={s.sampler} onChange={(e) => update("sampler", e.target.value)} className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50">
              {SAMPLERS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Scheduler</label>
            <select value={s.scheduler} onChange={(e) => update("scheduler", e.target.value)} className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500/50">
              {SCHEDULERS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        </div>

        {/* CLIP skip */}
        <div>
          <div className="flex justify-between text-[10px] text-muted-foreground"><span>CLIP skip</span><span className="font-mono">{s.clipSkip}</span></div>
          <input type="range" min={1} max={4} step={1} value={s.clipSkip} onChange={(e) => update("clipSkip", parseInt(e.target.value))} className="w-full h-1 accent-blue-500" />
        </div>

        {/* Seed */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => update("randomSeed", !s.randomSeed)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border transition-colors ${s.randomSeed ? "border-blue-500/40 bg-blue-500/15 text-blue-300" : "border-border text-muted-foreground hover:bg-foreground/5"}`}
            title="Randomize the seed each run"
          >
            <Dice5 className="w-3.5 h-3.5" /> Random
          </button>
          <input
            type="number"
            value={s.randomSeed ? "" : s.seed}
            disabled={s.randomSeed}
            placeholder={s.randomSeed ? "random" : "seed"}
            onChange={(e) => update("seed", parseInt(e.target.value) || 0)}
            className="flex-1 h-8 rounded-lg border border-border bg-background px-2 text-xs disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
          />
          {lastSeed != null && (
            <button type="button" onClick={() => { update("randomSeed", false); update("seed", lastSeed); }} className="text-[10px] text-muted-foreground hover:text-blue-400" title="Reuse the last seed">
              ↺ {lastSeed}
            </button>
          )}
        </div>

        {/* LoRAs */}
        <div className="rounded-lg border border-border/60 bg-foreground/5 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-blue-400" /> LoRAs</span>
            <button type="button" onClick={addLora} className="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-300"><Plus className="w-3 h-3" /> Add</button>
          </div>
          {s.loras.length === 0 && <p className="text-[10px] text-muted-foreground/60">No LoRAs: runs with the base checkpoint.</p>}
          {s.loras.map((l, i) => (
            <div key={i} className="space-y-1 border-t border-border/40 pt-1.5 first:border-t-0 first:pt-0">
              <div className="flex items-center gap-1.5">
                <input type="checkbox" checked={l.enabled} onChange={(e) => updateLora(i, { enabled: e.target.checked })} className="accent-blue-500" title="Enable this LoRA" />
                <LoraSelect value={l.name} options={loraOptions} onChange={(name) => updateLora(i, { name })} compatMode="image" />
                <button type="button" onClick={() => removeLora(i)} className="text-muted-foreground hover:text-destructive" title="Remove LoRA"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-muted-foreground w-14">Strength</span>
                <input type="range" min={-2} max={2} step={0.05} value={l.strengthModel} onChange={(e) => { const v = parseFloat(e.target.value); updateLora(i, { strengthModel: v, strengthClip: v }); }} className="flex-1 h-1 accent-blue-500" />
                <span className="text-[9px] font-mono text-blue-400 w-8 text-right">{l.strengthModel.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Batch */}
        <div>
          <div className="flex justify-between text-[10px] text-muted-foreground"><span>Batch (images per run)</span><span className="font-mono">{s.batch}</span></div>
          <input type="range" min={1} max={8} step={1} value={s.batch} onChange={(e) => update("batch", parseInt(e.target.value))} className="w-full h-1 accent-blue-500" />
        </div>

        {/* Generate / Stop: locked footer: pinned to the bottom of the dock so the action
            + live progress stay visible no matter which sections are scrolled. */}
        <div className="sticky bottom-0 z-10 mt-1 rounded-xl border border-blue-500/25 bg-[var(--sidebar)]/95 backdrop-blur p-2.5 space-y-2 shadow-[0_-4px_12px_rgba(0,0,0,0.25)]">
        {generating ? (
          <button onClick={stop} className="w-full h-10 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-sm font-medium flex items-center justify-center gap-2">
            <Square className="w-4 h-4" /> Stop
          </button>
        ) : (
          <button
            onClick={() => void generate()}
            className={`w-full h-10 rounded-lg text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
              ready ? "vek-generate-glow bg-blue-600/80 hover:bg-blue-500" : "bg-blue-600/40"
            }`}
          >
            <Sparkles className="w-4 h-4" /> Generate
          </button>
        )}
        {!generating && (
          <SendToQueueButton
            className="w-full"
            disabled={!ready}
            getJobs={() => {
              const total = Math.max(1, s.batch);
              const fixedBase = s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed;
              return Array.from({ length: total }, (_, b) => {
                const seed = s.randomSeed ? Math.floor(Math.random() * 2 ** 32) : fixedBase + b;
                return { workflow: buildWorkflow(buildParams(seed), "image") as Record<string, unknown>, name: "SDXL · SD1.5 · Pony", outputKind: "image" as const };
              });
            }}
          />
        )}

        {(generating || stage) && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground"><span>{stage}</span>{progressMax > 0 && <span className="font-mono">{pct}%</span>}</div>
            <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
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
          <span className="text-[11px] text-muted-foreground">
            {results.length > 0 ? `${results.length} image${results.length > 1 ? "s" : ""}` : "Gallery"}
          </span>
          <button type="button" onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-border text-muted-foreground hover:text-blue-300 hover:border-blue-500/40 transition-colors"
            title="Load image files into the shared gallery to upscale them"><ImagePlus className="w-3.5 h-3.5" /> Import</button>
          <button type="button" onClick={() => importDirRef.current?.click()}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border text-muted-foreground hover:text-blue-300 hover:border-blue-500/40 transition-colors"
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
                  className={`w-5 h-5 rounded text-[10px] font-mono border transition-colors ${previewCols === c ? "border-blue-500/50 bg-blue-500/15 text-blue-300" : "border-border text-muted-foreground hover:bg-foreground/5"}`}
                  title={`${c} per row`}>{c}</button>
              ))}
            </div>
            <button type="button" onClick={() => setShowDetails((v) => !v)}
              className={`inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border transition-colors ${showDetails ? "border-blue-500/40 bg-blue-500/15 text-blue-300" : "border-border text-muted-foreground hover:bg-foreground/5"}`}
              title="Show image details"><Info className="w-3.5 h-3.5" /> Details</button>
            <button type="button" onClick={() => setConfirmClear(true)} disabled={results.length === 0}
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40 transition-colors"
              title="Clear all images from the gallery"><Eraser className="w-3.5 h-3.5" /> Clear All</button>
          </div>
        </div>

        <div {...containerProps} className={`flex-1 min-h-0 overflow-y-auto p-3 transition-colors ${dragActive ? "ring-2 ring-inset ring-blue-500/60 bg-blue-500/5" : ""}`}>
          {results.length === 0 ? (
            <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-muted-foreground/50 gap-2">
              <Layers className="w-10 h-10" />
              <p className="text-xs">Generated images appear here</p>
              <p className="text-[10px] text-muted-foreground/40">Pick a {familyLabel} checkpoint and Generate, or drag &amp; drop images here</p>
            </div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${previewCols}, minmax(0, 1fr))` }}>
              {results.map((r, i) => (
                <div key={`${r.filename}-${i}`} {...getItemProps(i, r)} onContextMenu={(e) => openMenu(e, galleryKey(r))} className={`group relative rounded-lg overflow-hidden border bg-background cursor-grab active:cursor-grabbing ${selected.has(galleryKey(r)) ? "border-blue-500 ring-2 ring-blue-500/50" : "border-border/60"} ${dragOverIndex === i ? "ring-2 ring-blue-400" : ""}`}>
                  <button type="button" onClick={(e) => { e.stopPropagation(); toggleSelect(galleryKey(r)); }}
                    className={`absolute top-2 right-2 z-10 inline-flex items-center justify-center w-6 h-6 rounded-md border transition-colors ${selected.has(galleryKey(r)) ? "bg-blue-600 border-blue-500 text-white" : "bg-black/50 border-white/50 text-transparent hover:text-white/70"}`}
                    title={selected.has(galleryKey(r)) ? "Deselect" : "Select for upscale"}><Check className="w-3.5 h-3.5" /></button>
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
                        className="font-mono text-blue-400/80 hover:text-blue-300 hover:underline cursor-pointer"
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
            <span className="text-[11px] text-blue-300 font-medium">{selected.size} selected</span>
            <select value={upModel} onChange={(e) => setUpModel(e.target.value)} disabled={upscaling} className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500/50">
              {IMAGE_UPSCALE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <select value={upFactor} onChange={(e) => setUpFactor(parseInt(e.target.value, 10))} disabled={upscaling} className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500/50">
              {IMAGE_UPSCALE_FACTORS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <button type="button" onClick={() => void runUpscale()} disabled={upscaling} className="ml-auto inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-medium">
              <Wand2 className="w-3.5 h-3.5" /> {upscaling ? "Upscaling…" : `Upscale ${selected.size}`}
            </button>
          </div>
        )}
      </div>

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
