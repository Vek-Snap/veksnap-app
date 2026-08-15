"use client";

import { useState, useCallback, useRef } from "react";
import {
  Zap,
  ImageIcon,
  Loader2,
  ChevronDown,
  ChevronRight,
  Trash2,
  Check,
  X,
  RefreshCw,
  Settings2,
  Wand2,
  Upload,
  Maximize2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  DEFAULT_PARAMS,
  GenerationParams,
  ZIMAGE_MODELS,
  LoraEntry,
} from "@/lib/types";
import { buildWorkflow } from "@/lib/workflow-builder";
import {
  queuePrompt,
  getHistory,
  getImageUrl,
  uploadImage,
} from "@/lib/comfyui-api";
import { ensureVramForStage } from "@/lib/vram-guard";
import LoraSelector from "@/components/LoraSelector";

// ── Types ──

interface ZRefineKeyframe {
  id: string;
  frameIdx: number;
  timestamp: number;
  originalFile: string;       // in ComfyUI input/
  originalPreview: string;    // blob URL for thumbnail
  refinedFile: string | null; // in ComfyUI input/ (re-uploaded after refine)
  refinedPreview: string | null;
  // Per-frame overrides (manual mode)
  prompt: string;
  negativePrompt: string;
  denoise: number;
  steps: number;
  status: "idle" | "refining" | "done" | "error" | "user";
  error?: string;
  userUploaded?: boolean;     // true if user manually replaced this frame
}

interface ZRefinePanelProps {
  outputVideoFile: string;      // relative to ComfyUI/output/
  outputVideoUrl: string;
  videoPrompt: string;
  videoNegativePrompt: string;
  videoFrameRate: number;
  videoNumFrames: number;
  videoWidth: number;
  videoHeight: number;
  videoSeed: number;
  videoRandomSeed: boolean;
  disabled: boolean;
  onInjectGuideFrames: (frames: { image: string; frameIdx: number; strength: number }[]) => void;
}

// ── Helpers ──

/** Compute evenly-spaced frame indices including first and last */
function computeFrameIndices(numKeyframes: number, totalFrames: number): number[] {
  if (numKeyframes <= 0 || totalFrames <= 0) return [];
  if (numKeyframes === 1) return [0];
  if (numKeyframes >= totalFrames) return Array.from({ length: totalFrames }, (_, i) => i);
  const indices: number[] = [];
  for (let i = 0; i < numKeyframes; i++) {
    indices.push(Math.round((i * (totalFrames - 1)) / (numKeyframes - 1)));
  }
  return indices;
}

/** Fetch the first image output from a ComfyUI history entry */
function findImageOutput(outputs: Record<string, unknown>): { filename: string; subfolder: string; type: string } | null {
  for (const output of Object.values(outputs)) {
    const o = output as Record<string, unknown>;
    if (Array.isArray(o?.images) && o.images.length > 0) {
      return o.images[0] as { filename: string; subfolder: string; type: string };
    }
  }
  return null;
}

// ── Component ──

export default function ZRefinePanel({
  outputVideoFile,
  videoPrompt,
  videoNegativePrompt,
  videoFrameRate,
  videoNumFrames,
  videoWidth,
  videoHeight,
  videoSeed,
  videoRandomSeed,
  disabled,
  onInjectGuideFrames,
}: ZRefinePanelProps) {
  // Panel state
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<"select" | "auto" | "manual">("select");
  const [keyframes, setKeyframes] = useState<ZRefineKeyframe[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineProgress, setRefineProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [flushing, setFlushing] = useState(false);
  const [injected, setInjected] = useState(false);

  // Extraction settings
  const videoDuration = videoNumFrames / videoFrameRate;
  const defaultKeyframes = Math.max(2, Math.ceil(videoDuration * 0.75));
  const [numKeyframes, setNumKeyframes] = useState(defaultKeyframes);

  // Global Z-Image settings (auto mode)
  const [globalPrompt, setGlobalPrompt] = useState(videoPrompt);
  const [globalNegativePrompt, setGlobalNegativePrompt] = useState(videoNegativePrompt);
  const [globalDenoise, setGlobalDenoise] = useState<number>(ZIMAGE_MODELS.DEFAULT_I2I_DENOISE);
  const [globalSteps, setGlobalSteps] = useState<number>(ZIMAGE_MODELS.DEFAULT_I2I_STEPS);
  const [globalSampler, setGlobalSampler] = useState<string>(ZIMAGE_MODELS.DEFAULT_SAMPLER);
  const [globalScheduler, setGlobalScheduler] = useState<string>(ZIMAGE_MODELS.DEFAULT_SCHEDULER);
  const [globalLoras, setGlobalLoras] = useState<LoraEntry[]>([]);

  // Resolution (default to video resolution, user-editable)
  const [refineWidth, setRefineWidth] = useState(videoWidth);
  const [refineHeight, setRefineHeight] = useState(videoHeight);

  // Regeneration settings
  const [keepSeed, setKeepSeed] = useState(true);
  const [guideStrength, setGuideStrength] = useState(1.0);

  // Expanded frame in manual mode / full-size viewer
  const [expandedFrame, setExpandedFrame] = useState<string | null>(null);
  const [fullSizeFrame, setFullSizeFrame] = useState<string | null>(null);

  // Prompt expansion
  const [expandingPrompt, setExpandingPrompt] = useState(false);

  // Abort ref
  const abortRef = useRef(false);
  const modelLoadedRef = useRef(false);

  // ── Extract Keyframes ──
  const handleExtract = useCallback(async () => {
    setExtracting(true);
    setError(null);
    setKeyframes([]);
    try {
      const frameIndices = computeFrameIndices(numKeyframes, videoNumFrames);
      const res = await fetch("/api/director/extract-keyframes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoFile: outputVideoFile,
          frameIndices,
          frameRate: videoFrameRate,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `Extraction failed: ${res.status}`);
      }
      const data = await res.json();
      const kfs: ZRefineKeyframe[] = data.keyframes.map(
        (kf: { frameFile: string; frameIdx: number; timestamp: number }) => ({
          id: `kf_${kf.frameIdx}_${Date.now()}`,
          frameIdx: kf.frameIdx,
          timestamp: kf.timestamp,
          originalFile: kf.frameFile,
          originalPreview: getImageUrl(kf.frameFile, "", "input"),
          refinedFile: null,
          refinedPreview: null,
          prompt: globalPrompt,
          negativePrompt: globalNegativePrompt,
          denoise: globalDenoise,
          steps: globalSteps,
          status: "idle" as const,
        })
      );
      setKeyframes(kfs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setExtracting(false);
    }
  }, [numKeyframes, videoNumFrames, outputVideoFile, videoFrameRate, globalPrompt, globalNegativePrompt, globalDenoise, globalSteps]);

  // ── Prompt expansion ──
  const handleExpandPrompt = useCallback(async (currentPrompt: string, setter: (p: string) => void) => {
    if (!currentPrompt.trim() || expandingPrompt) return;
    setExpandingPrompt(true);
    try {
      const res = await fetch("/api/prompt-expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: currentPrompt }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.expanded) setter(data.expanded);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Prompt expansion failed");
    } finally {
      setExpandingPrompt(false);
    }
  }, [expandingPrompt]);

  // ── Upload user frame replacement ──
  const handleUploadFrame = useCallback(async (kfId: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const uploadedName = await uploadImage(file);
        const previewUrl = getImageUrl(uploadedName, "", "input");
        setKeyframes((prev) => prev.map((kf) =>
          kf.id === kfId
            ? { ...kf, refinedFile: uploadedName, refinedPreview: previewUrl, status: "user" as const, userUploaded: true }
            : kf
        ));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    };
    input.click();
  }, []);

  // ── Refine Single Keyframe ──
  const refineSingle = useCallback(async (kf: ZRefineKeyframe, isFirstInBatch: boolean): Promise<ZRefineKeyframe> => {
    // Build GenerationParams for Z-Image I2I
    const params: GenerationParams = {
      ...DEFAULT_PARAMS,
      positivePrompt: mode === "auto" ? globalPrompt : kf.prompt,
      negativePrompt: mode === "auto" ? globalNegativePrompt : kf.negativePrompt,
      width: refineWidth,
      height: refineHeight,
      steps: mode === "auto" ? globalSteps : kf.steps,
      cfg: ZIMAGE_MODELS.DEFAULT_CFG,
      sampler: mode === "auto" ? globalSampler : ZIMAGE_MODELS.DEFAULT_SAMPLER,
      scheduler: mode === "auto" ? globalScheduler : ZIMAGE_MODELS.DEFAULT_SCHEDULER,
      denoise: mode === "auto" ? globalDenoise : kf.denoise,
      sourceImage: kf.originalFile,
      seed: keepSeed ? videoSeed : -1,
      randomSeed: keepSeed ? false : true,
      loras: mode === "auto" ? globalLoras : kf.prompt ? globalLoras : [],
    };

    const workflow = buildWorkflow(params, "zimage");
    const clientId = `zrefine_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Queue the prompt
    const result = await queuePrompt(workflow, clientId);
    const promptId = result.prompt_id;

    // For the first frame in a batch, wait for execution_start to confirm model is loaded
    // This prevents skipped frames when ComfyUI is still loading models
    if (isFirstInBatch && !modelLoadedRef.current) {
      let executionStarted = false;
      for (let wait = 0; wait < 120; wait++) {
        if (abortRef.current) throw new Error("Aborted");
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const history = await getHistory(promptId);
          if (history?.outputs) {
            // Already complete: model was cached
            executionStarted = true;
            modelLoadedRef.current = true;
            const img = findImageOutput(history.outputs);
            if (img) {
              const imgUrl = getImageUrl(img.filename, img.subfolder || "", img.type || "output");
              const blob = await fetch(imgUrl).then((r) => r.blob());
              const refinedFileName = `zrefine_refined_f${kf.frameIdx}_${Date.now()}.png`;
              const file = new File([blob], refinedFileName, { type: "image/png" });
              const uploadedName = await uploadImage(file);
              return { ...kf, refinedFile: uploadedName, refinedPreview: imgUrl, status: "done" };
            }
          }
          // Check queue status, if prompt is running (has status), model is loading/loaded
          const queueRes = await fetch("/api/comfyui/queue");
          const queueData = await queueRes.json();
          const running = queueData?.queue_running ?? [];
          if (running.some((r: unknown[]) => r[1] === promptId)) {
            executionStarted = true;
            modelLoadedRef.current = true;
            break;
          }
        } catch { /* retry */ }
      }
      if (!executionStarted) throw new Error("Timeout waiting for model to load");
    }

    // Poll for completion
    for (let i = 0; i < 120; i++) {
      if (abortRef.current) throw new Error("Aborted");
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const history = await getHistory(promptId);
        if (history?.outputs) {
          const img = findImageOutput(history.outputs);
          if (img) {
            const imgUrl = getImageUrl(img.filename, img.subfolder || "", img.type || "output");
            const blob = await fetch(imgUrl).then((r) => r.blob());
            const refinedFileName = `zrefine_refined_f${kf.frameIdx}_${Date.now()}.png`;
            const file = new File([blob], refinedFileName, { type: "image/png" });
            const uploadedName = await uploadImage(file);
            return { ...kf, refinedFile: uploadedName, refinedPreview: imgUrl, status: "done" };
          }
        }
      } catch { /* retry */ }
    }
    throw new Error(`Timeout waiting for frame ${kf.frameIdx}`);
  }, [mode, globalPrompt, globalNegativePrompt, globalSteps, globalDenoise, globalSampler, globalScheduler, globalLoras, refineWidth, refineHeight, keepSeed, videoSeed]);

  // ── Refine All Keyframes ──
  const handleRefineAll = useCallback(async () => {
    // Make room for Z-Image before it loads. Measured + strategy-aware (see lib/vram-guard.ts):
    // keeps the LTX model resident when it fits / streaming is cheaper, instead of always flushing.
    setFlushing(true);
    try {
      await ensureVramForStage("zimage-refine");
    } catch { /* non-fatal */ }
    setFlushing(false);
    modelLoadedRef.current = false;

    setRefining(true);
    setError(null);
    abortRef.current = false;
    // Skip user-uploaded frames and already-done frames
    const toRefine = keyframes.filter((kf) => kf.status !== "done" && kf.status !== "user" && !kf.userUploaded);
    const total = toRefine.length;
    setRefineProgress({ current: 0, total });

    const updated = [...keyframes];
    let done = 0;
    let isFirst = true;

    for (let i = 0; i < updated.length; i++) {
      if (abortRef.current) break;
      // Skip done, user-uploaded, and user-status frames
      if (updated[i].status === "done" || updated[i].status === "user" || updated[i].userUploaded) continue;

      updated[i] = { ...updated[i], status: "refining" };
      setKeyframes([...updated]);

      try {
        updated[i] = await refineSingle(updated[i], isFirst);
        isFirst = false;
      } catch (err) {
        updated[i] = {
          ...updated[i],
          status: "error",
          error: err instanceof Error ? err.message : "Refine failed",
        };
      }
      done++;
      setRefineProgress({ current: done, total });
      setKeyframes([...updated]);
    }
    setRefining(false);
  }, [keyframes, refineSingle]);

  // ── Refine Single (manual mode) ──
  const handleRefineSingleFrame = useCallback(async (id: string) => {
    // Make room for Z-Image before it loads (measured + strategy-aware, see lib/vram-guard.ts).
    setFlushing(true);
    try {
      await ensureVramForStage("zimage-refine");
    } catch { /* non-fatal */ }
    setFlushing(false);
    modelLoadedRef.current = false;

    setRefining(true);
    setError(null);
    const idx = keyframes.findIndex((kf) => kf.id === id);
    if (idx === -1) { setRefining(false); return; }

    const updated = [...keyframes];
    updated[idx] = { ...updated[idx], status: "refining" };
    setKeyframes(updated);

    try {
      updated[idx] = await refineSingle(updated[idx], true);
    } catch (err) {
      updated[idx] = {
        ...updated[idx],
        status: "error",
        error: err instanceof Error ? err.message : "Refine failed",
      };
    }
    setKeyframes([...updated]);
    setRefining(false);
  }, [keyframes, refineSingle]);

  // ── Abort ──
  const handleAbort = useCallback(() => {
    abortRef.current = true;
  }, []);

  // ── Inject as Guide Frames (insert only, no auto-regenerate) ──
  const handleInjectGuideFrames = useCallback(async () => {
    const refined = keyframes.filter((kf) => kf.refinedFile);
    if (refined.length === 0) return;

    // Make room for LTX-2 before regeneration (measured + strategy-aware, see lib/vram-guard.ts).
    setFlushing(true);
    try {
      await ensureVramForStage("ltx2-regen");
    } catch { /* non-fatal */ }
    setFlushing(false);

    onInjectGuideFrames(
      refined.map((kf) => ({
        image: kf.refinedFile!,
        frameIdx: kf.frameIdx,
        strength: guideStrength,
      }))
    );
    setInjected(true);
  }, [keyframes, guideStrength, onInjectGuideFrames]);

  // ── Update per-frame settings ──
  const updateKeyframe = useCallback((id: string, patch: Partial<ZRefineKeyframe>) => {
    setKeyframes((prev) => prev.map((kf) => kf.id === id ? { ...kf, ...patch } : kf));
  }, []);

  const refinedCount = keyframes.filter((kf) => kf.status === "done" || kf.status === "user").length;
  const needsRefine = keyframes.filter((kf) => kf.status !== "done" && kf.status !== "user" && !kf.userUploaded).length;
  const allDone = keyframes.length > 0 && needsRefine === 0;

  // Don't render if disabled (LTX2 is generating)
  if (disabled) return null;

  return (
    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 overflow-hidden">
      {/* Header: always visible */}
      <button
        type="button"
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-cyan-500/10 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-cyan-400" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-cyan-400" />
        )}
        <Zap className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-[11px] text-cyan-400 font-medium">
          Z-Refine: Keyframe Enhancement
        </span>
        {refinedCount > 0 && (
          <span className="text-[9px] text-cyan-300/70 ml-auto">
            {refinedCount}/{keyframes.length} refined
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-cyan-500/20">
          {/* Mode selector: show only if no keyframes extracted yet */}
          {keyframes.length === 0 && !extracting && (
            <div className="pt-2 space-y-2">
              <p className="text-[9px] text-cyan-400/60">
                Extract keyframes from the generated video and refine them with Z-Image Turbo I2I.
                Refined frames can be injected as guide frames for a higher-quality re-generation.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant={mode === "auto" ? "default" : "outline"}
                  className={`flex-1 h-8 text-[10px] ${mode === "auto" ? "bg-cyan-600 hover:bg-cyan-500 text-white" : "border-cyan-500/30 text-cyan-400"}`}
                  onClick={() => setMode("auto")}
                >
                  <Zap className="w-3 h-3 mr-1" /> Auto Refine
                </Button>
                <Button
                  size="sm"
                  variant={mode === "manual" ? "default" : "outline"}
                  className={`flex-1 h-8 text-[10px] ${mode === "manual" ? "bg-cyan-600 hover:bg-cyan-500 text-white" : "border-cyan-500/30 text-cyan-400"}`}
                  onClick={() => setMode("manual")}
                >
                  <Settings2 className="w-3 h-3 mr-1" /> Manual Refine
                </Button>
              </div>
              {mode === "auto" && (
                <p className="text-[8px] text-cyan-400/50">
                  Same prompt &amp; settings applied to all frames. Fast, good for consistent refinement.
                </p>
              )}
              {mode === "manual" && (
                <p className="text-[8px] text-cyan-400/50">
                  Edit prompt &amp; settings per frame. Best for targeted fixes on specific keyframes.
                </p>
              )}
            </div>
          )}

          {/* Extraction controls */}
          {mode !== "select" && keyframes.length === 0 && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2">
                <label className="text-[9px] text-cyan-400/70 whitespace-nowrap">Keyframes:</label>
                <input
                  type="number"
                  min={2}
                  max={Math.min(videoNumFrames, 20)}
                  value={numKeyframes}
                  onChange={(e) => setNumKeyframes(Math.max(2, Math.min(20, parseInt(e.target.value) || 2)))}
                  className="w-14 h-6 rounded border border-cyan-500/30 bg-background px-1.5 text-[10px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                />
                <span className="text-[8px] text-muted-foreground">
                  ({(numKeyframes / videoDuration).toFixed(2)}/sec · {videoDuration.toFixed(1)}s video · {videoFrameRate}fps)
                </span>
              </div>
              <Button
                size="sm"
                className="w-full h-8 text-[10px] bg-cyan-600 hover:bg-cyan-500 text-white"
                onClick={handleExtract}
                disabled={extracting}
              >
                {extracting ? (
                  <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Extracting...</>
                ) : (
                  <><ImageIcon className="w-3 h-3 mr-1" /> Extract {numKeyframes} Keyframes</>
                )}
              </Button>
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[9px] text-red-400 flex items-start gap-1.5">
              <X className="w-3 h-3 mt-0.5 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Flushing indicator */}
          {flushing && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-amber-500/30 bg-amber-500/10">
              <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />
              <span className="text-[9px] text-amber-400">Flushing VRAM (unloading previous models)...</span>
            </div>
          )}

          {/* Keyframe grid (both modes) */}
          {keyframes.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-cyan-400/80 font-medium">
                  {keyframes.length} Keyframes
                  {keyframes.some((kf) => kf.userUploaded) && (
                    <span className="text-[8px] text-violet-400 ml-1.5">
                      ({keyframes.filter((kf) => kf.userUploaded).length} user-uploaded)
                    </span>
                  )}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 text-[8px] px-1.5 text-cyan-400/60"
                    onClick={() => { setKeyframes([]); setMode("select"); setInjected(false); }}
                    disabled={refining}
                  >
                    <Trash2 className="w-2.5 h-2.5 mr-0.5" /> Reset
                  </Button>
                </div>
              </div>

              {/* Thumbnail grid */}
              <div className={`grid gap-1.5 ${keyframes.length <= 4 ? "grid-cols-2" : keyframes.length <= 6 ? "grid-cols-3" : "grid-cols-4"}`}>
                {keyframes.map((kf) => (
                  <div
                    key={kf.id}
                    className={`relative rounded border overflow-hidden transition-colors ${
                      kf.status === "done"
                        ? "border-green-500/40 bg-green-500/5"
                        : kf.status === "user"
                          ? "border-violet-500/40 bg-violet-500/5"
                          : kf.status === "refining"
                            ? "border-amber-500/40 bg-amber-500/5"
                            : kf.status === "error"
                              ? "border-red-500/40 bg-red-500/5"
                              : "border-cyan-500/20 bg-black/20"
                    } ${mode === "manual" ? "hover:border-cyan-400/50 cursor-pointer" : ""}`}
                    onClick={() => {
                      if (mode === "manual") {
                        setExpandedFrame(expandedFrame === kf.id ? null : kf.id);
                      }
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={kf.refinedPreview || kf.originalPreview}
                      alt={`Frame ${kf.frameIdx}`}
                      className="w-full h-auto aspect-video object-cover"
                    />
                    <div className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5 flex items-center justify-between">
                      <span className="text-[7px] text-white/80 font-mono">
                        f{kf.frameIdx} · {kf.timestamp.toFixed(1)}s
                      </span>
                      <div className="flex items-center gap-0.5">
                        {/* Full-size view button */}
                        <button
                          type="button"
                          className="p-0.5 hover:bg-white/20 rounded transition-colors"
                          onClick={(e) => { e.stopPropagation(); setFullSizeFrame(kf.refinedPreview || kf.originalPreview); }}
                          title="View full size"
                        >
                          <Maximize2 className="w-2.5 h-2.5 text-white/70" />
                        </button>
                        {/* Upload replacement button */}
                        <button
                          type="button"
                          className="p-0.5 hover:bg-white/20 rounded transition-colors"
                          onClick={(e) => { e.stopPropagation(); handleUploadFrame(kf.id); }}
                          title="Upload replacement frame"
                        >
                          <Upload className="w-2.5 h-2.5 text-white/70" />
                        </button>
                        {kf.status === "done" && <Check className="w-2.5 h-2.5 text-green-400" />}
                        {kf.status === "user" && <Upload className="w-2.5 h-2.5 text-violet-400" />}
                        {kf.status === "refining" && <Loader2 className="w-2.5 h-2.5 text-amber-400 animate-spin" />}
                        {kf.status === "error" && <X className="w-2.5 h-2.5 text-red-400" />}
                      </div>
                    </div>
                    {kf.refinedPreview && (
                      <div className="absolute top-0.5 right-0.5">
                        {kf.userUploaded ? (
                          <span className="text-[6px] bg-violet-500/80 text-white px-1 py-0.5 rounded">uploaded</span>
                        ) : (
                          <span className="text-[6px] bg-green-500/80 text-white px-1 py-0.5 rounded">refined</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Full-size frame viewer modal */}
          {fullSizeFrame && (
            <div
              className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
              onClick={() => setFullSizeFrame(null)}
            >
              <div className="relative max-w-[90vw] max-h-[90vh]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={fullSizeFrame}
                  alt="Full size frame"
                  className="max-w-full max-h-[90vh] object-contain rounded-lg"
                />
                <button
                  type="button"
                  className="absolute top-2 right-2 p-1 bg-black/60 rounded-full hover:bg-black/80 transition-colors"
                  onClick={() => setFullSizeFrame(null)}
                >
                  <X className="w-4 h-4 text-white" />
                </button>
              </div>
            </div>
          )}

          {/* ═══ AUTO MODE: Global settings ═══ */}
          {mode === "auto" && keyframes.length > 0 && (
            <div className="space-y-2 pt-1 border-t border-cyan-500/20">
              <p className="text-[10px] text-cyan-400/80 font-medium">
                Z-Image Turbo Settings (applied to all frames)
              </p>
              {/* Prompt with expander */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[9px] text-cyan-400/60">Prompt</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 text-[8px] px-1.5 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={() => handleExpandPrompt(globalPrompt, setGlobalPrompt)}
                    disabled={refining || expandingPrompt || !globalPrompt.trim()}
                    title="Expand prompt using Qwen3.5-9B LLM"
                  >
                    {expandingPrompt ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Wand2 className="w-2.5 h-2.5" />}
                    <span className="ml-0.5">Expand</span>
                  </Button>
                </div>
                <textarea
                  value={globalPrompt}
                  onChange={(e) => setGlobalPrompt(e.target.value)}
                  className="w-full h-16 rounded border border-cyan-500/30 bg-background px-2 py-1.5 text-[10px] resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                  disabled={refining}
                />
              </div>
              {/* Negative prompt with expander */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[9px] text-cyan-400/60">Negative Prompt</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 text-[8px] px-1.5 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={() => handleExpandPrompt(globalNegativePrompt, setGlobalNegativePrompt)}
                    disabled={refining || expandingPrompt || !globalNegativePrompt.trim()}
                    title="Expand prompt"
                  >
                    {expandingPrompt ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Wand2 className="w-2.5 h-2.5" />}
                  </Button>
                </div>
                <textarea
                  value={globalNegativePrompt}
                  onChange={(e) => setGlobalNegativePrompt(e.target.value)}
                  className="w-full h-10 rounded border border-cyan-500/30 bg-background px-2 py-1.5 text-[10px] resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                  disabled={refining}
                />
              </div>
              {/* Resolution */}
              <div className="flex gap-2 items-center">
                <Label className="text-[9px] text-cyan-400/60 whitespace-nowrap">Resolution:</Label>
                <input
                  type="number"
                  min={256}
                  max={2048}
                  step={64}
                  value={refineWidth}
                  onChange={(e) => setRefineWidth(Math.max(256, parseInt(e.target.value) || videoWidth))}
                  className="w-16 h-6 rounded border border-cyan-500/30 bg-background px-1 text-[9px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                  disabled={refining}
                />
                <span className="text-[9px] text-cyan-400/40">×</span>
                <input
                  type="number"
                  min={256}
                  max={2048}
                  step={64}
                  value={refineHeight}
                  onChange={(e) => setRefineHeight(Math.max(256, parseInt(e.target.value) || videoHeight))}
                  className="w-16 h-6 rounded border border-cyan-500/30 bg-background px-1 text-[9px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                  disabled={refining}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 text-[7px] px-1 text-cyan-400/50"
                  onClick={() => { setRefineWidth(videoWidth); setRefineHeight(videoHeight); }}
                  disabled={refining}
                  title="Reset to video resolution"
                >
                  <RotateCcw className="w-2 h-2" />
                </Button>
              </div>
              {/* Denoise + Steps */}
              <div className="flex gap-3">
                <div className="flex-1 space-y-1">
                  <Label className="text-[9px] text-cyan-400/60">Denoise: {globalDenoise.toFixed(2)}</Label>
                  <Slider
                    value={[globalDenoise]}
                    onValueChange={([v]) => setGlobalDenoise(v)}
                    min={0.10}
                    max={0.90}
                    step={0.01}
                    disabled={refining}
                  />
                </div>
                <div className="w-20 space-y-1">
                  <Label className="text-[9px] text-cyan-400/60">Steps</Label>
                  <input
                    type="number"
                    min={4}
                    max={30}
                    value={globalSteps}
                    onChange={(e) => setGlobalSteps(Math.max(4, Math.min(30, parseInt(e.target.value) || 9)))}
                    className="w-full h-7 rounded border border-cyan-500/30 bg-background px-1.5 text-[10px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                    disabled={refining}
                  />
                </div>
              </div>
              {/* Sampler + Scheduler */}
              <div className="flex gap-3">
                <div className="flex-1 space-y-1">
                  <Label className="text-[9px] text-cyan-400/60">Sampler</Label>
                  <select
                    value={globalSampler}
                    onChange={(e) => setGlobalSampler(e.target.value)}
                    className="w-full h-7 rounded border border-cyan-500/30 bg-background px-1.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                    disabled={refining}
                  >
                    {["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "dpm_2", "dpm_2_ancestral", "uni_pc", "ddim"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 space-y-1">
                  <Label className="text-[9px] text-cyan-400/60">Scheduler</Label>
                  <select
                    value={globalScheduler}
                    onChange={(e) => setGlobalScheduler(e.target.value)}
                    className="w-full h-7 rounded border border-cyan-500/30 bg-background px-1.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                    disabled={refining}
                  >
                    {["simple", "normal", "karras", "exponential", "sgm_uniform", "ddim_uniform", "beta"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* LoRAs */}
              <LoraSelector loras={globalLoras} onChange={setGlobalLoras} mode="zimage" />
              {/* Refine button */}
              {!refining ? (
                <Button
                  size="sm"
                  className="w-full h-9 text-[11px] bg-cyan-600 hover:bg-cyan-500 text-white font-medium"
                  onClick={handleRefineAll}
                  disabled={allDone}
                >
                  {allDone ? (
                    <><Check className="w-3.5 h-3.5 mr-1" /> All Frames Refined</>
                  ) : (
                    <><Zap className="w-3.5 h-3.5 mr-1" /> Refine {needsRefine} Frame{needsRefine !== 1 ? "s" : ""}</>
                  )}
                </Button>
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-cyan-400 font-medium">
                      Refining {refineProgress.current}/{refineProgress.total}...
                    </span>
                    <Button size="sm" variant="ghost" className="h-5 text-[8px] px-1.5 text-red-400" onClick={handleAbort}>
                      Abort
                    </Button>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-cyan-500/20 overflow-hidden">
                    <div
                      className="h-full bg-cyan-500 transition-all duration-300"
                      style={{ width: `${refineProgress.total > 0 ? (refineProgress.current / refineProgress.total) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ═══ MANUAL MODE: Per-frame settings ═══ */}
          {mode === "manual" && keyframes.length > 0 && (
            <div className="space-y-2 pt-1 border-t border-cyan-500/20">
              <div className="flex items-center justify-between">
                <p className="text-[10px] text-cyan-400/80 font-medium">Per-Frame Settings</p>
                {!refining && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[9px] px-2 border-cyan-500/30 text-cyan-400"
                    onClick={handleRefineAll}
                    disabled={allDone}
                  >
                    <Zap className="w-2.5 h-2.5 mr-0.5" /> Refine All ({needsRefine})
                  </Button>
                )}
              </div>

              {/* Refine progress (manual mode) */}
              {refining && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-cyan-400 font-medium">
                      Refining {refineProgress.current}/{refineProgress.total}...
                    </span>
                    <Button size="sm" variant="ghost" className="h-5 text-[8px] px-1.5 text-red-400" onClick={handleAbort}>
                      Abort
                    </Button>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-cyan-500/20 overflow-hidden">
                    <div
                      className="h-full bg-cyan-500 transition-all duration-300"
                      style={{ width: `${refineProgress.total > 0 ? (refineProgress.current / refineProgress.total) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Per-frame expandable cards */}
              {keyframes.map((kf) => (
                <div
                  key={kf.id}
                  className={`rounded border overflow-hidden ${
                    kf.status === "done"
                      ? "border-green-500/30 bg-green-500/5"
                      : kf.status === "user"
                        ? "border-violet-500/30 bg-violet-500/5"
                        : kf.status === "error"
                          ? "border-red-500/30 bg-red-500/5"
                          : "border-cyan-500/15 bg-cyan-500/5"
                  }`}
                >
                  {/* Card header */}
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-cyan-500/5 transition-colors"
                    onClick={() => setExpandedFrame(expandedFrame === kf.id ? null : kf.id)}
                  >
                    {expandedFrame === kf.id ? (
                      <ChevronDown className="w-3 h-3 text-cyan-400/60" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-cyan-400/60" />
                    )}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={kf.refinedPreview || kf.originalPreview}
                      alt={`Frame ${kf.frameIdx}`}
                      className="w-10 h-6 rounded object-cover border border-cyan-500/20 cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); setFullSizeFrame(kf.refinedPreview || kf.originalPreview); }}
                    />
                    <span className="text-[9px] text-cyan-400/80 font-mono flex-1">
                      Frame {kf.frameIdx} · {kf.timestamp.toFixed(1)}s
                      {kf.userUploaded && <span className="text-violet-400 ml-1">(uploaded)</span>}
                    </span>
                    {kf.status === "done" && <Check className="w-3 h-3 text-green-400" />}
                    {kf.status === "user" && <Upload className="w-3 h-3 text-violet-400" />}
                    {kf.status === "refining" && <Loader2 className="w-3 h-3 text-amber-400 animate-spin" />}
                    {kf.status === "error" && (
                      <span className="text-[8px] text-red-400 truncate max-w-[100px]">{kf.error}</span>
                    )}
                    {(kf.status === "idle" || kf.status === "error") && !refining && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 text-[8px] px-1.5 text-cyan-400"
                        onClick={(e) => { e.stopPropagation(); handleRefineSingleFrame(kf.id); }}
                      >
                        <Zap className="w-2.5 h-2.5" />
                      </Button>
                    )}
                  </button>

                  {/* Expanded per-frame settings */}
                  {expandedFrame === kf.id && (
                    <div className="px-2 pb-2 space-y-1.5 border-t border-cyan-500/10">
                      {/* Prompt with expander */}
                      <div className="space-y-0.5 pt-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[8px] text-cyan-400/60">Prompt</Label>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-4 text-[7px] px-1 text-emerald-400 hover:bg-emerald-500/10"
                            onClick={() => handleExpandPrompt(kf.prompt, (p) => updateKeyframe(kf.id, { prompt: p }))}
                            disabled={refining || expandingPrompt || !kf.prompt.trim()}
                            title="Expand prompt"
                          >
                            {expandingPrompt ? <Loader2 className="w-2 h-2 animate-spin" /> : <Wand2 className="w-2 h-2" />}
                          </Button>
                        </div>
                        <textarea
                          value={kf.prompt}
                          onChange={(e) => updateKeyframe(kf.id, { prompt: e.target.value })}
                          className="w-full h-14 rounded border border-cyan-500/20 bg-background px-1.5 py-1 text-[9px] resize-none focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                          disabled={refining}
                        />
                      </div>
                      {/* Negative + Denoise + Steps row */}
                      <div className="flex gap-2 items-end">
                        <div className="flex-1 space-y-0.5">
                          <Label className="text-[8px] text-cyan-400/60">Denoise: {kf.denoise.toFixed(2)}</Label>
                          <Slider
                            value={[kf.denoise]}
                            onValueChange={([v]) => updateKeyframe(kf.id, { denoise: v })}
                            min={0.10}
                            max={0.90}
                            step={0.01}
                            disabled={refining}
                          />
                        </div>
                        <div className="w-14 space-y-0.5">
                          <Label className="text-[8px] text-cyan-400/60">Steps</Label>
                          <input
                            type="number"
                            min={4}
                            max={30}
                            value={kf.steps}
                            onChange={(e) => updateKeyframe(kf.id, { steps: Math.max(4, parseInt(e.target.value) || 9) })}
                            className="w-full h-6 rounded border border-cyan-500/20 bg-background px-1 text-[9px] font-mono text-center focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                            disabled={refining}
                          />
                        </div>
                      </div>
                      {/* Action buttons */}
                      <div className="flex gap-1">
                        {kf.status !== "done" && kf.status !== "user" && !refining && (
                          <Button
                            size="sm"
                            className="flex-1 h-6 text-[9px] bg-cyan-600 hover:bg-cyan-500 text-white"
                            onClick={() => handleRefineSingleFrame(kf.id)}
                          >
                            <Zap className="w-2.5 h-2.5 mr-0.5" /> Refine This Frame
                          </Button>
                        )}
                        {(kf.status === "done" || kf.status === "user") && !refining && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-1 h-6 text-[9px] border-cyan-500/30 text-cyan-400"
                            onClick={() => {
                              updateKeyframe(kf.id, { status: "idle", refinedFile: null, refinedPreview: null, userUploaded: false });
                            }}
                          >
                            <RefreshCw className="w-2.5 h-2.5 mr-0.5" /> Re-refine
                          </Button>
                        )}
                        {!refining && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[9px] px-2 border-violet-500/30 text-violet-400"
                            onClick={() => handleUploadFrame(kf.id)}
                          >
                            <Upload className="w-2.5 h-2.5 mr-0.5" /> Upload
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ═══ POST-REFINE: Inject as Guide Frames ═══ */}
          {refinedCount > 0 && !refining && (
            <div className="space-y-2 pt-2 border-t border-cyan-500/20">
              {injected ? (
                <>
                  <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-green-500/30 bg-green-500/10">
                    <Check className="w-3.5 h-3.5 text-green-400" />
                    <span className="text-[10px] text-green-400 font-medium">
                      {refinedCount} refined frame{refinedCount > 1 ? "s" : ""} inserted as guide frames
                    </span>
                  </div>
                  <p className="text-[8px] text-cyan-400/50">
                    Guide frames are now set. You can adjust your video settings above, then use the main Generate button to re-render with the refined frames applied.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[10px] text-cyan-400/80 font-medium">
                    Insert Refined Frames as Guides
                  </p>
                  <p className="text-[8px] text-cyan-400/50">
                    This will insert {refinedCount} refined frame{refinedCount > 1 ? "s" : ""} as guide frames.
                    You will then need to press the main Generate button to re-render the video with these guides.
                    Z-Image models will be unloaded from VRAM before insertion.
                  </p>
                  {/* Guide strength */}
                  <div className="flex items-center gap-2">
                    <Label className="text-[9px] text-cyan-400/60 whitespace-nowrap">Guide Strength:</Label>
                    <Slider
                      value={[guideStrength]}
                      onValueChange={([v]) => setGuideStrength(v)}
                      min={0.5}
                      max={1.0}
                      step={0.05}
                    />
                    <span className="text-[9px] text-cyan-400 font-mono w-7 text-right">{guideStrength.toFixed(2)}</span>
                  </div>
                  {/* Seed choice */}
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={keepSeed}
                      onChange={(e) => setKeepSeed(e.target.checked)}
                      className="w-3 h-3 accent-cyan-500"
                    />
                    <Label className="text-[9px] text-cyan-400/60">
                      Keep original seed ({videoRandomSeed ? "random" : videoSeed}) for consistency
                    </Label>
                  </div>
                  <Button
                    size="sm"
                    className="w-full h-9 text-[11px] bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-medium"
                    onClick={handleInjectGuideFrames}
                    disabled={flushing}
                  >
                    {flushing ? (
                      <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Flushing VRAM...</>
                    ) : (
                      <><ImageIcon className="w-3.5 h-3.5 mr-1" /> Insert {refinedCount} Refined Frames as Guides</>
                    )}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
