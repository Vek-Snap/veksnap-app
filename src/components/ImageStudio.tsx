"use client";

// ── Image Studio (Studio v2) ──────────────────────────────────────────────────
// A self-contained, professional industry standard-styled image generator for the polished /studio-v2
// shell. STAGE 1 = Z-Image Turbo (the modern default image engine): txt2img +
// img2img (source-image refinement).
//
// Design note: this is a v2-NATIVE studio with its own local state - it does NOT
// touch the classic `page.tsx` (which keeps its inline image modes as the
// shipping fallback). It reuses the shared library exactly like the other v2
// studios (LTX2Studio, AceStepStudio): `buildWorkflow(params, "zimage")` +
// `@/lib/comfyui-api` for queue/stream/history, and self-registers for the
// global "Open in ComfyUI" button. Compose/Re-Imagine, plain-SD, outpaint and
// smart-upscale are deliberately deferred to later stages.

import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Sparkles, Upload, X, Wand2, Download, Square, Dice5, Plus, Trash2, ChevronLeft, ChevronRight, Maximize2, LayoutGrid, Info, Eraser, Check, CheckSquare, ImagePlus, FolderOpen, RefreshCw } from "lucide-react";
import {
  DEFAULT_PARAMS,
  ZIMAGE_RESOLUTION_PRESETS,
  ZIMAGE_PROMPT_PRESETS,
  ZIMAGE_ENHANCE,
  ZIMAGE_FACE,
  CHARACTER_CARD_VIEWS,
  CHARACTER_CARD_NEGATIVE,
  CHARACTER_CARD_IDENTITY_PRESETS,
  IMAGE_UPSCALE_MODELS,
  IMAGE_UPSCALE_FACTORS,
  type GenerationParams,
  type ComfyUIProgress,
  type LoraEntry,
} from "@/lib/types";
import { buildWorkflow } from "@/lib/workflow-builder";
import {
  queuePrompt,
  getHistory,
  getImageUrl,
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
import { useGalleryDnd, useImageDropTarget } from "@/lib/use-gallery-dnd";
import GalleryContextMenu from "@/components/GalleryContextMenu";
import { useToast } from "@/components/ToastProvider";
import { applyOutputMetadata, buildOutputSummary } from "@/lib/output-metadata";

const SAMPLERS = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "res_multistep"] as const;
const SCHEDULERS = ["simple", "normal", "karras", "sgm_uniform", "beta"] as const;

// Parse a free-form prompt list (.txt) into individual prompts. Blocks are split
// on blank lines; short "title" lines (e.g. "Pose 1: …:" ending in a colon) and
// header lines (e.g. "Possible Golden Seed: …") are skipped. The long paragraphs
// that remain are the actual prompts.
function parsePromptList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((line) => {
      if (line.length < 40) return false;               // titles/blank lines
      if (/:\s*$/.test(line)) return false;              // "Pose 1: …:" titles
      if (/^possible golden seed/i.test(line)) return false;
      return true;
    });
}

// The fields the Z-Image builders actually read (see buildZImageTurbo/I2I).
interface ImageStudioState {
  positivePrompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  randomSeed: boolean;
  denoise: number;        // only used for img2img
  sourceImage: string | null; // ComfyUI-uploaded filename (img2img source)
  loras: LoraEntry[];
  batch: number;          // images per run
  multiTurnEnabled: boolean;    // batch: use Z-Image multi-turn character consistency
  characterDefinition: string;  // batch: Turn-1 identity block shared across all poses
  // ── "Enhance Details" (prompt-guided detail restoration) ──
  enhanceDetails: boolean;
  enhanceAppendPrompt: boolean;
  // ── "Face Repair" (region-targeted semantic face repair, Phase 2a) ──
  faceRepair: boolean;
  faceAppendPrompt: boolean;
  faceDenoise: number;
  faceGuideSize: number;
  faceThreshold: number;
  faceDilation: number;
  faceFeather: number;
}

const INITIAL: ImageStudioState = {
  positivePrompt: "",
  negativePrompt: "blurry, blurry eyes, low quality, bad quality, out of frame head",
  width: 896,
  height: 1152,
  steps: 20,
  cfg: 1.0,
  sampler: "euler",
  scheduler: "simple",
  seed: -1,
  randomSeed: true,
  denoise: 0.5,
  sourceImage: null,
  loras: [],
  batch: 1,
  enhanceDetails: false,
  enhanceAppendPrompt: false,
  faceRepair: false,
  faceAppendPrompt: false,
  faceDenoise: ZIMAGE_FACE.DENOISE,
  faceGuideSize: ZIMAGE_FACE.GUIDE_SIZE,
  faceThreshold: ZIMAGE_FACE.BBOX_THRESHOLD,
  faceDilation: ZIMAGE_FACE.BBOX_DILATION,
  faceFeather: ZIMAGE_FACE.FEATHER,
  multiTurnEnabled: false,
  characterDefinition: "",
};

// The gallery image shape is shared across all image studios (see the shared
// gallery store). Kept as a local alias so existing call-sites read naturally.
type ResultImage = GalleryImage;

// Module-scope session cache: the Modern shell (studio-v2) unmounts inactive
// studios on tab switch, which would reset all local state to INITIAL. Caching
// here keeps prompt + settings alive across remounts for the app session (a full
// page reload still starts fresh). NOTE: gallery results + view settings are NOT
// cached here: they live in the shared image-gallery store so all three image
// studios read/write one persistent pool.
const SESSION: {
  state: ImageStudioState;
  lastSeed: number | null;
} = {
  state: INITIAL,
  lastSeed: null,
};

export default function ImageStudio() {
  const [s, setS] = useState<ImageStudioState>(() => SESSION.state);
  const update = useCallback(<K extends keyof ImageStudioState>(k: K, v: ImageStudioState[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
  }, []);

  // Copy a finished image's seed into the Workflow Controls (turns random off).
  // Drives both the "Use Same Seed" right-click action and the clickable blue
  // seed shown in the Details overlay.
  const applySeed = useCallback((seed: number) => {
    setS((prev) => ({ ...prev, seed, randomSeed: false }));
  }, []);

  // ── LoRA manager (Z-Image builders honor params.loras) ──
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

  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Gallery results + view settings come from the SHARED store so the pool is
  // identical and persistent across all three image studios.
  const [results, setResults] = useGalleryResults();
  const { cols: previewCols, setCols: setPreviewCols, details: showDetails, setDetails: setShowDetails } = useGalleryView();
  const [lastSeed, setLastSeed] = useState<number | null>(() => SESSION.lastSeed);

  // Write working state back to the session cache so tab-switch remounts restore it.
  useEffect(() => { SESSION.state = s; }, [s]);
  useEffect(() => { SESSION.lastSeed = lastSeed; }, [lastSeed]);

  // ── Fullscreen lightbox ──
  const [lightbox, setLightbox] = useState<number | null>(null);

  // ── Upscale selection (commercial-safe ESRGAN models only) ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [upModel, setUpModel] = useState<string>(IMAGE_UPSCALE_MODELS[0].value);
  const [upFactor, setUpFactor] = useState<number>(2);
  const [upscaling, setUpscaling] = useState(false);
  const toggleSelect = useCallback((key: string) => {
    setSelected((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }, []);
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => (prev.size >= results.length ? new Set<string>() : new Set<string>(results.map(galleryKey))));
  }, [results]);

  const clearResults = useCallback(() => {
    setResults((prev) => { prev.forEach((r) => revokeIfBlob(r.url)); return []; });
    setLightbox(null);
    setSelected(new Set());
  }, []);

  // ── Gallery item actions (right-click menu / timeline / reorder) ──
  // Shared across all image studios so functionality is identical everywhere.
  const { toast } = useToast();
  const {
    menu, closeMenu, openMenu,
    confirmState, setConfirmState,
    clearFromPanel, deleteFromDisk, sendToTimeline, reorder,
    refreshPresence, refreshing,
  } = useGalleryActions({ results, selected, setSelected, setLightbox, fromStudio: "ImageStudio" });

  // ── Import existing images (files or a whole folder) so they can be run
  //    through Enhance/Upscale exactly like freshly-generated results. ──
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const importDirRef = useRef<HTMLInputElement | null>(null);
  const batchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // `webkitdirectory` isn't a typed React prop, set it imperatively so the
    // second picker selects a directory (Chromium/Electron).
    const el = importDirRef.current;
    if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); }
  }, []);
  const importFiles = useCallback((fileList: FileList | null) => {
    const imported = makeImportedImages(fileList);
    if (imported.length === 0) { toast("No image files found in that selection", "warning"); return; }
    setResults((prev) => [...imported, ...prev].slice(0, GALLERY_MAX));
    toast(`Imported ${imported.length} image${imported.length > 1 ? "s" : ""}, select and Enhance`, "success");
  }, [toast, setResults]);

  // Shared drag-and-drop: OS import, reorder, and export to input fields.
  const { dragActive, dragOverIndex, containerProps, getItemProps } = useGalleryDnd({ importFiles, reorder });

  const showPrev = useCallback(() => setLightbox((i) => (i === null ? null : (i - 1 + results.length) % results.length)), [results.length]);
  const showNext = useCallback(() => setLightbox((i) => (i === null ? null : (i + 1) % results.length)), [results.length]);

  // Keyboard: left/right cycle, Esc close - only while the lightbox is open.
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

  // Keep the open index + selection valid if the gallery shrinks or is cleared.
  useEffect(() => {
    if (lightbox !== null && lightbox >= results.length) setLightbox(results.length ? results.length - 1 : null);
    setSelected((prev) => {
      const valid = new Set(results.map(galleryKey));
      const next = new Set([...prev].filter((k) => valid.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [results, lightbox]);

  const clientIdRef = useRef<string>("");
  if (!clientIdRef.current) {
    clientIdRef.current =
      typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `vs2img-${Date.now()}`;
  }
  const esRef = useRef<EventSource | null>(null);
  const cancelRef = useRef(false);

  // Build a full GenerationParams from our scoped state for the shared builder.
  // `overrides` lets batch flows (e.g. Character Card) swap the prompt / size
  // without mutating the studio state; the resolved seed is never overridden.
  const buildParams = useCallback((seedOverride?: number, overrides?: Partial<GenerationParams>): GenerationParams => {
    const seed = seedOverride ?? (s.randomSeed || s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed);
    return {
      ...DEFAULT_PARAMS,
      positivePrompt: s.positivePrompt,
      negativePrompt: s.negativePrompt,
      width: s.width,
      height: s.height,
      steps: s.steps,
      cfg: s.cfg,
      sampler: s.sampler,
      scheduler: s.scheduler,
      seed,
      randomSeed: false, // seed already resolved
      denoise: s.denoise,
      sourceImage: s.sourceImage,
      loras: s.loras,
      regionInfo: null,
      // Enhance Details: only meaningful with a source image
      zimageEnhanceDetails: s.enhanceDetails,
      zimageEnhanceAppendPrompt: s.enhanceAppendPrompt,
      // Face Repair (Phase 2a): only meaningful with a source image
      zimageFaceRepair: s.faceRepair,
      zimageFaceAppendPrompt: s.faceAppendPrompt,
      zimageFaceDenoise: s.faceDenoise,
      zimageFaceGuideSize: s.faceGuideSize,
      zimageFaceThreshold: s.faceThreshold,
      zimageFaceDilation: s.faceDilation,
      zimageFaceFeather: s.faceFeather,
      ...overrides,
    };
  }, [s]);

  // Register with the global "Open in ComfyUI" button (uses a non-resolved seed
  // snapshot: fine for opening the graph).
  useRegisterComfyWorkflow(
    useCallback(
      () => ({
        workflow: buildWorkflow(buildParams(), "zimage") as Record<string, unknown>,
        name: "Vek-Snap Z-Image",
      }),
      [buildParams],
    ),
  );

  const { startRender, updateRenderProgress, endRender, completeRender } = useRenderStatus();

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  const onPickSource = useCallback(async (file: File) => {
    try {
      setError(null);
      setStage("Uploading source image…");
      const name = await uploadImage(file);
      update("sourceImage", name);
      setSourcePreview(URL.createObjectURL(file));
      setStage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Image upload failed");
      setStage("");
    }
  }, [update]);

  const clearSource = useCallback(() => {
    update("sourceImage", null);
    setSourcePreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, [update]);

  // Drop a gallery thumbnail (or OS image) onto the source field for img2img.
  const sourceDrop = useImageDropTarget(onPickSource);

  const stop = useCallback(() => {
    cancelRef.current = true;
    interruptGeneration().catch(() => {});
    esRef.current?.close();
  }, []);

  // Run a single image end-to-end (queue → stream progress → poll history).
  const runOne = useCallback(async (params: GenerationParams, label: string): Promise<ResultImage[]> => {
    const workflow = buildWorkflow(params, "zimage") as Record<string, unknown>;
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
          updateRenderProgress(v, m, `Z-Image: ${label} ${v}/${m}`, Date.now());
        }
      },
      () => {},
      () => {},
    );
    const queueRes = await queuePrompt(workflow, clientId);
    const promptId = queueRes.prompt_id;
    for (let i = 0; i < 600; i++) {
      if (cancelRef.current) break;
      await new Promise((r) => setTimeout(r, 1000));
      const hist = await getHistory(promptId);
      if (hist?.status?.status_str === "error") {
        throw new Error("ComfyUI reported an execution error: check the ComfyUI logs.");
      }
      if (hist?.outputs) {
        const imgs: ResultImage[] = [];
        for (const nodeOut of Object.values(hist.outputs)) {
          const node = nodeOut as { images?: Array<{ filename: string; subfolder?: string; type?: string }> };
          if (node.images) {
            for (const im of node.images) {
              imgs.push({ url: getImageUrl(im.filename, im.subfolder ?? "", im.type ?? "output"), filename: im.filename, subfolder: im.subfolder ?? "", type: im.type ?? "output" });
            }
          }
        }
        if (imgs.length > 0) return imgs;
      }
    }
    return [];
  }, [updateRenderProgress]);

  // Upscale the selected gallery images with a permissively-licensed ESRGAN model.
  // Each output image is re-uploaded as a ComfyUI input, then run through
  // UpscaleModelLoader → ImageUpscaleWithModel (native 4x) → optional ImageScaleBy → SaveImage.
  const runUpscale = useCallback(async () => {
    const targets = results.filter((r) => selected.has(galleryKey(r))) as ResultImage[];
    if (targets.length === 0) return;
    setError(null);
    setUpscaling(true);
    const clientId = clientIdRef.current;
    const scaleBy = upFactor / 4; // both safe models are native 4x
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
          if (hist?.status?.status_str === "error") throw new Error("ComfyUI reported an error during upscale: check the ComfyUI logs.");
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
        void applyOutputMetadata({
          files: produced.map((p) => ({ filename: p.filename, subfolder: p.subfolder, type: p.type })),
          workflow: null,
          summary: buildOutputSummary({ model: `Upscaled (${upModel})`, seed: null, loras: [] }),
        });
      }
      setStage("Upscale complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upscale failed");
      setStage("Upscale failed");
    } finally {
      setUpscaling(false);
    }
  }, [selected, results, upFactor, upModel]);

  const generate = useCallback(async () => {
    if (!s.positivePrompt.trim()) { setError("Enter a prompt to generate"); return; }
    setError(null);
    setGenerating(true);
    cancelRef.current = false;
    setProgress(0);
    setProgressMax(0);
    const total = Math.max(1, s.batch);
    setStage("Building workflow…");
    startRender("Z-Image", "Building workflow…");

    let produced = 0;
    try {
      for (let b = 0; b < total; b++) {
        if (cancelRef.current) break;
        // Random seed each image; fixed seed increments per image for variety.
        const fixedBase = s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed;
        const seed = s.randomSeed ? Math.floor(Math.random() * 2 ** 32) : fixedBase + b;
        if (b === 0) setLastSeed(seed);
        const params = buildParams(seed);
        const imgs = await runOne(params, total > 1 ? `Image ${b + 1}/${total}` : "Sampling");
        if (cancelRef.current) break;
        if (imgs.length > 0) {
          const summary = buildOutputSummary({ model: "Z-Image Turbo", seed, loras: s.loras });
          const withMeta: ResultImage[] = imgs.map((im) => ({ ...im, meta: { seed, model: "Z-Image Turbo", loras: summary.loras } }));
          produced += withMeta.length;
          setResults((prev) => [...withMeta, ...prev].slice(0, GALLERY_MAX));
          // Embed the enabled metadata options (self-gates; no-op when all off).
          void applyOutputMetadata({
            files: withMeta.map((im) => ({ filename: im.filename, subfolder: im.subfolder, type: im.type })),
            workflow: buildWorkflow(params, "zimage") as Record<string, unknown>,
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
  }, [s.positivePrompt, s.batch, s.seed, s.randomSeed, buildParams, runOne, startRender, completeRender, endRender]);

  // Character Card: run the six turnaround views at ONE locked seed, wrapping
  // the identity block from the prompt box. Each view is full-frame (its own
  // resolution) so detail stays sharp; assemble the card from the results.
  const generateCharacterCard = useCallback(async () => {
    const identity = s.positivePrompt.trim();
    if (!identity) { setError("Enter or pick a character identity first (Character Card)"); return; }
    setError(null);
    setGenerating(true);
    cancelRef.current = false;
    setProgress(0);
    setProgressMax(0);
    const lockedSeed = s.randomSeed || s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed;
    setLastSeed(lockedSeed);
    setStage("Character card…");
    startRender("Z-Image", "Character card…");

    let produced = 0;
    try {
      for (let i = 0; i < CHARACTER_CARD_VIEWS.length; i++) {
        if (cancelRef.current) break;
        const v = CHARACTER_CARD_VIEWS[i];
        const params = buildParams(lockedSeed, {
          positivePrompt: v.prompt.replace("{IDENTITY}", identity),
          negativePrompt: CHARACTER_CARD_NEGATIVE,
          width: v.width,
          height: v.height,
          denoise: 1.0,
          sourceImage: null,
        });
        const imgs = await runOne(params, `Card ${i + 1}/${CHARACTER_CARD_VIEWS.length}: ${v.label}`);
        if (cancelRef.current) break;
        if (imgs.length > 0) {
          const summary = buildOutputSummary({ model: "Z-Image Turbo", seed: lockedSeed, loras: s.loras });
          const withMeta: ResultImage[] = imgs.map((im) => ({ ...im, meta: { seed: lockedSeed, model: "Z-Image Turbo", loras: summary.loras } }));
          produced += withMeta.length;
          setResults((prev) => [...withMeta, ...prev].slice(0, GALLERY_MAX));
          void applyOutputMetadata({
            files: withMeta.map((im) => ({ filename: im.filename, subfolder: im.subfolder, type: im.type })),
            workflow: buildWorkflow(params, "zimage") as Record<string, unknown>,
            summary,
          });
        }
      }
      esRef.current?.close();
      if (cancelRef.current) { setStage("Stopped"); endRender(); return; }
      if (produced === 0) throw new Error("Character card produced no images.");
      setStage(`Character card complete, seed ${lockedSeed}`);
      completeRender();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Character card failed");
      setStage("Failed");
      endRender();
    } finally {
      setGenerating(false);
    }
  }, [s.positivePrompt, s.randomSeed, s.seed, s.loras, buildParams, runOne, startRender, completeRender, endRender]);

  // Batch Prompts: same format as Character Card - run a list of prompts
  // sequentially at ONE locked seed, reusing the current settings & LoRAs.
  // Each prompt overrides only the positive prompt; everything else is as set.
  const generateBatchPrompts = useCallback(async (prompts: string[]) => {
    if (prompts.length === 0) { setError("No prompts found in that file"); return; }
    setError(null);
    setGenerating(true);
    cancelRef.current = false;
    setProgress(0);
    setProgressMax(0);
    const lockedSeed = s.randomSeed || s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed;
    setLastSeed(lockedSeed);
    setStage(`Batch prompts (0/${prompts.length})…`);
    startRender("Z-Image", "Batch prompts…");

    let produced = 0;
    try {
      for (let i = 0; i < prompts.length; i++) {
        if (cancelRef.current) break;
        const useMultiTurn = s.multiTurnEnabled && s.characterDefinition.trim().length > 0;
        const params = buildParams(lockedSeed, {
          positivePrompt: prompts[i],
          ...(useMultiTurn ? { zimageMultiTurn: true, zimageCharacterDefinition: s.characterDefinition } : {}),
        });
        const imgs = await runOne(params, `Prompt ${i + 1}/${prompts.length}`);
        if (cancelRef.current) break;
        if (imgs.length > 0) {
          const summary = buildOutputSummary({ model: "Z-Image Turbo", seed: lockedSeed, loras: s.loras });
          const withMeta: ResultImage[] = imgs.map((im) => ({ ...im, meta: { seed: lockedSeed, model: "Z-Image Turbo", loras: summary.loras } }));
          produced += withMeta.length;
          setResults((prev) => [...withMeta, ...prev].slice(0, GALLERY_MAX));
          void applyOutputMetadata({
            files: withMeta.map((im) => ({ filename: im.filename, subfolder: im.subfolder, type: im.type })),
            workflow: buildWorkflow(params, "zimage") as Record<string, unknown>,
            summary,
          });
        }
      }
      esRef.current?.close();
      if (cancelRef.current) { setStage("Stopped"); endRender(); return; }
      if (produced === 0) throw new Error("Batch produced no images.");
      setStage(`Batch complete, ${produced} image${produced !== 1 ? "s" : ""}, seed ${lockedSeed}`);
      completeRender();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch failed");
      setStage("Failed");
      endRender();
    } finally {
      setGenerating(false);
    }
  }, [s.randomSeed, s.seed, s.loras, s.multiTurnEnabled, s.characterDefinition, buildParams, runOne, startRender, completeRender, endRender]);

  // Load a .txt prompt list from disk, parse it, and run the batch.
  const onPickPromptList = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const prompts = parsePromptList(text);
      if (prompts.length === 0) { setError("No prompts found in that .txt file"); return; }
      await generateBatchPrompts(prompts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read prompt file");
    }
  }, [generateBatchPrompts]);

  const pct = progressMax > 0 ? Math.round((progress / progressMax) * 100) : 0;
  const isI2I = !!s.sourceImage;

  return (
    <div className="h-full flex flex-col lg:flex-row gap-4 min-h-0 overflow-y-auto lg:overflow-hidden">
      {/* ── Controls column: projected into the shell's right-hand
             "Workflow Controls" panel (inline fallback when the dock is
             collapsed / Classic UI). ── */}
      <WorkflowControls>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ImageIcon className="w-4 h-4 text-sky-400" />
          Z-Image Turbo
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground">
            {isI2I ? "img → img" : "text → img"}
          </span>
        </div>

        {/* Prompt */}
        <label className="text-[11px] text-muted-foreground">Prompt</label>
        <textarea
          value={s.positivePrompt}
          onChange={(e) => update("positivePrompt", e.target.value)}
          placeholder="Describe the image you want…"
          rows={4}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs resize-y focus:outline-none focus:ring-1 focus:ring-sky-500/50"
        />
        <div className="flex flex-wrap gap-1">
          {ZIMAGE_PROMPT_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => update("positivePrompt", p.prompt)}
              className="text-[9px] px-1.5 py-0.5 rounded border border-sky-500/20 bg-sky-500/10 text-sky-300/80 hover:bg-sky-500/20"
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Character Card: 6-view identity turnaround at a locked seed */}
        <div className="rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/5 p-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-fuchsia-300">
            <LayoutGrid className="w-3.5 h-3.5" /> Character Card
          </div>
          <p className="text-[9px] text-muted-foreground/70 leading-snug">
            Pick an identity (or type your own above), then generate 6 evenly-lit studio views at one locked seed to assemble a reference card.
          </p>
          <div className="flex flex-wrap gap-1">
            {CHARACTER_CARD_IDENTITY_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => update("positivePrompt", p.prompt)}
                className="text-[9px] px-1.5 py-0.5 rounded border border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-200/80 hover:bg-fuchsia-500/20"
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={generating}
            onClick={() => void generateCharacterCard()}
            className="w-full h-8 rounded-md border border-fuchsia-500/40 bg-fuchsia-600/20 text-fuchsia-100 text-[11px] font-medium hover:bg-fuchsia-600/30 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            <LayoutGrid className="w-3.5 h-3.5" /> Generate Character Card (6 views)
          </button>
        </div>

        {/* Batch Prompts: run a .txt list sequentially at one locked seed */}
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-300">
            <FolderOpen className="w-3.5 h-3.5" /> Batch Prompts
          </div>
          <p className="text-[9px] text-muted-foreground/70 leading-snug">
            Load a <code>.txt</code> list (one prompt per paragraph) and run every prompt in order at one locked seed, reusing the current settings, LoRAs & resolution.
          </p>

          {/* Multi-turn character consistency (requires QwenImageWanBridge nodes) */}
          <label className="flex items-center gap-1.5 text-[10px] text-emerald-200/90 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={s.multiTurnEnabled}
              onChange={(e) => update("multiTurnEnabled", e.target.checked)}
              className="accent-emerald-500"
            />
            Multi-turn character consistency
          </label>
          {s.multiTurnEnabled && (
            <>
              <p className="text-[9px] text-muted-foreground/60 leading-snug">
                Define the character once below (Turn 1). Each list prompt becomes a pose "turn" that preserves identity. Requires the <code>ComfyUI-QwenImageWanBridge</code> nodes installed + ComfyUI restarted.
              </p>
              <textarea
                value={s.characterDefinition}
                onChange={(e) => update("characterDefinition", e.target.value)}
                placeholder="Character definition (identity block): face, hair, wardrobe, distinguishing features…"
                rows={3}
                className="w-full rounded-md border border-emerald-500/30 bg-background px-2 py-1.5 text-[11px] resize-y focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
              />
            </>
          )}

          <button
            type="button"
            disabled={generating}
            onClick={() => batchInputRef.current?.click()}
            className="w-full h-8 rounded-md border border-emerald-500/40 bg-emerald-600/20 text-emerald-100 text-[11px] font-medium hover:bg-emerald-600/30 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            <FolderOpen className="w-3.5 h-3.5" /> Load Prompt List &amp; Run Batch
          </button>
          <input
            ref={batchInputRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickPromptList(f); e.target.value = ""; }}
          />
        </div>

        <label className="text-[11px] text-muted-foreground mt-1">Negative prompt</label>
        <textarea
          value={s.negativePrompt}
          onChange={(e) => update("negativePrompt", e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs resize-y focus:outline-none focus:ring-1 focus:ring-sky-500/50"
        />

        {/* Source image (img2img) */}
        <div
          {...sourceDrop.dropProps}
          className={`rounded-lg border bg-foreground/5 p-2 space-y-2 transition-colors ${sourceDrop.isOver ? "border-sky-500 ring-2 ring-sky-500/40 bg-sky-500/5" : "border-border/60"}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium flex items-center gap-1.5">
              <Wand2 className="w-3.5 h-3.5 text-sky-400" /> Source image <span className="text-muted-foreground/60">(optional → img2img · drop here)</span>
            </span>
            {s.sourceImage && (
              <button type="button" onClick={clearSource} className="text-muted-foreground hover:text-destructive" title="Remove source">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {sourcePreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sourcePreview} alt="Source" className="max-h-32 mx-auto rounded" />
          ) : (
            <label className="flex items-center justify-center gap-2 h-16 rounded-md border border-dashed border-border cursor-pointer text-[11px] text-muted-foreground hover:bg-foreground/5">
              <Upload className="w-4 h-4" /> Upload to refine an existing image
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickSource(f); }}
              />
            </label>
          )}
          {isI2I && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-16">Denoise</span>
              <input type="range" min={0.1} max={1} step={0.01} value={s.denoise}
                onChange={(e) => update("denoise", parseFloat(e.target.value))}
                className="flex-1 h-1 accent-sky-500" />
              <span className="text-[10px] font-mono text-sky-400 w-8 text-right">{s.denoise.toFixed(2)}</span>
            </div>
          )}

          {/* ── Enhance Details (detail restoration) ── */}
          {isI2I && (
            <div className={`rounded-md border p-2 space-y-2 ${s.enhanceDetails ? "border-amber-500/40 bg-amber-500/5" : "border-border/60 bg-foreground/5"}`}>
              <button
                type="button"
                onClick={() => { const next = !s.enhanceDetails; update("enhanceDetails", next); if (next) update("faceRepair", false); }}
                className={`w-full flex items-center gap-1.5 text-[11px] font-medium transition-colors ${s.enhanceDetails ? "text-amber-300" : "text-muted-foreground hover:text-foreground"}`}
                title="Repair and sharpen the uploaded image instead of reinterpreting it"
              >
                <Wand2 className="w-3.5 h-3.5" />
                Enhance Details
                <span className={`ml-auto px-1.5 py-0.5 rounded text-[9px] border ${s.enhanceDetails ? "border-amber-500/40 bg-amber-500/15 text-amber-300" : "border-border text-muted-foreground"}`}>
                  {s.enhanceDetails ? "ON" : "OFF"}
                </span>
              </button>

              {!s.enhanceDetails && (
                <p className="text-[9px] text-muted-foreground/70 leading-tight">
                  Detail restoration: repairs softness, compression artifacts and mushy texture in
                  the uploaded image, rather than re-generating it. Enabling snaps the sampler to the
                  safe restoration window.
                </p>
              )}

              {s.enhanceDetails && (
                <>
                  <p className="text-[9px] text-amber-200/70 leading-tight">
                    Detail-quality conditioning is applied automatically. <strong>CFG is capped at{" "}
                    {ZIMAGE_ENHANCE.CFG_MAX}</strong> (Z-Image Turbo is distilled, higher values break
                    it) and <strong>denoise at {ZIMAGE_ENHANCE.DENOISE_MAX}</strong> (above that it
                    re-imagines rather than restores). Steps are the count that actually runs; the
                    schedule is scaled up internally to compensate for low denoise.
                  </p>
                  <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={s.enhanceAppendPrompt}
                      onChange={(e) => update("enhanceAppendPrompt", e.target.checked)}
                      className="accent-amber-500"
                    />
                    Also use my prompt (adds subject context; detail instruction still leads)
                  </label>
                </>
              )}
            </div>
          )}

          {/* ── Face Repair (region-targeted semantic repair, Phase 2a) ── */}
          {isI2I && (
            <div className={`rounded-md border p-2 space-y-2 ${s.faceRepair ? "border-rose-500/40 bg-rose-500/5" : "border-border/60 bg-foreground/5"}`}>
              <button
                type="button"
                onClick={() => { const next = !s.faceRepair; update("faceRepair", next); if (next) update("enhanceDetails", false); }}
                className={`w-full flex items-center gap-1.5 text-[11px] font-medium transition-colors ${s.faceRepair ? "text-rose-300" : "text-muted-foreground hover:text-foreground"}`}
                title="Detect faces and repair only those regions (fixes melted teeth / warped eyes): the rest of the image is untouched"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Face Repair
                <span className={`ml-auto px-1.5 py-0.5 rounded text-[9px] border ${s.faceRepair ? "border-rose-500/40 bg-rose-500/15 text-rose-300" : "border-border text-muted-foreground"}`}>
                  {s.faceRepair ? "ON" : "OFF"}
                </span>
              </button>

              {!s.faceRepair && (
                <p className="text-[9px] text-muted-foreground/70 leading-tight">
                  Region-targeted repair: detects faces (YOLO) and redraws only those crops with the
                  low-denoise restorer, fixing facial artifacts (melted teeth, warped eyes) while
                  leaving the rest of the frame untouched.
                </p>
              )}

              {s.faceRepair && (
                <>
                  <p className="text-[9px] text-rose-200/70 leading-tight">
                    Face-repair conditioning is applied automatically. <strong>CFG is capped at{" "}
                    {ZIMAGE_FACE.CFG_MAX}</strong> and <strong>denoise at {ZIMAGE_FACE.DENOISE_MAX}</strong>;
                    only detected face regions are regenerated and composited back with feathering.
                  </p>

                  <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
                    <input
                      type="checkbox"
                      checked={s.faceAppendPrompt}
                      onChange={(e) => update("faceAppendPrompt", e.target.checked)}
                      className="accent-rose-500"
                    />
                    Also use my prompt (adds subject context; face instruction still leads)
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="flex justify-between text-[9px] text-muted-foreground">
                        <span>Repair strength</span><span className="font-mono text-rose-400">{s.faceDenoise.toFixed(2)}</span>
                      </div>
                      <input type="range" min={ZIMAGE_FACE.DENOISE_MIN} max={ZIMAGE_FACE.DENOISE_MAX} step={0.01} value={s.faceDenoise}
                        onChange={(e) => update("faceDenoise", parseFloat(e.target.value))}
                        className="w-full h-1 accent-rose-500 mt-1.5" />
                    </div>
                    <div>
                      <div className="flex justify-between text-[9px] text-muted-foreground">
                        <span>Face detail size</span><span className="font-mono text-rose-400">{s.faceGuideSize}</span>
                      </div>
                      <input type="range" min={ZIMAGE_FACE.GUIDE_SIZE_MIN} max={ZIMAGE_FACE.GUIDE_SIZE_MAX} step={64} value={s.faceGuideSize}
                        onChange={(e) => update("faceGuideSize", parseInt(e.target.value, 10))}
                        className="w-full h-1 accent-rose-500 mt-1.5" />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <div className="flex justify-between text-[9px] text-muted-foreground">
                        <span>Detect</span><span className="font-mono text-rose-400">{s.faceThreshold.toFixed(2)}</span>
                      </div>
                      <input type="range" min={0.1} max={0.9} step={0.05} value={s.faceThreshold}
                        onChange={(e) => update("faceThreshold", parseFloat(e.target.value))}
                        className="w-full h-1 accent-rose-500 mt-1.5" />
                    </div>
                    <div>
                      <div className="flex justify-between text-[9px] text-muted-foreground">
                        <span>Grow px</span><span className="font-mono text-rose-400">{s.faceDilation}</span>
                      </div>
                      <input type="range" min={0} max={64} step={1} value={s.faceDilation}
                        onChange={(e) => update("faceDilation", parseInt(e.target.value, 10))}
                        className="w-full h-1 accent-rose-500 mt-1.5" />
                    </div>
                    <div>
                      <div className="flex justify-between text-[9px] text-muted-foreground">
                        <span>Feather</span><span className="font-mono text-rose-400">{s.faceFeather}</span>
                      </div>
                      <input type="range" min={0} max={32} step={1} value={s.faceFeather}
                        onChange={(e) => update("faceFeather", parseInt(e.target.value, 10))}
                        className="w-full h-1 accent-rose-500 mt-1.5" />
                    </div>
                  </div>

                  <p className="text-[9px] text-muted-foreground/60 leading-tight">
                    <strong>Detect</strong> = confidence to accept a face · <strong>Grow</strong> = expand
                    the box to catch jaw/hairline · <strong>Feather</strong> = blend width at the paste edge.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Resolution */}
        <label className="text-[11px] text-muted-foreground">Resolution</label>
        <select
          value={`${s.width}x${s.height}`}
          onChange={(e) => {
            const preset = ZIMAGE_RESOLUTION_PRESETS.find((p) => `${p.width}x${p.height}` === e.target.value);
            if (preset) { update("width", preset.width); update("height", preset.height); }
          }}
          className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-sky-500/50"
        >
          {!ZIMAGE_RESOLUTION_PRESETS.some((p) => p.width === s.width && p.height === s.height) && (
            <option value={`${s.width}x${s.height}`}>{s.width}×{s.height}: Custom</option>
          )}
          {ZIMAGE_RESOLUTION_PRESETS.map((p) => (
            <option key={p.label} value={`${p.width}x${p.height}`}>{p.label}</option>
          ))}
        </select>
        {/* Custom width/height: anything beyond the presets. Snapped to /8 (VAE-safe). */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-muted-foreground">Width</label>
            <input type="number" min={256} max={2048} step={8} value={s.width}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) update("width", v); }}
              onBlur={(e) => { const v = parseInt(e.target.value, 10); update("width", Math.min(2048, Math.max(256, Math.round((isNaN(v) ? 256 : v) / 8) * 8))); }}
              className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-sky-500/50" />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Height</label>
            <input type="number" min={256} max={2048} step={8} value={s.height}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) update("height", v); }}
              onBlur={(e) => { const v = parseInt(e.target.value, 10); update("height", Math.min(2048, Math.max(256, Math.round((isNaN(v) ? 256 : v) / 8) * 8))); }}
              className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-sky-500/50" />
          </div>
        </div>
        <p className="text-[9px] text-muted-foreground/60 -mt-1">Custom size: any dimensions; multiples of 64 recommended for best quality.</p>

        {/* Steps + CFG */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground"><span>Steps</span><span className="font-mono">{s.steps}</span></div>
            <input type="range" min={1} max={50} step={1} value={s.steps} onChange={(e) => update("steps", parseInt(e.target.value))} className="w-full h-1 accent-sky-500" />
          </div>
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground"><span>CFG</span><span className="font-mono">{s.cfg.toFixed(1)}</span></div>
            <input type="range" min={1} max={12} step={0.1} value={s.cfg} onChange={(e) => update("cfg", parseFloat(e.target.value))} className="w-full h-1 accent-sky-500" />
          </div>
        </div>

        {/* Sampler + Scheduler */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-muted-foreground">Sampler</label>
            <select value={s.sampler} onChange={(e) => update("sampler", e.target.value)} className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-sky-500/50">
              {SAMPLERS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">Scheduler</label>
            <select value={s.scheduler} onChange={(e) => update("scheduler", e.target.value)} className="w-full h-8 rounded-lg border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-sky-500/50">
              {SCHEDULERS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </div>
        </div>

        {/* Seed */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => update("randomSeed", !s.randomSeed)}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border transition-colors ${s.randomSeed ? "border-sky-500/40 bg-sky-500/15 text-sky-300" : "border-border text-muted-foreground hover:bg-foreground/5"}`}
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
            className="flex-1 h-8 rounded-lg border border-border bg-background px-2 text-xs disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
          />
          {lastSeed != null && (
            <button type="button" onClick={() => { update("randomSeed", false); update("seed", lastSeed); }} className="text-[10px] text-muted-foreground hover:text-sky-400" title="Reuse the last seed">
              ↺ {lastSeed}
            </button>
          )}
        </div>

        {/* LoRAs */}
        <div className="rounded-lg border border-border/60 bg-foreground/5 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-sky-400" /> LoRAs</span>
            <button type="button" onClick={addLora} className="inline-flex items-center gap-1 text-[10px] text-sky-400 hover:text-sky-300"><Plus className="w-3 h-3" /> Add</button>
          </div>
          {s.loras.length === 0 && <p className="text-[10px] text-muted-foreground/60">No LoRAs: Z-Image runs with the base model.</p>}
          {s.loras.map((l, i) => (
            <div key={i} className="space-y-1 border-t border-border/40 pt-1.5 first:border-t-0 first:pt-0">
              <div className="flex items-center gap-1.5">
                <input type="checkbox" checked={l.enabled} onChange={(e) => updateLora(i, { enabled: e.target.checked })} className="accent-sky-500" title="Enable this LoRA" />
                <LoraSelect value={l.name} options={loraOptions} onChange={(name) => updateLora(i, { name })} compatMode="zimage" />
                <button type="button" onClick={() => removeLora(i)} className="text-muted-foreground hover:text-destructive" title="Remove LoRA"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-muted-foreground w-14">Strength</span>
                <input type="range" min={-2} max={2} step={0.05} value={l.strengthModel} onChange={(e) => { const v = parseFloat(e.target.value); updateLora(i, { strengthModel: v, strengthClip: v }); }} className="flex-1 h-1 accent-sky-500" />
                <span className="text-[9px] font-mono text-sky-400 w-8 text-right">{l.strengthModel.toFixed(2)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Batch */}
        <div>
          <div className="flex justify-between text-[10px] text-muted-foreground"><span>Batch (images per run)</span><span className="font-mono">{s.batch}</span></div>
          <input type="range" min={1} max={8} step={1} value={s.batch} onChange={(e) => update("batch", parseInt(e.target.value))} className="w-full h-1 accent-sky-500" />
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
              s.positivePrompt.trim()
                ? "vek-generate-glow bg-sky-600/80 hover:bg-sky-500"
                : "bg-sky-600/40"
            }`}
          >
            <Sparkles className="w-4 h-4" /> Generate
          </button>
        )}
        {!generating && (
          <SendToQueueButton
            className="w-full"
            disabled={!s.positivePrompt.trim()}
            getJobs={() => {
              const total = Math.max(1, s.batch);
              const fixedBase = s.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : s.seed;
              return Array.from({ length: total }, (_, b) => {
                const seed = s.randomSeed ? Math.floor(Math.random() * 2 ** 32) : fixedBase + b;
                return { workflow: buildWorkflow(buildParams(seed), "zimage") as Record<string, unknown>, name: "Z-Image Turbo", outputKind: "image" as const };
              });
            }}
          />
        )}

        {(generating || stage) && (
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground"><span>{stage}</span>{progressMax > 0 && <span className="font-mono">{pct}%</span>}</div>
            <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
              <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        {error && <p className="text-[11px] text-rose-400 whitespace-pre-wrap">{error}</p>}
        </div>
      </div>
      </WorkflowControls>

      {/* ── Results column ── */}
      <div className="flex-1 min-w-0 min-h-0 flex flex-col rounded-lg border border-border/60 bg-foreground/5">
        {/* Gallery toolbar: preview size, details toggle, clear */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 shrink-0">
          <span className="text-[11px] text-muted-foreground">
            {results.length > 0 ? `${results.length} image${results.length > 1 ? "s" : ""}` : "Gallery"}
          </span>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-border text-muted-foreground hover:text-sky-300 hover:border-sky-500/40 transition-colors"
            title="Load image files into the gallery to enhance/upscale them"
          >
            <ImagePlus className="w-3.5 h-3.5" /> Import
          </button>
          <button
            type="button"
            onClick={() => importDirRef.current?.click()}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border text-muted-foreground hover:text-sky-300 hover:border-sky-500/40 transition-colors"
            title="Load a whole folder of images"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          {results.length > 0 && (
            <button
              type="button"
              onClick={toggleSelectAll}
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-border text-muted-foreground hover:bg-foreground/5 transition-colors"
              title="Select or deselect all images"
            >
              <CheckSquare className="w-3.5 h-3.5" /> {selected.size >= results.length ? "None" : "All"}
            </button>
          )}
          {results.length > 0 && (
            <button
              type="button"
              onClick={() => void refreshPresence()}
              disabled={refreshing}
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-border text-muted-foreground hover:bg-foreground/5 disabled:opacity-40 transition-colors"
              title="Remove previews whose file was deleted or moved on disk"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
            </button>
          )}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => clearFromPanel(Array.from(selected))}
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-border text-muted-foreground hover:text-amber-300 hover:border-amber-500/40 transition-colors"
              title="Remove the selected images from the gallery (files on disk are kept)"
            >
              <Eraser className="w-3.5 h-3.5" /> Clear Selected ({selected.size})
            </button>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <div className="flex items-center gap-1 text-muted-foreground" title="Preview size">
              <LayoutGrid className="w-3.5 h-3.5" />
              {[2, 3, 4, 5].map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPreviewCols(c)}
                  className={`w-5 h-5 rounded text-[10px] font-mono border transition-colors ${previewCols === c ? "border-sky-500/50 bg-sky-500/15 text-sky-300" : "border-border text-muted-foreground hover:bg-foreground/5"}`}
                  title={`${c} per row`}
                >
                  {c}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className={`inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border transition-colors ${showDetails ? "border-sky-500/40 bg-sky-500/15 text-sky-300" : "border-border text-muted-foreground hover:bg-foreground/5"}`}
              title="Show image details"
            >
              <Info className="w-3.5 h-3.5" /> Details
            </button>
            <button
              type="button"
              onClick={() => setConfirmState({ title: "Clear all images?", description: "This removes every image from the gallery. Your saved files on disk are not deleted.", confirmLabel: "Clear all", onConfirm: clearResults })}
              disabled={results.length === 0}
              className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40 transition-colors"
              title="Clear all images from the gallery"
            >
              <Eraser className="w-3.5 h-3.5" /> Clear All
            </button>
          </div>
        </div>

        {/* Grid */}
        <div
          {...containerProps}
          className={`flex-1 min-h-0 overflow-y-auto p-3 transition-colors ${dragActive ? "ring-2 ring-inset ring-sky-500/60 bg-sky-500/5" : ""}`}
        >
          {results.length === 0 ? (
            <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-muted-foreground/50 gap-2">
              <ImageIcon className="w-10 h-10" />
              <p className="text-xs">Generated images appear here</p>
              <p className="text-[10px] text-muted-foreground/40">…or <span className="text-sky-400/70">Import</span> / drag &amp; drop images to enhance</p>
            </div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${previewCols}, minmax(0, 1fr))` }}>
              {results.map((r, i) => (
                <div
                  key={`${r.filename}-${i}`}
                  {...getItemProps(i, r)}
                  onContextMenu={(e) => openMenu(e, galleryKey(r))}
                  className={`group relative rounded-lg overflow-hidden border bg-background cursor-grab active:cursor-grabbing ${selected.has(galleryKey(r)) ? "border-sky-500 ring-2 ring-sky-500/50" : "border-border/60"} ${dragOverIndex === i ? "ring-2 ring-sky-400" : ""}`}
                >
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleSelect(galleryKey(r)); }}
                    className={`absolute top-2 right-2 z-10 inline-flex items-center justify-center w-6 h-6 rounded-md border transition-colors ${selected.has(galleryKey(r)) ? "bg-sky-600 border-sky-500 text-white" : "bg-black/50 border-white/50 text-transparent hover:text-white/70"}`}
                    title={selected.has(galleryKey(r)) ? "Deselect" : "Select for upscale"}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={() => setLightbox(i)} className="block w-full cursor-zoom-in" title="Click to view fullscreen">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.url} alt={r.filename} draggable={false} className="w-full h-auto" />
                    <span className="absolute top-2 left-2 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center w-6 h-6 rounded-md bg-black/60 text-white">
                      <Maximize2 className="w-3 h-3" />
                    </span>
                  </button>
                  <a
                    href={r.url}
                    download={r.filename}
                    className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 px-2 py-1 rounded-md bg-black/70 text-white text-[10px]"
                  >
                    <Download className="w-3 h-3" /> Save
                  </a>
                  {showDetails && (
                    <div className="px-2 py-1 text-[9px] text-muted-foreground border-t border-border/40 space-y-0.5">
                      <div className="truncate" title={r.filename}>{r.filename}</div>
                      {r.imported && <div className="text-amber-400/70">imported</div>}
                      {r.meta && (
                        <>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); applySeed(r.meta!.seed); }}
                            className="font-mono text-sky-400/80 hover:text-sky-300 hover:underline cursor-pointer"
                            title="Use this seed (copies it to Workflow Controls and turns random off)"
                          >
                            seed {r.meta.seed}
                          </button>
                          <div className="truncate" title={r.meta.model}>{r.meta.model}</div>
                          {(r.meta.loras?.length ?? 0) > 0 && (
                            <div
                              className="truncate text-fuchsia-400/70"
                              title={r.meta.loras!.map((l) => `${l.name} @ ${l.strength}`).join(", ")}
                            >
                              {r.meta.loras!.map((l) => `${l.name.replace(/\.[^.]+$/, "")} ${l.strength}`).join(", ")}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upscale panel: appears when previews are selected (commercial-safe models only) */}
        {selected.size > 0 && (
          <div className="shrink-0 border-t border-border/50 p-2.5 flex items-center gap-2 flex-wrap bg-background/40">
            <span className="text-[11px] text-sky-300 font-medium">{selected.size} selected</span>
            <select value={upModel} onChange={(e) => setUpModel(e.target.value)} disabled={upscaling}
              className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-sky-500/50">
              {IMAGE_UPSCALE_MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            <select value={upFactor} onChange={(e) => setUpFactor(parseInt(e.target.value, 10))} disabled={upscaling}
              className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-sky-500/50">
              {IMAGE_UPSCALE_FACTORS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <button type="button" onClick={() => void runUpscale()} disabled={upscaling}
              className="ml-auto inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-[11px] font-medium">
              <Wand2 className="w-3.5 h-3.5" /> {upscaling ? "Upscaling…" : `Upscale ${selected.size}`}
            </button>
          </div>
        )}
      </div>

      {/* ── Fullscreen lightbox (click preview to open; left/right cycle, Esc close) ── */}
      {lightbox !== null && results[lightbox] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm" onClick={() => setLightbox(null)}>
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="absolute top-16 left-1/2 -translate-x-1/2 inline-flex items-center justify-center w-10 h-10 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
            title="Close (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="absolute top-16 left-4 flex items-center gap-3 text-white/80 text-xs">
            <span className="font-mono px-2 py-1 rounded-md bg-white/10">{lightbox + 1} / {results.length}</span>
            {results[lightbox].meta && (
              <span className="font-mono px-2 py-1 rounded-md bg-white/10 text-white/70">seed {results[lightbox].meta!.seed}</span>
            )}
            <a
              href={results[lightbox].url}
              download={results[lightbox].filename}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
              title="Download this image"
            >
              <Download className="w-4 h-4" /> Save
            </a>
          </div>
          {results.length > 1 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); showPrev(); }}
              className="absolute left-4 inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
              title="Previous (left arrow)"
            >
              <ChevronLeft className="w-7 h-7" />
            </button>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={results[lightbox].url}
            alt={results[lightbox].filename}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[92vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
          />
          {results.length > 1 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); showNext(); }}
              className="absolute right-4 inline-flex items-center justify-center w-12 h-12 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
              title="Next (right arrow)"
            >
              <ChevronRight className="w-7 h-7" />
            </button>
          )}
        </div>
      )}

      {/* ── Shared right-click context menu ── */}
      <GalleryContextMenu
        menu={menu}
        onClose={closeMenu}
        onClearFromPanel={clearFromPanel}
        onDeleteFromDisk={deleteFromDisk}
        onSendToTimeline={sendToTimeline}
        seedValue={menu && menu.targets.length === 1 ? (results.find((r) => galleryKey(r) === menu.targets[0])?.meta?.seed ?? null) : null}
        onUseSeed={() => { const sd = menu && menu.targets.length === 1 ? results.find((r) => galleryKey(r) === menu.targets[0])?.meta?.seed : undefined; if (sd != null) applySeed(sd); }}
      />

      {/* Hidden pickers for Import (files) and folder import. */}
      <input
        ref={importInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { importFiles(e.target.files); e.target.value = ""; }}
      />
      <input
        ref={importDirRef}
        type="file"
        className="hidden"
        onChange={(e) => { importFiles(e.target.files); e.target.value = ""; }}
      />

      {/* Destructive-action confirmation (Clear All / Delete from disk). */}
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
