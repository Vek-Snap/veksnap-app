"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import ModeNav from "@/components/ModeNav";
import { Button } from "@/components/ui/button";
import { Crop, Layers, Sparkles, Film, GripVertical, Eye, Zap, Paintbrush, Eraser, Upload as UploadIcon, RotateCcw, Copy, Volume2, RefreshCw, Image as ImageIcon } from "lucide-react";
import Header from "@/components/menubar/MenuBar";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useAutoSave, getAutoSaveRecovery, clearAutoSaveRecovery } from "@/hooks/useAutoSave";
import { getAllPromptHeights, applyPromptHeights } from "@/lib/prompt-heights";
import { isSwitchingLayout } from "@/lib/layout-switch";
import { saveJsonFile } from "@/lib/save-file";
import { useRecentFiles } from "@/hooks/useRecentFiles";
import { useToast } from "@/components/ToastProvider";
import { useUndoRedo } from "@/hooks/useUndoRedo";
import ServiceManager from "@/components/ServiceManager";
import ProcessList from "@/components/ProcessList";
import ModelSelector from "@/components/ModelSelector";
import LoraSelector from "@/components/LoraSelector";
import EmbeddingSelector from "@/components/EmbeddingSelector";
import GenerationParams from "@/components/GenerationParams";
import PromptEditor from "@/components/PromptEditor";
import RenderPanel from "@/components/RenderPanel";
import OutputViewer from "@/components/OutputViewer";
import VideoCompiler from "@/components/VideoCompiler";
import ResourceMonitor from "@/components/ResourceMonitor";
import VirtualMemoryPanel from "@/components/VirtualMemoryPanel";

import SystemLogs from "@/components/SystemLogs";
import ThrottleControls from "@/components/ThrottleControls";
import ImageCropTool from "@/components/ImageCropTool";
import InpaintRegionTool from "@/components/InpaintRegionTool";
import CompositePreview from "@/components/CompositePreview";
import AiTools from "@/components/AiTools";
import MaskPainter from "@/components/MaskPainter";
import OutpaintControls from "@/components/OutpaintControls";
import KeyframeGeneratorModal from "@/components/KeyframeGeneratorModal";
import VideoTrimmer from "@/components/VideoTrimmer";
import LoraFactory from "@/components/LoraFactory";
import LTX2Studio from "@/components/LTX2Studio";
import LTX25Studio from "@/components/LTX25Studio";
import CameraShotHelper from "@/components/CameraShotHelper";
import WanS2VStudio from "@/components/WanS2VStudio";
import DirectorStudio from "@/components/DirectorStudio";
import VideoRestoration from "@/components/VideoRestoration";
import AceStepStudio from "@/components/AceStepStudio";
import HeartMuLaStudio from "@/components/HeartMuLaStudio";
import LipSyncStudio from "@/components/LipSyncStudio";
import DramaBoxStudio from "@/components/DramaBoxStudio";
import MovieMakerStudio from "@/components/MovieMakerStudio";
import ComponentManager from "@/components/ComponentManager";
import MetaGuardStudio from "@/components/MetaGuardStudio";
import LoRATriggerGuide from "@/components/LoRATriggerGuide";
import { VideoRestorationConfig, VIDEO_RESTORATION_DEFAULTS, AceStepConfig, ACESTEP_DEFAULTS, HeartMuLaConfig, HEARTMULA_DEFAULTS, DramaBoxConfig, DRAMABOX_DEFAULTS, MovieMakerConfig, MOVIEMAKER_DEFAULTS } from "@/lib/types";
import { useAutoplay } from "@/lib/use-autoplay";
import { planBatches, type VideoProbeResult, type FrameExtractionResult, getFrameUrl } from "@/lib/video-pipeline";
import {
  GenerationParams as GenParams,
  DEFAULT_PARAMS,
  GenerationStatus,
  GenerationResult,
  ComfyUIProgress,
  GenerationMode,
  ComposeSubMode,
  ComposeOutputType,
  RegionInfo,
  LoraEntry,
  EmbeddingEntry,
  WanPairedLoraEntry,
  WAN_T2V_OPTIONS,
  CONTEXT_PADDING_PRESETS,
  ZIMAGE_MODELS,
  ZIMAGE_RESOLUTION_PRESETS,
  ZIMAGE_PROMPT_PRESETS,
  WAN_REMIX_MODELS,
  WAN_SVI_MODELS,
  WAN_SVI_LIGHTNING_COMBOS,
  WAN_REMIX_RESOLUTION_PRESETS,
  WAN_REMIX_FRAME_PRESETS,
  WAN_REMIX_STEP_PRESETS,
  PONY_PROMPT_PRESETS,
  PONY_NEGATIVE_PROMPT,
  isPonyCheckpoint,
  FOLEY_PROMPT_PRESETS,
  FOLEY_SAMPLERS,
  UPSCALE_MODES,
  UPSCALE_SCALE_PRESETS,
  ENHANCE_UPSCALER_MODELS,
  UpscaleMode,
  InpaintMethod,
  INPAINT_METHODS,
  INPAINT_DEFAULTS,
  CONTENT_AWARE_ENGINES,
  ContentAwareEngine,
  EXAMPLE_INPAINT_PROMPTS,
  LTX2Config,
  LTX2_DEFAULTS,
  LTX25_DEFAULTS,
  DirectorConfig,
  DIRECTOR_DEFAULTS,
  WanS2VConfig,
  WAN_S2V_DEFAULTS,
  getCheckpointArch,
} from "@/lib/types";
import {
  queuePrompt,
  getHistory,
  interruptGeneration,
  clearQueue,
  connectComfyStream,
  checkConnection,
  uploadImage,
  getImageUrl,
  getCheckpoints,
  getCheckpointSizes,
  registerRender,
  completeRender,
  recoverOrphanedRenders,
} from "@/lib/comfyui-api";
import { ensureVramForStage } from "@/lib/vram-guard";
import { buildWorkflow, buildEditBatchWorkflow, buildFoleyAudioWorkflow, getSeed } from "@/lib/workflow-builder";
import { useRegisterComfyWorkflow } from "@/components/ComfyOpenProvider";
import { parseComfyPrompt } from "@/lib/workflow-parser";
import { buildSegmentProgress, parseSingleSegmentPass } from "@/lib/segment-tracker";
import { prepareOutpaintImages } from "@/lib/outpaint-utils";
import type { SegmentProgress, PreviewHistoryEntry } from "@/lib/types";
import { startWatchdog, preRenderTempCheck, DEFAULT_WATCHDOG_CONFIG, type WatchdogConfig } from "@/lib/gpu-watchdog";
import { loadAppPreferences, saveAppPreferences, resetAppPreferences } from "@/lib/app-preferences";
import { estimateVram, fetchTotalVramMB, type VramEstimate } from "@/lib/vram-estimator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { RenderStatusProvider, useRenderStatus } from "@/lib/render-status-context";

// ── Format ComfyUI node_errors into concise human-readable message ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatNodeErrors(nodeErrors: Record<string, any>): string {
  const ids = Object.keys(nodeErrors);
  const lines = ids.slice(0, 4).map((id) => {
    const ne = nodeErrors[id];
    const cls = ne.class_type || "Unknown";
    const msgs = (ne.errors || []).map((e: { details?: string; message?: string }) => e.details || e.message || "unknown").join(", ");
    return `${cls}(${id}): ${msgs}`;
  });
  let msg = lines.join("\n");
  if (ids.length > 4) msg += `\n...and ${ids.length - 4} more node(s)`;
  return msg;
}

// ── Vek-Snap intelligent crop helpers ──
// Computes optimal crop region around mask bbox
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
  // Square-ish bbox with 15% extra
  const abp = (maxR + minR) >> 1;
  const abm = (maxR - minR) >> 1;
  const cdp = (maxC + minC) >> 1;
  const cdm = (maxC - minC) >> 1;
  const l = Math.round(Math.max(abm, cdm) * 1.15);
  let a = abp - l, b = abp + l + 1, c = cdp - l, d = cdp + l + 1;
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
  // Ensure minimum 64px
  if (H < 64) H = 64;
  if (W < 64) W = 64;
  return { h: H, w: W };
}

// ── Render Status Banner: shown at top of center panel during generation ──
function CenterPanelRenderStatus() {
  const { status } = useRenderStatus();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!status?.active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status?.active]);

  if (!status?.active) return null;

  const { stage, progress, progressMax, stepTimestamps, mode, completed, wallClockStart } = status;
  const pct = progressMax > 0 ? Math.min(100, Math.round((progress / progressMax) * 100)) : 0;

  let etaStr = "";
  if (!completed && stepTimestamps.length >= 2 && progress < progressMax) {
    const recent = stepTimestamps.slice(-10);
    const avgMs = (recent[recent.length - 1] - recent[0]) / (recent.length - 1);
    const remaining = progressMax - progress;
    const secs = (remaining * avgMs) / 1000;
    if (secs >= 0 && isFinite(secs)) {
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      etaStr = `${m}:${s.toString().padStart(2, "0")}`;
    }
  }

  let elapsedStr = "";
  if (wallClockStart && !completed) {
    const elapsed = (now - wallClockStart) / 1000;
    if (elapsed >= 0 && isFinite(elapsed)) {
      const m = Math.floor(elapsed / 60);
      const s = Math.floor(elapsed % 60);
      elapsedStr = `${m}:${s.toString().padStart(2, "0")}`;
    }
  }

  const stripeColor = completed ? "#22c55e" : "#eab308";

  return (
    <div className="shrink-0 px-3 pt-2">
      <div className="rounded-md overflow-hidden shadow-lg" style={{ background: stripeColor }}>
        <div
          className="h-[6px] w-full"
          style={{
            backgroundImage: `repeating-linear-gradient(-45deg, ${stripeColor}, ${stripeColor} 8px, #000 8px, #000 16px)`,
            backgroundSize: "22.6px 22.6px",
            animation: completed ? "none" : "hazard-scroll 0.8s linear infinite",
          }}
        />
        <div className="px-3 py-1.5 space-y-0.5">
          <div className="flex items-center gap-2 justify-between">
            <span className="text-[10px] font-semibold text-black/80 uppercase tracking-wide truncate">
              {completed ? "\u2713 Complete" : stage} {mode ? `(${mode})` : ""}
            </span>
            {etaStr && !completed && (
              <span className="text-[10px] font-mono font-bold text-black/80 shrink-0">
                ETA {etaStr}
              </span>
            )}
          </div>
          {progressMax > 0 && !completed && (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 bg-black/20 rounded-full overflow-hidden">
                <div
                  className="h-full bg-black/70 rounded-full transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-[9px] font-mono font-bold text-black/70 shrink-0 tabular-nums">
                {progress}/{progressMax}
              </span>
            </div>
          )}
          {elapsedStr && !completed && (
            <div className="text-[8px] text-black/60 font-mono mt-0.5">
              Elapsed: {elapsedStr}
            </div>
          )}
        </div>
        <div
          className="h-[6px] w-full"
          style={{
            backgroundImage: `repeating-linear-gradient(-45deg, ${stripeColor}, ${stripeColor} 8px, #000 8px, #000 16px)`,
            backgroundSize: "22.6px 22.6px",
            animation: completed ? "none" : "hazard-scroll 0.8s linear infinite",
          }}
        />
      </div>
      <style jsx>{`
        @keyframes hazard-scroll {
          from { background-position: 0 0; }
          to { background-position: 22.6px 0; }
        }
      `}</style>
    </div>
  );
}

// ── Sequential render queue ──
// A queued job is a frozen snapshot of the generation settings (params + mode)
// at the moment it was added. The runner executes them one after another,
// waiting for each render to finish before starting the next.
interface QueueJob {
  id: string;
  label: string;
  mode: GenerationMode;
  composeSubMode: ComposeSubMode;
  params: GenParams;
  status: "pending" | "running" | "done" | "error";
}

export default function Home() {
  const [comfyConnected, setComfyConnected] = useState(false);
  const [params, setParams] = useState<GenParams>(DEFAULT_PARAMS);
  const [ltx2Config, setLtx2Config] = useState<LTX2Config>(() => {
    const defaults = { ...LTX2_DEFAULTS };
    if (typeof window !== "undefined") {
      try {
        const saved = localStorage.getItem("veksnap-embed-metadata");
        if (saved !== null) defaults.embedWorkflowMetadata = saved === "true";
      } catch {}
    }
    return defaults;
  });
  const [ltx25Config, setLtx25Config] = useState<LTX2Config>({ ...LTX25_DEFAULTS });
  const [directorConfig, setDirectorConfig] = useState<DirectorConfig>({ ...DIRECTOR_DEFAULTS });
  const [s2vConfig, setS2vConfig] = useState<WanS2VConfig>({ ...WAN_S2V_DEFAULTS });
  const [restoreConfig, setRestoreConfig] = useState<VideoRestorationConfig>({ ...VIDEO_RESTORATION_DEFAULTS });
  const [aceStepConfig, setAceStepConfig] = useState<AceStepConfig>({ ...ACESTEP_DEFAULTS });
  const [heartMuLaConfig, setHeartMuLaConfig] = useState<HeartMuLaConfig>({ ...HEARTMULA_DEFAULTS });
  const [dramaBoxConfig, setDramaBoxConfig] = useState<DramaBoxConfig>({ ...DRAMABOX_DEFAULTS });
  const [movieMakerConfig, setMovieMakerConfig] = useState<MovieMakerConfig>({ ...MOVIEMAKER_DEFAULTS });
  const [autoplay, setAutoplay] = useAutoplay();
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [currentNode, setCurrentNode] = useState("");
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeRaw] = useState<GenerationMode>("zimage");

  // Auto-adjust defaults when switching modes
  const setMode = useCallback((newMode: GenerationMode) => {
    setModeRaw(newMode);
    if (newMode === "wan") {
      setParams((prev) => ({
        ...prev,
        width: prev.width > 832 || prev.height > 832 ? 832 : prev.width,
        height: prev.width > 832 || prev.height > 832 ? 480 : prev.height,
        frames: [17, 21, 25, 29, 33, 41, 49, 61, 81].includes(prev.frames) ? prev.frames : 33,
        steps: prev.steps < 20 ? 25 : prev.steps,
        cfg: prev.cfg > 10 ? 6 : prev.cfg,
        sampler: "euler",
        scheduler: "normal",
      }));
    }
    if (newMode === "wan_remix") {
      setParams((prev) => ({
        ...prev,
        width: 704,
        height: 1024,
        frames: 113,
        fps: 24,
        cfg: 1.0,
        sampler: "euler",
        scheduler: "simple",
        denoise: 1.0,
        wanRemixHighModel: prev.wanRemixHighModel || WAN_REMIX_MODELS.HIGH_Q,
        wanRemixLowModel: prev.wanRemixLowModel || WAN_REMIX_MODELS.LOW_Q,
        wanRemixShift: prev.wanRemixShift || 5.0,
        wanRemixPass1Steps: prev.wanRemixPass1Steps || 3,
        wanRemixTotalSteps: prev.wanRemixTotalSteps || 4,
      }));
    }
    if (newMode === "zimage") {
      setParams((prev) => ({
        ...prev,
        width: 896,
        height: 1152,
        steps: 20,
        cfg: 1.0,
        sampler: "euler",
        scheduler: "simple",
        denoise: ZIMAGE_MODELS.DEFAULT_I2I_DENOISE,
        inpaintStrength: 0.55,
        negativePrompt: "blurry, burry eyes, low quality, bad quality, out of frame head",
      }));
    }
    if (newMode === "image" || newMode === "video") {
      setParams((prev) => ({
        ...prev,
        width: prev.width > 768 ? 512 : prev.width,
        height: prev.height > 768 ? 512 : prev.height,
        steps: 20,
        cfg: 7.0,
        sampler: "euler_ancestral",
        scheduler: "normal",
        negativePrompt: prev.negativePrompt || "deformed hands, extra fingers, mutated hands, poorly drawn hands, bad anatomy, deformed limbs, extra limbs, missing arms, fused fingers, too many fingers, long neck, blurry, distorted, deformed, low quality, cropped, worst quality, jpeg artifacts, watermark, text",
      }));
    }
    if (newMode === "compose") {
      setParams((prev) => ({
        ...prev,
        steps: 20,
        cfg: 7.0,
        sampler: "euler_ancestral",
        scheduler: "normal",
      }));
    }
  }, []);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(() => {
    if (typeof window === "undefined") return true;
    try { const v = localStorage.getItem("veksnap-show-preview"); return v !== "false"; } catch { return true; }
  });
  const showPreviewRef = useRef(true);
  useEffect(() => { showPreviewRef.current = showPreview; }, [showPreview]);
  useEffect(() => { try { localStorage.setItem("veksnap-show-preview", String(showPreview)); } catch {} }, [showPreview]);
  const [showResources, setShowResources] = useState(true);
  const [showLogs, setShowLogs] = useState(false);
  const [showCropTool, setShowCropTool] = useState(false);
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [composeSubMode, setComposeSubMode] = useState<ComposeSubMode>("inpaint");
  const [showRegionTool, setShowRegionTool] = useState(false);
  const [showMaskPainter, setShowMaskPainter] = useState(false);
  const [paintedMaskUrl, setPaintedMaskUrl] = useState<string | null>(null);
  const [maskFeather, setMaskFeather] = useState(0);
  const [backgroundPreview, setBackgroundPreview] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState<string>("");
  const [lastSeed, setLastSeed] = useState<number | null>(null);
  const [wsPreviewCount, setWsPreviewCount] = useState(0);
  const [stepTimestamps, setStepTimestamps] = useState<number[]>([]);
  const [segmentProgress, setSegmentProgress] = useState<SegmentProgress | null>(null);
  const [passLabel, setPassLabel] = useState<string>("");
  const [previewHistory, setPreviewHistory] = useState<PreviewHistoryEntry[]>([]);
  const currentSegmentRef = useRef(0);
  const currentPassLabelRef = useRef("");
  // GPU safety watchdog: a SYSTEM/SAFETY preference (machine-specific), persisted
  // separately from render settings via the app-preferences store (see below).
  const [watchdogConfig, setWatchdogConfig] = useState<WatchdogConfig>(() => loadAppPreferences().watchdogConfig);
  const [watchdogWarning, setWatchdogWarning] = useState<string | null>(null);
  const stopWatchdogRef = useRef<(() => void) | null>(null);
  // WAN paired LoRA auto-detection: { label, highName, lowName }[]
  const [wanPairedLoraOptions, setWanPairedLoraOptions] = useState<Array<{ label: string; highName: string; lowName: string }>>([]);
  const [wanLoraFiles, setWanLoraFiles] = useState<string[]>([]); // all WAN\ lora files for manual selection
  const [vramWarning, setVramWarning] = useState<VramEstimate | null>(null);
  const skipVramCheckRef = useRef(false);

  // Foley audio generation state
  const [foleyStatus, setFoleyStatus] = useState<"idle" | "preparing" | "generating" | "complete" | "error">("idle");
  const [foleyProgress, setFoleyProgress] = useState(0);
  const [foleyProgressMax, setFoleyProgressMax] = useState(0);
  const [foleyAudioUrl, setFoleyAudioUrl] = useState<string | null>(null);
  const [foleyAudioFile, setFoleyAudioFile] = useState<{ filename: string; subfolder: string } | null>(null);
  const [foleyError, setFoleyError] = useState<string | null>(null);
  const [foleyMerging, setFoleyMerging] = useState(false);
  const foleyPhaseRef = useRef(false);
  // Standalone Foley: uploaded video info
  const [foleyUpload, setFoleyUpload] = useState<{
    directory: string; frameCount: number; fps: number; duration: number; fileName: string; videoPath: string;
  } | null>(null);
  const [foleyUploading, setFoleyUploading] = useState(false);
  const foleyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foleyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foleyEsRef = useRef<EventSource | null>(null);

  // Storyboard keyframe generation state
  const [keyframeGenerating, setKeyframeGenerating] = useState<Set<string>>(new Set());
  // Keyframe generator modal state
  const [keyframeModal, setKeyframeModal] = useState<{ segIdx: number; slot: "start" | "end"; prompt: string } | null>(null);

  // Video Edit pipeline state
  const [videoSession, setVideoSession] = useState<{
    sessionId: string;
    probe: VideoProbeResult;
    trimStart: number;
    trimEnd: number;
    extraction: FrameExtractionResult;
    audioPath: string | null;
    batchPlan: ReturnType<typeof planBatches>;
  } | null>(null);
  const [editBatchIndex, setEditBatchIndex] = useState(0);
  const [editProcessedFrames, setEditProcessedFrames] = useState<string[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const clientIdRef = useRef<string>(typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  const promptIdRef = useRef<string>("");
  // Batch generation tracking: queue same workflow N times with different seeds
  const batchPromptIdsRef = useRef<string[]>([]);
  const batchImagesRef = useRef<GenerationResult["images"]>([]);
  const batchCompletedRef = useRef(0);
  const batchTotalRef = useRef(1);
  // Sequential batch: items are submitted one at a time (the completion handler
  // queues the next) so the user can pause between items. These track pause
  // state, which prompt is in flight, and a deduped set of counted prompt IDs.
  const batchPausedRef = useRef(false);
  const batchCountedRef = useRef<Set<string>>(new Set());
  const batchInFlightIdRef = useRef<string>("");
  const batchSubmitNextRef = useRef<(() => void) | null>(null);
  const [batchPaused, setBatchPaused] = useState(false);

  const updateParam = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (key: string, value: any) => {
      setParams((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  // ── Undo/Redo (Ctrl+Z / Ctrl+Shift+Z outside text fields) ──
  // Tracks the active render-settings across EVERY mode, not just image params,
  // so a Ctrl+Z reverts the last settings change anywhere, including the per-mode
  // "Restore Defaults" buttons (e.g. Continuum → Advanced → Normalization). Each
  // debounced change is one history step; undo/redo distributes back to each setter.
  const undoState = useMemo(() => ({
    params, ltx2Config, ltx25Config, s2vConfig, directorConfig, restoreConfig,
    aceStepConfig, heartMuLaConfig, dramaBoxConfig, movieMakerConfig,
  }), [params, ltx2Config, ltx25Config, s2vConfig, directorConfig, restoreConfig, aceStepConfig, heartMuLaConfig, dramaBoxConfig, movieMakerConfig]);
  const applyUndoState = useCallback((s: typeof undoState) => {
    if (s.params) setParams(s.params);
    if (s.ltx2Config) setLtx2Config(s.ltx2Config);
    if (s.ltx25Config) setLtx25Config(s.ltx25Config);
    if (s.s2vConfig) setS2vConfig(s.s2vConfig);
    if (s.directorConfig) setDirectorConfig(s.directorConfig);
    if (s.restoreConfig) setRestoreConfig(s.restoreConfig);
    if (s.aceStepConfig) setAceStepConfig(s.aceStepConfig);
    if (s.heartMuLaConfig) setHeartMuLaConfig(s.heartMuLaConfig);
    if (s.dramaBoxConfig) setDramaBoxConfig(s.dramaBoxConfig);
    if (s.movieMakerConfig) setMovieMakerConfig(s.movieMakerConfig);
  }, []);
  useUndoRedo(undoState, applyUndoState);

  // ── Persistent user preferences (localStorage) ──
  const PREFS_KEY = "veksnap-user-prefs";
  const PERSISTED_KEYS = ["composeOutputType", "batchSize"] as const;

  // Load saved preferences on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        setParams((prev) => {
          const merged = { ...prev };
          for (const k of PERSISTED_KEYS) {
            if (k in saved && saved[k] !== undefined) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (merged as any)[k] = saved[k];
            }
          }
          return merged;
        });
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Note: embedMetadata preference is restored in ltx2Config state initializer (no useEffect race)

  // Save preferences whenever persisted keys change
  useEffect(() => {
    try {
      const prefs: Record<string, unknown> = {};
      for (const k of PERSISTED_KEYS) {
        prefs[k] = params[k];
      }
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.composeOutputType, params.batchSize]);

  // ── System / Safety preferences (separate from render settings) ──
  // Persist the GPU watchdog whenever it changes, into the dedicated app-prefs store.
  useEffect(() => {
    saveAppPreferences({ watchdogConfig });
  }, [watchdogConfig]);

  // Restore system/performance/safety preferences to defaults (does NOT touch render settings).
  const handleResetSystemPreferences = useCallback(() => {
    const defaults = resetAppPreferences();
    setWatchdogConfig(defaults.watchdogConfig);
    toast("System preferences restored to defaults", "success");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  // ── Auto-save session every 60s ──
  const getAutoSaveSnapshot = useCallback(() => {
    const stripBlobUrl = (v: string) => (v && v.startsWith("blob:")) ? "" : v;
    return {
      params: { ...params },
      mode,
      composeSubMode,
      lastSeed,
      outputDir,
      ltx2Config: { ...ltx2Config, sourceImage: (ltx2Config.sourceImage?.startsWith("blob:") || ltx2Config.sourceImage?.startsWith("data:")) ? "" : (ltx2Config.sourceImage || "") },
      ltx25Config: { ...ltx25Config, sourceImage: (ltx25Config.sourceImage?.startsWith("blob:") || ltx25Config.sourceImage?.startsWith("data:")) ? "" : (ltx25Config.sourceImage || ""), sourceImageLast: (ltx25Config.sourceImageLast?.startsWith("blob:") || ltx25Config.sourceImageLast?.startsWith("data:")) ? "" : (ltx25Config.sourceImageLast || "") },
      s2vConfig,
      directorConfig: {
        ...directorConfig,
        masterAudioPreview: directorConfig.masterAudioPreview?.startsWith("blob:") ? "" : (directorConfig.masterAudioPreview || ""),
        storyboardImages: directorConfig.storyboardImages.map((sb) => ({ ...sb, preview: "" })),
        segments: directorConfig.segments.map((seg) => ({
          ...seg,
          sourceImagePreview: stripBlobUrl(seg.sourceImagePreview),
          endImagePreview: stripBlobUrl(seg.endImagePreview),
        })),
      },
      restoreConfig,
      aceStepConfig,
      heartMuLaConfig,
      dramaBoxConfig,
      movieMakerConfig,
      promptHeights: getAllPromptHeights(),
      version: 7,
    };
  }, [params, mode, composeSubMode, lastSeed, outputDir, ltx2Config, ltx25Config, s2vConfig, directorConfig, restoreConfig, aceStepConfig, heartMuLaConfig, dramaBoxConfig, movieMakerConfig]);
  useAutoSave(getAutoSaveSnapshot);

  // ── Unsaved-changes (dirty) tracking ──
  // Compares the live, serializable render-settings snapshot against the last "clean"
  // baseline (set on Save / Load / Restore / New). NOTE: machine-only prefs (the GPU
  // watchdog) live in the separate app-preferences store and are intentionally NOT part
  // of this snapshot, so toggling them never marks the project dirty.
  const [isDirty, setIsDirty] = useState(false);
  const cleanSnapshotRef = useRef<string | null>(null);
  const adoptBaselineRef = useRef(false);

  // Use after SAVE (state is unchanged, so the current snapshot IS the clean baseline).
  const markCleanNow = useCallback(() => {
    try { cleanSnapshotRef.current = JSON.stringify(getAutoSaveSnapshot()); } catch { /* ignore */ }
    setIsDirty(false);
  }, [getAutoSaveSnapshot]);

  // Use after LOAD / RESTORE / NEW (state changes via batched setState, adopt the next
  // settled snapshot as the clean baseline rather than the current pre-update one).
  const markCleanAfterUpdate = useCallback(() => {
    adoptBaselineRef.current = true;
  }, []);

  // Recompute dirty whenever the snapshot identity changes (any saveable state edit).
  useEffect(() => {
    let now: string;
    try { now = JSON.stringify(getAutoSaveSnapshot()); } catch { return; }
    if (cleanSnapshotRef.current === null || adoptBaselineRef.current) {
      cleanSnapshotRef.current = now;
      adoptBaselineRef.current = false;
      setIsDirty(false);
      return;
    }
    setIsDirty(now !== cleanSnapshotRef.current);
  }, [getAutoSaveSnapshot]);

  // Warn before leaving with unsaved changes. In the browser dev build this is the
  // browser's native generic confirm. In the Electron shell the window 'close'
  // intercept shows a real Save / Don't Save / Cancel dialog (see the effect below
  // that syncs dirty state + the MenuBar close dialog). Auto-save still protects the
  // work either way.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // In the Electron shell, close confirmation is owned by the main-process
      // 'close' intercept + the themed MenuBar dialog. A beforeunload
      // preventDefault here CANCELS the confirmed close and hangs the window
      // (it even defeats the main-process force-close watchdog), so never guard
      // inside Electron: this is only the plain-browser dev fallback.
      if (window.electronAPI) return;
      // An intentional classic->modern layout switch must not be cancelled by
      // this guard: auto-save persists the work across the reload.
      if (isSwitchingLayout()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  // Keep the Electron shell in sync with our dirty state so the native close
  // intercept only shows the "Save / Don't Save / Cancel" prompt when there are
  // genuinely unsaved changes (otherwise it's a plain Quit / Cancel).
  useEffect(() => {
    window.electronAPI?.setUnsavedChanges(isDirty);
  }, [isDirty]);

  // Reflect unsaved changes in the window/tab title (a leading "●").
  useEffect(() => {
    const base = document.title.replace(/^●\s*/, "");
    document.title = isDirty ? `● ${base}` : base;
  }, [isDirty]);

  // ── Auto-save recovery on mount ──
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryTimestamp, setRecoveryTimestamp] = useState("");

  useEffect(() => {
    const recovery = getAutoSaveRecovery();
    if (recovery) {
      const ts = new Date(recovery.timestamp);
      const ago = Math.round((Date.now() - ts.getTime()) / 60000);
      setRecoveryTimestamp(ago <= 1 ? "less than a minute ago" : `${ago} minutes ago`);
      setRecoveryOpen(true);
    }
  }, []);

  const restoreAutoSave = useCallback(() => {
    const recovery = getAutoSaveRecovery();
    if (!recovery) return;
    const config = recovery.snapshot;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = config as any;
    if (c.params) setParams((prev) => ({ ...prev, ...c.params }));
    // RAW setter: the wrapped setMode() re-applies per-mode default width/height/steps,
    // which would clobber the resolution we just restored.
    if (c.mode) setModeRaw(c.mode);
    if (c.composeSubMode) setComposeSubMode(c.composeSubMode);
    if (c.lastSeed != null) setLastSeed(c.lastSeed);
    if (c.outputDir) setOutputDir(c.outputDir);
    if (c.ltx2Config) setLtx2Config((prev: LTX2Config) => ({ ...prev, ...c.ltx2Config }));
    if (c.ltx25Config) setLtx25Config((prev: LTX2Config) => ({ ...prev, ...c.ltx25Config }));
    if (c.s2vConfig) setS2vConfig((prev: WanS2VConfig) => ({ ...prev, ...c.s2vConfig }));
    if (c.directorConfig) setDirectorConfig((prev: DirectorConfig) => ({ ...prev, ...c.directorConfig }));
    if (c.restoreConfig) setRestoreConfig((prev: VideoRestorationConfig) => ({ ...prev, ...c.restoreConfig }));
    if (c.aceStepConfig) setAceStepConfig((prev: AceStepConfig) => ({ ...prev, ...c.aceStepConfig }));
    if (c.heartMuLaConfig) setHeartMuLaConfig((prev: HeartMuLaConfig) => ({ ...prev, ...c.heartMuLaConfig }));
    if (c.dramaBoxConfig) setDramaBoxConfig((prev: DramaBoxConfig) => ({ ...prev, ...c.dramaBoxConfig }));
    if (c.movieMakerConfig) setMovieMakerConfig((prev: MovieMakerConfig) => ({ ...prev, ...c.movieMakerConfig }));
    applyPromptHeights(c.promptHeights);
    clearAutoSaveRecovery();
    markCleanAfterUpdate(); // restored state is the new clean baseline
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Recover orphaned renders after OOM crash ──
  // If the renderer died during a generation, the render may have completed
  // server-side. On remount, check the tracker and recover any finished outputs.
  useEffect(() => {
    const recover = async () => {
      try {
        const orphans = await recoverOrphanedRenders();
        if (orphans.length > 0) {
          console.log(`[Recovery] Found ${orphans.length} completed render(s) from previous session`);
          // Show the most recent recovered render
          const latest = orphans[orphans.length - 1];
          setResult({ images: latest.images, promptId: latest.prompt_id });
          setStatus("complete");
          setError("");
        }
      } catch { /* ComfyUI might not be up yet, that's OK */ }
    };
    // Delay slightly to let the page hydrate first
    const timer = setTimeout(recover, 3000);
    return () => clearTimeout(timer);
  }, []);

  // ── Global drag-and-drop prevention ──
  // Prevent the browser from navigating away when files are dragged/dropped
  // anywhere on the page. Individual components opt-in to handle drops via
  // their own onDrop handlers with stopPropagation().
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); };
    document.addEventListener("dragover", prevent);
    document.addEventListener("drop", prevent);
    return () => {
      document.removeEventListener("dragover", prevent);
      document.removeEventListener("drop", prevent);
    };
  }, []);

  // Scan WAN paired LoRAs: extracted for reuse by refresh button
  const scanWanPairedLoras = useCallback(async () => {
    try {
      const res = await fetch(`/api/lora-files?t=${Date.now()}`);
      if (!res.ok) return;
      const allLoras: string[] = await res.json();
      // Filter to WAN\ and WAN-2.2\ subfolders (exclude .gguf, those are full UNET models, not LoRAs)
      const wanLoras = allLoras.filter((n) =>
        (n.startsWith("WAN\\") || n.startsWith("WAN/") || n.startsWith("WAN-2.2\\") || n.startsWith("WAN-2.2/"))
        && !n.toLowerCase().endsWith(".gguf")
      );
      setWanLoraFiles(wanLoras);
      // Normalize: strip HIGH/LOW, digits, separators, extension → compare base identity
      const normalize = (s: string) =>
        s.toUpperCase()
          .replace(/^WAN[-.]?[\d.]*[\\/]/, "")
          .replace(/\.\w+$/, "")
          .replace(/[-_]?HIGH[-_]?/g, "")
          .replace(/[-_]?LOW[-_]?/g, "")
          .replace(/\d+/g, "")
          .replace(/[-_]+/g, "-")
          .replace(/^-|-$/g, "");
      // Auto-detect pairs: match by normalized base name
      const pairs: Array<{ label: string; highName: string; lowName: string }> = [];
      const used = new Set<string>();
      for (const name of wanLoras) {
        if (used.has(name)) continue;
        const upper = name.toUpperCase();
        if (upper.includes("HIGH")) {
          const baseNorm = normalize(name);
          const lowCandidate = wanLoras.find((n) => {
            if (used.has(n) || n === name) return false;
            return n.toUpperCase().includes("LOW") && normalize(n) === baseNorm;
          });
          const base = name.replace(/^WAN[-.]?[\d.]*[\\/]/, "").replace(/[-_]?[Hh][Ii][Gg][Hh][-_]?/, " ").replace(/\.\w+$/, "").trim();
          pairs.push({ label: base, highName: name, lowName: lowCandidate || "" });
          used.add(name);
          if (lowCandidate) used.add(lowCandidate);
        }
      }
      // Add any remaining unpaired files as solo entries
      for (const name of wanLoras) {
        if (used.has(name)) continue;
        const isLow = name.toUpperCase().includes("LOW");
        const base = name.replace(/^WAN[-.]?[\d.]*[\\/]/, "").replace(/[-_]?[Hh][Ii][Gg][Hh][-_]?|[-_]?[Ll][Oo][Ww][-_]?/, " ").replace(/\.\w+$/, "").trim();
        pairs.push({ label: base + (isLow ? " (low only)" : " (high only)"), highName: isLow ? "" : name, lowName: isLow ? name : "" });
        used.add(name);
      }
      setWanPairedLoraOptions(pairs);
    } catch { /* non-critical */ }
  }, []);

  // Auto-scan WAN paired LoRAs when wan_remix mode is active
  useEffect(() => {
    if (mode !== "wan_remix") return;
    scanWanPairedLoras();
  }, [mode, scanWanPairedLoras]);

  // Register the classic generator's workflow with the global "Open in ComfyUI"
  // button, but ONLY for ComfyUI-driven classic modes. Studio modes (ltx2,
  // acestep, etc.) render their own components which self-register, so we stay
  // disabled there to avoid clobbering their registration. (G has no klien/flux.)
  const CLASSIC_COMFY_MODES: GenerationMode[] = ["wan", "wan_remix", "zimage", "image", "video", "compose"];
  useRegisterComfyWorkflow(
    () => ({
      workflow: buildWorkflow(params, mode, mode === "compose" ? composeSubMode : undefined) as Record<string, unknown>,
      name: `Vek-Snap ${mode}`,
    }),
    CLASSIC_COMFY_MODES.includes(mode)
  );

  const handleGenerate = useCallback(async (paramsOverride?: GenParams) => {
    const p = paramsOverride ?? params;
    if (mode !== "wan" && mode !== "wan_remix" && mode !== "zimage" && !p.checkpoint) {
      setError("Select a checkpoint model first");
      return;
    }
    const storyboardHasSource = p.storyboardSegments.length >= 2 && !!p.storyboardSegments[0]?.startImageFile;
    if (mode === "wan_remix" && !p.sourceImage && !storyboardHasSource) {
      setError("WAN Story requires a source image: upload one or set a Start keyframe on Shot 1");
      return;
    }
    const hasStoryboard = mode === "wan_remix" && p.storyboardSegments.length >= 2;
    if (hasStoryboard && p.sourceImage && p.storyboardSegments[0]?.startImageFile) {
      setError("Conflict: both a main source image and a Shot 1 Start keyframe are set; remove one so the generator knows which to use");
      return;
    }
    if (!hasStoryboard && !p.positivePrompt.trim()) {
      setError("Enter a positive prompt");
      return;
    }
    if (hasStoryboard && !p.storyboardSegments.some((s) => s.prompt.trim()) && !p.positivePrompt.trim()) {
      setError("Enter at least one segment prompt or a main positive prompt");
      return;
    }
    if ((mode === "video" || (mode === "compose" && p.composeOutputType === "video")) && !p.motionModule) {
      setError("Select a motion module for video generation");
      return;
    }
    if (mode === "compose" && !p.regionInfo) {
      setError("Select a region on a background image first");
      return;
    }
    if (mode === "image" && p.outpaint.enabled) {
      if (!p.sourceImage) {
        setError("Upload a source image for outpainting");
        return;
      }
      if (!Object.values(p.outpaint.directions).some(Boolean)) {
        setError("Select at least one outpaint direction (Left, Right, Top, Bottom)");
        return;
      }
    }
    if (mode === "image" && p.upscaleMode !== "off" && !p.sourceImage) {
      setError("Smart Upscale requires a source image: upload one first");
      return;
    }
    if (mode === "image" && p.upscaleMode === "quality" && !p.checkpoint) {
      setError("Quality upscale requires a checkpoint model for diffusion refinement");
      return;
    }

    // Pre-render temperature check
    if (watchdogConfig.enabled) {
      const tempCheck = await preRenderTempCheck(watchdogConfig.tempThresholdC);
      if (!tempCheck.ok) {
        setError(tempCheck.message);
        return;
      }
      if (tempCheck.message) {
        setWatchdogWarning(tempCheck.message);
      }
    }

    // Pre-render VRAM estimation: warn if configuration may cause OOM
    if (!skipVramCheckRef.current) {
      const vramMB = await fetchTotalVramMB();
      if (vramMB) {
        const estimate = estimateVram(mode, p, vramMB);
        if (estimate.risk !== "safe") {
          setVramWarning(estimate);
          return;
        }
      }
    }
    skipVramCheckRef.current = false;

    setError(null);
    setStatus("queued");
    setProgress(0);
    setProgressMax(0);
    setCurrentNode("");
    setResult(null);
    setPreviewUrl(null);
    setWsPreviewCount(0);
    setStepTimestamps([]);
    setSegmentProgress(null);
    setPassLabel("");
    setPreviewHistory([]);
    currentSegmentRef.current = 0;
    currentPassLabelRef.current = "";
    setWatchdogWarning(null);
    // Stop any previous watchdog
    if (stopWatchdogRef.current) { stopWatchdogRef.current(); stopWatchdogRef.current = null; }
    // Reset foley state for new generation
    if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }
    foleyPhaseRef.current = false;
    setFoleyStatus("idle");
    setFoleyProgress(0);
    setFoleyProgressMax(0);
    setFoleyAudioUrl(null);
    setFoleyAudioFile(null);
    setFoleyMerging(false);
    setFoleyError(null);

    const clientId = clientIdRef.current;

    try {
      // Resolve the actual seed (random or user-specified) and track it
      const resolvedSeed = getSeed(p);
      setLastSeed(resolvedSeed);
      let genParams = { ...p, seed: resolvedSeed, randomSeed: false as const };

      // Outpaint preparation: pad, mask, fill, soft mask → upload to ComfyUI
      if (mode === "image" && p.outpaint.enabled && p.sourceImage) {
        setStatus("uploading");
        const sourceUrl = getImageUrl(p.sourceImage, "", "input");
        const { paddedBlob, filledBlob, maskBlob, softMaskBlob, padding } =
          await prepareOutpaintImages(sourceUrl, p.outpaint);

        const [paddedName, filledName, maskName, softMaskName] = await Promise.all([
          uploadImage(new File([paddedBlob], "outpaint_padded.png", { type: "image/png" })),
          uploadImage(new File([filledBlob], "outpaint_filled.png", { type: "image/png" })),
          uploadImage(new File([maskBlob], "outpaint_mask.png", { type: "image/png" })),
          uploadImage(new File([softMaskBlob], "outpaint_softmask.png", { type: "image/png" })),
        ]);

        genParams = {
          ...genParams,
          width: padding.totalWidth,
          height: padding.totalHeight,
          outpaintInfo: {
            filledImageFile: filledName,
            paddedImageFile: paddedName,
            maskFile: maskName,
            softMaskFile: softMaskName,
            totalWidth: padding.totalWidth,
            totalHeight: padding.totalHeight,
          },
        };
      }

      // Check ComfyUI is reachable first
      const connected = await checkConnection();
      if (!connected) {
        setStatus("error");
        setError("Cannot reach ComfyUI backend. Make sure the ComfyUI service is running.");
        return;
      }

      // Batch: still-image modes run the workflow N times with different seeds
      const isStillImageMode = mode === "image" || mode === "zimage"
        || (mode === "compose" && p.composeOutputType === "image");
      const effectiveBatch = isStillImageMode ? (p.batchSize || 1) : 1;
      batchPromptIdsRef.current = [];
      batchImagesRef.current = [];
      batchCompletedRef.current = 0;
      batchTotalRef.current = effectiveBatch;
      batchPausedRef.current = false;
      batchCountedRef.current = new Set();
      batchInFlightIdRef.current = "";
      setBatchPaused(false);

      promptIdRef.current = "";
      let usePolling = false;

      // Submit a single batch item (build workflow + queue). Item 0 keeps the
      // resolved seed; later items get fresh random seeds. Returns false on a
      // node-validation error (caller should abort).
      const submitBatchItem = async (bi: number): Promise<boolean> => {
        const batchSeed = bi === 0 ? resolvedSeed : Math.floor(Math.random() * 2 ** 32);
        const batchParams = { ...genParams, seed: batchSeed, randomSeed: false as const };
        const workflow = buildWorkflow(batchParams, mode, mode === "compose" ? composeSubMode : undefined);
        const response = await queuePrompt(workflow, clientId);
        batchPromptIdsRef.current.push(response.prompt_id);
        batchInFlightIdRef.current = response.prompt_id;
        if (bi === 0) promptIdRef.current = response.prompt_id;
        registerRender(response.prompt_id, mode);
        setStatus("generating");
        if (response.node_errors && Object.keys(response.node_errors).length > 0) {
          setStatus("error");
          setError(formatNodeErrors(response.node_errors));
          return false;
        }
        return true;
      };

      // Queue the next not-yet-submitted item, unless the user requested a
      // pause, or an item is still in flight. Driven by the SSE completion
      // handler (and Skip/Resume). Stored in a ref so those handlers can call it.
      const submitNextBatchItem = () => {
        if (batchPausedRef.current) {
          setBatchPaused(true);
          setPassLabel(`Paused: ${batchCompletedRef.current}/${batchTotalRef.current} done`);
          return;
        }
        const nextIdx = batchPromptIdsRef.current.length;
        if (nextIdx !== batchCompletedRef.current) return; // an item is still in flight
        if (nextIdx >= batchTotalRef.current) return;       // nothing left to submit
        setStatus("generating");
        setPassLabel(`Batch ${nextIdx + 1}/${batchTotalRef.current}`);
        submitBatchItem(nextIdx);
      };
      batchSubmitNextRef.current = submitNextBatchItem;

      // Connect SSE stream for progress + live preview (proxied through server-side WS)
      if (esRef.current) esRef.current.close();

      try {
        esRef.current = connectComfyStream(
          clientId,
          (msg: ComfyUIProgress) => {
            if (msg.type === "progress" && msg.data) {
              if (foleyPhaseRef.current) {
                setFoleyProgress(msg.data.value ?? 0);
                setFoleyProgressMax(msg.data.max ?? 0);
              } else {
                setStatus("generating");
                setProgress(msg.data.value ?? 0);
                setProgressMax(msg.data.max ?? 0);
                setStepTimestamps((prev) => {
                  const next = [...prev, Date.now()];
                  return next.length > 100 ? next.slice(-100) : next;
                });
              }
            } else if (msg.type === "executing" && msg.data) {
              if (msg.data.node) {
                setCurrentNode(msg.data.node);
                // Segment tracking for WAN Story storyboard mode
                const numSegs = p.storyboardSegments?.length || 0;
                if (numSegs > 1) {
                  const sp = buildSegmentProgress(msg.data.node, numSegs);
                  if (sp) {
                    setSegmentProgress(sp);
                    setPassLabel(sp.passLabel);
                    currentSegmentRef.current = sp.currentSegment;
                    currentPassLabelRef.current = sp.passLabel;
                  }
                } else if (mode === "wan_remix") {
                  // Single-segment WAN Story pass tracking
                  const pi = parseSingleSegmentPass(msg.data.node);
                  if (pi) {
                    setPassLabel(pi.label);
                    currentPassLabelRef.current = pi.label;
                  }
                }
              }
              if (
                msg.data.node === null &&
                msg.data.prompt_id &&
                batchPromptIdsRef.current.includes(msg.data.prompt_id)
              ) {
                const completedId = msg.data.prompt_id;
                // Dedup: a Skip may have already counted this item.
                if (batchCountedRef.current.has(completedId)) return;
                batchCountedRef.current.add(completedId);
                completeRender(completedId);
                // Brief delay to let ComfyUI finalize output files
                setTimeout(() => {
                  getHistory(completedId).then((history) => {
                    if (history?.outputs) {
                      const newImages: GenerationResult["images"] = [];
                      for (const nodeOutput of Object.values(history.outputs)) {
                        if (nodeOutput.images) {
                          newImages.push(...nodeOutput.images);
                        }
                        if (nodeOutput.gifs) {
                          newImages.push(...nodeOutput.gifs);
                        }
                      }
                      // Accumulate images across batch runs
                      batchImagesRef.current = [...batchImagesRef.current, ...newImages];
                      // Show results incrementally
                      setResult({
                        images: [...batchImagesRef.current],
                        promptId: batchPromptIdsRef.current[0],
                      });
                    }
                    // Count the item even if it produced no output (don't stall).
                    batchCompletedRef.current += 1;
                    if (batchCompletedRef.current >= batchTotalRef.current) {
                      // All batch runs complete
                      setStatus("complete");
                      setPassLabel("");
                      if (stopWatchdogRef.current) { stopWatchdogRef.current(); stopWatchdogRef.current = null; }
                      if (esRef.current) { esRef.current.close(); esRef.current = null; }
                    } else {
                      // Submit the next item, or hold here if a pause was requested.
                      submitNextBatchItem();
                    }
                  });
                }, 500);
              }
            } else if (msg.type === "execution_error") {
              setStatus("error");
              setError("Execution error: check ComfyUI console for details");
              // Close SSE stream on error to release server-side WebSocket + memory
              if (esRef.current) { esRef.current.close(); esRef.current = null; }
              if (stopWatchdogRef.current) { stopWatchdogRef.current(); stopWatchdogRef.current = null; }
            }
          },
          undefined,
          undefined,
          (dataUrl: string) => {
            if (!showPreviewRef.current) return;
            setPreviewUrl(dataUrl);
            setWsPreviewCount((c) => c + 1);
            setPreviewHistory((prev) => {
              const entry = {
                dataUrl,
                timestamp: Date.now(),
                segment: currentSegmentRef.current,
                passLabel: currentPassLabelRef.current || "Sampling",
              };
              // Cap at 30 entries to prevent unbounded memory growth (~15 MB max)
              const next = [...prev, entry];
              return next.length > 30 ? next.slice(-30) : next;
            });
          }
        );
      } catch {
        console.warn("SSE stream unavailable, falling back to polling");
        usePolling = true;
      }

      // Start GPU safety watchdog during generation
      if (watchdogConfig.enabled) {
        stopWatchdogRef.current = startWatchdog(watchdogConfig, {
          onTriggered: (reason, reading) => {
            const msg = reason === "temperature"
              ? `Safety auto-interrupt: GPU hit ${reading.tempC}°C (threshold: ${watchdogConfig.tempThresholdC}°C)`
              : `Safety auto-interrupt: GPU power draw ${reading.powerW.toFixed(0)}W exceeded threshold`;
            setError(msg);
            interruptGeneration();
            if (stopWatchdogRef.current) { stopWatchdogRef.current(); stopWatchdogRef.current = null; }
          },
          onWarning: (reason, reading) => {
            const msg = reason === "temperature"
              ? `GPU temp ${reading.tempC}°C approaching safety threshold (${watchdogConfig.tempThresholdC}°C)...`
              : `GPU power ${reading.powerW.toFixed(0)}W approaching limit...`;
            setWatchdogWarning(msg);
          },
          onReading: () => {},
        });
      }

      // Queue the prompt(s). In normal (SSE) mode we submit ONE item at a time,
      // the completion handler queues the next, so the user can pause between
      // batch items. Under the polling fallback (no SSE) we submit all upfront
      // and let ComfyUI's own queue chain them.
      if (effectiveBatch > 1) setPassLabel(`Batch 1/${effectiveBatch}`);
      const firstOk = await submitBatchItem(0);
      if (!firstOk) return;
      if (usePolling) {
        for (let bi = 1; bi < effectiveBatch; bi++) {
          const ok = await submitBatchItem(bi);
          if (!ok) return;
        }
      }

      // If WebSocket failed, poll for completion (batch-aware)
      if (usePolling) {
        const pollInterval = setInterval(async () => {
          try {
            let allDone = true;
            for (const pid of batchPromptIdsRef.current) {
              const history = await getHistory(pid);
              if (!history?.status?.completed) {
                allDone = false;
              } else {
                // Collect images from completed prompts not yet collected
                if (!batchImagesRef.current.some(img => img.filename.includes(pid))) {
                  if (history.outputs) {
                    for (const nodeOutput of Object.values(history.outputs)) {
                      if (nodeOutput.images) batchImagesRef.current.push(...nodeOutput.images);
                      if (nodeOutput.gifs) batchImagesRef.current.push(...nodeOutput.gifs);
                    }
                  }
                }
              }
            }
            if (allDone) {
              clearInterval(pollInterval);
              setResult({ images: [...batchImagesRef.current], promptId: batchPromptIdsRef.current[0] });
              setStatus("complete");
              setPassLabel("");
              // Clear from render tracker
              for (const pid2 of batchPromptIdsRef.current) completeRender(pid2);
            }
          } catch {
            // keep polling
          }
        }, 2000);
        // Safety: stop polling after 10 minutes per batch item
        setTimeout(() => clearInterval(pollInterval), 600000 * effectiveBatch);
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [params, mode, composeSubMode]);

  const handleInterrupt = useCallback(async () => {
    // Cancel any batch pause/sequencing state
    batchPausedRef.current = false;
    setBatchPaused(false);
    // Stop watchdog on interrupt
    if (stopWatchdogRef.current) { stopWatchdogRef.current(); stopWatchdogRef.current = null; }
    // Close SSE stream to release server-side WebSocket + memory
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    // Interrupt current execution AND clear remaining queued batch prompts
    await interruptGeneration();
    // Remove any pending batch prompts from ComfyUI's queue
    const pendingIds = batchPromptIdsRef.current.filter((id) => id !== promptIdRef.current);
    if (pendingIds.length > 0) {
      try { await clearQueue(pendingIds); } catch { /* non-fatal */ }
    }
    // Clear render tracker for all batch prompts
    for (const pid of batchPromptIdsRef.current) {
      try { completeRender(pid); } catch { /* ignore */ }
    }
    batchPromptIdsRef.current = [];
    // Fetch any partial results (frames already rendered before interrupt)
    const pid = promptIdRef.current;
    if (pid) {
      try {
        // Brief delay to let ComfyUI finalize outputs
        await new Promise((r) => setTimeout(r, 1000));
        const history = await getHistory(pid);
        if (history?.outputs) {
          const allImages: GenerationResult["images"] = [];
          for (const nodeOutput of Object.values(history.outputs)) {
            if (nodeOutput.images) {
              allImages.push(...nodeOutput.images);
            }
            if (nodeOutput.gifs) {
              allImages.push(...nodeOutput.gifs);
            }
          }
          // Include any previously collected batch images
          const combined = [...batchImagesRef.current, ...allImages];
          if (combined.length > 0) {
            setResult({ images: combined, promptId: pid });
            setStatus("complete");
            return;
          }
        }
      } catch {
        // If history fetch fails, show any batch images collected so far
        if (batchImagesRef.current.length > 0) {
          setResult({ images: [...batchImagesRef.current], promptId: pid });
          setStatus("complete");
          return;
        }
      }
    }
    setStatus("idle");
  }, []);

  // Skip current batch item (interrupt it) but let the remaining batch continue.
  // In sequential mode ComfyUI has no next item queued after an interrupt, so we
  // count the skipped item and submit the next one ourselves.
  const handleSkip = useCallback(async () => {
    await interruptGeneration();
    const currentId = batchInFlightIdRef.current;
    if (currentId && !batchCountedRef.current.has(currentId)) {
      batchCountedRef.current.add(currentId);
      batchCompletedRef.current += 1;
      try { completeRender(currentId); } catch { /* ignore */ }
    }
    if (batchCompletedRef.current >= batchTotalRef.current) {
      setStatus("complete");
      setPassLabel("");
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    } else {
      setPassLabel("Skipped: starting next item...");
      batchSubmitNextRef.current?.();
    }
  }, []);

  // Pause AFTER the current batch item finishes (does not interrupt it).
  const handlePauseBatch = useCallback(() => {
    batchPausedRef.current = true;
    setPassLabel("Pausing after current item...");
  }, []);

  // Resume a paused batch by submitting the next item.
  const handleResumeBatch = useCallback(() => {
    batchPausedRef.current = false;
    setBatchPaused(false);
    batchSubmitNextRef.current?.();
  }, []);

  // ── Sequential render queue ──
  // The runner drives handleGenerate one job at a time. It can't use a return
  // value (handleGenerate is fire-and-forget; completion arrives async via
  // `status`), so it observes `status` transitions instead. We keep a ref to
  // the latest handleGenerate so the runner always launches with the current
  // mode's closure after a mode switch.
  const [renderQueue, setRenderQueue] = useState<QueueJob[]>([]);
  const [queueRunning, setQueueRunning] = useState(false);
  const handleGenerateRef = useRef(handleGenerate);
  useEffect(() => { handleGenerateRef.current = handleGenerate; }, [handleGenerate]);
  // True once we've seen the current job reach an active status, guards against
  // finalizing a job on a stale "complete"/"idle" lingering from the previous one.
  const jobObservedActiveRef = useRef(false);
  // Watchdog: if a launched job never reaches an active status (e.g. it fails
  // client-side validation, which returns without touching `status`), mark it
  // errored so the queue doesn't deadlock.
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enqueueCurrentRender = useCallback(() => {
    const label = (params.positivePrompt || "").trim().replace(/\s+/g, " ").slice(0, 70) || `${mode} render`;
    const snapshot: GenParams = JSON.parse(JSON.stringify(params));
    setRenderQueue((q) => [...q, {
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      label,
      mode,
      composeSubMode,
      params: snapshot,
      status: "pending",
    }]);
  }, [params, mode, composeSubMode]);

  const removeQueueJob = useCallback((id: string) => {
    setRenderQueue((q) => q.filter((j) => j.id !== id || j.status === "running"));
  }, []);

  const clearRenderQueue = useCallback(() => {
    // Keep a running job; only drop pending/done/error entries.
    setRenderQueue((q) => q.filter((j) => j.status === "running"));
  }, []);

  // The runner: a single effect reacting to status + queue + mode changes.
  useEffect(() => {
    const runningJob = renderQueue.find((j) => j.status === "running");

    if (runningJob) {
      const isActive = status === "queued" || status === "uploading" || status === "generating";
      if (isActive) {
        jobObservedActiveRef.current = true;
        if (launchTimerRef.current) { clearTimeout(launchTimerRef.current); launchTimerRef.current = null; }
        return;
      }
      // Finalize on a terminal status, but only after the job actually started
      // (so we don't react to a previous job's lingering "complete"/"idle").
      // This runs regardless of queueRunning so a graceful Stop still tidies up.
      if (jobObservedActiveRef.current && (status === "complete" || status === "error" || status === "idle")) {
        const result = status === "error" ? "error" : "done";
        jobObservedActiveRef.current = false;
        if (launchTimerRef.current) { clearTimeout(launchTimerRef.current); launchTimerRef.current = null; }
        setRenderQueue((q) => q.map((j) => (j.id === runningJob.id ? { ...j, status: result } : j)));
      }
      return;
    }

    if (!queueRunning) return;

    const next = renderQueue.find((j) => j.status === "pending");
    if (!next) { setQueueRunning(false); return; }

    // Align the editor mode with the job before launching, so handleGenerate's
    // closure (which reads `mode`/`composeSubMode`) builds the right workflow.
    // Use the RAW setter to preserve the snapshot's resolution/steps.
    if (next.mode !== mode) { setModeRaw(next.mode); return; }
    if (next.mode === "compose" && next.composeSubMode !== composeSubMode) { setComposeSubMode(next.composeSubMode); return; }

    jobObservedActiveRef.current = false;
    setRenderQueue((q) => q.map((j) => (j.id === next.id ? { ...j, status: "running" } : j)));
    if (launchTimerRef.current) clearTimeout(launchTimerRef.current);
    launchTimerRef.current = setTimeout(() => {
      if (!jobObservedActiveRef.current) {
        // Never started: most likely a validation error. Mark errored + move on.
        setRenderQueue((q) => q.map((j) => (j.status === "running" ? { ...j, status: "error" } : j)));
      }
    }, 15000);
    // Defer the actual launch until after this render commits.
    setTimeout(() => { handleGenerateRef.current(next.params); }, 0);
  }, [status, queueRunning, renderQueue, mode, composeSubMode]);

  // ── Storyboard Keyframe Generation (Z-Image single-image) ──
  const generateKeyframe = useCallback(async (segIdx: number, slot: "start" | "end", prompt: string) => {
    const key = `${segIdx}_${slot}`;
    setKeyframeGenerating((prev) => new Set(prev).add(key));
    try {
      const genParams: GenParams = {
        ...DEFAULT_PARAMS,
        positivePrompt: prompt || params.positivePrompt || "scene",
        negativePrompt: "",
        width: params.width,
        height: params.height,
        steps: 20,
        cfg: 1.0,
        sampler: "euler",
        scheduler: "simple",
        seed: -1,
        randomSeed: true,
      };
      const workflow = buildWorkflow(genParams, "zimage");
      const response = await queuePrompt(workflow, clientIdRef.current);
      // Poll for completion (max 2 min)
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const history = await getHistory(response.prompt_id);
        if (history?.status?.completed) {
          const outputs = history.outputs;
          for (const nodeId of Object.keys(outputs || {})) {
            const nodeOut = outputs![nodeId];
            if (nodeOut.images && nodeOut.images.length > 0) {
              const img = nodeOut.images[0];
              const imgUrl = getImageUrl(img.filename, img.subfolder, img.type);
              const res = await fetch(imgUrl);
              const blob = await res.blob();
              const file = new File([blob], `keyframe_s${segIdx}_${slot}.png`, { type: "image/png" });
              const name = await uploadImage(file);
              setParams((prev) => {
                const arr = [...prev.storyboardSegments];
                if (slot === "start") {
                  arr[segIdx] = { ...arr[segIdx], startImageFile: name };
                } else {
                  arr[segIdx] = { ...arr[segIdx], endImageFile: name };
                }
                return { ...prev, storyboardSegments: arr };
              });
              return;
            }
          }
          throw new Error("No image output found");
        }
      }
      throw new Error("Keyframe generation timed out (2 min)");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Keyframe generation failed");
    } finally {
      setKeyframeGenerating((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [params.positivePrompt, params.width, params.height, clientIdRef]);

  // ── Render Single Storyboard Segment ──
  // Renders one segment via single-segment WAN Story I2V (not the full multi-segment chain).
  // Resolves the segment's start image from: own startImageFile > prev endImageFile > main sourceImage.
  const handleRenderSegment = useCallback((segIdx: number) => {
    const seg = params.storyboardSegments[segIdx];
    if (!seg) return;

    // Resolve start image for this segment
    let resolvedSource: string | null = null;
    if (seg.startImageFile) {
      resolvedSource = seg.startImageFile;
    } else if (segIdx > 0 && params.storyboardSegments[segIdx - 1]?.endImageFile) {
      resolvedSource = params.storyboardSegments[segIdx - 1].endImageFile;
    } else {
      resolvedSource = params.sourceImage;
    }

    if (!resolvedSource) {
      setError(`Shot ${segIdx + 1} has no start image: upload one, set a keyframe, or add a main source image`);
      return;
    }

    // Build override params for single-segment render (pass directly, no state mutation)
    const segPrompt = seg.prompt?.trim() || params.positivePrompt;
    const overrideParams: GenParams = {
      ...params,
      sourceImage: resolvedSource,
      positivePrompt: segPrompt,
      wanRemixEndImage: seg.endImageFile || "",
      storyboardSegments: [], // empty → dispatch goes to single I2V, not extended
    };

    handleGenerate(overrideParams);
  }, [params, handleGenerate]);

  // ── Foley Audio Generation (post-processing OR standalone) ──
  const handleFoleyGenerate = useCallback(async (sourceResult?: GenerationResult) => {
    if (!params.foleyPrompt.trim()) return;

    // Determine source: uploaded video (already staged) or generation result
    const useUpload = foleyUpload && !sourceResult;
    const r = sourceResult || result;
    if (!useUpload && !r) return;

    // Clean up any previous poll/timeout
    if (foleyPollRef.current) { clearInterval(foleyPollRef.current); foleyPollRef.current = null; }
    if (foleyTimeoutRef.current) { clearTimeout(foleyTimeoutRef.current); foleyTimeoutRef.current = null; }

    setFoleyStatus("preparing");
    setFoleyError(null);
    setFoleyAudioUrl(null);
    setFoleyAudioFile(null);
    setFoleyProgress(0);
    setFoleyProgressMax(0);
    foleyPhaseRef.current = true;

    try {
      let directory: string;
      let foleyFps: number;
      let foleyDuration: number;

      if (useUpload && foleyUpload) {
        // Standalone mode: frames already extracted by foley-upload
        directory = foleyUpload.directory;
        foleyFps = foleyUpload.fps;
        foleyDuration = foleyUpload.duration;
      } else if (r) {
        // Post-generation mode: copy output frames to staging
        const prepRes = await fetch("/api/foley-prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: r.images }),
        });
        if (!prepRes.ok) {
          const err = await prepRes.json().catch(() => ({}));
          throw new Error(err.error || "Failed to prepare frames for Foley");
        }
        const prepData = await prepRes.json();
        if (!prepData.frameCount) throw new Error("No frames were staged for Foley");
        directory = prepData.directory;
        foleyFps = params.fps;
        // Use actual frame count from result (handles storyboard multi-segment correctly)
        const actualFrames = r.images.length;
        foleyDuration = Math.max(1, Math.round((actualFrames / Math.max(1, params.fps)) * 10) / 10);
      } else {
        throw new Error("No video source for Foley");
      }

      // Make room for the Foley model. Measured + strategy-aware (see lib/vram-guard.ts):
      // never an unconditional flush.
      await ensureVramForStage("foley");

      // Open a dedicated SSE connection for Foley progress events
      if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }
      try {
        foleyEsRef.current = connectComfyStream(
          clientIdRef.current,
          (msg: ComfyUIProgress) => {
            if (msg.type === "progress" && msg.data) {
              setFoleyProgress(msg.data.value ?? 0);
              setFoleyProgressMax(msg.data.max ?? 0);
            }
          }
        );
      } catch {
        console.warn("Foley SSE stream unavailable, progress will not update");
      }

      // Build and queue Foley workflow (override fps/duration for uploaded videos)
      const foleyParams = { ...params, fps: foleyFps };
      // Patch frames so duration calc is correct for uploaded videos or multi-segment storyboard
      if (useUpload) {
        foleyParams.frames = Math.round(foleyFps * foleyDuration);
      } else if (r) {
        foleyParams.frames = r.images.length;
      }
      const foleyWorkflow = buildFoleyAudioWorkflow(foleyParams, directory);
      const response = await queuePrompt(foleyWorkflow, clientIdRef.current);

      setFoleyStatus("generating");

      if (response.node_errors && Object.keys(response.node_errors).length > 0) {
        throw new Error(formatNodeErrors(response.node_errors));
      }

      // Poll for completion
      foleyPollRef.current = setInterval(async () => {
        try {
          const history = await getHistory(response.prompt_id);
          if (history?.status?.completed) {
            if (foleyPollRef.current) { clearInterval(foleyPollRef.current); foleyPollRef.current = null; }
            if (foleyTimeoutRef.current) { clearTimeout(foleyTimeoutRef.current); foleyTimeoutRef.current = null; }
            if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }
            foleyPhaseRef.current = false;
            // Extract audio output
            if (history.outputs) {
              for (const nodeOutput of Object.values(history.outputs)) {
                if (nodeOutput.audio && nodeOutput.audio.length > 0) {
                  const audioFile = nodeOutput.audio[0];
                  const url = getImageUrl(audioFile.filename, audioFile.subfolder, audioFile.type);
                  setFoleyAudioUrl(url);
                  setFoleyAudioFile({ filename: audioFile.filename, subfolder: audioFile.subfolder });
                }
              }
            }
            setFoleyStatus("complete");
          }
        } catch { /* keep polling */ }
      }, 2000);
      // Safety timeout: 10 minutes
      foleyTimeoutRef.current = setTimeout(() => {
        if (foleyPollRef.current) { clearInterval(foleyPollRef.current); foleyPollRef.current = null; }
        if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }
        foleyPhaseRef.current = false;
        setFoleyStatus("error");
        setFoleyError("Foley generation timed out (10 min)");
      }, 600000);
    } catch (err) {
      if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }
      foleyPhaseRef.current = false;
      setFoleyStatus("error");
      setFoleyError(err instanceof Error ? err.message : "Foley generation failed");
    }
  }, [result, params, foleyUpload]);

  // Cancel Foley audio generation
  const handleFoleyCancel = useCallback(async () => {
    // Stop polling and close SSE
    if (foleyPollRef.current) { clearInterval(foleyPollRef.current); foleyPollRef.current = null; }
    if (foleyTimeoutRef.current) { clearTimeout(foleyTimeoutRef.current); foleyTimeoutRef.current = null; }
    if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }
    foleyPhaseRef.current = false;
    // Send interrupt to ComfyUI
    try { await interruptGeneration(); } catch { /* ignore */ }
    setFoleyStatus("idle");
    setFoleyProgress(0);
    setFoleyProgressMax(0);
    setFoleyError(null);
  }, []);

  // Handle video file upload for standalone Foley
  const handleFoleyVideoUpload = useCallback(async (file: File) => {
    setFoleyUploading(true);
    setFoleyError(null);
    setFoleyUpload(null);
    try {
      const formData = new FormData();
      formData.append("video", file);
      const res = await fetch("/api/foley-upload", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to process video");
      }
      const data = await res.json();
      setFoleyUpload({ ...data, fileName: file.name });
    } catch (err) {
      setFoleyError(err instanceof Error ? err.message : "Video upload failed");
    } finally {
      setFoleyUploading(false);
    }
  }, []);

  // Merge video + Foley audio into a single downloadable MP4
  const handleFoleyMerge = useCallback(async () => {
    if (!foleyAudioFile) return;

    // Determine video source
    let videoSource: { type: string; path?: string; filename?: string; subfolder?: string };
    if (foleyUpload) {
      // Standalone mode: use the uploaded video file
      videoSource = { type: "upload", path: foleyUpload.videoPath };
    } else if (result && result.images.length > 0) {
      // Post-gen mode: use the first video/gif output from ComfyUI
      const vid = result.images[0];
      videoSource = { type: "comfyui", filename: vid.filename, subfolder: vid.subfolder };
    } else {
      setFoleyError("No video source available for merge");
      return;
    }

    setFoleyMerging(true);
    setFoleyError(null);
    try {
      const res = await fetch("/api/foley-merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoSource,
          audioFilename: foleyAudioFile.filename,
          audioSubfolder: foleyAudioFile.subfolder,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to merge video and audio");
      }
      // Trigger browser download
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `VekSnap_Foley_${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setFoleyError(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setFoleyMerging(false);
    }
  }, [foleyAudioFile, foleyUpload, result]);

  // Auto-trigger Foley after video generation completes (if enabled)
  const foleyAutoTriggeredRef = useRef(false);
  useEffect(() => {
    if (status !== "complete" || !result || !params.foleyEnabled || !params.foleyPrompt.trim()) {
      foleyAutoTriggeredRef.current = false;
      return;
    }
    // Only for video-producing modes
    if (!["wan_remix", "video", "wan"].includes(mode)) return;
    // Prevent double-trigger
    if (foleyAutoTriggeredRef.current) return;
    foleyAutoTriggeredRef.current = true;
    // Small delay to ensure frames are fully written to disk
    const timer = setTimeout(() => handleFoleyGenerate(result), 2000);
    return () => clearTimeout(timer);
  }, [status, result, params.foleyEnabled, params.foleyPrompt, mode, handleFoleyGenerate]);

  // ── Cascaded Video Edit Generation ──
  const handleEditGenerate = useCallback(async () => {
    if (!videoSession) { setError("No video session: extract frames first"); return; }
    if (!params.checkpoint) { setError("Select a checkpoint model"); return; }
    if (!params.motionModule) { setError("Select a motion module"); return; }
    if (!params.positivePrompt.trim()) { setError("Enter a prompt"); return; }

    const connected = await checkConnection();
    if (!connected) { setError("Cannot reach ComfyUI backend. Make sure the ComfyUI service is running."); return; }

    setError(null);
    setStatus("generating");
    setEditBatchIndex(0);
    setEditProcessedFrames([]);
    const allOutputImages: GenerationResult["images"] = [];
    const clientId = clientIdRef.current;
    const { batchPlan, extraction } = videoSession;

    // Resolve seed once for the entire edit session
    const resolvedSeed = getSeed(params);
    setLastSeed(resolvedSeed);
    const editParams = { ...params, seed: resolvedSeed, randomSeed: false as const };

    try {
      for (let bi = 0; bi < batchPlan.length; bi++) {
        setEditBatchIndex(bi);
        setProgress(0);
        setProgressMax(0);
        setCurrentNode(`Batch ${bi + 1}/${batchPlan.length}`);

        // Determine init image: first frame of this batch from extracted frames
        // For batch 0, use the first extracted frame. For subsequent, use last output of previous batch.
        let initImageFile: string | null = null;

        if (bi === 0) {
          // Upload the first extracted frame as init
          const firstFramePath = extraction.frames[batchPlan[0].startFrame];
          if (firstFramePath) {
            const res = await fetch(getFrameUrl(firstFramePath));
            const blob = await res.blob();
            const file = new File([blob], `edit_init_b0.png`, { type: "image/png" });
            initImageFile = await uploadImage(file);
          }
        } else if (allOutputImages.length > 0) {
          // Use last frame of previous batch as init
          const lastImg = allOutputImages[allOutputImages.length - 1];
          const url = getImageUrl(lastImg.filename, lastImg.subfolder, lastImg.type);
          const res = await fetch(url);
          const blob = await res.blob();
          const file = new File([blob], `edit_init_b${bi}.png`, { type: "image/png" });
          initImageFile = await uploadImage(file);
        }

        const workflow = buildEditBatchWorkflow(editParams, initImageFile, bi);

        // Queue and wait for completion using polling
        const response = await queuePrompt(workflow, clientId);
        const pid = response.prompt_id;

        if (response.node_errors && Object.keys(response.node_errors).length > 0) {
          setError(`Batch ${bi + 1}: ${formatNodeErrors(response.node_errors)}`);
          break;
        }

        // Poll for completion
        let completed = false;
        for (let attempt = 0; attempt < 600; attempt++) { // max ~10 min per batch
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const history = await getHistory(pid);
            if (history?.status?.completed) {
              // Collect output images
              if (history.outputs) {
                for (const nodeOutput of Object.values(history.outputs)) {
                  if (nodeOutput.images) {
                    allOutputImages.push(...nodeOutput.images);
                  }
                }
              }
              completed = true;
              break;
            }
          } catch {
            // History not ready yet, continue polling
          }
        }

        if (!completed) {
          setError(`Batch ${bi + 1} timed out, ${allOutputImages.length} frames saved so far`);
          // Save partial results so they're recoverable
          if (allOutputImages.length > 0) {
            setResult({ images: [...allOutputImages], promptId: "edit_partial_" + videoSession.sessionId });
            setStatus("complete");
          }
          break;
        }

        // Incremental save: update result after every batch so partial output is always available
        setEditProcessedFrames([...allOutputImages.map(img => img.filename)]);
        setResult({ images: [...allOutputImages], promptId: "edit_" + videoSession.sessionId });
      }

      // All batches done (or partial if broken out)
      setEditBatchIndex(batchPlan.length);
      if (allOutputImages.length > 0) {
        setResult({ images: allOutputImages, promptId: "edit_" + videoSession.sessionId });
      }
      setStatus("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Edit generation failed");
      // Still save whatever we got
      if (allOutputImages.length > 0) {
        setResult({ images: [...allOutputImages], promptId: "edit_partial_" + videoSession.sessionId });
        setStatus("complete");
      } else {
        setStatus("error");
      }
    }
  }, [videoSession, params, mode]);

  // ── Reassemble edited frames + audio → MP4 ──
  const [reassembling, setReassembling] = useState(false);
  const [outputVideoUrl, setOutputVideoUrl] = useState<string | null>(null);

  const handleReassemble = useCallback(async () => {
    if (!videoSession || !result || result.images.length === 0) return;
    setReassembling(true);
    setError(null);

    try {
      // Server-side: API route fetches frames directly from ComfyUI, writes to disk, runs FFmpeg
      const form = new FormData();
      form.append("action", "reassemble-comfyui");
      form.append("sessionId", videoSession.sessionId);
      form.append("fps", String(videoSession.probe.fps));
      form.append("images", JSON.stringify(result.images));

      if (videoSession.audioPath) {
        form.append("audioPath", videoSession.audioPath);
      }

      const res = await fetch("/api/video-process", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Reassembly failed: ${res.status}`);
      }
      const { outputPath } = await res.json();

      setOutputVideoUrl(`/api/video-process?file=${encodeURIComponent(outputPath)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Video reassembly failed");
    }
    setReassembling(false);
  }, [videoSession, result]);

  const disabledReasons: string[] = [];
  if (mode !== "wan" && mode !== "wan_remix" && mode !== "zimage" && mode !== "lipsync" && mode !== "dramabox" && mode !== "moviemaker" && mode !== "components" && mode !== "metaguard" && !params.checkpoint) disabledReasons.push("Select a checkpoint model");
  const storyboardHasSourceImg = params.storyboardSegments.length >= 2 && !!params.storyboardSegments[0]?.startImageFile;
  if (mode === "wan_remix" && !params.sourceImage && !storyboardHasSourceImg) disabledReasons.push("Add a source image or set a Start keyframe on Shot 1");
  const hasStoryboardActive = mode === "wan_remix" && params.storyboardSegments.length >= 2;
  if (hasStoryboardActive && params.sourceImage && params.storyboardSegments[0]?.startImageFile) disabledReasons.push("Conflict: remove either the main source image or the Shot 1 Start keyframe");
  if (!hasStoryboardActive && mode !== "dramabox" && mode !== "moviemaker" && !params.positivePrompt.trim()) disabledReasons.push("Enter a positive prompt");
  if (hasStoryboardActive && !params.storyboardSegments.some((s) => s.prompt.trim()) && !params.positivePrompt.trim()) disabledReasons.push("Enter at least one segment prompt");
  if ((mode === "video" || (mode === "compose" && params.composeOutputType === "video") || mode === "edit") && !params.motionModule) disabledReasons.push("Select a motion module");
  if (mode === "compose" && !params.regionInfo) disabledReasons.push("Select a region first");
  if (mode === "edit" && !videoSession) disabledReasons.push("Upload and extract video frames first");
  const disabledReason = disabledReasons.length > 0 ? disabledReasons.join(" · ") : undefined;

  // ── Recent files ──
  const { recentFiles, addRecentFile, clearRecentFiles, enabled: recentFilesEnabled, setEnabled: setRecentFilesEnabled } = useRecentFiles();
  const { toast } = useToast();

  // ── Header action handlers ──
  const handleSaveSettings = useCallback(async (): Promise<boolean> => {
    // Strip ephemeral blob URLs before saving, they're useless after page reload.
    // Keep ComfyUI filenames (short strings) so we can reconstruct previews on load.
    const stripBlobUrl = (v: string) => (v && v.startsWith("blob:")) ? "" : v;

    const cleanDirector = {
      ...directorConfig,
      voiceRefPreviewUrl: "",
      masterAudioPreview: directorConfig.masterAudioPreview?.startsWith("blob:") ? "" : (directorConfig.masterAudioPreview || ""),
      storyboardImages: directorConfig.storyboardImages.map((sb) => ({
        ...sb,
        preview: "", // blob URLs - will be reconstructed on load from sb.image
      })),
      segments: directorConfig.segments.map((seg) => ({
        ...seg,
        sourceImagePreview: stripBlobUrl(seg.sourceImagePreview),
        endImagePreview: stripBlobUrl(seg.endImagePreview),
      })),
    };

    const stripEphemeralUrl = (v?: string) => (v && (v.startsWith("blob:") || v.startsWith("data:"))) ? "" : (v || "");
    const cleanLtx2 = {
      ...ltx2Config,
      sourceImage: stripEphemeralUrl(ltx2Config.sourceImage),
    };
    const cleanLtx25 = {
      ...ltx25Config,
      sourceImage: stripEphemeralUrl(ltx25Config.sourceImage),
      sourceImageLast: stripEphemeralUrl(ltx25Config.sourceImageLast),
    };

    const cleanParams = {
      ...params,
    };
    const config = { params: cleanParams, mode, composeSubMode, composeOutputType: params.composeOutputType, lastSeed, outputDir, ltx2Config: cleanLtx2, ltx25Config: cleanLtx25, s2vConfig, directorConfig: cleanDirector, restoreConfig, aceStepConfig, heartMuLaConfig, dramaBoxConfig, movieMakerConfig, promptHeights: getAllPromptHeights(), version: 7 };
    const filename = `veksnap_settings_${Date.now()}.json`;
    // saveJsonFile uses the native Save dialog (Electron) and RESOLVES ONLY after
    // the file is written, so Save & Quit can await real completion (no timer).
    const saved = await saveJsonFile(filename, config);
    if (!saved) return false; // user cancelled the dialog, nothing persisted
    addRecentFile(filename, JSON.stringify(config, null, 2));
    markCleanNow(); // current state is now persisted → clean
    toast("Settings saved", "success");
    return true;
  }, [params, mode, composeSubMode, lastSeed, outputDir, ltx2Config, ltx25Config, s2vConfig, directorConfig, restoreConfig, aceStepConfig, heartMuLaConfig, dramaBoxConfig, movieMakerConfig, addRecentFile, toast, markCleanNow]);

  const handleLoadSettings = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const config = JSON.parse(reader.result as string);
          if (config.params) {
            setParams((prev) => ({ ...prev, ...config.params, ...INPAINT_DEFAULTS }));
          }
          // RAW setter: preserve loaded resolution/steps (wrapped setMode would clobber them).
          if (config.mode) setModeRaw(config.mode);
          if (config.composeSubMode) setComposeSubMode(config.composeSubMode);
          if (config.lastSeed != null) setLastSeed(config.lastSeed);
          if (config.outputDir) setOutputDir(config.outputDir);
          if (config.s2vConfig) setS2vConfig((prev: WanS2VConfig) => ({ ...prev, ...config.s2vConfig }));
          if (config.directorConfig) {
            // Reconstruct preview URLs from ComfyUI filenames
            const dc = config.directorConfig;
            if (dc.storyboardImages) {
              dc.storyboardImages = dc.storyboardImages.map((sb: { image?: string; preview?: string }) => ({
                ...sb,
                preview: (sb.image && !sb.preview) ? getImageUrl(sb.image, "", "input") : (sb.preview || ""),
              }));
            }
            if (dc.masterAudioFile && !dc.masterAudioPreview) {
              dc.masterAudioPreview = getImageUrl(dc.masterAudioFile, "", "input");
            }
            if (dc.segments) {
              dc.segments = dc.segments.map((seg: { sourceImage?: string; sourceImagePreview?: string; endImage?: string; endImagePreview?: string; status?: string; outputUrl?: string | null }) => ({
                ...seg,
                sourceImagePreview: (seg.sourceImage && !seg.sourceImagePreview) ? getImageUrl(seg.sourceImage, "", "input") : (seg.sourceImagePreview || ""),
                endImagePreview: (seg.endImage && !seg.endImagePreview) ? getImageUrl(seg.endImage, "", "input") : (seg.endImagePreview || ""),
                // Fix stale statuses from interrupted sessions, "generating" is only valid during active render
                status: seg.status === "generating" ? (seg.outputUrl ? "complete" : "pending") : (seg.status || "pending"),
              }));
            }
            setDirectorConfig((prev: DirectorConfig) => ({ ...prev, ...dc }));
          }
          if (config.ltx2Config) {
            const lc = config.ltx2Config;
            // Track referenced files that need ComfyUI to still have them
            const missingHints: string[] = [];
            if (lc.sourceImage && !lc.sourceImage.startsWith("data:") && !lc.sourceImage.startsWith("blob:")) {
              missingHints.push(`Source: ${lc.sourceImage}`);
            }
            if (lc.a2vAudioFile) missingHints.push(`A2V Audio: ${lc.a2vAudioFile}`);
            if (lc.guideVideoFile) missingHints.push(`Guide Video: ${lc.guideVideoFile}`);
            if (lc.editVideoSourceFile) missingHints.push(`Edit Video: ${lc.editVideoSourceFile}`);
            if (missingHints.length > 0) {
              setError((prev) => {
                const base = prev ? prev + "\n" : "";
                return base + `⚠ Loaded LTX2 references (ensure ComfyUI has these files): ${missingHints.join(", ")}`;
              });
            }
            // Preserve user's embedMetadata preference from localStorage, don't let file override it
            try {
              const savedMeta = localStorage.getItem("veksnap-embed-metadata");
              if (savedMeta !== null) lc.embedWorkflowMetadata = savedMeta === "true";
            } catch {}
            setLtx2Config((prev: LTX2Config) => ({ ...prev, ...lc }));
          }
          if (config.restoreConfig) setRestoreConfig((prev: VideoRestorationConfig) => ({ ...prev, ...config.restoreConfig }));
          if (config.aceStepConfig) setAceStepConfig((prev: AceStepConfig) => ({ ...prev, ...config.aceStepConfig }));
          if (config.heartMuLaConfig) setHeartMuLaConfig((prev: HeartMuLaConfig) => ({ ...prev, ...config.heartMuLaConfig }));
          if (config.dramaBoxConfig) setDramaBoxConfig((prev: DramaBoxConfig) => ({ ...prev, ...config.dramaBoxConfig }));
          if (config.movieMakerConfig) setMovieMakerConfig((prev: MovieMakerConfig) => ({ ...prev, ...config.movieMakerConfig }));
          applyPromptHeights(config.promptHeights);
          addRecentFile(file.name, reader.result as string);
          markCleanAfterUpdate(); // loaded state is the new clean baseline
          toast(`Loaded settings from ${file.name}`, "success");
        } catch {
          setError("Invalid settings file: expected a .json file saved by Vek-Snap");
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [setMode, addRecentFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLoadRecentFile = useCallback((json: string) => {
    try {
      const config = JSON.parse(json);
      if (config.params) setParams((prev) => ({ ...prev, ...config.params }));
      if (config.mode) setMode(config.mode);
      if (config.composeSubMode) setComposeSubMode(config.composeSubMode);
      if (config.lastSeed != null) setLastSeed(config.lastSeed);
      if (config.outputDir) setOutputDir(config.outputDir);
      if (config.ltx2Config) setLtx2Config((prev: LTX2Config) => ({ ...prev, ...config.ltx2Config }));
      if (config.ltx25Config) setLtx25Config((prev: LTX2Config) => ({ ...prev, ...config.ltx25Config }));
      if (config.s2vConfig) setS2vConfig((prev: WanS2VConfig) => ({ ...prev, ...config.s2vConfig }));
      if (config.directorConfig) setDirectorConfig((prev: DirectorConfig) => ({ ...prev, ...config.directorConfig }));
      if (config.restoreConfig) setRestoreConfig((prev: VideoRestorationConfig) => ({ ...prev, ...config.restoreConfig }));
      if (config.aceStepConfig) setAceStepConfig((prev: AceStepConfig) => ({ ...prev, ...config.aceStepConfig }));
      if (config.heartMuLaConfig) setHeartMuLaConfig((prev: HeartMuLaConfig) => ({ ...prev, ...config.heartMuLaConfig }));
      if (config.dramaBoxConfig) setDramaBoxConfig((prev: DramaBoxConfig) => ({ ...prev, ...config.dramaBoxConfig }));
      if (config.movieMakerConfig) setMovieMakerConfig((prev: MovieMakerConfig) => ({ ...prev, ...config.movieMakerConfig }));
      applyPromptHeights(config.promptHeights);
      markCleanAfterUpdate(); // loaded state is the new clean baseline
      toast("Settings restored from recent file", "success");
    } catch {
      setError("Failed to load recent file: it may be corrupted");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [freshStartOpen, setFreshStartOpen] = useState(false);

  const handleFreshStart = useCallback(() => {
    setFreshStartOpen(true);
  }, []);

  const executeFreshStart = useCallback(() => {
    setParams(DEFAULT_PARAMS);
    setLtx2Config({ ...LTX2_DEFAULTS });
    setLtx25Config({ ...LTX25_DEFAULTS });
    try { localStorage.setItem("veksnap-embed-metadata", String(LTX2_DEFAULTS.embedWorkflowMetadata ?? true)); } catch {}
    setDirectorConfig({ ...DIRECTOR_DEFAULTS });
    setS2vConfig({ ...WAN_S2V_DEFAULTS });
    setRestoreConfig({ ...VIDEO_RESTORATION_DEFAULTS });
    setAceStepConfig({ ...ACESTEP_DEFAULTS });
    setHeartMuLaConfig({ ...HEARTMULA_DEFAULTS });
    setDramaBoxConfig({ ...DRAMABOX_DEFAULTS });
    setMovieMakerConfig({ ...MOVIEMAKER_DEFAULTS });
    setMode("zimage");
    setComposeSubMode("inpaint");
    setResult(null);
    setError(null);
    setLastSeed(null);
    setOutputDir("");
    markCleanAfterUpdate(); // a fresh default project starts clean
    toast("All settings reset to defaults", "info");
  }, [toast]);

  const handleOpenOutputFolder = useCallback(() => {
    const dir = outputDir.trim();
    if (dir) {
      fetch("/api/open-output", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir }) });
    } else {
      fetch("/api/open-output", { method: "POST" });
    }
  }, [outputDir]);

  const handleLoadComfyFile = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mp4,.png,.webm,.mov";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      setError(null);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/extract-metadata", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Failed to extract metadata");
          return;
        }
        const promptJson = data.prompt;
        if (!promptJson || typeof promptJson !== "object") {
          setError("No ComfyUI prompt data found in this file");
          return;
        }
        const { params: parsed, mode: detectedMode, extra } = parseComfyPrompt(promptJson as Record<string, unknown>);
        setParams((prev) => ({ ...prev, ...parsed }));
        setMode(detectedMode);
        if (parsed.seed != null) setLastSeed(parsed.seed);
        const parts: string[] = [`Mode: ${detectedMode}`];
        if (parsed.seed != null) parts.push(`Seed: ${parsed.seed}`);
        if (parsed.width && parsed.height) parts.push(`${parsed.width}×${parsed.height}`);
        if (parsed.frames) parts.push(`${parsed.frames} frames`);
        if (extra.sourceImageName) parts.push(`Source: ${extra.sourceImageName}`);
        setError(`✓ Loaded from ${file.name}: ${parts.join(" · ")}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to extract metadata");
      }
    };
    input.click();
  }, [setMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drag-and-drop file import ──
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) { setDragOver(false); dragCounterRef.current = 0; }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Shared handler for dropping/selecting a classic-mode I2I source image. Used by the
  // per-field dropzones so a media drop lands in THAT field (instead of bubbling up to the
  // page-level catch-all, which only imports settings/workflow JSON). Path-based: uploads to
  // ComfyUI input/ and stores the returned filename; preview is a transient object URL.
  const handleSourceImageFile = useCallback(async (file: File, i2iDenoise: number, i2iSteps: number) => {
    if (!file.type.startsWith("image/")) {
      toast("Please drop an image file here.", "warning");
      return;
    }
    try {
      setStatus("uploading");
      const name = await uploadImage(file);
      updateParam("sourceImage", name);
      updateParam("denoise", i2iDenoise);
      updateParam("steps", i2iSteps);
      setSourcePreview(URL.createObjectURL(file));
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setStatus("error");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateParam, toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    dragCounterRef.current = 0;

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // The page-level handler is the CATCH-ALL: it only handles project-level files
    // (settings JSON / ComfyUI workflow JSON). Per-field media drops are handled by the
    // individual input dropzones (which call stopPropagation). If a media file reaches
    // here it means it was dropped on the page background, NOT on a field, so give clear
    // guidance instead of silently mis-treating it as a settings/workflow import.
    const file = files.find((f) => f.name.toLowerCase().endsWith(".json")) ?? files[0];
    const isJson = file.name.toLowerCase().endsWith(".json");

    if (!isJson) {
      const isMedia = file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/");
      toast(
        isMedia
          ? "To use this file, drop it directly onto an input field (e.g. Reference Image / Source Video / Audio). Dropping on the page background only imports .json settings or workflows."
          : "Unsupported file. Drop a .json settings/workflow file here, or drop media directly onto a specific input field.",
        "warning",
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(reader.result as string);
      } catch {
        toast("Invalid JSON: the dropped file could not be parsed.", "error");
        return;
      }
      if (!parsed || typeof parsed !== "object") {
        toast(`"${file.name}" is not a recognized Vek-Snap settings or workflow file.`, "error");
        return;
      }
      const obj = parsed as Record<string, unknown>;

      // ── Vek-Snap settings file? (saved via Save Settings / auto-save snapshot) ──
      const isVekSettings =
        "params" in obj || "ltx2Config" in obj || "s2vConfig" in obj || "aceStepConfig" in obj ||
        ("mode" in obj && "version" in obj);
      // ── ComfyUI API prompt? (node-id → { class_type, inputs }) ──
      const looksLikeComfyPrompt = Object.values(obj).some(
        (v) => v != null && typeof v === "object" && "class_type" in (v as Record<string, unknown>),
      );

      if (isVekSettings) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const config = obj as any;
        if (config.params) setParams((prev) => ({ ...prev, ...config.params }));
        // RAW setter: preserve loaded resolution/steps (wrapped setMode would clobber them).
        if (config.mode) setModeRaw(config.mode);
        if (config.composeSubMode) setComposeSubMode(config.composeSubMode);
        if (config.lastSeed != null) setLastSeed(config.lastSeed);
        if (config.outputDir) setOutputDir(config.outputDir);
        if (config.ltx2Config) setLtx2Config((prev: LTX2Config) => ({ ...prev, ...config.ltx2Config }));
        if (config.ltx25Config) setLtx25Config((prev: LTX2Config) => ({ ...prev, ...config.ltx25Config }));
        if (config.s2vConfig) setS2vConfig((prev: WanS2VConfig) => ({ ...prev, ...config.s2vConfig }));
        if (config.directorConfig) setDirectorConfig((prev: DirectorConfig) => ({ ...prev, ...config.directorConfig }));
        if (config.restoreConfig) setRestoreConfig((prev: VideoRestorationConfig) => ({ ...prev, ...config.restoreConfig }));
        if (config.aceStepConfig) setAceStepConfig((prev: AceStepConfig) => ({ ...prev, ...config.aceStepConfig }));
        if (config.heartMuLaConfig) setHeartMuLaConfig((prev: HeartMuLaConfig) => ({ ...prev, ...config.heartMuLaConfig }));
        if (config.dramaBoxConfig) setDramaBoxConfig((prev: DramaBoxConfig) => ({ ...prev, ...config.dramaBoxConfig }));
        if (config.movieMakerConfig) setMovieMakerConfig((prev: MovieMakerConfig) => ({ ...prev, ...config.movieMakerConfig }));
        addRecentFile(file.name, reader.result as string);
        markCleanAfterUpdate(); // imported state is the new clean baseline
        toast(`Imported settings from ${file.name}`, "success");
        return;
      }

      if (looksLikeComfyPrompt) {
        try {
          const { params: p, mode: detectedMode } = parseComfyPrompt(obj);
          setParams((prev) => ({ ...prev, ...p }));
          // RAW setter: keep the resolution/steps parsed from the workflow.
          setModeRaw(detectedMode);
          if (p.seed != null) setLastSeed(p.seed);
          markCleanAfterUpdate(); // loaded workflow is the new clean baseline
          toast(`Loaded ComfyUI workflow from ${file.name}, mode: ${detectedMode}`, "success");
        } catch {
          toast("This looks like a ComfyUI workflow but could not be parsed (it may be the editor graph export rather than an API prompt).", "error");
        }
        return;
      }

      toast(`"${file.name}" is not a recognized Vek-Snap settings or ComfyUI workflow file.`, "error");
    };
    reader.readAsText(file);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, addRecentFile]);

  return (
    <RenderStatusProvider>
    <div
      className="flex flex-col h-screen overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-[300] bg-background/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="border-2 border-dashed border-primary/50 rounded-2xl px-12 py-8 text-center">
            <UploadIcon className="w-12 h-12 text-primary/60 mx-auto mb-3" />
            <p className="text-lg font-medium text-foreground">Drop settings file to import</p>
            <p className="text-sm text-muted-foreground">.json files only</p>
          </div>
        </div>
      )}
      <Header
        onSaveSettings={handleSaveSettings}
        onLoadSettings={handleLoadSettings}
        onFreshStart={handleFreshStart}
        onLoadComfyFile={handleLoadComfyFile}
        onOpenOutputFolder={handleOpenOutputFolder}
        showPreview={showPreview}
        onShowPreviewChange={setShowPreview}
        embedMetadata={ltx2Config.embedWorkflowMetadata === true}
        onEmbedMetadataChange={(v) => {
          setLtx2Config((prev) => ({ ...prev, embedWorkflowMetadata: v }));
          try { localStorage.setItem("veksnap-embed-metadata", String(v)); } catch {}
        }}
        recentFiles={recentFiles}
        onLoadRecentFile={handleLoadRecentFile}
        onClearRecentFiles={clearRecentFiles}
        recentFilesEnabled={recentFilesEnabled}
        onRecentFilesEnabledChange={setRecentFilesEnabled}
        comfyConnected={comfyConnected}
      />
      <ServiceManager onComfyStatusChange={setComfyConnected} />
      <ProcessList />

      <PanelGroup orientation="horizontal" className="flex-1 overflow-hidden" id="veksnap-layout">
        {/* Left Sidebar: Controls */}
        <Panel id="left" defaultSize="22" minSize="14" maxSize="35" className="flex flex-col">
          <ScrollArea className="flex-1 overflow-hidden">
            <div className="p-4 space-y-4">
              {/* Self-contained studios use their own controls, hide standard left sidebar */}
              {mode !== "zimage" && mode !== "lora" && mode !== "ltx2" && mode !== "ltx25" && mode !== "director" && mode !== "wan_s2v" && mode !== "restore" && mode !== "acestep" && mode !== "heartmula" && mode !== "lipsync" && mode !== "dramabox" && mode !== "moviemaker" && mode !== "components" && mode !== "metaguard" && (
                <ModelSelector
                  checkpoint={params.checkpoint}
                  motionModule={params.motionModule}
                  mode={mode}
                  composeOutputType={params.composeOutputType}
                  hideMotionModule={mode === "image" || mode === "wan" || mode === "wan_remix" || (mode === "compose" && params.composeOutputType === "image")}
                  onCheckpointChange={(v) => updateParam("checkpoint", v)}
                  onMotionModuleChange={(v) => updateParam("motionModule", v)}
                />
              )}

              {mode !== "zimage" && mode !== "lora" && mode !== "ltx2" && mode !== "ltx25" && mode !== "director" && mode !== "wan_s2v" && mode !== "restore" && mode !== "acestep" && mode !== "heartmula" && mode !== "lipsync" && mode !== "dramabox" && mode !== "moviemaker" && mode !== "components" && mode !== "metaguard" && (
                <>
                  <LoraSelector
                    loras={params.loras}
                    onChange={(loras: LoraEntry[]) => updateParam("loras", loras)}
                    mode={mode}
                  />

                  <EmbeddingSelector
                    embeddings={params.embeddings}
                    onChange={(embeddings: EmbeddingEntry[]) => updateParam("embeddings", embeddings)}
                  />
                </>
              )}

              {/* Camera Shot Helper: always available as an independent reference tool */}
              <CameraShotHelper />

              {mode === "zimage" && (
                <>
                  <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 space-y-1">
                    <p className="text-[10px] text-cyan-400/80 font-medium">Z-Image Turbo Models (auto-loaded)</p>
                    <p className="text-[9px] text-muted-foreground">UNET: z_image_turbo_bf16.safetensors</p>
                    <p className="text-[9px] text-muted-foreground">CLIP: qwen_3_4b.safetensors (lumina2, CPU)</p>
                    <p className="text-[9px] text-muted-foreground">VAE: ae.safetensors</p>
                    <p className="text-[9px] text-cyan-400/60 mt-1">20 steps &middot; euler/simple &middot; CFG 1.0 &middot; txt2img or I2I refine</p>
                  </div>
                  <LoraSelector
                    loras={params.loras}
                    onChange={(loras: LoraEntry[]) => updateParam("loras", loras)}
                    mode={mode}
                  />
                </>
              )}

              {/* ── Foley Audio Generation (post-processing for video modes) ── */}
              {["wan_remix", "video", "wan"].includes(mode) && (
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-sky-400 font-medium flex items-center gap-1.5">
                      🎵 Foley Audio
                    </p>
                    <Switch
                      checked={params.foleyEnabled}
                      onCheckedChange={(v) => updateParam("foleyEnabled", v)}
                      className="scale-75"
                    />
                  </div>
                  {params.foleyEnabled && (
                    <div className="space-y-2">
                      <p className="text-[9px] text-sky-400/60">Generates motion-synced audio after video renders. Requires HunyuanVideo-Foley + VHS custom nodes.</p>
                      <div>
                        <Label className="text-[10px] text-sky-400/70">Audio Description</Label>
                        <textarea
                          value={params.foleyPrompt}
                          onChange={(e) => updateParam("foleyPrompt", e.target.value)}
                          placeholder="Describe the sounds: footsteps on gravel, rustling leaves, distant thunder, a door creaking..."
                          rows={3}
                          className="w-full mt-1 rounded border border-sky-500/30 bg-background px-2 py-1.5 text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-sky-500/50 resize-none"
                        />
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {FOLEY_PROMPT_PRESETS.map((p) => (
                            <button
                              key={p.label}
                              onClick={() => updateParam("foleyPrompt", p.prompt)}
                              className="px-2 py-0.5 rounded text-[9px] border border-sky-500/20 text-sky-400/60 hover:text-sky-400 hover:border-sky-500/40 hover:bg-sky-500/10 transition-colors"
                              title={p.prompt}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <Label className="text-[10px] text-sky-400/70">Negative (sounds to avoid)</Label>
                        <input
                          type="text"
                          value={params.foleyNegativePrompt}
                          onChange={(e) => updateParam("foleyNegativePrompt", e.target.value)}
                          className="w-full mt-1 h-7 rounded border border-sky-500/30 bg-background px-2 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[10px] text-sky-400/70">Sampler</Label>
                        <select
                          value={params.foleySampler}
                          onChange={(e) => {
                            const sampler = FOLEY_SAMPLERS.find((s) => s.value === e.target.value);
                            updateParam("foleySampler", e.target.value);
                            if (sampler) {
                              updateParam("foleySteps", sampler.defaultSteps);
                              updateParam("foleyCfg", sampler.defaultCfg);
                            }
                          }}
                          className="w-full h-7 rounded border border-sky-500/30 bg-background px-2 text-[10px] focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                        >
                          {FOLEY_SAMPLERS.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <Label className="text-[10px] text-sky-400/70">Steps</Label>
                          <input
                            type="number"
                            value={params.foleySteps}
                            onChange={(e) => updateParam("foleySteps", parseInt(e.target.value) || 50)}
                            min={10} max={200} step={1}
                            className="w-full h-7 rounded border border-sky-500/30 bg-background px-2 text-[11px] font-mono"
                          />
                        </div>
                        <div>
                          <Label className="text-[10px] text-sky-400/70">CFG</Label>
                          <input
                            type="number"
                            value={params.foleyCfg}
                            onChange={(e) => updateParam("foleyCfg", parseFloat(e.target.value) || 4.5)}
                            min={1} max={15} step={0.1}
                            className="w-full h-7 rounded border border-sky-500/30 bg-background px-2 text-[11px] font-mono"
                          />
                        </div>
                      </div>

                      {/* Upload existing video for standalone Foley */}
                      <div className="space-y-1.5">
                        <Label className="text-[10px] text-sky-400/70">Upload Video (standalone test)</Label>
                        <label
                          className="flex items-center justify-center w-full h-9 rounded border border-dashed border-sky-500/30 bg-sky-500/5 cursor-pointer hover:border-sky-500/50 hover:bg-sky-500/10 transition-colors"
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const f = e.dataTransfer.files?.[0];
                            if (f && f.type.startsWith("video/")) { handleFoleyVideoUpload(f); }
                          }}
                        >
                          <input
                            type="file"
                            accept="video/mp4,video/webm,video/avi,video/mov,video/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) handleFoleyVideoUpload(f);
                              e.target.value = "";
                            }}
                            disabled={foleyUploading || foleyStatus === "generating"}
                          />
                          <span className="text-[10px] text-sky-400/60">
                            {foleyUploading ? "Processing video..." : "Drop or click to upload MP4"}
                          </span>
                        </label>
                        {foleyUpload && (
                          <div className="rounded border border-sky-500/20 bg-sky-500/5 px-2 py-1.5 space-y-0.5">
                            <p className="text-[10px] text-sky-400/80 font-medium truncate">{foleyUpload.fileName}</p>
                            <p className="text-[9px] text-muted-foreground">
                              {foleyUpload.frameCount} frames · {foleyUpload.fps} fps · {foleyUpload.duration}s
                            </p>
                            <button
                              onClick={() => setFoleyUpload(null)}
                              className="text-[9px] text-red-400/60 hover:text-red-400 underline"
                            >
                              Remove
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Foley status / progress */}
                      {foleyStatus === "preparing" && (
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] text-sky-400/80 animate-pulse">Staging frames for Foley...</p>
                          <button
                            onClick={handleFoleyCancel}
                            className="text-[9px] text-red-400/60 hover:text-red-400 underline"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                      {foleyStatus === "generating" && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <p className="text-[10px] text-sky-400/80">Generating audio... {foleyProgress}/{foleyProgressMax}</p>
                            <button
                              onClick={handleFoleyCancel}
                              className="px-2 py-0.5 rounded text-[9px] border border-red-500/30 text-red-400/70 hover:text-red-400 hover:border-red-500/50 hover:bg-red-500/10 transition-colors"
                            >
                              Stop
                            </button>
                          </div>
                          <div className="w-full h-1.5 bg-sky-500/10 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-sky-500 rounded-full transition-all"
                              style={{ width: foleyProgressMax > 0 ? `${(foleyProgress / foleyProgressMax) * 100}%` : "0%" }}
                            />
                          </div>
                        </div>
                      )}
                      {foleyStatus === "complete" && foleyAudioUrl && (
                        <div className="space-y-1.5">
                          <p className="text-[10px] text-green-400/80">✓ Audio generated</p>
                          <audio controls src={foleyAudioUrl} className="w-full h-8" />
                          <div className="flex gap-2">
                            <a
                              href={foleyAudioUrl}
                              download="VekSnap_Foley.flac"
                              className="flex-1 text-center text-[9px] py-1 rounded border border-sky-500/20 text-sky-400/70 hover:text-sky-400 hover:border-sky-500/40 transition-colors"
                            >
                              Audio only
                            </a>
                            {foleyAudioFile && (foleyUpload || result) && (
                              <button
                                onClick={handleFoleyMerge}
                                disabled={foleyMerging}
                                className="flex-1 text-center text-[9px] py-1 rounded border border-green-500/30 text-green-400/70 hover:text-green-400 hover:border-green-500/50 hover:bg-green-500/5 transition-colors disabled:opacity-50"
                              >
                                {foleyMerging ? "Merging..." : "Video + Audio (.mp4)"}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                      {foleyError && (
                        <p className="text-[10px] text-red-400/80">{foleyError}</p>
                      )}

                      {/* Generate button: works for uploaded video OR post-generation result */}
                      {(foleyUpload || (status === "complete" && result)) && foleyStatus !== "generating" && foleyStatus !== "preparing" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full h-7 text-[10px] border-sky-500/30 text-sky-400/80 hover:text-sky-400 hover:border-sky-500/50"
                          onClick={() => handleFoleyGenerate()}
                          disabled={!params.foleyPrompt.trim()}
                        >
                          {foleyStatus === "complete" ? "Re-generate Audio" : "Generate Foley Audio"}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* AI Tools: always visible at bottom of sidebar */}
              <AiTools />
            </div>
          </ScrollArea>
        </Panel>

        <PanelResizeHandle className="w-1.5 bg-border/50 hover:bg-primary/30 active:bg-primary/50 transition-colors relative group flex items-center justify-center">
          <GripVertical className="w-3 h-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
        </PanelResizeHandle>

        {/* Center: Prompt + Output */}
        <Panel id="center" defaultSize="56" minSize="30" className="flex flex-col overflow-hidden">
              <CenterPanelRenderStatus />
              <ScrollArea className="flex-1 overflow-hidden">
                <div className="p-4 space-y-4">
                  {/* Mode Navigation: Two-tier category system */}
                  <ModeNav mode={mode} onModeChange={setMode} />

                  {/* LoRA Factory: takes over the entire content area */}
                  {mode === "lora" && (
                    <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <LoraFactory />
                    </div>
                  )}

                  {/* WAN 2.2 S2V Studio, sound-to-video with lipsync */}
                  {mode === "wan_s2v" && (
                    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <WanS2VStudio config={s2vConfig} onConfigChange={setS2vConfig} />
                    </div>
                  )}

                  {/* LTX-2 Studio: joint audio-video generation */}
                  {mode === "ltx2" && (
                    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <LTX2Studio config={ltx2Config} onConfigChange={setLtx2Config} />
                    </div>
                  )}

                  {/* LTX-2.5 Studio: two-stage distilled joint audio-video generation */}
                  {mode === "ltx25" && (
                    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <LTX25Studio config={ltx25Config} onConfigChange={setLtx25Config} />
                    </div>
                  )}

                  {/* Director Mode: multi-segment pipeline */}
                  {mode === "director" && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <DirectorStudio config={directorConfig} onConfigChange={setDirectorConfig} />
                    </div>
                  )}

                  {/* Video Restoration: SeedVR2 + Real-ESRGAN */}
                  {mode === "restore" && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <VideoRestoration config={restoreConfig} onConfigChange={setRestoreConfig} />
                    </div>
                  )}

                  {/* AceStep Music Generation */}
                  {mode === "acestep" && (
                    <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <AceStepStudio config={aceStepConfig} onConfigChange={setAceStepConfig} />
                    </div>
                  )}

                  {/* HeartMuLa Music Generation */}
                  {mode === "heartmula" && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <HeartMuLaStudio config={heartMuLaConfig} onConfigChange={setHeartMuLaConfig} />
                    </div>
                  )}

                  {/* Lip-Sync Music Video Studio */}
                  {mode === "lipsync" && (
                    <div className="rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <LipSyncStudio />
                    </div>
                  )}

                  {/* DramaBox Expressive TTS */}
                  {mode === "dramabox" && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <DramaBoxStudio config={dramaBoxConfig} onConfigChange={setDramaBoxConfig} />
                    </div>
                  )}

                  {/* VS - Movie Maker (Multi-Speaker Dialogue) */}
                  {mode === "moviemaker" && (
                    <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <MovieMakerStudio
                        config={movieMakerConfig}
                        onConfigChange={setMovieMakerConfig}
                        onExportToDirector={(segments, configOverrides) => {
                          setDirectorConfig((prev) => ({
                            ...prev,
                            segments: segments as DirectorConfig["segments"],
                            ...(configOverrides as Partial<DirectorConfig>),
                          }));
                          setMode("director");
                        }}
                      />
                    </div>
                  )}

                  {/* Component Manager */}
                  {mode === "components" && (
                    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <ComponentManager />
                    </div>
                  )}

                  {/* Meta-Guard: Privacy Metadata Toolkit */}
                  {mode === "metaguard" && (
                    <div className="rounded-lg border border-teal-500/30 bg-teal-500/5 -mx-1 -mb-1 flex-1 min-h-[600px]">
                      <MetaGuardStudio />
                    </div>
                  )}

                  {mode === "compose" && (
                    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 space-y-2">
                      <p className="text-[11px] text-cyan-400 font-medium flex items-center gap-1.5">
                        <Layers className="w-3.5 h-3.5" /> Re-Imagine: Region-Limited Generation
                      </p>
                      <p className="text-[10px] text-cyan-400/70">
                        Select a region of an image/frame. Only that region gets processed by the AI, drastically reducing render time.
                      </p>
                      {/* Image vs Video output toggle */}
                      <div className="flex gap-1.5 pb-1 border-b border-cyan-500/20">
                        {(["image", "video"] as ComposeOutputType[]).map((t) => (
                          <Button
                            key={t}
                            size="sm"
                            variant={params.composeOutputType === t ? "default" : "outline"}
                            className={`flex-1 text-[10px] h-7 ${params.composeOutputType === t ? "bg-cyan-700 hover:bg-cyan-600" : ""}`}
                            onClick={() => updateParam("composeOutputType", t)}
                          >
                            {t === "image" ? "🖼 Still Image" : "🎬 Animated Video"}
                          </Button>
                        ))}
                      </div>
                      {params.composeOutputType === "image" && (
                        <p className="text-[9px] text-emerald-400/80">Still image mode: no AnimateDiff or motion module needed. Faster, works with SD1.5 + SDXL checkpoints.</p>
                      )}
                      <div className="flex gap-1.5">
                        {(["inpaint", "overlay", "combined"] as ComposeSubMode[]).map((sub) => (
                          <Button
                            key={sub}
                            size="sm"
                            variant={composeSubMode === sub ? "default" : "outline"}
                            className={`flex-1 text-[10px] h-7 ${composeSubMode === sub ? "bg-cyan-600 hover:bg-cyan-500" : ""}`}
                            onClick={() => {
                              setComposeSubMode(sub);
                              // Auto-adjust inpaint strength for sub-mode (Vek-Snap)
                              if (sub === "overlay") setParams((prev) => ({ ...prev, denoise: 1.0, inpaintStrength: 1.0 }));
                              else if (sub === "inpaint") setParams((prev) => ({ ...prev, denoise: 0.5, inpaintStrength: prev.inpaintStrength }));
                              else if (sub === "combined") setParams((prev) => ({ ...prev, denoise: 0.55, inpaintStrength: prev.inpaintStrength }));
                            }}
                          >
                            {sub === "inpaint" ? "Inpaint" : sub === "overlay" ? "Overlay" : "Combined"}
                          </Button>
                        ))}
                      </div>
                      <p className="text-[9px] text-muted-foreground">
                        {composeSubMode === "inpaint" && "Animate/modify the selected region using img2img, preserves original content. Denoise 0.4-0.65 recommended."}
                        {composeSubMode === "overlay" && "Generate entirely new content at region size + RMBG subject isolation. Denoise forced to 1.0."}
                        {composeSubMode === "combined" && "Inpaint region + isolate subject via RMBG background removal. Denoise 0.4-0.65 recommended."}
                      </p>
                      <div className="flex items-center justify-between pt-1 border-t border-cyan-500/20">
                        <div className="flex items-center gap-1.5">
                          <Eye className="w-3.5 h-3.5 text-cyan-400" />
                          <span className="text-[10px] text-cyan-400 font-medium">Content Aware</span>
                        </div>
                        <Switch
                          checked={params.contentAware}
                          onCheckedChange={(v) => updateParam("contentAware", v)}
                          className="scale-75"
                        />
                      </div>
                      {params.contentAware ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] text-muted-foreground/70 flex-shrink-0">Context:</span>
                          <select
                            value={params.contextPadding}
                            onChange={(e) => updateParam("contextPadding", parseFloat(e.target.value))}
                            className="flex-1 h-6 rounded border border-cyan-500/30 bg-background px-1.5 text-[10px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                          >
                            {CONTEXT_PADDING_PRESETS.map((p) => (
                              <option key={p.value} value={p.value}>{p.label}</option>
                            ))}
                          </select>
                          <span className="text-[9px] text-muted-foreground/50 flex-shrink-0">per side</span>
                        </div>
                      ) : (
                        <p className="text-[9px] text-muted-foreground/70">
                          OFF: AI generates blindly within the region crop
                        </p>
                      )}
                    </div>
                  )}

                  {/* Vek-Snap Inpaint Method + Settings */}
                  {mode === "compose" && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                      <p className="text-[11px] text-amber-400 font-medium flex items-center gap-1.5">
                        <Paintbrush className="w-3.5 h-3.5" /> Inpaint Method
                      </p>
                      <select
                        value={params.inpaintMethod}
                        onChange={(e) => {
                          const method = e.target.value as InpaintMethod;
                          updateParam("inpaintMethod", method);
                          // Auto-adjust settings per Vek-Snap defaults
                          if (method === "default") {
                            setParams((prev) => ({ ...prev, inpaintMethod: method, inpaintStrength: 1.0, inpaintRespectiveField: 0.618, inpaintDisableInitialLatent: false }));
                          } else if (method === "detail") {
                            setParams((prev) => ({ ...prev, inpaintMethod: method, inpaintStrength: 0.5, inpaintRespectiveField: 0.0, inpaintDisableInitialLatent: false }));
                          } else if (method === "modify") {
                            setParams((prev) => ({ ...prev, inpaintMethod: method, inpaintStrength: 1.0, inpaintRespectiveField: 0.0, inpaintDisableInitialLatent: true }));
                          }
                        }}
                        className="w-full h-7 rounded border border-amber-500/30 bg-background px-2 text-[10px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                      >
                        {INPAINT_METHODS.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                      <p className="text-[9px] text-muted-foreground">
                        {INPAINT_METHODS.find((m) => m.value === params.inpaintMethod)?.description}
                      </p>

                      {/* Additional prompt (shown for detail + modify methods) */}
                      {(params.inpaintMethod === "detail" || params.inpaintMethod === "modify") && (
                        <div className="space-y-1">
                          <input
                            type="text"
                            value={params.inpaintAdditionalPrompt}
                            onChange={(e) => updateParam("inpaintAdditionalPrompt", e.target.value)}
                            placeholder="Describe what to inpaint (optional)..."
                            className="w-full h-7 rounded border border-amber-500/30 bg-background px-2 text-[10px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                          />
                          {params.inpaintMethod === "detail" && (
                            <div className="flex flex-wrap gap-1">
                              {EXAMPLE_INPAINT_PROMPTS.map((p) => (
                                <button
                                  key={p}
                                  className="text-[8px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400/80 hover:bg-amber-500/20 border border-amber-500/20"
                                  onClick={() => updateParam("inpaintAdditionalPrompt", p)}
                                >
                                  {p}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Advanced inpaint settings (collapsible) */}
                      <details className="group">
                        <summary className="text-[9px] text-amber-400/70 cursor-pointer hover:text-amber-400 select-none">
                          Advanced Inpaint Settings
                        </summary>
                        <div className="mt-2 space-y-2 pl-1">
                          {/* Restore Defaults */}
                          <button
                            onClick={() => setParams((prev) => ({ ...prev, ...INPAINT_DEFAULTS }))}
                            className="flex items-center gap-1 text-[9px] text-amber-400/60 hover:text-amber-400 transition-colors"
                            title="Reset all inpaint settings to defaults"
                          >
                            <RotateCcw className="w-3 h-3" /> Restore Defaults
                          </button>
                          {/* Inpaint Denoising Strength */}
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-muted-foreground whitespace-nowrap w-20">Denoise:</span>
                            <input
                              type="range" min="0" max="1" step="0.01"
                              value={params.inpaintStrength}
                              onChange={(e) => updateParam("inpaintStrength", parseFloat(e.target.value))}
                              className="flex-1 h-1 accent-amber-500"
                            />
                            <span className="text-[9px] font-mono text-amber-400 w-8 text-right">{params.inpaintStrength.toFixed(2)}</span>
                          </div>
                          {/* Respective Field */}
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-muted-foreground whitespace-nowrap w-20">Resp. Field:</span>
                            <input
                              type="range" min="0" max="1" step="0.01"
                              value={params.inpaintRespectiveField}
                              onChange={(e) => updateParam("inpaintRespectiveField", parseFloat(e.target.value))}
                              className="flex-1 h-1 accent-amber-500"
                            />
                            <span className="text-[9px] font-mono text-amber-400 w-8 text-right">{params.inpaintRespectiveField.toFixed(2)}</span>
                          </div>
                          <p className="text-[8px] text-muted-foreground/60 -mt-1">0 = Only Masked, 1 = Whole Image (default: 0.618)</p>
                          {/* Mask Erode / Dilate */}
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-muted-foreground whitespace-nowrap w-20">Erode/Dilate:</span>
                            <input
                              type="range" min="-64" max="64" step="1"
                              value={params.inpaintErodeDilate}
                              onChange={(e) => updateParam("inpaintErodeDilate", parseInt(e.target.value))}
                              className="flex-1 h-1 accent-amber-500"
                            />
                            <span className="text-[9px] font-mono text-amber-400 w-8 text-right">{params.inpaintErodeDilate}</span>
                          </div>
                          <p className="text-[8px] text-muted-foreground/60 -mt-1">+ = expand mask, − = shrink mask</p>
                          {/* Mask Grow (VAEEncodeForInpaint) */}
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-muted-foreground whitespace-nowrap w-20">Mask Grow:</span>
                            <input
                              type="range" min="0" max="64" step="1"
                              value={params.inpaintMaskGrow}
                              onChange={(e) => updateParam("inpaintMaskGrow", parseInt(e.target.value))}
                              className="flex-1 h-1 accent-amber-500"
                            />
                            <span className="text-[9px] font-mono text-amber-400 w-8 text-right">{params.inpaintMaskGrow}px</span>
                          </div>
                          {/* Toggles row */}
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] text-muted-foreground">Invert Mask</span>
                              <Switch
                                checked={params.inpaintInvertMask}
                                onCheckedChange={(v) => updateParam("inpaintInvertMask", v)}
                                className="scale-[0.6]"
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] text-muted-foreground">No Init Latent</span>
                              <Switch
                                checked={params.inpaintDisableInitialLatent}
                                onCheckedChange={(v) => updateParam("inpaintDisableInitialLatent", v)}
                                className="scale-[0.6]"
                              />
                            </div>
                          </div>

                          {/* Content-Aware Engine */}
                          <div className="rounded border border-emerald-500/25 bg-emerald-500/5 p-2 space-y-1.5">
                            <span className="text-[10px] text-emerald-300 font-medium flex items-center gap-1">
                              <Eraser className="w-3 h-3" /> Content-Aware Engine
                            </span>
                            <select
                              value={params.contentAwareEngine}
                              onChange={(e) => updateParam("contentAwareEngine", e.target.value as ContentAwareEngine)}
                              className="w-full h-7 rounded border border-emerald-500/30 bg-background px-2 text-[10px] focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                            >
                              {CONTENT_AWARE_ENGINES.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
                            </select>
                            <p className="text-[9px] text-muted-foreground/70">{CONTENT_AWARE_ENGINES.find((e) => e.value === params.contentAwareEngine)?.description}</p>
                            {params.contentAwareEngine !== "diffdiff" && (
                              <p className="text-[9px] text-amber-300/70">Requires the {params.contentAwareEngine === "powerpaint" ? "PowerPaint" : "BrushNet"} weights (installer model card). If missing, generation errors, switch back to Standard.</p>
                            )}
                            <div className="flex items-center gap-1.5">
                              <Switch
                                checked={params.objectRemoval}
                                onCheckedChange={(v) => updateParam("objectRemoval", v)}
                                className="scale-[0.6]"
                              />
                              <span className="text-[9px] text-emerald-200/90">Object removal (erase subject)</span>
                            </div>
                            {params.contentAwareEngine !== "diffdiff" && (
                              <div className="flex items-center gap-2">
                                <span className="text-[9px] text-muted-foreground whitespace-nowrap w-16">Fill</span>
                                <input
                                  type="range" min="0.1" max="1" step="0.05"
                                  value={params.brushnetScale}
                                  onChange={(e) => updateParam("brushnetScale", parseFloat(e.target.value))}
                                  className="flex-1 h-1 accent-emerald-500"
                                />
                                <span className="text-[9px] font-mono text-emerald-400 w-9 text-right">{Math.round(params.brushnetScale * 100)}%</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </details>
                    </div>
                  )}

                  {/* Re-Imagine / Z-Image Region Selector */}
                  {(mode === "compose" || mode === "zimage") && !showRegionTool && !showMaskPainter && (
                    <div className="space-y-2">
                      {params.regionInfo ? (
                        <div className="relative rounded-lg overflow-hidden border border-border bg-black/20">
                          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30">
                            <span className="text-[11px] font-medium flex items-center gap-1.5">
                              <Layers className="w-3.5 h-3.5 text-cyan-400" />
                              Region: {params.regionInfo.width}×{params.regionInfo.height} @ ({params.regionInfo.x}, {params.regionInfo.y})
                              {params.regionInfo.contextImageFile && (
                                <span className="text-[9px] text-emerald-400 ml-1" title={`Context: ${params.regionInfo.contextWidth}×${params.regionInfo.contextHeight}, pad: ${params.regionInfo.padLeft}L ${params.regionInfo.padTop}T`}>
                                  👁 CA
                                </span>
                              )}
                            </span>
                            <div className="flex gap-1">
                              {paintedMaskUrl || mode === "zimage" ? (
                                <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-cyan-400" onClick={() => setShowMaskPainter(true)}>Edit Mask</Button>
                              ) : (
                                <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => setShowRegionTool(true)}>Change</Button>
                              )}
                              <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-destructive" onClick={() => { updateParam("regionInfo", null); updateParam("sourceImage", null); setBackgroundPreview(null); setSourcePreview(null); setPaintedMaskUrl(null); }}>Remove</Button>
                            </div>
                          </div>
                          {/* Generation size control: paint-mask path (no padding) */}
                          {params.regionInfo && (params.regionInfo.padLeft ?? 0) === 0 && (params.regionInfo.padTop ?? 0) === 0 && (
                            <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/50">
                              <span className="text-[9px] text-muted-foreground whitespace-nowrap">Gen size:</span>
                              <span className="text-[10px] font-mono text-cyan-400">{params.width}×{params.height}</span>
                              <select
                                value="custom"
                                onChange={(e) => {
                                  const target = parseInt(e.target.value);
                                  if (!target || !params.regionInfo) return;
                                  const { contextWidth: cw, contextHeight: ch } = params.regionInfo;
                                  if (!cw || !ch) return;
                                  const longest = Math.max(cw, ch);
                                  const scale = target / longest;
                                  const w = Math.floor((cw * scale) / 8) * 8;
                                  const h = Math.floor((ch * scale) / 8) * 8;
                                  setParams((prev) => ({ ...prev, width: w, height: h }));
                                }}
                                className="flex-1 h-6 rounded border border-cyan-500/30 bg-background px-1.5 text-[10px]"
                              >
                                <option value="custom">{params.width === params.regionInfo.contextWidth && params.height === params.regionInfo.contextHeight ? "Original" : "Custom"}</option>
                                {[512, 768, 1024, 1280, 1536].map((s) => (
                                  <option key={s} value={String(s)}>Fit {s}px</option>
                                ))}
                              </select>
                            </div>
                          )}
                          {backgroundPreview && (
                            <div className="p-2">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={backgroundPreview} alt="Background" className="max-h-40 mx-auto rounded opacity-70" />
                              <p className="text-[9px] text-center text-muted-foreground mt-1">Background frame: region marked for generation</p>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          {mode === "compose" && (
                            <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10" onClick={() => setShowRegionTool(true)}>
                              <Layers className="w-3.5 h-3.5" /> Rectangle Region
                            </Button>
                          )}
                          <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10" onClick={() => setShowMaskPainter(true)}>
                            <Paintbrush className="w-3.5 h-3.5" /> Paint Mask
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {mode === "compose" && showRegionTool && (
                    <InpaintRegionTool
                      onRegionSelected={async (blob, regionInfo, bgBlob) => {
                        try {
                          setStatus("uploading");
                          const file = new File([blob], "region_crop.png", { type: "image/png" });
                          const name = await uploadImage(file);
                          // Store the cropped region as sourceImage
                          updateParam("sourceImage", name);

                          const fullInfo: RegionInfo = { ...regionInfo, sourceImageFile: name };

                          // Content-aware: generate padded context crop + mask
                          if (params.contentAware) {
                            const PADDING_FRAC = params.contextPadding;
                            const rX = regionInfo.x;
                            const rY = regionInfo.y;
                            const rW = regionInfo.width;
                            const rH = regionInfo.height;
                            const srcW = regionInfo.sourceWidth;
                            const srcH = regionInfo.sourceHeight;

                            // Compute padding (clamped to image bounds, rounded to mult of 8)
                            const rawPadL = Math.round(rW * PADDING_FRAC);
                            const rawPadT = Math.round(rH * PADDING_FRAC);
                            const rawPadR = Math.round(rW * PADDING_FRAC);
                            const rawPadB = Math.round(rH * PADDING_FRAC);

                            const padL = Math.min(rawPadL, rX);
                            const padT = Math.min(rawPadT, rY);
                            const padR = Math.min(rawPadR, srcW - rX - rW);
                            const padB = Math.min(rawPadB, srcH - rY - rH);

                            // Round pad to mult of 8 (floor so we stay within bounds)
                            const pL = Math.floor(padL / 8) * 8;
                            const pT = Math.floor(padT / 8) * 8;
                            // Total dimensions must be mult of 8
                            const ctxW = Math.ceil((rW + pL + Math.floor(padR / 8) * 8) / 8) * 8;
                            const ctxH = Math.ceil((rH + pT + Math.floor(padB / 8) * 8) / 8) * 8;

                            // Clamp context crop to image bounds
                            const ctxX = rX - pL;
                            const ctxY = rY - pT;
                            const finalW = Math.min(ctxW, srcW - ctxX);
                            const finalH = Math.min(ctxH, srcH - ctxY);
                            // Re-round to mult of 8
                            const cW = Math.floor(finalW / 8) * 8;
                            const cH = Math.floor(finalH / 8) * 8;

                            // Draw context crop from full background image
                            const bgImg = new Image();
                            const bgUrl = URL.createObjectURL(bgBlob);
                            await new Promise<void>((res) => { bgImg.onload = () => res(); bgImg.src = bgUrl; });

                            const ctxCanvas = document.createElement("canvas");
                            ctxCanvas.width = cW;
                            ctxCanvas.height = cH;
                            const ctxCtx = ctxCanvas.getContext("2d")!;
                            ctxCtx.drawImage(bgImg, -ctxX, -ctxY);

                            // Create mask: black background, white rectangle where inner region is
                            const maskCanvas = document.createElement("canvas");
                            maskCanvas.width = cW;
                            maskCanvas.height = cH;
                            const maskCtx = maskCanvas.getContext("2d")!;
                            maskCtx.fillStyle = "#000000";
                            maskCtx.fillRect(0, 0, cW, cH);
                            maskCtx.fillStyle = "#ffffff";
                            maskCtx.fillRect(pL, pT, rW, rH);

                            // Convert to blobs and upload
                            const ctxBlob = await new Promise<Blob>((res) => ctxCanvas.toBlob((b) => res(b!), "image/png"));
                            const maskBlob = await new Promise<Blob>((res) => maskCanvas.toBlob((b) => res(b!), "image/png"));

                            const ctxFile = new File([ctxBlob], "context_crop.png", { type: "image/png" });
                            const maskFile = new File([maskBlob], "context_mask.png", { type: "image/png" });

                            const ctxName = await uploadImage(ctxFile);
                            const maskName = await uploadImage(maskFile);

                            fullInfo.contextImageFile = ctxName;
                            fullInfo.maskImageFile = maskName;
                            fullInfo.padLeft = pL;
                            fullInfo.padTop = pT;
                            fullInfo.contextWidth = cW;
                            fullInfo.contextHeight = cH;

                            URL.revokeObjectURL(bgUrl);
                          }

                          updateParam("regionInfo", fullInfo);
                          updateParam("width", regionInfo.width);
                          updateParam("height", regionInfo.height);
                          setSourcePreview(URL.createObjectURL(blob));
                          setBackgroundPreview(URL.createObjectURL(bgBlob));
                          setShowRegionTool(false);
                          setStatus("idle");
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Upload failed");
                          setStatus("error");
                        }
                      }}
                      onCancel={() => setShowRegionTool(false)}
                    />
                  )}

                  {/* Mask Painter: freehand inpaint mask */}
                  {(mode === "compose" || mode === "zimage") && showMaskPainter && (
                    <MaskPainter
                      initialMaskUrl={paintedMaskUrl || undefined}
                      onMaskComplete={async (maskBlob, sourceBlob, srcW, srcH) => {
                        try {
                          setStatus("uploading");

                          // Upload original source image (used for post-composite destination)
                          const srcFile = new File([sourceBlob], "mask_source.png", { type: "image/png" });
                          const srcName = await uploadImage(srcFile);

                          // Create full-size mask canvas for bbox computation
                          const mskBmp = await createImageBitmap(maskBlob);
                          const fullMskCanvas = document.createElement("canvas");
                          fullMskCanvas.width = srcW; fullMskCanvas.height = srcH;
                          const fullMskCtx = fullMskCanvas.getContext("2d")!;
                          fullMskCtx.drawImage(mskBmp, 0, 0, srcW, srcH);

                          // ── Vek-Snap intelligent crop ──
                          // 1. Compute mask bounding box (square-ish with 15% extra)
                          const bbox = computeMaskBbox(fullMskCanvas);
                          // 2. Expand using respectiveField (0 = tight crop, 1 = whole image)
                          const respectiveField = params.inpaintRespectiveField;
                          const crop = bbox
                            ? vekSnapSolveAbcd(srcH, srcW, bbox.a, bbox.b, bbox.c, bbox.d, respectiveField)
                            : { a: 0, b: srcH, c: 0, d: srcW };
                          const cropX = crop.c, cropY = crop.a;
                          const cropW = crop.d - crop.c, cropH = crop.b - crop.a;

                          // 3. Compute target generation dimensions (~1024 pixel area, mult of 64)
                          const { h: genH, w: genW } = vekSnapTargetDims(cropH, cropW, 1024);

                          // 4. Crop + scale source image to generation resolution
                          const srcBmp = await createImageBitmap(sourceBlob);
                          const ctxCanvas = document.createElement("canvas");
                          ctxCanvas.width = genW; ctxCanvas.height = genH;
                          const ctxCtx = ctxCanvas.getContext("2d")!;
                          ctxCtx.drawImage(srcBmp, cropX, cropY, cropW, cropH, 0, 0, genW, genH);
                          const ctxBlob = await new Promise<Blob>((res) => ctxCanvas.toBlob((b) => res(b!), "image/png"));
                          const ctxFile = new File([ctxBlob], "context_crop.png", { type: "image/png" });
                          const ctxName = await uploadImage(ctxFile);

                          // 5. Crop + scale mask to generation resolution
                          // Draw from fullMskCanvas (at srcW×srcH) since crop coords are in that space
                          const mskCanvas = document.createElement("canvas");
                          mskCanvas.width = genW; mskCanvas.height = genH;
                          const mskCtx = mskCanvas.getContext("2d")!;
                          mskCtx.drawImage(fullMskCanvas, cropX, cropY, cropW, cropH, 0, 0, genW, genH);
                          const mskBlob = await new Promise<Blob>((res) => mskCanvas.toBlob((b) => res(b!), "image/png"));
                          const maskFile = new File([mskBlob], "painted_mask.png", { type: "image/png" });
                          const maskName = await uploadImage(maskFile);

                          // 6. Vek-Snap preprocessing: fill + soft mask
                          let filledName: string | undefined;
                          let softMaskName: string | undefined;
                          try {
                            const { vekSnapFill, morphologicalOpen } = await import("@/lib/vek-snap-fill");

                            // Vek-Snap Fill at genW×genH: smooth color fill in masked area
                            const filled = vekSnapFill(ctxCanvas, mskCanvas);
                            const filledBlob = await new Promise<Blob>((res) =>
                              filled.toBlob((b) => res(b!), "image/png")
                            );
                            const filledFile = new File([filledBlob], "veksnap_filled.png", { type: "image/png" });
                            filledName = await uploadImage(filledFile);

                            // Morphological Open at srcW×srcH: soft gradient mask for
                            // post-composite (must match sourceImageFile dimensions)
                            const softMask = morphologicalOpen(fullMskCanvas);
                            const softBlob = await new Promise<Blob>((res) =>
                              softMask.toBlob((b) => res(b!), "image/png")
                            );
                            const softFile = new File([softBlob], "soft_mask.png", { type: "image/png" });
                            softMaskName = await uploadImage(softFile);
                          } catch (fillErr) {
                            console.warn("Vek-Snap preprocessing failed:", fillErr);
                          }

                          // contextImageFile = cropped+scaled to genW×genH (VAEEncode input)
                          // filledImageFile = vekSnapFill at genW×genH (for denoise > 0.99)
                          // maskImageFile = cropped+scaled to genW×genH (matches context)
                          // sourceImageFile = original srcW×srcH (post-composite destination)
                          // softMaskFile = morphological_open at srcW×srcH (post-composite blend mask)
                          // cropX/Y/W/H = crop region in original image (for scaling result back)
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

                          updateParam("sourceImage", srcName);
                          updateParam("regionInfo", fullInfo);
                          updateParam("contentAware", true);
                          updateParam("width", genW);
                          updateParam("height", genH);
                          setBackgroundPreview(URL.createObjectURL(sourceBlob));
                          setSourcePreview(URL.createObjectURL(sourceBlob));
                          setPaintedMaskUrl(URL.createObjectURL(maskBlob));
                          setShowMaskPainter(false);
                          setStatus("idle");
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Upload failed");
                          setStatus("error");
                        }
                      }}
                      initialFeather={maskFeather}
                      onFeatherChange={setMaskFeather}
                      onCancel={() => setShowMaskPainter(false)}
                    />
                  )}

                  {/* Outpaint Controls (Image mode) */}
                  {mode === "image" && (
                    <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] text-violet-400 font-medium flex items-center gap-1.5">
                          <Layers className="w-3.5 h-3.5" /> Outpaint: Expand Image
                        </p>
                        <Switch
                          checked={params.outpaint.enabled}
                          onCheckedChange={(checked) =>
                            updateParam("outpaint", { ...params.outpaint, enabled: checked })
                          }
                        />
                      </div>
                      {params.outpaint.enabled && (
                        <div className="space-y-2">
                          <p className="text-[9px] text-violet-400/70">
                            Upload a source image and select directions to expand. The AI will generate new content that seamlessly extends the original.
                          </p>
                          {/* Source image for outpainting */}
                          {params.sourceImage && sourcePreview ? (
                            <div className="relative rounded-lg overflow-hidden border border-border bg-black/20">
                              <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30">
                                <span className="text-[11px] font-medium flex items-center gap-1.5">
                                  <Crop className="w-3.5 h-3.5 text-violet-400" />
                                  Source Image
                                </span>
                                <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-destructive" onClick={() => {
                                  updateParam("sourceImage", null);
                                  updateParam("outpaintInfo", null);
                                  setSourcePreview(null);
                                }}>
                                  Remove
                                </Button>
                              </div>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={sourcePreview} alt="Outpaint source" className="max-h-32 mx-auto rounded p-2" />
                            </div>
                          ) : (
                            <label
                              className="flex items-center justify-center gap-2 w-full py-3 rounded-md border border-dashed border-violet-500/30 text-xs text-violet-400/70 hover:bg-violet-500/5 hover:border-violet-500/50 cursor-pointer transition-colors"
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={async (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const file = e.dataTransfer.files?.[0];
                                if (!file || !file.type.startsWith("image/")) return;
                                try {
                                  setStatus("uploading");
                                  const name = await uploadImage(file);
                                  updateParam("sourceImage", name);
                                  const img = new Image();
                                  const url = URL.createObjectURL(file);
                                  img.onload = () => {
                                    updateParam("width", img.naturalWidth);
                                    updateParam("height", img.naturalHeight);
                                    URL.revokeObjectURL(url);
                                  };
                                  img.src = url;
                                  setSourcePreview(URL.createObjectURL(file));
                                  setStatus("idle");
                                } catch (err) {
                                  setError(err instanceof Error ? err.message : "Upload failed");
                                  setStatus("error");
                                }
                              }}
                            >
                              <UploadIcon className="w-3.5 h-3.5" /> Upload source image to expand
                              <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={async (e) => {
                                  const file = e.target.files?.[0];
                                  if (!file) return;
                                  try {
                                    setStatus("uploading");
                                    const name = await uploadImage(file);
                                    updateParam("sourceImage", name);
                                    // Read image dimensions
                                    const img = new Image();
                                    const url = URL.createObjectURL(file);
                                    img.onload = () => {
                                      updateParam("width", img.naturalWidth);
                                      updateParam("height", img.naturalHeight);
                                      URL.revokeObjectURL(url);
                                    };
                                    img.src = url;
                                    setSourcePreview(URL.createObjectURL(file));
                                    setStatus("idle");
                                  } catch (err) {
                                    setError(err instanceof Error ? err.message : "Upload failed");
                                    setStatus("error");
                                  }
                                }}
                              />
                            </label>
                          )}
                          {params.sourceImage && (
                            <OutpaintControls
                              config={params.outpaint}
                              onChange={(cfg) => updateParam("outpaint", cfg)}
                              sourceWidth={params.width}
                              sourceHeight={params.height}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Smart Upscale (Image mode) */}
                  {mode === "image" && (
                    <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 px-3 py-2 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] text-sky-400 font-medium flex items-center gap-1.5">
                          <Zap className="w-3.5 h-3.5" /> Smart Upscale
                        </p>
                        <select
                          value={params.upscaleMode}
                          onChange={(e) => updateParam("upscaleMode", e.target.value as UpscaleMode)}
                          className="h-6 rounded border border-sky-500/30 bg-background px-1.5 text-[10px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                        >
                          {UPSCALE_MODES.map((m) => (
                            <option key={m.value} value={m.value}>{m.label}</option>
                          ))}
                        </select>
                      </div>
                      {params.upscaleMode !== "off" && (
                        <div className="space-y-2">
                          <p className="text-[9px] text-sky-400/70">
                            {params.upscaleMode === "fast" && "ESRGAN pixel upscale only: fastest, no diffusion. Requires source image."}
                            {params.upscaleMode === "quality" && "ESRGAN upscale + img2img refinement: best quality. Requires source image + checkpoint."}
                          </p>
                          {/* Scale presets */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-muted-foreground">Scale:</span>
                            {UPSCALE_SCALE_PRESETS.map((p) => (
                              <button
                                key={p.value}
                                onClick={() => updateParam("upscaleScale", p.value)}
                                className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                                  params.upscaleScale === p.value
                                    ? "bg-sky-500/20 border-sky-500/50 text-sky-400"
                                    : "border-border text-muted-foreground hover:border-sky-500/30"
                                }`}
                              >
                                {p.label}
                              </button>
                            ))}
                            <span className="text-[9px] text-muted-foreground ml-1">
                              → {Math.round(params.width * params.upscaleScale)}×{Math.round(params.height * params.upscaleScale)}
                            </span>
                          </div>
                          {/* Upscaler model (for fast/quality) */}
                          {(params.upscaleMode === "fast" || params.upscaleMode === "quality") && (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] text-muted-foreground flex-shrink-0">Model:</span>
                              <select
                                value={params.upscaleModel}
                                onChange={(e) => updateParam("upscaleModel", e.target.value)}
                                className="flex-1 h-6 rounded border border-sky-500/30 bg-background px-1.5 text-[10px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                              >
                                {ENHANCE_UPSCALER_MODELS.map((m) => (
                                  <option key={m.value} value={m.value}>{m.label}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          {/* Quality route: denoise + steps */}
                          {params.upscaleMode === "quality" && (
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-0.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[9px] text-muted-foreground">Denoise</span>
                                  <span className="text-[9px] font-mono text-muted-foreground">{params.upscaleDenoise.toFixed(2)}</span>
                                </div>
                                <input
                                  type="range"
                                  min={0.1} max={0.7} step={0.01}
                                  value={params.upscaleDenoise}
                                  onChange={(e) => updateParam("upscaleDenoise", parseFloat(e.target.value))}
                                  className="w-full h-1.5 accent-sky-500"
                                />
                              </div>
                              <div className="space-y-0.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[9px] text-muted-foreground">Steps</span>
                                  <span className="text-[9px] font-mono text-muted-foreground">{params.upscaleSteps}</span>
                                </div>
                                <input
                                  type="range"
                                  min={5} max={40} step={1}
                                  value={params.upscaleSteps}
                                  onChange={(e) => updateParam("upscaleSteps", parseInt(e.target.value))}
                                  className="w-full h-1.5 accent-sky-500"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {mode === "wan" && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 space-y-2">
                      <div>
                        <p className="text-[11px] text-amber-400 font-medium">Wan 2.1 1.3B</p>
                        <p className="text-[10px] text-amber-400/70 mt-0.5">
                          {params.sourceImage ? "I2V mode: animating from source image" : "T2V mode: generating from text prompt"}
                          {" · "}Expect 5-15 min per clip on GTX 1080 Ti
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] text-amber-400/70 flex-shrink-0">Model:</label>
                        <select
                          value={params.wanModel}
                          onChange={(e) => updateParam("wanModel", e.target.value)}
                          className="flex-1 h-7 rounded border border-amber-500/30 bg-background px-2 text-[11px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-amber-500/50 truncate"
                        >
                          {WAN_T2V_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {mode === "wan_remix" && (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 space-y-2">
                      <div>
                        <p className="text-[11px] text-emerald-400 font-medium flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5" /> WAN 2.2 {params.wanSviMode ? "SVI Enhanced I2V" : "Story I2V"} (Two-Pass GGUF)
                        </p>
                        <p className="text-[10px] text-emerald-400/70 mt-0.5">
                          {params.wanSviMode
                            ? "SVI infinite-video pipeline · Camera + Consistent Face · Lightning 4-step"
                            : "Two-pass pipeline: high-Q initial denoising → low-Q refinement · Requires source image"}
                        </p>
                      </div>

                      {/* ── SVI Mode Toggle ── */}
                      <div className="space-y-1.5 pt-1 border-t border-emerald-500/20">
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={params.wanSviMode}
                            onChange={(e) => {
                              const svi = e.target.checked;
                              setParams((prev) => ({
                                ...prev,
                                wanSviMode: svi,
                                wanRemixPass1Steps: svi ? WAN_SVI_MODELS.DEFAULT_STEPS_PASS1 : 3,
                                wanRemixTotalSteps: svi ? WAN_SVI_MODELS.DEFAULT_STEPS_TOTAL : 4,
                                cfg: svi ? WAN_SVI_MODELS.DEFAULT_CFG : 1.0,
                              }));
                            }}
                            className="w-3.5 h-3.5 rounded accent-emerald-500"
                          />
                          <label className="text-[10px] text-emerald-400 font-medium">SVI Mode (Enhanced + Lightning)</label>
                        </div>
                        {params.wanSviMode && (
                          <div className="space-y-1.5 pl-5">
                            {/* Lightning toggle + combo */}
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={params.wanSviLightningEnabled}
                                onChange={(e) => updateParam("wanSviLightningEnabled", e.target.checked)}
                                className="w-3 h-3 rounded accent-amber-500"
                              />
                              <label className="text-[9px] text-amber-400/80">Lightning LoRAs (4-step speed)</label>
                            </div>
                            {params.wanSviLightningEnabled && (
                              <select
                                value={String(params.wanSviLightningCombo)}
                                onChange={(e) => updateParam("wanSviLightningCombo", parseInt(e.target.value))}
                                className="w-full h-6 rounded border border-amber-500/30 bg-background px-2 text-[9px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                              >
                                {WAN_SVI_LIGHTNING_COMBOS.map((c, i) => (
                                  <option key={i} value={String(i)}>{c.label}</option>
                                ))}
                              </select>
                            )}
                            {/* SVI LoRA strength */}
                            <div className="flex items-center gap-2">
                              <label className="text-[9px] text-emerald-400/70 whitespace-nowrap">SVI LoRA:</label>
                              <input
                                type="range" min="0" max="2" step="0.05"
                                value={params.wanSviLoraStrength}
                                onChange={(e) => updateParam("wanSviLoraStrength", parseFloat(e.target.value))}
                                className="flex-1 h-1.5 accent-emerald-500"
                              />
                              <span className="text-[9px] font-mono text-emerald-400 w-7 text-right">{params.wanSviLoraStrength.toFixed(2)}</span>
                            </div>
                            {/* 3-KSampler toggle */}
                            {params.wanSviLightningEnabled && (
                              <>
                                <div className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={params.wanSviTripleKSampler}
                                    onChange={(e) => updateParam("wanSviTripleKSampler", e.target.checked)}
                                    className="w-3 h-3 rounded accent-violet-500"
                                  />
                                  <label className="text-[9px] text-violet-400/80" title="First step without Lightning preserves image structure, recommended for detailed scenes">3-KSampler (structure-preserving first step)</label>
                                </div>
                                {params.wanSviTripleKSampler && (
                                  <div className="flex items-center gap-2">
                                    <label className="text-[9px] text-violet-400/60 whitespace-nowrap">Clean CFG:</label>
                                    <input
                                      type="number" min={1} max={10} step={0.5}
                                      value={params.wanSviCleanStepCfg}
                                      onChange={(e) => updateParam("wanSviCleanStepCfg", parseFloat(e.target.value) || 4.0)}
                                      className="w-16 h-5 rounded border border-violet-500/30 bg-background px-1.5 text-[9px] font-mono"
                                    />
                                    <span className="text-[8px] text-violet-400/50">for motion (lower = calmer)</span>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {/* Test Load: apply exact reference workflow settings */}
                        <button
                          type="button"
                          onClick={() => setParams((prev) => ({
                            ...prev,
                            wanSviMode: true,
                            wanSviLightningEnabled: true,
                            wanSviLightningCombo: 1,
                            wanSviLoraStrength: 1.0,
                            wanSviTripleKSampler: true,
                            wanSviCleanStepCfg: 4.0,
                            wanRemixShift: 8,
                            wanRemixPass1Steps: 4,
                            wanRemixTotalSteps: 7,
                            cfg: 1.0,
                            sampler: "euler",
                            scheduler: "simple",
                            frames: 81,
                            width: 832,
                            height: 480,
                            negativePrompt: "\u8272\u8C03\u8273\u4E3D\uFF0C\u8FC7\u66DD\uFF0C\u9759\u6001\uFF0C\u7EC6\u8282\u6A21\u7CCA\u4E0D\u6E05\uFF0C\u5B57\u5E55\uFF0C\u98CE\u683C\uFF0C\u4F5C\u54C1\uFF0C\u753B\u4F5C\uFF0C\u753B\u9762\uFF0C\u9759\u6B62\uFF0C\u6574\u4F53\u53D1\u7070\uFF0C\u6700\u5DEE\u8D28\u91CF\uFF0C\u4F4E\u8D28\u91CF\uFF0CJPEG\u538B\u7F29\u6B8B\u7559\uFF0C\u4E11\u964B\u7684\uFF0C\u6B8B\u7F3A\u7684\uFF0C\u591A\u4F59\u7684\u624B\u6307\uFF0C\u753B\u5F97\u4E0D\u597D\u7684\u624B\u90E8\uFF0C\u753B\u5F97\u4E0D\u597D\u7684\u8138\u90E8\uFF0C\u7578\u5F62\u7684\uFF0C\u6BC1\u5BB9\u7684\uFF0C\u5F62\u6001\u7578\u5F62\u7684\u80A2\u4F53\uFF0C\u624B\u6307\u878D\u5408\uFF0C\u9759\u6B62\u4E0D\u52A8\u7684\u753B\u9762\uFF0C\u6742\u4E71\u7684\u80CC\u666F\uFF0C\u4E09\u6761\u817F\uFF0C\u80CC\u666F\u4EBA\u5F88\u591A\uFF0C\u5012\u7740\u8D70, \u8BF4\u8BDD, \u8BF4\u5427, \u5531\u6B4C, \u732B",
                            positivePrompt: prev.positivePrompt || "A woman walking through a sunlit garden, cinematic, high quality, smooth motion",
                          }))}
                          className="w-full h-6 rounded border border-orange-500/40 bg-orange-500/10 text-[9px] text-orange-400 font-medium hover:bg-orange-500/20 transition-colors"
                          title="Load exact settings from reference SVI 3-KSampler workflow (shift=8, steps=7, pass1End=4, 3-KSampler, Lightning Combo 2, CFG clean=4)"
                        >
                          Test Load: Reference SVI 3-KSampler Preset
                        </button>
                      </div>

                      {/* Resolution preset */}
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] text-emerald-400/70 flex-shrink-0">Resolution:</label>
                        <select
                          value={`${params.width}x${params.height}`}
                          onChange={(e) => {
                            const [w, h] = e.target.value.split("x").map(Number);
                            updateParam("width", w);
                            updateParam("height", h);
                          }}
                          className="flex-1 h-7 rounded border border-emerald-500/30 bg-background px-2 text-[11px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                        >
                          {WAN_REMIX_RESOLUTION_PRESETS.map((p) => (
                            <option key={p.label} value={`${p.width}x${p.height}`}>{p.label}</option>
                          ))}
                        </select>
                      </div>
                      {/* Frame preset */}
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] text-emerald-400/70 flex-shrink-0">Frames:</label>
                        <select
                          value={String(params.frames)}
                          onChange={(e) => updateParam("frames", parseInt(e.target.value))}
                          className="flex-1 h-7 rounded border border-emerald-500/30 bg-background px-2 text-[11px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                        >
                          {WAN_REMIX_FRAME_PRESETS.map((f) => (
                            <option key={f} value={String(f)}>{f} frames (~{(f / 24).toFixed(1)}s @24fps)</option>
                          ))}
                        </select>
                      </div>
                      {/* High-Q / Low-Q model, hidden in SVI mode (auto-selected) */}
                      {!params.wanSviMode && (
                        <>
                          <div className="flex items-center gap-2">
                            <label className="text-[10px] text-emerald-400/70 flex-shrink-0">High-Q:</label>
                            <input
                              type="text"
                              value={params.wanRemixHighModel}
                              onChange={(e) => updateParam("wanRemixHighModel", e.target.value)}
                              placeholder={WAN_REMIX_MODELS.HIGH_Q}
                              className="flex-1 h-7 rounded border border-emerald-500/30 bg-background px-2 text-[10px] font-mono ring-offset-background focus:outline-none focus:ring-1 focus:ring-emerald-500/50 placeholder:text-muted-foreground/40"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <label className="text-[10px] text-emerald-400/70 flex-shrink-0">Low-Q:</label>
                            <input
                              type="text"
                              value={params.wanRemixLowModel}
                              onChange={(e) => updateParam("wanRemixLowModel", e.target.value)}
                              placeholder={WAN_REMIX_MODELS.LOW_Q}
                              className="flex-1 h-7 rounded border border-emerald-500/30 bg-background px-2 text-[10px] font-mono ring-offset-background focus:outline-none focus:ring-1 focus:ring-emerald-500/50 placeholder:text-muted-foreground/40"
                            />
                          </div>
                        </>
                      )}
                      {params.wanSviMode && (
                        <p className="text-[9px] text-emerald-400/50 font-mono truncate" title={`HIGH: ${WAN_SVI_MODELS.HIGH_GGUF}\nLOW: ${WAN_SVI_MODELS.LOW_GGUF}`}>
                          Models: {WAN_SVI_MODELS.HIGH_GGUF.replace(/.*_/, "").slice(0, 12)}… / {WAN_SVI_MODELS.LOW_GGUF.replace(/.*_/, "").slice(0, 12)}…
                        </p>
                      )}
                      {/* Shift + Two-pass steps */}
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-[9px] text-emerald-400/70">Shift</label>
                          <input
                            type="number"
                            value={params.wanRemixShift}
                            onChange={(e) => updateParam("wanRemixShift", parseFloat(e.target.value) || 5.0)}
                            className="w-full h-7 rounded border border-emerald-500/30 bg-background px-2 text-[11px] font-mono"
                            min={1} max={20} step={0.5}
                          />
                        </div>
                        <div className="col-span-2">
                          <label className="text-[9px] text-emerald-400/70">Quality Preset</label>
                          <select
                            value={`${params.wanRemixPass1Steps}/${params.wanRemixTotalSteps}`}
                            onChange={(e) => {
                              const preset = WAN_REMIX_STEP_PRESETS.find((p) => `${p.pass1}/${p.total}` === e.target.value);
                              if (preset) {
                                setParams((prev) => ({ ...prev, wanRemixPass1Steps: preset.pass1, wanRemixTotalSteps: preset.total }));
                              }
                            }}
                            className="w-full h-7 rounded border border-emerald-500/30 bg-background px-2 text-[11px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                          >
                            {WAN_REMIX_STEP_PRESETS.map((p) => (
                              <option key={p.label} value={`${p.pass1}/${p.total}`}>{p.label}</option>
                            ))}
                            {!WAN_REMIX_STEP_PRESETS.some((p) => p.pass1 === params.wanRemixPass1Steps && p.total === params.wanRemixTotalSteps) && (
                              <option value={`${params.wanRemixPass1Steps}/${params.wanRemixTotalSteps}`}>Custom ({params.wanRemixPass1Steps}/{params.wanRemixTotalSteps})</option>
                            )}
                          </select>
                        </div>
                        <div>
                          <label className="text-[9px] text-emerald-400/70">Pass 1 end</label>
                          <input
                            type="number"
                            value={params.wanRemixPass1Steps}
                            onChange={(e) => updateParam("wanRemixPass1Steps", parseInt(e.target.value) || 3)}
                            className="w-full h-7 rounded border border-emerald-500/30 bg-background px-2 text-[11px] font-mono"
                            min={1} max={30} step={1}
                          />
                        </div>
                        <div>
                          <label className="text-[9px] text-emerald-400/70">Total steps</label>
                          <input
                            type="number"
                            value={params.wanRemixTotalSteps}
                            onChange={(e) => updateParam("wanRemixTotalSteps", parseInt(e.target.value) || 4)}
                            className="w-full h-7 rounded border border-emerald-500/30 bg-background px-2 text-[11px] font-mono"
                            min={1} max={50} step={1}
                          />
                        </div>
                      </div>

                      {/* ── Segment Color Drift Correction ── */}
                      <div className="space-y-1 pt-1 border-t border-emerald-500/20">
                        <div className="flex items-center gap-2">
                          <label className="text-[9px] text-emerald-400/70 whitespace-nowrap">Color Drift Fix:</label>
                          <input
                            type="range" min="0" max="0.5" step="0.01"
                            value={params.segmentColorCorrection}
                            onChange={(e) => updateParam("segmentColorCorrection", parseFloat(e.target.value))}
                            className="flex-1 h-1.5 accent-emerald-500"
                          />
                          <span className="text-[10px] font-mono text-emerald-400 w-8 text-right">{params.segmentColorCorrection.toFixed(2)}</span>
                        </div>
                        <p className="text-[8px] text-muted-foreground/50">Histogram-matches each segment&apos;s last frame to the source image. 0=off, 0.10-0.20=subtle, prevents cumulative saturation/brightness drift.</p>
                      </div>

                      {/* ── Paired WAN LoRAs (HIGH/LOW per pass) ── */}
                      <div className="space-y-1.5 pt-1 border-t border-emerald-500/20">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] text-emerald-400/70 font-medium">Paired Motion LoRAs (HIGH→Pass1, LOW→Pass2)</p>
                          <button
                            type="button"
                            onClick={scanWanPairedLoras}
                            className="text-[9px] text-emerald-400/50 hover:text-emerald-400 flex items-center gap-1 transition-colors"
                            title="Refresh LoRA list"
                          >
                            <RefreshCw className="w-3 h-3" /> Refresh
                          </button>
                        </div>
                        {/* Auto-detected pairs */}
                        {wanPairedLoraOptions.map((opt, idx) => {
                          const existing = params.wanPairedLoras.find((p) => p.highName === opt.highName && p.lowName === opt.lowName);
                          const isEnabled = existing?.enabled ?? false;
                          const strength = existing?.strength ?? 1.0;
                          return (
                            <div key={`auto-${idx}`} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={isEnabled}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setParams((prev) => {
                                    const arr = [...prev.wanPairedLoras];
                                    const i = arr.findIndex((p) => p.highName === opt.highName && p.lowName === opt.lowName);
                                    if (i >= 0) {
                                      arr[i] = { ...arr[i], enabled: checked };
                                    } else {
                                      arr.push({ enabled: checked, highName: opt.highName, lowName: opt.lowName, strength: 1.0 });
                                    }
                                    return { ...prev, wanPairedLoras: arr };
                                  });
                                }}
                                className="w-3 h-3 rounded accent-emerald-500"
                              />
                              <span className="flex-1 text-[10px] text-emerald-400/80 truncate" title={`H: ${opt.highName || "-"}\nL: ${opt.lowName || "-"}`}>
                                {opt.label}
                              </span>
                              <input
                                type="number"
                                value={strength.toFixed(2)}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 1.0;
                                  setParams((prev) => {
                                    const arr = [...prev.wanPairedLoras];
                                    const i = arr.findIndex((p) => p.highName === opt.highName && p.lowName === opt.lowName);
                                    if (i >= 0) {
                                      arr[i] = { ...arr[i], strength: val };
                                    } else {
                                      arr.push({ enabled: true, highName: opt.highName, lowName: opt.lowName, strength: val });
                                    }
                                    return { ...prev, wanPairedLoras: arr };
                                  });
                                }}
                                step={0.05}
                                min={-5}
                                max={5}
                                disabled={!isEnabled}
                                className="w-14 h-6 rounded border border-emerald-500/30 bg-background px-1 text-center text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-40"
                              />
                            </div>
                          );
                        })}
                        {/* Manual paired LoRA entries */}
                        {params.wanPairedLoras
                          .filter((p) => !wanPairedLoraOptions.some((o) => o.highName === p.highName && o.lowName === p.lowName))
                          .map((entry, idx) => (
                            <div key={`manual-${idx}`} className="space-y-1 rounded border border-emerald-500/20 bg-emerald-500/5 p-1.5">
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="checkbox"
                                  checked={entry.enabled}
                                  onChange={(e) => {
                                    setParams((prev) => {
                                      const arr = [...prev.wanPairedLoras];
                                      const i = arr.findIndex((p) => p.highName === entry.highName && p.lowName === entry.lowName);
                                      if (i >= 0) arr[i] = { ...arr[i], enabled: e.target.checked };
                                      return { ...prev, wanPairedLoras: arr };
                                    });
                                  }}
                                  className="w-3 h-3 rounded accent-emerald-500"
                                />
                                <span className="text-[9px] text-emerald-400/60">Manual pair</span>
                                <div className="flex-1" />
                                <input
                                  type="number"
                                  value={entry.strength.toFixed(2)}
                                  onChange={(e) => {
                                    const val = parseFloat(e.target.value) || 1.0;
                                    setParams((prev) => {
                                      const arr = [...prev.wanPairedLoras];
                                      const i = arr.findIndex((p) => p.highName === entry.highName && p.lowName === entry.lowName);
                                      if (i >= 0) arr[i] = { ...arr[i], strength: val };
                                      return { ...prev, wanPairedLoras: arr };
                                    });
                                  }}
                                  step={0.05} min={-5} max={5}
                                  disabled={!entry.enabled}
                                  className="w-14 h-5 rounded border border-emerald-500/30 bg-background px-1 text-center text-[9px] font-mono disabled:opacity-40"
                                />
                                <button
                                  onClick={() => {
                                    setParams((prev) => ({
                                      ...prev,
                                      wanPairedLoras: prev.wanPairedLoras.filter((p) => !(p.highName === entry.highName && p.lowName === entry.lowName)),
                                    }));
                                  }}
                                  className="text-red-400/60 hover:text-red-400 text-[10px]"
                                  title="Remove"
                                >✕</button>
                              </div>
                              <select
                                value={entry.highName}
                                onChange={(e) => {
                                  setParams((prev) => {
                                    const arr = [...prev.wanPairedLoras];
                                    const i = arr.findIndex((p) => p.highName === entry.highName && p.lowName === entry.lowName);
                                    if (i >= 0) arr[i] = { ...arr[i], highName: e.target.value };
                                    return { ...prev, wanPairedLoras: arr };
                                  });
                                }}
                                className="w-full h-5 rounded border border-emerald-500/20 bg-background px-1 text-[9px] font-mono"
                              >
                                <option value="">HIGH (pass 1)</option>
                                {wanLoraFiles.map((f) => <option key={f} value={f}>{f.replace(/^WAN[\\/]/, "")}</option>)}
                              </select>
                              <select
                                value={entry.lowName}
                                onChange={(e) => {
                                  setParams((prev) => {
                                    const arr = [...prev.wanPairedLoras];
                                    const i = arr.findIndex((p) => p.highName === entry.highName && p.lowName === entry.lowName);
                                    if (i >= 0) arr[i] = { ...arr[i], lowName: e.target.value };
                                    return { ...prev, wanPairedLoras: arr };
                                  });
                                }}
                                className="w-full h-5 rounded border border-emerald-500/20 bg-background px-1 text-[9px] font-mono"
                              >
                                <option value="">LOW (pass 2)</option>
                                {wanLoraFiles.map((f) => <option key={f} value={f}>{f.replace(/^WAN[\\/]/, "")}</option>)}
                              </select>
                            </div>
                          ))}
                        {/* Add manual pair button */}
                        <button
                          onClick={() => {
                            setParams((prev) => ({
                              ...prev,
                              wanPairedLoras: [...prev.wanPairedLoras, { enabled: true, highName: "", lowName: "", strength: 1.0 }],
                            }));
                          }}
                          className="w-full h-6 rounded border border-dashed border-emerald-500/30 text-[10px] text-emerald-400/60 hover:text-emerald-400 hover:border-emerald-500/50 transition-colors"
                        >
                          + Add Manual Pair
                        </button>
                        {/* Trigger word guidance for selected WAN paired LoRAs */}
                        <LoRATriggerGuide
                          selectedLoras={params.wanPairedLoras.filter(p => p.enabled).flatMap(p => [p.highName, p.lowName])}
                          onInsertToPrompt={(text) => {
                            setParams((prev) => {
                              const current = prev.positivePrompt.trim();
                              const sep = current ? ", " : "";
                              return { ...prev, positivePrompt: current + sep + text };
                            });
                          }}
                        />
                      </div>

                      {/* ── Storyboard Mode (Multi-Segment Extended Video) ── */}
                      <div className="space-y-1.5 pt-1 border-t border-emerald-500/20">
                        <div className="flex items-center justify-between">
                          <p className="text-[10px] text-emerald-400/70 font-medium flex items-center gap-1">
                            <Film className="w-3 h-3" /> Storyboard Mode
                          </p>
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <span className="text-[9px] text-emerald-400/50">
                              {params.storyboardSegments.length >= 2
                                ? `${params.storyboardSegments.length} segments · ~${((params.storyboardSegments.length * params.frames - (params.storyboardSegments.length - 1)) / params.fps).toFixed(1)}s`
                                : "Off"}
                            </span>
                            <input
                              type="checkbox"
                              checked={params.storyboardSegments.length >= 2}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setParams((prev) => ({
                                    ...prev,
                                    storyboardSegments: [
                                      { prompt: prev.positivePrompt, startImageFile: null, endImageFile: null },
                                      { prompt: "", startImageFile: null, endImageFile: null },
                                    ],
                                  }));
                                } else {
                                  setParams((prev) => ({ ...prev, storyboardSegments: [] }));
                                }
                              }}
                              className="w-3 h-3 rounded accent-emerald-500"
                            />
                          </label>
                        </div>
                        {params.storyboardSegments.length >= 2 && (
                          <>
                            <p className="text-[9px] text-emerald-400/50">
                              Each segment generates ~{(params.frames / params.fps).toFixed(1)}s. Upload keyframes or inherit from adjacent segments automatically.
                            </p>
                            <div className="flex items-center gap-2">
                              <label className="text-[9px] text-emerald-400/70 flex-shrink-0">Segments:</label>
                              <select
                                value={String(params.storyboardSegments.length)}
                                onChange={(e) => {
                                  const count = parseInt(e.target.value);
                                  setParams((prev) => {
                                    const arr = [...prev.storyboardSegments];
                                    while (arr.length < count) arr.push({ prompt: "", startImageFile: null, endImageFile: null });
                                    return { ...prev, storyboardSegments: arr.slice(0, count) };
                                  });
                                }}
                                className="flex-1 h-6 rounded border border-emerald-500/30 bg-background px-2 text-[10px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                              >
                                {[2, 3, 4, 5, 6, 8, 10].map((n) => {
                                  const totalFrames = n * params.frames - (n - 1);
                                  const totalSec = (totalFrames / params.fps).toFixed(1);
                                  return (
                                    <option key={n} value={String(n)}>
                                      {n} segments (~{totalSec}s total)
                                    </option>
                                  );
                                })}
                              </select>
                            </div>

                            {/* ── Segment Cards ── */}
                            <div className="space-y-2">
                              {params.storyboardSegments.map((seg, idx) => {
                                const segStart = (idx * (params.frames - 1)) / params.fps;
                                const segEnd = ((idx + 1) * params.frames - idx) / params.fps;
                                const prevSeg = idx > 0 ? params.storyboardSegments[idx - 1] : null;
                                const nextSeg = idx < params.storyboardSegments.length - 1 ? params.storyboardSegments[idx + 1] : null;
                                const startLabel = seg.startImageFile
                                  ? "Uploaded"
                                  : idx === 0
                                    ? "Source image"
                                    : prevSeg?.endImageFile
                                      ? "Prev end keyframe"
                                      : "Auto (prev last frame)";
                                const endLabel = seg.endImageFile
                                  ? "Uploaded"
                                  : "Auto (last frame)";

                                return (
                                  <div key={idx} className="rounded border border-emerald-500/20 bg-emerald-500/5 p-2 space-y-1.5">
                                    {/* Segment header */}
                                    <div className="flex items-center justify-between">
                                      <span className="text-[10px] text-emerald-400 font-medium">
                                        Shot {idx + 1}
                                      </span>
                                      <div className="flex items-center gap-2">
                                        <button
                                          onClick={() => handleRenderSegment(idx)}
                                          disabled={status === "generating" || status === "queued"}
                                          className="px-1.5 py-0.5 rounded text-[8px] font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                          title={`Render only Shot ${idx + 1} as a single WAN Story segment`}
                                        >
                                          Render Shot
                                        </button>
                                        <span className="text-[9px] text-emerald-400/50">
                                          {segStart.toFixed(1)}s – {segEnd.toFixed(1)}s
                                        </span>
                                      </div>
                                    </div>

                                    {/* Prompt */}
                                    <textarea
                                      value={seg.prompt}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        setParams((prev) => {
                                          const arr = [...prev.storyboardSegments];
                                          arr[idx] = { ...arr[idx], prompt: val };
                                          return { ...prev, storyboardSegments: arr };
                                        });
                                      }}
                                      placeholder={idx === 0 ? "Describe the motion... (uses main prompt if empty)" : `Describe the motion for shot ${idx + 1}...`}
                                      rows={2}
                                      className="w-full rounded border border-emerald-500/20 bg-background px-2 py-1 text-[10px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-emerald-500/50 placeholder:text-muted-foreground/30 resize-none"
                                    />

                                    {/* Keyframe row: Start → End */}
                                    <div className="grid grid-cols-2 gap-2">
                                      {/* Start Keyframe */}
                                      <div className="space-y-0.5">
                                        <div className="flex items-center justify-between">
                                          <span className="text-[8px] text-emerald-400/60 font-medium uppercase tracking-wide">Start</span>
                                          <span className="text-[8px] text-emerald-400/40">{startLabel}</span>
                                        </div>
                                        <div className="relative rounded border border-emerald-500/20 bg-black/20 flex items-center justify-center overflow-hidden group" style={{ minHeight: '3.5rem' }}>
                                          {seg.startImageFile ? (
                                            <>
                                              <img
                                                src={`/api/comfyui/view?filename=${encodeURIComponent(seg.startImageFile)}&type=input`}
                                                alt="Start keyframe"
                                                className="w-full object-contain max-h-40"
                                              />
                                              <button
                                                onClick={() => {
                                                  setParams((prev) => {
                                                    const arr = [...prev.storyboardSegments];
                                                    arr[idx] = { ...arr[idx], startImageFile: null };
                                                    return { ...prev, storyboardSegments: arr };
                                                  });
                                                }}
                                                className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-red-400 text-[9px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                                title="Remove start keyframe"
                                              >✕</button>
                                            </>
                                          ) : keyframeGenerating.has(`${idx}_start`) ? (
                                            <div className="text-center">
                                              <div className="w-5 h-5 border-2 border-emerald-400/40 border-t-emerald-400 rounded-full animate-spin mx-auto" />
                                              <p className="text-[8px] text-emerald-400/50 mt-0.5">Generating...</p>
                                            </div>
                                          ) : (
                                            <div className="flex flex-col items-center gap-0.5">
                                              <span className="text-[8px] text-emerald-400/40">{idx === 0 ? "Uses source" : "Auto"}</span>
                                              <div className="flex gap-1.5">
                                                <label
                                                  className="cursor-pointer text-[8px] text-emerald-400/50 hover:text-emerald-400 underline transition-colors"
                                                  onDragOver={(e) => e.preventDefault()}
                                                  onDrop={async (e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    const file = e.dataTransfer.files?.[0];
                                                    if (!file || !file.type.startsWith("image/")) return;
                                                    try {
                                                      const name = await uploadImage(file);
                                                      setParams((prev) => {
                                                        const arr = [...prev.storyboardSegments];
                                                        arr[idx] = { ...arr[idx], startImageFile: name };
                                                        return { ...prev, storyboardSegments: arr };
                                                      });
                                                    } catch (err) {
                                                      setError(err instanceof Error ? err.message : "Upload failed");
                                                    }
                                                  }}
                                                >
                                                  Upload
                                                  <input
                                                    type="file"
                                                    accept="image/*"
                                                    className="hidden"
                                                    onChange={async (e) => {
                                                      const file = e.target.files?.[0];
                                                      if (!file) return;
                                                      try {
                                                        const name = await uploadImage(file);
                                                        setParams((prev) => {
                                                          const arr = [...prev.storyboardSegments];
                                                          arr[idx] = { ...arr[idx], startImageFile: name };
                                                          return { ...prev, storyboardSegments: arr };
                                                        });
                                                      } catch (err) {
                                                        setError(err instanceof Error ? err.message : "Upload failed");
                                                      }
                                                    }}
                                                  />
                                                </label>
                                                <button
                                                  onClick={() => setKeyframeModal({ segIdx: idx, slot: "start", prompt: seg.prompt })}
                                                  className="text-[8px] text-emerald-400/50 hover:text-emerald-400 underline transition-colors"
                                                  title="Generate keyframe with full image controls"
                                                >
                                                  Gen
                                                </button>
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      </div>

                                      {/* End Keyframe */}
                                      <div className="space-y-0.5">
                                        <div className="flex items-center justify-between">
                                          <span className="text-[8px] text-emerald-400/60 font-medium uppercase tracking-wide">End</span>
                                          <span className="text-[8px] text-emerald-400/40">{endLabel}</span>
                                        </div>
                                        <div className="relative rounded border border-emerald-500/20 bg-black/20 flex items-center justify-center overflow-hidden group" style={{ minHeight: '3.5rem' }}>
                                          {seg.endImageFile ? (
                                            <>
                                              <img
                                                src={`/api/comfyui/view?filename=${encodeURIComponent(seg.endImageFile)}&type=input`}
                                                alt="End keyframe"
                                                className="w-full object-contain max-h-40"
                                              />
                                              <button
                                                onClick={() => {
                                                  setParams((prev) => {
                                                    const arr = [...prev.storyboardSegments];
                                                    arr[idx] = { ...arr[idx], endImageFile: null };
                                                    return { ...prev, storyboardSegments: arr };
                                                  });
                                                }}
                                                className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/60 text-red-400 text-[9px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                                title="Remove end keyframe"
                                              >✕</button>
                                            </>
                                          ) : keyframeGenerating.has(`${idx}_end`) ? (
                                            <div className="text-center">
                                              <div className="w-5 h-5 border-2 border-emerald-400/40 border-t-emerald-400 rounded-full animate-spin mx-auto" />
                                              <p className="text-[8px] text-emerald-400/50 mt-0.5">Generating...</p>
                                            </div>
                                          ) : (
                                            <div className="flex flex-col items-center gap-0.5">
                                              <span className="text-[8px] text-emerald-400/40">Auto</span>
                                              <div className="flex gap-1.5">
                                                <label
                                                  className="cursor-pointer text-[8px] text-emerald-400/50 hover:text-emerald-400 underline transition-colors"
                                                  onDragOver={(e) => e.preventDefault()}
                                                  onDrop={async (e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    const file = e.dataTransfer.files?.[0];
                                                    if (!file || !file.type.startsWith("image/")) return;
                                                    try {
                                                      const name = await uploadImage(file);
                                                      setParams((prev) => {
                                                        const arr = [...prev.storyboardSegments];
                                                        arr[idx] = { ...arr[idx], endImageFile: name };
                                                        return { ...prev, storyboardSegments: arr };
                                                      });
                                                    } catch (err) {
                                                      setError(err instanceof Error ? err.message : "Upload failed");
                                                    }
                                                  }}
                                                >
                                                  Upload
                                                  <input
                                                    type="file"
                                                    accept="image/*"
                                                    className="hidden"
                                                    onChange={async (e) => {
                                                      const file = e.target.files?.[0];
                                                      if (!file) return;
                                                      try {
                                                        const name = await uploadImage(file);
                                                        setParams((prev) => {
                                                          const arr = [...prev.storyboardSegments];
                                                          arr[idx] = { ...arr[idx], endImageFile: name };
                                                          return { ...prev, storyboardSegments: arr };
                                                        });
                                                      } catch (err) {
                                                        setError(err instanceof Error ? err.message : "Upload failed");
                                                      }
                                                    }}
                                                  />
                                                </label>
                                                <button
                                                  onClick={() => setKeyframeModal({ segIdx: idx, slot: "end", prompt: seg.prompt })}
                                                  className="text-[8px] text-emerald-400/50 hover:text-emerald-400 underline transition-colors"
                                                  title="Generate keyframe with full image controls"
                                                >
                                                  Gen
                                                </button>
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                        {/* Quick-link: use first frame of next shot */}
                                        {nextSeg && !seg.endImageFile && nextSeg.startImageFile && (
                                          <button
                                            onClick={() => {
                                              setParams((prev) => {
                                                const arr = [...prev.storyboardSegments];
                                                arr[idx] = { ...arr[idx], endImageFile: nextSeg.startImageFile };
                                                return { ...prev, storyboardSegments: arr };
                                              });
                                            }}
                                            className="text-[8px] text-emerald-400/40 hover:text-emerald-400/70 underline"
                                          >
                                            Use next shot&apos;s start frame
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>

                            {/* Add segment button */}
                            <button
                              onClick={() => {
                                setParams((prev) => ({
                                  ...prev,
                                  storyboardSegments: [...prev.storyboardSegments, { prompt: "", startImageFile: null, endImageFile: null }],
                                }));
                              }}
                              className="w-full h-6 rounded border border-dashed border-emerald-500/30 text-[10px] text-emerald-400/60 hover:text-emerald-400 hover:border-emerald-500/50 transition-colors"
                            >
                              + Add Shot
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {mode === "zimage" && (
                    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 space-y-2">
                      <div>
                        <p className="text-[11px] text-cyan-400 font-medium flex items-center gap-1.5">
                          <Zap className="w-3.5 h-3.5" /> Z-Image Turbo
                        </p>
                        <p className="text-[10px] text-cyan-400/70 mt-0.5">
                          Modern turbo model &middot; Qwen 3 4B text encoder &middot; 20 steps &middot; {params.sourceImage ? "I2I Refine" : "txt2img"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] text-cyan-400/70 flex-shrink-0">Resolution:</label>
                        <select
                          value={`${params.width}x${params.height}`}
                          onChange={(e) => {
                            const [w, h] = e.target.value.split("x").map(Number);
                            updateParam("width", w);
                            updateParam("height", h);
                          }}
                          className="flex-1 h-7 rounded border border-cyan-500/30 bg-background px-2 text-[11px] ring-offset-background focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                        >
                          {ZIMAGE_RESOLUTION_PRESETS.map((p) => (
                            <option key={p.label} value={`${p.width}x${p.height}`}>{p.label}</option>
                          ))}
                        </select>
                      </div>
                      {/* I2I Source Image: upload an image for refinement */}
                      <div className="space-y-1.5 pt-1 border-t border-cyan-500/20">
                        <p className="text-[10px] text-cyan-400/80 font-medium">Image-to-Image Refine</p>
                        {params.sourceImage ? (
                          <div className="space-y-1.5">
                            <div className="relative rounded border border-cyan-500/30 overflow-hidden bg-black/20">
                              <div className="flex items-center justify-between px-2 py-1 bg-cyan-500/10">
                                <span className="text-[9px] text-cyan-400 flex items-center gap-1">
                                  <ImageIcon className="w-3 h-3" /> Source loaded
                                </span>
                                <Button size="sm" variant="ghost" className="h-5 text-[9px] px-1.5 text-destructive" onClick={() => {
                                  updateParam("sourceImage", null);
                                  updateParam("denoise", 1.0);
                                  updateParam("steps", ZIMAGE_MODELS.DEFAULT_STEPS);
                                  setSourcePreview(null);
                                }}>
                                  Remove
                                </Button>
                              </div>
                              {sourcePreview && (
                                <div className="p-1.5">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={sourcePreview} alt="I2I source" className="max-h-28 mx-auto rounded" />
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <label className="text-[9px] text-cyan-400/60 whitespace-nowrap w-16">Denoise:</label>
                              <input
                                type="range" min="0.10" max="0.90" step="0.01"
                                value={params.denoise}
                                onChange={(e) => updateParam("denoise", parseFloat(e.target.value))}
                                className="flex-1 h-1.5 accent-cyan-500"
                              />
                              <span className="text-[10px] font-mono text-cyan-400 w-8 text-right">{params.denoise.toFixed(2)}</span>
                            </div>
                            <p className="text-[8px] text-muted-foreground/50">
                              Low (0.2–0.4): sharpen &amp; add detail &middot; Med (0.4–0.6): significant refinement &middot; High (0.6+): heavy re-render
                            </p>
                          </div>
                        ) : (
                          <label
                            className="flex items-center gap-2 cursor-pointer rounded border border-dashed border-cyan-500/30 px-2 py-2 hover:bg-cyan-500/10 transition-colors"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const f = e.dataTransfer.files?.[0];
                              if (f) handleSourceImageFile(f, ZIMAGE_MODELS.DEFAULT_I2I_DENOISE, ZIMAGE_MODELS.DEFAULT_I2I_STEPS);
                            }}
                          >
                            <ImageIcon className="w-4 h-4 text-cyan-400/50" />
                            <span className="text-[10px] text-cyan-400/60">Drop or click to add source image for I2I refinement</span>
                            <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              await handleSourceImageFile(file, ZIMAGE_MODELS.DEFAULT_I2I_DENOISE, ZIMAGE_MODELS.DEFAULT_I2I_STEPS);
                            }} />
                          </label>
                        )}
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-cyan-400/70">Prompt starters:</label>
                        <div className="flex flex-wrap gap-1">
                          {ZIMAGE_PROMPT_PRESETS.map((p) => (
                            <button
                              key={p.label}
                              onClick={() => updateParam("positivePrompt", p.prompt)}
                              className="text-[9px] px-1.5 py-0.5 rounded border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 pt-1 border-t border-cyan-500/20">
                        <span className="text-[9px] text-muted-foreground/60">Compatibility:</span>
                        <span className="text-[9px] text-green-400">🟢 txt2img</span>
                        <span className="text-[9px] text-green-400">🟢 I2I Refine</span>
                        <span className="text-[9px] text-green-400">🟢 LoRA</span>
                        <span className="text-[9px] text-green-400">🟢 Inpaint</span>
                        <span className="text-[9px] text-red-400">🔴 Video</span>
                        <span className="text-[9px] text-red-400">🔴 FaceID</span>
                      </div>
                      {/* Z-Image Inpainting settings: shown when mask is painted */}
                      {params.regionInfo?.maskImageFile && (
                        <div className="space-y-1.5 pt-1.5 border-t border-cyan-500/20">
                          <p className="text-[10px] text-cyan-400/80 font-medium">Inpaint Settings (DifferentialDiffusion)</p>
                          <div className="flex items-center gap-2">
                            <label className="text-[9px] text-cyan-400/60 whitespace-nowrap w-16">Denoise:</label>
                            <input
                              type="range" min="0.1" max="1.0" step="0.01"
                              value={params.inpaintStrength}
                              onChange={(e) => updateParam("inpaintStrength", parseFloat(e.target.value))}
                              className="flex-1 h-1.5 accent-cyan-500"
                            />
                            <span className="text-[10px] font-mono text-cyan-400 w-8 text-right">{params.inpaintStrength.toFixed(2)}</span>
                          </div>
                          <p className="text-[8px] text-muted-foreground/50">0.44–0.66 typical for edits, higher for replacement</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Video Edit Mode */}
                  {mode === "edit" && (
                    <div className="space-y-3">
                      <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2 space-y-1">
                        <p className="text-[11px] text-violet-400 font-medium flex items-center gap-1.5">
                          <Film className="w-3.5 h-3.5" /> Video Edit Pipeline
                        </p>
                        <p className="text-[10px] text-violet-400/70">
                          Upload an MP4, trim, select region, then generate frame-by-frame with cascaded AnimateDiff batches.
                          Audio is preserved and reassembled at the end.
                        </p>
                      </div>

                      <VideoTrimmer
                        onSessionReady={(session) => {
                          setVideoSession(session);
                          setEditBatchIndex(0);
                          setEditProcessedFrames([]);
                          // Auto-set resolution to match video
                          updateParam("width", Math.round(session.probe.width / 8) * 8);
                          updateParam("height", Math.round(session.probe.height / 8) * 8);
                          updateParam("fps", Math.round(session.probe.fps));
                          updateParam("frames", 16);
                        }}
                      />

                      {/* Region selection for video edit, select area on first extracted frame */}
                      {videoSession && !showRegionTool && !params.regionInfo && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full gap-2 text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
                          onClick={() => setShowRegionTool(true)}
                        >
                          <Layers className="w-3.5 h-3.5" /> Select Region (optional, full-frame if skipped)
                        </Button>
                      )}

                      {videoSession && !showRegionTool && params.regionInfo && (
                        <div className="flex items-center justify-between rounded-lg border border-violet-500/30 px-3 py-1.5">
                          <span className="text-[10px] text-violet-400 font-medium">
                            Region: {params.regionInfo.width}×{params.regionInfo.height}
                          </span>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => setShowRegionTool(true)}>Change</Button>
                            <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-destructive" onClick={() => { updateParam("regionInfo", null); }}>Remove</Button>
                          </div>
                        </div>
                      )}

                      {mode === "edit" && showRegionTool && videoSession && (
                        <InpaintRegionTool
                          initialImageUrl={getFrameUrl(videoSession.extraction.frames[0])}
                          onRegionSelected={async (blob, regionInfo, bgBlob) => {
                            try {
                              setStatus("uploading");
                              const file = new File([blob], "edit_region_crop.png", { type: "image/png" });
                              const name = await uploadImage(file);
                              updateParam("sourceImage", name);
                              const fullInfo: RegionInfo = { ...regionInfo, sourceImageFile: name };
                              updateParam("regionInfo", fullInfo);
                              updateParam("width", regionInfo.width);
                              updateParam("height", regionInfo.height);
                              if (bgBlob) setBackgroundPreview(URL.createObjectURL(bgBlob));
                              setShowRegionTool(false);
                              setStatus("idle");
                            } catch {
                              setError("Failed to upload region crop");
                              setStatus("idle");
                            }
                          }}
                          onCancel={() => setShowRegionTool(false)}
                        />
                      )}

                      {videoSession && (
                        <div className="space-y-2 rounded-lg border border-border p-3">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-medium text-violet-400">
                              {videoSession.extraction.frameCount} frames extracted
                            </span>
                            <span className="text-[10px] text-muted-foreground font-mono">
                              {videoSession.batchPlan.length} batches × 16 frames
                            </span>
                          </div>

                          {/* Frame strip preview */}
                          <div className="flex gap-0.5 overflow-x-auto py-1">
                            {videoSession.extraction.frames
                              .filter((_, i) => i % Math.max(1, Math.floor(videoSession.extraction.frameCount / 12)) === 0)
                              .slice(0, 12)
                              .map((framePath, i) => (
                                <img
                                  key={i}
                                  src={getFrameUrl(framePath)}
                                  alt={`Frame ${i}`}
                                  className="h-12 rounded border border-border object-cover flex-shrink-0"
                                />
                              ))}
                          </div>

                          {/* Batch progress */}
                          <div className="text-[10px] text-muted-foreground">
                            <div className="flex items-center justify-between mb-1">
                              <span>Batch Progress</span>
                              <span className="font-mono">{editBatchIndex}/{videoSession.batchPlan.length}</span>
                            </div>
                            <div className="w-full bg-muted rounded-full h-1.5">
                              <div
                                className="bg-violet-500 h-1.5 rounded-full transition-all"
                                style={{ width: `${videoSession.batchPlan.length > 0 ? (editBatchIndex / videoSession.batchPlan.length) * 100 : 0}%` }}
                              />
                            </div>
                          </div>

                          {editProcessedFrames.length > 0 && (
                            <p className="text-[10px] text-green-400">
                              {editProcessedFrames.length} frames processed
                              {result?.promptId?.includes("partial") && (
                                <span className="text-amber-400 ml-1">(partial, interrupted/timed out)</span>
                              )}
                            </p>
                          )}

                          {/* Reassemble button: available whenever we have any result frames */}
                          {result && result.images.length > 0 && status === "complete" && (
                            <div className="space-y-2 pt-1 border-t border-border">
                              <Button
                                className="w-full gap-1.5 h-8 text-xs bg-violet-600 hover:bg-violet-500"
                                onClick={handleReassemble}
                                disabled={reassembling}
                              >
                                {reassembling ? (
                                  <>Reassembling {result.images.length} frames...</>
                                ) : (
                                  <>Reassemble Video ({result.images.length} frames + audio)</>
                                )}
                              </Button>

                              {outputVideoUrl && (
                                <div className="space-y-1.5">
                                  <video
                                    src={outputVideoUrl}
                                    controls
                                    className="w-full rounded-lg border border-border max-h-48 bg-black"
                                  />
                                  <a
                                    href={outputVideoUrl}
                                    download={`veksnap_edit_${videoSession.sessionId}.mp4`}
                                    className="flex items-center justify-center gap-1 text-[10px] text-violet-400 hover:text-violet-300 underline"
                                  >
                                    Download MP4
                                  </a>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* I2V Source Image (Video + Wan + WAN Story modes) */}
                  {(mode === "video" || mode === "wan" || mode === "wan_remix") && !showCropTool && (
                    <div className="space-y-2">
                      {params.sourceImage ? (
                        <div className="relative rounded-lg overflow-hidden border border-border bg-black/20">
                          <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30">
                            <span className="text-[11px] font-medium flex items-center gap-1.5">
                              <Crop className="w-3.5 h-3.5 text-cyan-400" />
                              Source Image (I2V)
                            </span>
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => setShowCropTool(true)}>Change</Button>
                              <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-destructive" onClick={() => { updateParam("sourceImage", null); setSourcePreview(null); }}>Remove</Button>
                            </div>
                          </div>
                          {sourcePreview && (
                            <div className="p-2">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={sourcePreview} alt="Source" className="max-h-32 mx-auto rounded" />
                            </div>
                          )}
                        </div>
                      ) : (
                        <Button variant="outline" size="sm" className="w-full gap-2 text-xs" onClick={() => setShowCropTool(true)}>
                          <Crop className="w-3.5 h-3.5" /> Add Source Image (Image→Video)
                        </Button>
                      )}
                    </div>
                  )}

                  {showCropTool && (
                    <ImageCropTool
                      targetWidth={params.width}
                      targetHeight={params.height}
                      onCropComplete={async (blob) => {
                        try {
                          setStatus("uploading");
                          const file = new File([blob], "source_crop.png", { type: "image/png" });
                          const name = await uploadImage(file);
                          updateParam("sourceImage", name);
                          // Auto-lower denoise for I2V so source image is preserved
                          if (params.denoise > 0.8) updateParam("denoise", 0.65);
                          setSourcePreview(URL.createObjectURL(blob));
                          setShowCropTool(false);
                          setStatus("idle");
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Upload failed");
                          setStatus("error");
                        }
                      }}
                      onCancel={() => setShowCropTool(false)}
                    />
                  )}

                  {/* Pony / PDXL prompt helper, shown when a Pony checkpoint is selected */}
                  {mode !== "wan" && mode !== "wan_remix" && mode !== "lora" && mode !== "ltx2" && mode !== "ltx25" && isPonyCheckpoint(params.checkpoint) && (
                    <div className="rounded-lg border border-pink-500/30 bg-pink-500/5 px-3 py-2 space-y-2">
                      <p className="text-[11px] text-pink-400 font-medium">🦄 Pony / PDXL Model Detected</p>
                      <p className="text-[9px] text-pink-400/70">
                        Pony models use booru-style tags with score prefixes. Click a preset to populate the prompt.
                      </p>
                      <div className="space-y-1">
                        <label className="text-[10px] text-pink-400/70">Prompt starters:</label>
                        <div className="flex flex-wrap gap-1">
                          {PONY_PROMPT_PRESETS.map((p) => (
                            <button
                              key={p.label}
                              onClick={() => updateParam("positivePrompt", p.prompt)}
                              className="text-[9px] px-1.5 py-0.5 rounded border border-pink-500/30 text-pink-300 hover:bg-pink-500/20 transition-colors"
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      {params.negativePrompt !== PONY_NEGATIVE_PROMPT && (
                        <button
                          onClick={() => updateParam("negativePrompt", PONY_NEGATIVE_PROMPT)}
                          className="text-[9px] px-2 py-0.5 rounded border border-pink-500/30 text-pink-300 hover:bg-pink-500/20 transition-colors"
                        >
                          Apply Pony negative prompt
                        </button>
                      )}
                    </div>
                  )}

                  {mode !== "lora" && mode !== "ltx2" && mode !== "ltx25" && mode !== "wan_s2v" && mode !== "director" && mode !== "restore" && mode !== "acestep" && mode !== "heartmula" && mode !== "lipsync" && mode !== "dramabox" && mode !== "moviemaker" && mode !== "components" && mode !== "metaguard" && (
                    <>
                  <PromptEditor
                    positivePrompt={params.positivePrompt}
                    negativePrompt={params.negativePrompt}
                    onPositiveChange={(v) => updateParam("positivePrompt", v)}
                    onNegativeChange={(v) => updateParam("negativePrompt", v)}
                  />

                  <Separator />

                  <RenderPanel
                    status={status}
                    progress={progress}
                    progressMax={progressMax}
                    currentNode={currentNode}
                    onGenerate={mode === "edit" ? handleEditGenerate : () => handleGenerate()}
                    onInterrupt={() => { if (queueRunning) setQueueRunning(false); handleInterrupt(); }}
                    onSkip={handleSkip}
                    onPauseBatch={handlePauseBatch}
                    onResumeBatch={handleResumeBatch}
                    batchPaused={batchPaused}
                    isBatch={batchTotalRef.current > 1}
                    disabled={!!disabledReason}
                    disabledReason={disabledReason}
                    wsPreviewCount={wsPreviewCount}
                    stepTimestamps={stepTimestamps}
                    segmentProgress={segmentProgress}
                    passLabel={passLabel}
                    queue={renderQueue.map((j) => ({ id: j.id, label: j.label, mode: j.mode, status: j.status }))}
                    queueRunning={queueRunning}
                    onAddToQueue={enqueueCurrentRender}
                    onRunQueue={() => setQueueRunning(true)}
                    onStopQueue={() => setQueueRunning(false)}
                    onRemoveQueueItem={removeQueueJob}
                    onClearQueue={clearRenderQueue}
                  />
                    </>
                  )}

                  {mode !== "lora" && mode !== "ltx2" && mode !== "ltx25" && mode !== "wan_s2v" && mode !== "director" && mode !== "restore" && mode !== "acestep" && mode !== "heartmula" && mode !== "lipsync" && mode !== "dramabox" && mode !== "moviemaker" && mode !== "components" && mode !== "metaguard" && (
                    <>
                  {watchdogWarning && (
                    <div className="text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 rounded-md p-3 flex items-center gap-2">
                      <span className="text-base">🌡️</span>
                      <span>{watchdogWarning}</span>
                    </div>
                  )}

                  {error && (
                    <pre className="text-xs text-destructive bg-destructive/10 rounded-md p-3 max-h-32 overflow-auto whitespace-pre-wrap break-words font-sans">
                      {error}
                    </pre>
                  )}

                  <OutputViewer result={result} fps={params.fps} previewUrl={previewUrl} status={status} previewHistory={previewHistory} />
                    </>
                  )}

                  {/* Composite Preview: Re-Imagine video mode only (composites AnimateDiff frames onto background) */}
                  {mode === "compose" && params.composeOutputType === "video" && result && params.regionInfo && backgroundPreview && (
                    <CompositePreview
                      result={result}
                      regionInfo={params.regionInfo}
                      backgroundUrl={backgroundPreview}
                      fps={params.fps}
                      onReReimagine={async (compositeBlob) => {
                        try {
                          setStatus("uploading");
                          const ri = params.regionInfo!;
                          const srcW = ri.sourceWidth;
                          const srcH = ri.sourceHeight;
                          const w = ri.contextWidth || Math.floor(srcW / 8) * 8;
                          const h = ri.contextHeight || Math.floor(srcH / 8) * 8;

                          // 1. Upload composite as new source image (srcW×srcH)
                          const srcFile = new File([compositeBlob], "rereimagine_source.png", { type: "image/png" });
                          const srcName = await uploadImage(srcFile);

                          // 2. Create resized context image at w×h for VAEEncode
                          const srcBmp = await createImageBitmap(compositeBlob);
                          const ctxCanvas = document.createElement("canvas");
                          ctxCanvas.width = w; ctxCanvas.height = h;
                          const ctxCtx = ctxCanvas.getContext("2d")!;
                          ctxCtx.drawImage(srcBmp, 0, 0, w, h);
                          const ctxBlob = await new Promise<Blob>((res) => ctxCanvas.toBlob((b) => res(b!), "image/png"));
                          const ctxFile = new File([ctxBlob], "rereimagine_context.png", { type: "image/png" });
                          const ctxName = await uploadImage(ctxFile);

                          // 3. Re-compute vek-snap fill with new source + existing mask
                          let filledName = ri.filledImageFile;
                          try {
                            // Load existing mask at w×h for vek-snap fill
                            const maskUrl = paintedMaskUrl
                              ? paintedMaskUrl
                              : `/comfyui/view?filename=${encodeURIComponent(ri.maskImageFile || "")}&type=input`;
                            const maskImg = new Image();
                            maskImg.crossOrigin = "anonymous";
                            await new Promise<void>((res, rej) => { maskImg.onload = () => res(); maskImg.onerror = rej; maskImg.src = maskUrl; });
                            const mskCanvas = document.createElement("canvas");
                            mskCanvas.width = w; mskCanvas.height = h;
                            const mskCtx = mskCanvas.getContext("2d")!;
                            mskCtx.drawImage(maskImg, 0, 0, w, h);

                            const { vekSnapFill } = await import("@/lib/vek-snap-fill");
                            const filled = vekSnapFill(ctxCanvas, mskCanvas);
                            const filledBlob = await new Promise<Blob>((res) => filled.toBlob((b) => res(b!), "image/png"));
                            const filledFile = new File([filledBlob], "rereimagine_filled.png", { type: "image/png" });
                            filledName = await uploadImage(filledFile);
                          } catch (fillErr) {
                            console.warn("Re-Re-Imagine vek-snap fill failed:", fillErr);
                          }

                          // 4. Update regionInfo: keep mask, softMask, dimensions; update source + context + fill
                          const updatedInfo: RegionInfo = {
                            ...ri,
                            sourceImageFile: srcName,
                            contextImageFile: ctxName,
                            filledImageFile: filledName,
                          };

                          updateParam("sourceImage", srcName);
                          updateParam("regionInfo", updatedInfo);
                          const newPreviewUrl = URL.createObjectURL(compositeBlob);
                          setBackgroundPreview(newPreviewUrl);
                          setSourcePreview(newPreviewUrl);
                          setResult(null);
                          setPreviewUrl(null);
                          setStatus("idle");
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Re-Re-Imagine failed");
                          setStatus("error");
                        }
                      }}
                    />
                  )}

                  <VideoCompiler result={result} fps={params.fps} />
                </div>
              </ScrollArea>
        </Panel>

        <PanelResizeHandle className="w-1.5 bg-border/50 hover:bg-primary/30 active:bg-primary/50 transition-colors relative group flex items-center justify-center">
          <GripVertical className="w-3 h-3 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
        </PanelResizeHandle>

        {/* Right Sidebar: Generation Params + Resources */}
        <Panel id="right" defaultSize="22" minSize="14" maxSize="35" className="flex flex-col">
              <ScrollArea className="flex-1 overflow-hidden">
                <div className="p-4 space-y-4">
                  {mode !== "lora" && mode !== "ltx2" && mode !== "ltx25" && mode !== "director" && mode !== "wan_s2v" && mode !== "restore" && mode !== "acestep" && mode !== "heartmula" && mode !== "lipsync" && mode !== "dramabox" && mode !== "moviemaker" && mode !== "components" && mode !== "metaguard" && (
                    <>
                      <GenerationParams
                        width={params.width}
                        height={params.height}
                        frames={params.frames}
                        fps={params.fps}
                        steps={params.steps}
                        cfg={params.cfg}
                        sampler={params.sampler}
                        scheduler={params.scheduler}
                        seed={params.seed}
                        randomSeed={params.randomSeed}
                        denoise={params.denoise}
                        clipSkip={params.clipSkip}
                        hiresEnabled={params.hiresEnabled}
                        hiresScale={params.hiresScale}
                        hiresSteps={params.hiresSteps}
                        hiresDenoise={params.hiresDenoise}
                        hiresUpscaleMethod={params.hiresUpscaleMethod}
                        enhanceEnabled={params.enhanceEnabled}
                        enhanceUpscalerModel={params.enhanceUpscalerModel}
                        enhanceDenoise={params.enhanceDenoise}
                        enhanceSteps={params.enhanceSteps}
                        adetailerEnabled={params.adetailerEnabled}
                        adetailerDenoise={params.adetailerDenoise}
                        adetailerCfg={params.adetailerCfg}
                        adetailerSteps={params.adetailerSteps}
                        batchSize={params.batchSize}
                        hasSourceImage={!!params.sourceImage}
                        mode={mode}
                        composeOutputType={params.composeOutputType}
                        lastSeed={lastSeed}
                        onChange={updateParam}
                      />
                      <Separator />
                    </>
                  )}

                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium flex items-center gap-1.5">
                      <Volume2 className="w-3.5 h-3.5" /> Autoplay Media
                    </Label>
                    <Switch checked={autoplay} onCheckedChange={setAutoplay} />
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium flex items-center gap-1.5">System Resources</Label>
                    <Switch checked={showResources} onCheckedChange={setShowResources} />
                  </div>

                  {showResources && (
                    <>
                      <ResourceMonitor />
                      <VirtualMemoryPanel />

                      <ThrottleControls
                        watchdogConfig={watchdogConfig}
                        onWatchdogConfigChange={setWatchdogConfig}
                        onResetDefaults={handleResetSystemPreferences}
                      />
                    </>
                  )}

                  <Separator />

                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium flex items-center gap-1.5">System Logs</Label>
                    <Switch checked={showLogs} onCheckedChange={setShowLogs} />
                  </div>

                  {showLogs && <SystemLogs />}
                </div>
              </ScrollArea>
        </Panel>
      </PanelGroup>

      {/* VRAM OOM warning dialog */}
      <Dialog open={!!vramWarning} onOpenChange={(open) => { if (!open) setVramWarning(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className={vramWarning?.risk === "danger" ? "text-red-400" : "text-amber-400"}>
              {vramWarning?.risk === "danger" ? "VRAM Likely Insufficient" : "VRAM Warning"}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-2">
                <p className="text-sm">{vramWarning?.message}</p>
                {vramWarning?.suggestion && (
                  <p className="text-xs text-muted-foreground">{vramWarning.suggestion}</p>
                )}
                <div className="flex items-center gap-2 text-xs">
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        vramWarning?.risk === "danger" ? "bg-red-500" : "bg-amber-500"
                      }`}
                      style={{ width: `${Math.min(100, ((vramWarning?.estimatedPeakGB ?? 0) / (vramWarning?.totalVramGB ?? 1)) * 100)}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground whitespace-nowrap">
                    {vramWarning?.estimatedPeakGB.toFixed(1)} / {vramWarning?.totalVramGB.toFixed(1)} GB
                  </span>
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setVramWarning(null)}>
              Cancel
            </Button>
            <Button
              variant={vramWarning?.risk === "danger" ? "destructive" : "default"}
              onClick={() => {
                setVramWarning(null);
                skipVramCheckRef.current = true;
                handleGenerate();
              }}
            >
              Proceed Anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Keyframe Generator Modal (Storyboard) ── */}
      <KeyframeGeneratorModal
        open={!!keyframeModal}
        onClose={() => setKeyframeModal(null)}
        onAccept={(filename) => {
          if (!keyframeModal) return;
          const { segIdx, slot } = keyframeModal;
          setParams((prev) => {
            const arr = [...prev.storyboardSegments];
            if (slot === "start") {
              arr[segIdx] = { ...arr[segIdx], startImageFile: filename };
            } else {
              arr[segIdx] = { ...arr[segIdx], endImageFile: filename };
            }
            return { ...prev, storyboardSegments: arr };
          });
          setKeyframeModal(null);
        }}
        initialPrompt={keyframeModal?.prompt || ""}
        segmentIndex={keyframeModal?.segIdx ?? 0}
        slot={keyframeModal?.slot ?? "start"}
        mainWidth={params.width}
        mainHeight={params.height}
        clientId={clientIdRef.current}
      />
    </div>

    {/* ── Fresh Start confirmation dialog ── */}
    <ConfirmDialog
      open={freshStartOpen}
      onOpenChange={setFreshStartOpen}
      title="Reset to Factory Defaults?"
      description="This will clear all prompts, uploaded files, model selections, and settings across all modes."
      confirmLabel="Reset"
      cancelLabel="Cancel"
      variant="destructive"
      onConfirm={executeFreshStart}
    />

    {/* ── Auto-save recovery dialog ── */}
    <ConfirmDialog
      open={recoveryOpen}
      onOpenChange={(open) => { if (!open) { clearAutoSaveRecovery(); setRecoveryOpen(false); } }}
      title="Recover Previous Session?"
      description={`An auto-saved session was found from ${recoveryTimestamp}. Would you like to restore your previous settings?`}
      confirmLabel="Restore"
      cancelLabel="Start Fresh"
      onConfirm={restoreAutoSave}
      onCancel={() => clearAutoSaveRecovery()}
    />
    </RenderStatusProvider>
  );
}
