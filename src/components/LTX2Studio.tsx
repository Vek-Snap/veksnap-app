"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAutoplay } from "@/lib/use-autoplay";
import { ltxCard } from "@/lib/ltx-theme";
import { WorkflowControls } from "@/components/WorkflowControlsSlot";
import {
  Play,
  Square,
  Upload,
  X,
  Film,
  Volume2,
  VolumeX,
  Settings2,
  Sparkles,
  RefreshCw,
  Download,
  Image as ImageIcon,
  Wand2,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  AudioLines,
  Loader2,
  FolderOpen,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HardDrive,
  Timer,
  Cpu,
  Info,
  Palette,
  Eye,
  Maximize2,
  Zap,
  Flame,
  Save,
  BookmarkCheck,
  Rocket,
  Repeat,
  Spline,
  Scissors,
  Paintbrush,
  Edit3,
  Crop,
  Clock,
  Layers,
} from "lucide-react";
import { VideoSlot } from "@/components/media/MediaPlayer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  LTX2Config,
  LTX2_DEFAULTS,
  MotionTrack,
  LTX2_RESOLUTION_PRESETS,
  LTX2_FRAME_PRESETS,
  LTX2_PROMPT_PRESETS,
  LTX2_CHECKPOINT_PRESETS,
  getLTX2CheckpointConfig,
  getPreviewResolution,
  getResolutionScaledDefaults,
  ComfyUIProgress,
  LoraEntry,
  LTX2ModelVersion,
  LTX2PipelineMode,
  LTX2QualityTier,
  LTX2_OFFICIAL_NEGATIVE,
  LTX2_OFFICIAL_LORA_STRENGTH,
  LTX2_OFFICIAL_GUIDER_PARAMS,
  LTX2_MAGIC_SAUCE,
  getLTX2ModelDefaults,
  TURBO_UPSCALE_DEFAULTS,
  getTurboHalfResolution,
  isGGUFModel,
  LTX23_MODEL_DEFAULTS,
  LTX23_INPAINT_LORAS,
  TimelineSegment,
  getLoRATriggerInfo,
} from "@/lib/types";
import { buildLTX2Workflow, buildLTX2OfficialWorkflow, buildLTX2AutoregressiveWorkflow } from "@/lib/workflow-builder";
import { useRegisterComfyWorkflow } from "@/components/ComfyOpenProvider";
import SendToQueueButton from "@/components/SendToQueueButton";
import { STYLE_PRESETS, STYLE_PRESET_OPTIONS, buildNegativePrompt, getPresetFps } from "@/lib/prompt-architect";
import LoRATriggerGuide from "@/components/LoRATriggerGuide";
import LoRATriggerScanner from "@/components/LoRATriggerScanner";
import LoraSelect from "@/components/LoraSelect";
import DecimalInput from "@/components/DecimalInput";
import { getTriggerForLora, setTriggerForLora } from "@/lib/lora-trigger-registry";
import ZRefinePanel from "@/components/ZRefinePanel";
import MotionTrackEditor from "@/components/MotionTrackEditor";
import MaskPainter from "@/components/MaskPainter";
import AudioTrimmer from "@/components/AudioTrimmer";
import ReferencePrepStudio from "@/components/ReferencePrepStudio";
import { estimateLtx2Vram, fetchTotalVramMB, type LTX2VramEstimate } from "@/lib/vram-estimator";
import { useRenderStatus } from "@/lib/render-status-context";
import {
  queuePrompt,
  getHistory,
  getImageUrl,
  interruptGeneration,
  connectComfyStream,
  uploadImage,
  uploadAudio,
  uploadVideo,
  resolveComfyInputAbsPath,
  checkConnection,
  getLivePreviewSupport,
  type LivePreviewSupport,
} from "@/lib/comfyui-api";

function formatEtaTime(seconds: number): string {
  if (seconds < 0 || !isFinite(seconds)) return "--:--";
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function LTX2ETACountdown({ stepTimestamps, progress, progressMax }: {
  stepTimestamps: number[];
  progress: number;
  progressMax: number;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (stepTimestamps.length < 2 || progressMax <= 0) return null;

  // Average ms per step from recent timestamps (use last 10 for smoothing)
  const recent = stepTimestamps.slice(-11);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    intervals.push(recent[i] - recent[i - 1]);
  }
  const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const lastStepMs = intervals[intervals.length - 1];

  const stepsRemaining = progressMax - progress;
  const etaSeconds = (stepsRemaining * avgMs) / 1000;
  const sinceLastStep = (now - stepTimestamps[stepTimestamps.length - 1]) / 1000;
  const liveEta = Math.max(0, etaSeconds - sinceLastStep);

  const elapsed = (now - stepTimestamps[0]) / 1000;

  return (
    <div className="rounded-lg border border-cyan-500/20 bg-gradient-to-r from-cyan-500/5 to-blue-500/5 p-2 mt-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] text-cyan-400/70 flex items-center gap-1">
          <Timer className="w-3 h-3" /> ETA
        </span>
        <span className="text-[9px] text-muted-foreground font-mono">
          {(avgMs / 1000).toFixed(0)}s/step · last {(lastStepMs / 1000).toFixed(0)}s
        </span>
      </div>
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-xl font-mono font-bold text-cyan-400 tabular-nums tracking-tight">
          {formatEtaTime(liveEta)}
        </span>
        <span className="text-[9px] text-cyan-400/50">remaining</span>
      </div>
      <div className="flex justify-between mt-1 text-[8px] text-muted-foreground font-mono">
        <span>Elapsed: {formatEtaTime(elapsed)}</span>
        <span>{stepsRemaining} steps left</span>
      </div>
    </div>
  );
}

interface GuideFrameEntry {
  id: string;
  previewUrl: string | null;   // blob URL for UI preview
  comfyFile: string | null;    // uploaded filename in ComfyUI
  frameIdx: number;            // 0-based frame index
  strength: number;            // 0-1
}

interface LTX2StudioProps {
  config: LTX2Config;
  onConfigChange: (config: LTX2Config) => void;
}

export default function LTX2Studio({ config, onConfigChange }: LTX2StudioProps) {
  const configRef = useRef(config);
  configRef.current = config;

  const setConfig = useCallback(
    (updater: LTX2Config | ((prev: LTX2Config) => LTX2Config)) => {
      const newConfig =
        typeof updater === "function" ? updater(configRef.current) : updater;
      configRef.current = newConfig;
      onConfigChange(newConfig);
    },
    [onConfigChange]
  );
  const { startRender, updateRenderProgress, updateStage: updateHeaderStage, endRender, completeRender } = useRenderStatus();
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [stage, setStage] = useState("");
  const [stepTimestamps, setStepTimestamps] = useState<number[]>([]);
  const cumulativeStepsRef = useRef(0);
  const prevChunkMaxRef = useRef(0);
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [lorasExpanded, setLorasExpanded] = useState(false);
  const [normExpanded, setNormExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [fullSchedulerExpanded, setFullSchedulerExpanded] = useState(false);
  const [denoiseProcessing, setDenoiseProcessing] = useState(false);
  const [denoiseNoiseFloor, setDenoiseNoiseFloor] = useState(-30);
  const [denoiseAmount, setDenoiseAmount] = useState(0.75);
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);
  isRunningRef.current = isRunning;
  const [lastRenderTime, setLastRenderTime] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [outputVideoFile, setOutputVideoFile] = useState<string | null>(null); // ComfyUI output path for swap-audio
  const [generatedOutputUrl, setGeneratedOutputUrl] = useState<string | null>(null); // URL with model-generated audio
  const [a2vAudioFileUsed, setA2vAudioFileUsed] = useState<string | null>(null); // audio file used in generation
  const [audioChoice, setAudioChoice] = useState<"generated" | "original">("generated");
  const [swappingAudio, setSwappingAudio] = useState(false);
  const [autoplay] = useAutoplay();
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null);
  const [previewResolution, setPreviewResolution] = useState<string>(""); // null>(null);
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [endFramePreview, setEndFramePreview] = useState<string | null>(null);
  const [endFrameFile, setEndFrameFile] = useState<string | null>(null);
  const [likenessPreview, setLikenessPreview] = useState<string | null>(null);
  const [referenceSheetPreview, setReferenceSheetPreview] = useState<string | null>(null);
  const [startFrameStrength, setStartFrameStrength] = useState(1.0);
  const [endFrameStrength, setEndFrameStrength] = useState(1.0);
  const [comfyConnected, setComfyConnected] = useState<boolean | null>(null);
  // Live Preview (Tiny VAE) availability, probed from ComfyUI. null = not yet checked.
  const [livePreviewSupport, setLivePreviewSupport] = useState<LivePreviewSupport | null>(null);
  const [isPreview, setIsPreview] = useState(false);
  const [modelPathInput, setModelPathInput] = useState(config.modelBasePath || "");
  const [modelPathValidation, setModelPathValidation] = useState<{
    status: "idle" | "checking" | "valid" | "warning" | "error";
    message: string;
    files?: { subfolder: string; filename: string; exists: boolean; critical: boolean; sizeMB: number }[];
  }>({ status: "idle", message: "" });
  const [modelPathExpanded, setModelPathExpanded] = useState(!!config.modelBasePath);
  const [customRes, setCustomRes] = useState(false);
  const [rawFrameInput, setRawFrameInput] = useState(String(config.numFrames));
  const [rawSecInput, setRawSecInput] = useState((config.numFrames / config.frameRate).toFixed(1));
  const [vramEstimate, setVramEstimate] = useState<LTX2VramEstimate | null>(null);
  const [totalVramMB, setTotalVramMB] = useState<number | null>(null);
  const [llmBusy, setLlmBusy] = useState<"idle" | "describing" | "expanding">("idle");
  const [llmError, setLlmError] = useState<string | null>(null);
  const [a2vAudioPreview, setA2vAudioPreview] = useState<string | null>(null);
  const [a2vAudioDuration, setA2vAudioDuration] = useState<number | null>(null);
  const [a2vTrimEnabled, setA2vTrimEnabled] = useState(false);
  const [a2vTrimStart, setA2vTrimStart] = useState(0);
  const [a2vTrimEnd, setA2vTrimEnd] = useState(0);
  const a2vFileRef = useRef<HTMLInputElement>(null);
  const [guideVideoPreview, setGuideVideoPreview] = useState<string | null>(null);
  const [guideVideoDuration, setGuideVideoDuration] = useState<number | null>(null);
  const guideVideoFileRef = useRef<HTMLInputElement>(null);
  // V2V Inpaint Edit Video state
  const [editVideoPreview, setEditVideoPreview] = useState<string | null>(null);
  const [editVideoDuration, setEditVideoDuration] = useState<number | null>(null);
  const [editVideoFirstFrame, setEditVideoFirstFrame] = useState<string | null>(null); // data URL
  const [editVideoFirstFrameComfy, setEditVideoFirstFrameComfy] = useState<string | null>(null); // ComfyUI input/ filename
  const [editVideoMaskPreview, setEditVideoMaskPreview] = useState<string | null>(null); // data URL of painted mask
  const [editVideoRefPreview, setEditVideoRefPreview] = useState<string | null>(null);
  // Multi-reference: data URL preview map keyed by ComfyUI filename so each slot can render its own thumbnail
  const [editVideoRefPreviews, setEditVideoRefPreviews] = useState<Record<string, string>>({});
  const [showEditMaskPainter, setShowEditMaskPainter] = useState(false);
  // Reference Prep Studio modal: standalone subject-cutout + crop + bg-replace tool.
  // Not yet wired to any workflow; user runs it separately to prepare reference images.
  const [showReferencePrep, setShowReferencePrep] = useState(false);
  const [editVideoExtracting, setEditVideoExtracting] = useState(false);
  const [editVideoUploading, setEditVideoUploading] = useState(false);
  const [editVideoFile, setEditVideoFile] = useState<File | null>(null); // canonical handle, persists across re-renders
  const editVideoFileRef = useRef<HTMLInputElement>(null);
  const editRefImageFileRef = useRef<HTMLInputElement>(null);
  // ── Retake / Extend (native continuity editing) state ──
  const [continuityPreview, setContinuityPreview] = useState<string | null>(null);
  const [continuityDuration, setContinuityDuration] = useState<number | null>(null);
  const [continuityFile, setContinuityFile] = useState<File | null>(null); // canonical handle, survives re-renders
  const [continuityUploading, setContinuityUploading] = useState(false);
  const continuityFileRef = useRef<HTMLInputElement>(null);
  // SAM2 video tracking state
  const [sam2Running, setSam2Running] = useState(false);
  const [sam2Status, setSam2Status] = useState<string | null>(null);
  const [sam2Model, setSam2Model] = useState<"sam2.1_hiera_tiny" | "sam2.1_hiera_small" | "sam2.1_hiera_base_plus" | "sam2.1_hiera_large">("sam2.1_hiera_tiny");
  // SAM2 backend availability, when not installed, its mask-source button is hidden.
  // Optimistic default (true) avoids hiding a working feature on a transient fetch error.
  const [samCaps, setSamCaps] = useState<{ sam2: boolean }>({ sam2: true });
  // Cache of which mask files are video masks (mp4 from SAM2) vs static PNGs
  const [maskIsVideo, setMaskIsVideo] = useState(false);
  const [showTrackEditor, setShowTrackEditor] = useState(false);
  const [extraGuideFrames, setExtraGuideFrames] = useState<GuideFrameEntry[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const promptIdRef = useRef<string | null>(null);
  const clientIdRef = useRef<string>(
    `ltx2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );

  // Reconstruct previews from ComfyUI filenames (after settings load or tab switch)
  // Also handles legacy save files that still contain base64 data URLs in sourceImage
  useEffect(() => {
    const src = config.sourceImage;
    if (src && !sourcePreview) {
      if (src.startsWith("data:") || src.startsWith("blob:")) {
        setSourcePreview(src);
      } else {
        setSourcePreview(getImageUrl(src, "", "input"));
      }
    }
    const likenessRef = config.likenessImage;
    if (likenessRef && !likenessPreview) {
      if (likenessRef.startsWith("data:") || likenessRef.startsWith("blob:")) {
        setLikenessPreview(likenessRef);
      } else {
        setLikenessPreview(getImageUrl(likenessRef, "", "input"));
      }
    }
    // Multi-reference edit-video thumbnails: rebuild any missing preview straight from
    // its persisted ComfyUI input/ path (no base64 retained). Fixes broken thumbnails
    // after a tab switch unmounted/remounted this studio.
    const editRefs = config.editVideoReferenceImages ?? [];
    if (editRefs.length > 0) {
      setEditVideoRefPreviews((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const r of editRefs) {
          if (r.file && !next[r.file]) {
            next[r.file] = getImageUrl(r.file, "", "input");
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    // Edit-video SOURCE video: persisted as an absolute fs path in config. Rebuild the
    // preview (and thus the "loaded" UI state) from the ComfyUI input/video/ path so the
    // source survives a tab switch. We only retain the absolute path, so derive the
    // input-relative basename for the /view URL. No base64, the bytes live on disk.
    const editSrc = config.editVideoSourceFile;
    if (editSrc && !editVideoPreview) {
      const base = editSrc.split(/[\\/]/).pop() || "";
      if (base) setEditVideoPreview(getImageUrl(base, "video", "input"));
    }
    // Retake/Extend SOURCE video: same persistence as edit-video - rebuild preview from the
    // absolute path's basename so the "loaded" state (and the window/append controls) survive a tab switch.
    const contSrc = config.continuitySourceVideo;
    if (contSrc && !continuityPreview) {
      const base = contSrc.split(/[\\/]/).pop() || "";
      if (base) setContinuityPreview(getImageUrl(base, "video", "input"));
    }
  }, [config.sourceImage, config.likenessImage, config.editVideoReferenceImages, config.editVideoSourceFile, config.continuitySourceVideo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch available LoRAs on mount
  useEffect(() => {
    fetch(`/api/lora-files?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: string[]) => {
        setAvailableLoras(list);
        // Auto-select motion track IC-LoRA if none is set
        if (!config.motionTrackLoRA) {
          const motionLora = list.find((n) => {
            const l = n.toLowerCase();
            return l.includes("motion-track") || l.includes("motion_track");
          });
          if (motionLora) {
            setConfig((prev) => ({ ...prev, motionTrackLoRA: motionLora }));
          }
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect installed SAM backends
  useEffect(() => {
    fetch(`/api/sam/capabilities?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((caps) => {
        if (caps && typeof caps.sam2 === "boolean") {
          setSamCaps({ sam2: !!caps.sam2 });
        }
      })
      .catch(() => {});
  }, []);

  const update = useCallback(
    <K extends keyof LTX2Config>(key: K, value: LTX2Config[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    [setConfig]
  );

  // ── LLM: Describe source image via Qwen2.5-VL ──
  const handleDescribeImage = useCallback(async () => {
    if (!config.sourceImage || llmBusy !== "idle") return;
    setLlmBusy("describing");
    setLlmError(null);
    try {
      const res = await fetch("/api/vision-describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imagePath: config.sourceImage }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.description) {
        // Prepend to existing prompt or replace if empty
        const current = configRef.current.prompt.trim();
        const newPrompt = current
          ? `${data.description}\n\n${current}`
          : data.description;
        update("prompt", newPrompt);
      }
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : "Vision describe failed");
    } finally {
      setLlmBusy("idle");
    }
  }, [config.sourceImage, llmBusy, update]);

  // ── LLM: Expand prompt via Qwen3.5-9B ──
  const handleExpandPrompt = useCallback(async () => {
    if (!configRef.current.prompt.trim() || llmBusy !== "idle") return;
    setLlmBusy("expanding");
    setLlmError(null);
    try {
      const styleKey = configRef.current.stylePreset;
      const styleDesc = styleKey !== "none" && STYLE_PRESETS[styleKey]
        ? STYLE_PRESETS[styleKey].description
        : "";
      const res = await fetch("/api/prompt-expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: configRef.current.prompt,
          style: styleDesc,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.expanded) {
        update("prompt", data.expanded);
      }
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : "Prompt expansion failed");
    } finally {
      setLlmBusy("idle");
    }
  }, [llmBusy, update]);

  // ── LLM: Abort running process ──
  const handleAbortLlm = useCallback(async () => {
    try {
      await fetch("/api/llm-abort", { method: "POST" });
    } catch { /* ignore */ }
    setLlmBusy("idle");
    setLlmError("Cancelled by user");
  }, []);

  const validateModelPath = useCallback(async (pathValue: string) => {
    if (!pathValue.trim()) {
      // Clear the path: remove from yaml
      setModelPathValidation({ status: "idle", message: "" });
      update("modelBasePath", "");
      try {
        await fetch("/api/ltx2/model-path", { method: "DELETE" });
      } catch { /* ignore */ }
      return;
    }
    setModelPathValidation({ status: "checking", message: "Validating..." });
    try {
      const res = await fetch("/api/ltx2/model-path", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basePath: pathValue.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setModelPathValidation({ status: "error", message: data.error || "Invalid path" });
        return;
      }
      update("modelBasePath", pathValue.trim());
      if (data.missingCritical > 0) {
        setModelPathValidation({
          status: "warning",
          message: data.message,
          files: data.files,
        });
      } else {
        setModelPathValidation({
          status: "valid",
          message: data.message,
          files: data.files,
        });
      }
    } catch (err) {
      setModelPathValidation({
        status: "error",
        message: err instanceof Error ? err.message : "Validation failed",
      });
    }
  }, [update]);

  const addLora = () => {
    const usedNames = new Set(config.userLoras.map((l) => l.name));
    const firstUnused = availableLoras.find((n) => !usedNames.has(n));
    const entry: LoraEntry = {
      enabled: true,
      name: firstUnused || "",
      strengthModel: 1.0,
      strengthClip: 1.0,
      triggerWord: firstUnused ? getTriggerForLora(firstUnused) : undefined,
    };
    setConfig((prev) => ({ ...prev, userLoras: [...prev.userLoras, entry] }));
  };

  const removeLora = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      userLoras: prev.userLoras.filter((_, i) => i !== index),
    }));
  };

  const updateLora = (index: number, patch: Partial<LoraEntry>) => {
    setConfig((prev) => {
      const updated = prev.userLoras.map((l, i) => {
        if (i !== index) return l;
        const merged = { ...l, ...patch };
        // Auto-populate trigger from registry when LoRA name changes
        if (patch.name && patch.name !== l.name) {
          merged.triggerWord = getTriggerForLora(patch.name);
        }
        // Persist trigger to global registry when user edits it
        if (patch.triggerWord !== undefined && merged.name) {
          setTriggerForLora(merged.name, patch.triggerWord);
        }
        return merged;
      });
      return { ...prev, userLoras: updated };
    });
  };

  const handleAudioDenoise = useCallback(async (mode: "audio" | "merge") => {
    if (!outputUrl) return;
    setDenoiseProcessing(true);
    setError(null);
    try {
      const res = await fetch("/api/audio-denoise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: outputUrl,
          mode,
          noiseFloor: denoiseNoiseFloor,
          noiseAmount: denoiseAmount,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = mode === "audio"
        ? `ltx2_denoised_audio_${Date.now()}.wav`
        : `ltx2_denoised_${Date.now()}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Audio denoise failed");
    } finally {
      setDenoiseProcessing(false);
    }
  }, [outputUrl, denoiseNoiseFloor, denoiseAmount]);

  // Sync raw frame/seconds inputs when config changes externally
  useEffect(() => {
    setRawFrameInput(String(config.numFrames));
    setRawSecInput((config.numFrames / config.frameRate).toFixed(1));
  }, [config.numFrames, config.frameRate]);

  // Check ComfyUI connection on mount + periodic re-check
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let probedThisConnection = false;
    const poll = async () => {
      const ok = await checkConnection();
      setComfyConnected(ok);
      // Probe Live Preview (Tiny VAE) assets once per (re)connection, cheap
      // object_info lookups; result gates the toggle below.
      if (ok && !probedThisConnection) {
        probedThisConnection = true;
        getLivePreviewSupport().then(setLivePreviewSupport).catch(() => {});
      } else if (!ok) {
        probedThisConnection = false;
      }
      // Re-check every 5s while disconnected, every 30s while connected
      timer = setTimeout(poll, ok ? 30000 : 5000);
    };
    poll();
    fetchTotalVramMB().then(setTotalVramMB);
    return () => clearTimeout(timer);
  }, []);

  // If the Tiny VAE assets are confirmed missing, force the toggle off so we
  // never inject nodes ComfyUI can't resolve (which would error the render).
  useEffect(() => {
    if (livePreviewSupport && !livePreviewSupport.supported && config.livePreview) {
      update("livePreview", false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePreviewSupport]);

  // Live VRAM + render time estimation whenever config changes
  useEffect(() => {
    if (totalVramMB) {
      setVramEstimate(estimateLtx2Vram(config, totalVramMB));
    }
  }, [config.width, config.height, config.numFrames, config.enableAudio, config.sourceImage, config.qualityTier, totalVramMB]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  // Track which node is currently executing so we can filter non-sampling progress events
  const currentNodeRef = useRef<string | null>(null);
  // Wall-clock render start for accurate total time (immune to ffmpeg frame spam)
  const renderStartRef = useRef<number>(0);

  // Post-sampling nodes whose progress events should NOT count as diffusion steps.
  // VHS_VideoCombine ("17") fires per-frame progress during ffmpeg encoding which
  // previously inflated the step counter from 8 to 147+.
  const POST_SAMPLING_NODES = new Set(["17", "129", "16"]);

  // When Prompt Timeline is active, generation is allowed even if the main prompt is empty
  // (the global prompt field or segment text provides the conditioning instead).
  const hasPromptContent = !!(config.prompt.trim() ||
    (config.promptRelay && (
      config.promptRelayGlobal?.trim() ||
      config.promptRelaySegments?.some(s => s.text.trim())
    ))
  );

  const handleGenerate = useCallback(async (preview = false) => {
    setIsRunning(true);
    setIsPreview(preview);
    setError(null);
    setLastRenderTime(null);
    setOutputUrl(null);
    setOutputVideoFile(null);
    setLivePreviewUrl(null);
    setGeneratedOutputUrl(null);
    setA2vAudioFileUsed(null);
    setAudioChoice("generated");
    setProgress(0);
    setProgressMax(0);
    setStepTimestamps([]);
    cumulativeStepsRef.current = 0;
    prevChunkMaxRef.current = 0;
    currentNodeRef.current = null;
    renderStartRef.current = Date.now();
    setStage(preview ? "Building preview workflow..." : "Building workflow...");
    startRender("LTX-2", preview ? "Building preview workflow..." : "Building workflow...");

    try {
      const seed = config.randomSeed
        ? Math.floor(Math.random() * 2 ** 32)
        : config.seed < 0
          ? Math.floor(Math.random() * 2 ** 32)
          : config.seed;

      // If source image is a data URL, upload it to ComfyUI first
      let sourceImageFile = config.sourceImage;
      if (sourceImageFile && sourceImageFile.startsWith("data:")) {
        setStage("Uploading source image...");
        const blob = await fetch(sourceImageFile).then((r) => r.blob());
        const file = new File([blob], `ltx2_source_${Date.now()}.png`, {
          type: "image/png",
        });
        sourceImageFile = await uploadImage(file);
        update("sourceImage", sourceImageFile);
      }

      // If likeness character reference is a data URL, upload it to ComfyUI first
      let likenessImageFile = config.likenessImage;
      if (config.likenessEnabled && likenessImageFile && likenessImageFile.startsWith("data:")) {
        setStage("Uploading character reference...");
        const blob = await fetch(likenessImageFile).then((r) => r.blob());
        const file = new File([blob], `ltx2_likeness_${Date.now()}.png`, { type: "image/png" });
        likenessImageFile = await uploadImage(file);
        update("likenessImage", likenessImageFile);
      }

      // A2V: upload audio file if it's a data URL
      let a2vAudioFile = config.a2vAudioFile;
      if (config.a2vMode && a2vAudioPreview && !a2vAudioFile) {
        setStage("Uploading audio for A2V...");
        const blob = await fetch(a2vAudioPreview).then((r) => r.blob());
        const file = new File([blob], `ltx2_a2v_${Date.now()}.wav`, { type: "audio/wav" });
        a2vAudioFile = await uploadAudio(file);
        update("a2vAudioFile", a2vAudioFile);
      }

      // A2V audio intelligence: trim (if user selected a region) then normalize audio length to match video duration
      if (config.a2vMode && a2vAudioFile) {
        const targetDuration = config.numFrames / config.frameRate;
        setStage(a2vTrimEnabled ? "Trimming & normalizing audio..." : "Normalizing audio length...");
        try {
          const normBody: Record<string, unknown> = { audioFile: a2vAudioFile, targetDuration };
          if (a2vTrimEnabled && a2vTrimEnd > a2vTrimStart) {
            normBody.trimStart = a2vTrimStart;
            normBody.trimEnd = a2vTrimEnd;
          }
          const normRes = await fetch("/api/director/normalize-audio", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(normBody),
          });
          if (normRes.ok) {
            const normData = await normRes.json();
            if (normData.action !== "unchanged") {
              console.log(`[A2V] Audio ${normData.action}: ${normData.originalDuration.toFixed(1)}s → ${normData.targetDuration.toFixed(1)}s`);
              a2vAudioFile = normData.audioFile;
            }
          }
        } catch (normErr) {
          console.warn("[A2V] Audio normalization failed, using original:", normErr);
        }
      }

      // Remember which audio file we used (for swap-audio later)
      if (config.a2vMode && a2vAudioFile) {
        setA2vAudioFileUsed(a2vAudioFile);
      }

      // IC-LoRA Motion Guide: upload guide video to ComfyUI input/video/
      let guideVideoFile = config.guideVideoFile;
      if (config.icLoraMode && guideVideoPreview && !guideVideoFile) {
        const videoFile = guideVideoFileRef.current?.files?.[0];
        if (videoFile) {
          setStage("Uploading guide video...");
          guideVideoFile = await uploadVideo(videoFile);
          update("guideVideoFile", guideVideoFile);
        }
      }

      // V2V Inpaint Edit: upload source video to ComfyUI input/video/ (mask was uploaded on paint-complete)
      // and resolve to its absolute filesystem path. VHS_LoadVideoPath validates with `os.path.isfile()`
      // and rejects ComfyUI-input-relative paths like "video/foo.mp4" (see VideoHelperSuite utils.py:322).
      // The relative form returned by uploadVideo() must be converted before it reaches the workflow builder.
      let editVideoSourceFile = config.editVideoSourceFile;
      if (config.editVideoMode && editVideoPreview && !editVideoSourceFile) {
        const videoFile = editVideoFile ?? editVideoFileRef.current?.files?.[0];
        if (videoFile) {
          setStage("Uploading source video for editing...");
          const relPath = await uploadVideo(videoFile);
          editVideoSourceFile = await resolveComfyInputAbsPath(relPath);
        }
      }
      // Validation: edit mode requires both source video and a painted mask
      if (config.editVideoMode) {
        if (!editVideoSourceFile) {
          throw new Error("V2V Inpaint: source video is required.");
        }
        if (!config.editVideoMaskFile) {
          throw new Error("V2V Inpaint: paint a mask on the first frame before generating.");
        }
        if (!config.editVideoLoraName) {
          throw new Error("V2V Inpaint: select an inpaint LoRA.");
        }
      }

      // Retake / Extend: ensure the source video resolves to an absolute filesystem path
      // (VHS_LoadVideoPath validates with os.path.isfile()). Mirror the edit-video eager-upload fallback.
      let continuitySourceVideoFile = config.continuitySourceVideo;
      const continuityActive = config.continuityMode === "retake" || config.continuityMode === "extend";
      if (continuityActive && continuityPreview && !continuitySourceVideoFile) {
        const vf = continuityFile ?? continuityFileRef.current?.files?.[0];
        if (vf) {
          setStage("Uploading source video...");
          const relPath = await uploadVideo(vf);
          continuitySourceVideoFile = await resolveComfyInputAbsPath(relPath);
        }
      }
      if (continuityActive) {
        if (!continuitySourceVideoFile) {
          throw new Error(`${config.continuityMode === "retake" ? "Retake" : "Extend"}: load a source video first.`);
        }
        if (config.continuityMode === "retake" && (config.retakeEnd ?? 0) <= (config.retakeStart ?? 0)) {
          throw new Error("Retake: the regenerate window end must be after its start.");
        }
      }

      // Build guideFrames: start/end frame I2V guides + extra guide frames from the Guide Frames UI
      let guideFrames: { image: string; frameIdx: number; strength: number }[] | undefined;
      if (sourceImageFile && endFrameFile) {
        guideFrames = [
          { image: sourceImageFile, frameIdx: 0, strength: startFrameStrength },
          { image: endFrameFile, frameIdx: config.numFrames - 1, strength: endFrameStrength },
        ];
      }
      // Append extra guide frames (from Guide Frames UI), only those with uploaded images
      const validExtras = extraGuideFrames.filter((gf) => gf.comfyFile);
      if (validExtras.length > 0) {
        if (!guideFrames) guideFrames = [];
        for (const gf of validExtras) {
          guideFrames.push({ image: gf.comfyFile!, frameIdx: gf.frameIdx, strength: gf.strength });
        }
      }

      // Preview mode: generate at half resolution
      let workflowConfig = { ...config, sourceImage: sourceImageFile, a2vAudioFile, guideFrames, guideVideoFile, editVideoSourceFile, continuitySourceVideo: continuitySourceVideoFile, likenessImage: likenessImageFile };
      if (preview) {
        const prev = getPreviewResolution(config.width, config.height);
        workflowConfig = { ...workflowConfig, width: prev.width, height: prev.height };
      }
      const workflow = workflowConfig.autoregressiveEnabled
        ? buildLTX2AutoregressiveWorkflow(workflowConfig, seed)
        : workflowConfig.pipelineMode === "official"
        ? buildLTX2OfficialWorkflow(workflowConfig, seed)
        : buildLTX2Workflow(workflowConfig, seed);

      setStage("Queuing to ComfyUI...");

      // Connect SSE for progress updates
      const clientId = clientIdRef.current;
      esRef.current?.close();
      esRef.current = connectComfyStream(
        clientId,
        (msg: ComfyUIProgress) => {
          if (msg.type === "progress" && msg.data) {
            // Skip progress events from post-sampling nodes (VHS_VideoCombine ffmpeg
            // fires per-frame progress that inflates the step counter)
            if (currentNodeRef.current && POST_SAMPLING_NODES.has(currentNodeRef.current)) {
              // Don't update step counters: just show encoding status
              return;
            }
            const chunkVal = msg.data.value ?? 0;
            const chunkMax = msg.data.max ?? 0;
            // Detect new normalizer chunk: chunkMax changed or progress reset
            if (chunkMax !== prevChunkMaxRef.current && prevChunkMaxRef.current > 0) {
              cumulativeStepsRef.current += prevChunkMaxRef.current;
            }
            prevChunkMaxRef.current = chunkMax;
            // Total steps from quality tier config + turbo upscale refinement
            const tier = configRef.current.qualityTier || "distilled";
            // Advanced gates distilled step overrides + the distilled audio-refine pass (matches the builder).
            const adv = (configRef.current.officialAdvanced ?? false) || tier === "test";
            const distAudio = adv && (configRef.current.testAudioSteps ?? 0) > 0 ? (configRef.current.testAudioSteps ?? 0) : 0;
            let totalSteps = tier === "full"
              ? (configRef.current.fullSteps ?? 15)
              : tier === "test"
                ? (configRef.current.testVideoSteps ?? 3) + (configRef.current.testAudioSteps ?? 5)
                : (adv ? (configRef.current.distilledSteps ?? 8) : 8) + distAudio;
            if (configRef.current.turboUpscale && (configRef.current.turboUpscaleMethod ?? TURBO_UPSCALE_DEFAULTS.method) === "latent") {
              totalSteps += configRef.current.turboUpscaleRefineSteps ?? TURBO_UPSCALE_DEFAULTS.refineSteps;
            }
            const globalStep = cumulativeStepsRef.current + chunkVal;
            setProgress(globalStep);
            setProgressMax(totalSteps);
            setStage(`Sampling step ${globalStep}/${totalSteps}`);
            updateRenderProgress(globalStep, totalSteps, `Sampling step ${globalStep}/${totalSteps}`, Date.now());
            // Record timestamp for ETA calculation
            setStepTimestamps((prev) => {
              const next = [...prev, Date.now()];
              return next.length > 100 ? next.slice(-100) : next;
            });
          } else if (msg.type === "executing" && msg.data) {
            if (msg.data.node === null) {
              // Execution finished: fetch result
              currentNodeRef.current = null;
              fetchResult();
            } else {
              // Track current node for progress filtering
              currentNodeRef.current = msg.data.node as string;
              // Show which node is executing
              const nodeNames: Record<string, string> = {
                "88": "Loading text encoder...",
                "91": "Loading diffusion model...",
                "107": "Loading video VAE...",
                "87": "Loading audio VAE...",
                "6": "Encoding prompt...",
                "123": "Sampling...",
                "129": "Decoding video (tiled)...",
                "16": "Decoding audio...",
                "17": "Encoding MP4...",
                // Turbo Upscale nodes
                "800": "Loading latent upscaler...",
                "801": "Upscaling latent 2x...",
                "802": "Re-injecting source image...",
                "808": "Turbo refine sampling...",
                "809": "Separating refined latents...",
                // 10S Likeness nodes
                "850": "Loading character reference...",
                "851": "Encoding character identity...",
                "852": "Hooking identity anchor...",
              };
              const nodeName = nodeNames[msg.data.node as string];
              if (nodeName) { setStage(nodeName); updateHeaderStage(nodeName); }
            }
          } else if (msg.type === "execution_error" && msg.data) {
            setError(
              (msg.data as Record<string, unknown>).exception_message as string ||
              "ComfyUI execution error"
            );
            setIsRunning(false);
            endRender();
          }
        },
        () => {
          // SSE closed, if we're still running, the connection dropped unexpectedly
          // (e.g. Node.js OOM crash). Recover the UI after a brief delay.
          setTimeout(() => {
            if (!isRunningRef.current) return;
            setError("Connection to ComfyUI lost. The backend may still be processing. Check ComfyUI output folder.");
            setStage("");
            setProgress(0);
            setProgressMax(0);
            setIsRunning(false);
            endRender();
          }, 3000);
        },
        () => {
          // SSE error: same recovery logic
          if (!isRunningRef.current) return;
          setError("Connection error with ComfyUI. Check if the backend is still running.");
          setStage("");
          setProgress(0);
          setProgressMax(0);
          setIsRunning(false);
          endRender();
        },
        (dataUrl: string) => {
          setLivePreviewUrl(dataUrl);
        }
      );

      // Queue the prompt
      const result = await queuePrompt(workflow, clientId);
      promptIdRef.current = result.prompt_id;
      setStage("Waiting for ComfyUI...");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsRunning(false);
      endRender();
    }

    async function fetchResult() {
      const pid = promptIdRef.current;
      if (!pid) return;

      // Poll history until output appears
      for (let i = 0; i < 30; i++) {
        try {
          const history = await getHistory(pid);
          if (history?.outputs) {
            // Find VHS_VideoCombine output (node "17")
            const vhsOutput = history.outputs["17"];
            if (vhsOutput?.gifs?.[0]) {
              const gif = vhsOutput.gifs[0];
              const videoFilePath = gif.subfolder
                ? `${gif.subfolder}/${gif.filename}`
                : gif.filename;
              const url = getImageUrl(
                gif.filename,
                gif.subfolder || "",
                gif.type || "output"
              );
              setGeneratedOutputUrl(url);
              setOutputVideoFile(videoFilePath);
              setOutputUrl(url);

              setStage("Complete!");
              // Use wall-clock time for accurate total render time
              const wallClockSeconds = (Date.now() - renderStartRef.current) / 1000;
              setLastRenderTime(formatEtaTime(wallClockSeconds));
              setIsRunning(false);
              completeRender(formatEtaTime(wallClockSeconds));
              esRef.current?.close();
              return;
            }
          }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
      setStage("Complete (output may be in ComfyUI)");
      const wallClockSeconds = (Date.now() - renderStartRef.current) / 1000;
      setLastRenderTime(formatEtaTime(wallClockSeconds));
      setIsRunning(false);
      completeRender(formatEtaTime(wallClockSeconds));
      esRef.current?.close();
    }
  }, [config, startRender, updateRenderProgress, updateHeaderStage, endRender, completeRender]);

  const handleCancel = useCallback(async () => {
    esRef.current?.close();
    try {
      await interruptGeneration();
    } catch { /* ignore */ }
    setIsRunning(false);
    setStage("");
    setProgress(0);
    setProgressMax(0);
    endRender();
  }, [endRender]);

  // Register this page's workflow with the global "Open in ComfyUI" button.
  // The button stages this graph on ComfyUI and loads it directly (no paste).
  useRegisterComfyWorkflow(() => {
    const seed = config.seed >= 0 ? config.seed : Math.floor(Math.random() * 2 ** 32);
    const workflow = config.autoregressiveEnabled
      ? buildLTX2AutoregressiveWorkflow(config, seed)
      : config.pipelineMode === "official"
      ? buildLTX2OfficialWorkflow(config, seed)
      : buildLTX2Workflow(config, seed);
    return {
      workflow: workflow as Record<string, unknown>,
      name: `LTX-2 ${config.pipelineMode === "official" ? "Official" : "Alternative"}`,
    };
  });

  // Edit-video SOURCE selection: set the in-memory preview/handle for instant UX, then
  // EAGERLY upload the video to ComfyUI input/ and persist its absolute path into config
  // RIGHT AWAY (not lazily at generate time). This is the "cached temp file", it makes the
  // reference survive tab switches (component unmount) and save/load, since the canonical
  // identity now lives in persisted config rather than a transient in-memory File. No base64
  // is ever stored: only the on-disk path.
  const handleEditVideoSelected = useCallback((f: File) => {
    const url = URL.createObjectURL(f);
    setEditVideoPreview(url);
    setEditVideoFile(f); // keep the File as an immediate fallback for this session
    const vid = document.createElement("video");
    vid.src = url;
    vid.onloadedmetadata = () => setEditVideoDuration(vid.duration);
    // Eager upload + persist the canonical path.
    setEditVideoUploading(true);
    (async () => {
      try {
        const relPath = await uploadVideo(f);
        const absPath = await resolveComfyInputAbsPath(relPath);
        update("editVideoSourceFile", absPath);
      } catch (err) {
        console.error("[edit-video] Eager upload failed:", err);
        // Non-fatal: generate-time fallback will retry from the in-memory File.
      } finally {
        setEditVideoUploading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update]);

  // ── Retake / Extend helpers ──
  // LTX latent length must be 8n+1. Source frames are aligned DOWN (never exceed what the clip
  // actually has); the Extend tail is a multiple of 8 so source(8n+1) + tail(8m) = total(8(n+m)+1)
  // and the concatenated latent temporal dims line up exactly.
  const align8n1Down = (n: number) => Math.max(9, Math.floor((n - 1) / 8) * 8 + 1);
  const align8 = (n: number) => Math.max(8, Math.round(n / 8) * 8);

  // Recompute numFrames (and retake window) for the given continuity mode from the loaded source.
  const applyContinuityFrameMath = useCallback(
    (mode: "off" | "retake" | "extend", srcFramesRaw: number, fps: number, extendSec: number): Partial<LTX2Config> => {
      if (mode === "retake") {
        const n = align8n1Down(srcFramesRaw);
        return { numFrames: n, continuitySourceFrames: n, retakeStart: 0, retakeEnd: +(n / fps).toFixed(2) };
      }
      if (mode === "extend") {
        const src = align8n1Down(srcFramesRaw);
        const tail = align8(Math.round(extendSec * fps));
        return { numFrames: src + tail, continuitySourceFrames: src };
      }
      return {};
    },
    [],
  );

  // Edit-video-style eager upload + persist for the Retake/Extend source video.
  const handleContinuityVideoSelected = useCallback((f: File) => {
    const url = URL.createObjectURL(f);
    setContinuityPreview(url);
    setContinuityFile(f);
    const vid = document.createElement("video");
    vid.src = url;
    vid.onloadedmetadata = () => {
      setContinuityDuration(vid.duration);
      setConfig((prev) => {
        const srcFramesRaw = Math.max(9, Math.round(vid.duration * prev.frameRate));
        const mode = prev.continuityMode ?? "off";
        const patch = applyContinuityFrameMath(
          mode === "off" ? "extend" : mode, // default a freshly-loaded clip to a usable mode's math
          srcFramesRaw,
          prev.frameRate,
          prev.extendSeconds ?? 3,
        );
        return { ...prev, ...patch };
      });
    };
    setContinuityUploading(true);
    (async () => {
      try {
        const relPath = await uploadVideo(f);
        const absPath = await resolveComfyInputAbsPath(relPath);
        update("continuitySourceVideo", absPath);
      } catch (err) {
        console.error("[continuity] Eager upload failed:", err);
      } finally {
        setContinuityUploading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update, setConfig, applyContinuityFrameMath]);

  // Clear all Retake/Extend state + config back to off.
  const clearContinuity = useCallback(() => {
    setContinuityPreview(null);
    setContinuityDuration(null);
    setContinuityFile(null);
    setConfig((prev) => ({
      ...prev,
      continuityMode: "off",
      continuitySourceVideo: "",
      continuitySourceFrames: 0,
    }));
  }, [setConfig]);

  const SAUCE_STORAGE_KEY = "ltx2_custom_sauce";

  const handleApplyMagicSauce = useCallback(() => {
    // Apply the LTX 2.3 model defaults for the magic sauce model
    // Use getLTX2CheckpointConfig (not getLTX2ModelDefaults) to ensure GGUF flags are reset
    const ckptConfig = getLTX2CheckpointConfig(LTX2_MAGIC_SAUCE.diffusionModel!);
    setConfig((prev) => ({ ...prev, ...ckptConfig, ...LTX2_MAGIC_SAUCE }));
  }, [setConfig]);

  const handleSaveSauce = useCallback(() => {
    // Save current test-relevant settings to localStorage
    const sauce: Partial<LTX2Config> = {
      stylePreset: config.stylePreset,
      testVideoSteps: config.testVideoSteps,
      testAudioSteps: config.testAudioSteps,
      testSampler: config.testSampler,
      negativePrompt: config.negativePrompt,
      diffusionModel: config.diffusionModel,
      distillLoRAStrength: config.distillLoRAStrength,
      directSampling: config.directSampling,
      imgCompression: config.imgCompression,
      qualityTier: config.qualityTier,
      pipelineMode: config.pipelineMode,
      videoNormFactors: config.videoNormFactors,
      audioNormFactors: config.audioNormFactors,
      videoCfg: config.videoCfg,
      audioCfg: config.audioCfg,
      videoCfgRescale: config.videoCfgRescale,
      audioCfgRescale: config.audioCfgRescale,
      stg: config.stg,
      fullSteps: config.fullSteps,
      fullEta: config.fullEta,
      fullSampler: config.fullSampler,
      schedulerShift: config.schedulerShift,
      schedulerBaseShift: config.schedulerBaseShift,
      schedulerTerminal: config.schedulerTerminal,
      distilledSteps: config.distilledSteps,
      previewRate: config.previewRate,
      i2vStrength: config.i2vStrength,
      perfectLoop: config.perfectLoop,
      perfectLoopEndStrength: config.perfectLoopEndStrength,
    };
    localStorage.setItem(SAUCE_STORAGE_KEY, JSON.stringify(sauce));
  }, [config]);

  const handleLoadSauce = useCallback(() => {
    const raw = localStorage.getItem(SAUCE_STORAGE_KEY);
    if (!raw) return;
    try {
      const sauce = JSON.parse(raw) as Partial<LTX2Config>;
      // Use getLTX2CheckpointConfig (not getLTX2ModelDefaults) to ensure GGUF flags are reset
      const ckptConfig = sauce.diffusionModel
        ? getLTX2CheckpointConfig(sauce.diffusionModel)
        : {};
      setConfig((prev) => ({ ...prev, ...ckptConfig, ...sauce }));
    } catch { /* ignore bad data */ }
  }, [setConfig]);

  const hasSavedSauce = typeof window !== "undefined" && !!localStorage.getItem(SAUCE_STORAGE_KEY);

  const handleReferenceSheet = useCallback(
    (file: File) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        update("referenceSheetImage", dataUrl);
        setReferenceSheetPreview(dataUrl);
      };
      reader.readAsDataURL(file);
    },
    [update]
  );

  const handleSourceImage = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        update("sourceImage", dataUrl);
        setSourcePreview(dataUrl);
      };
      reader.readAsDataURL(file);
    },
    [update]
  );

  const handleEndFrameUpload = useCallback(
    async (file: File) => {
      const previewUrl = URL.createObjectURL(file);
      setEndFramePreview(previewUrl);
      try {
        const comfyFilename = await uploadImage(file);
        setEndFrameFile(comfyFilename);
      } catch (err) {
        setEndFramePreview(null);
        setEndFrameFile(null);
        setError(`End frame upload failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    []
  );

  const clearEndFrame = useCallback(() => {
    if (endFramePreview) URL.revokeObjectURL(endFramePreview);
    setEndFramePreview(null);
    setEndFrameFile(null);
  }, [endFramePreview]);

  // ── Guide Frame helpers ──
  const addGuideFrame = useCallback(() => {
    setExtraGuideFrames((prev) => [
      ...prev,
      {
        id: `gf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        previewUrl: null,
        comfyFile: null,
        frameIdx: 0,
        strength: 1.0,
      },
    ]);
  }, []);

  const removeGuideFrame = useCallback((id: string) => {
    setExtraGuideFrames((prev) => {
      const entry = prev.find((g) => g.id === id);
      if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      return prev.filter((g) => g.id !== id);
    });
  }, []);

  const updateGuideFrame = useCallback(
    (id: string, patch: Partial<GuideFrameEntry>) => {
      setExtraGuideFrames((prev) =>
        prev.map((g) => (g.id === id ? { ...g, ...patch } : g))
      );
    },
    []
  );

  const handleGuideFrameImage = useCallback(
    async (id: string, file: File) => {
      const previewUrl = URL.createObjectURL(file);
      updateGuideFrame(id, { previewUrl });
      try {
        const comfyFile = await uploadImage(file);
        updateGuideFrame(id, { comfyFile });
      } catch (err) {
        updateGuideFrame(id, { previewUrl: null, comfyFile: null });
        setError(`Guide frame upload failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [updateGuideFrame]
  );

  const progressPct =
    progressMax > 0 ? Math.round((progress / progressMax) * 100) : 0;

  const activeRes = LTX2_RESOLUTION_PRESETS.find(
    (p) => p.width === config.width && p.height === config.height
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-blue-500/30 bg-blue-500/5">
        <div className="flex items-center gap-2">
          <Film className="w-5 h-5 text-blue-400" />
          <h2 className="text-sm font-semibold text-blue-400">LTX-2 Studio</h2>
          {/* Model version toggle */}
          <div className="flex items-center bg-muted/30 rounded-md p-0.5">
            {(["2.0", "2.3"] as LTX2ModelVersion[]).map((v) => (
              <button
                key={v}
                onClick={() => {
                  if (v === (config.modelVersion || "2.0")) return;
                  const defaults = getLTX2ModelDefaults(v);
                  const ckptConfig = defaults.diffusionModel
                    ? getLTX2CheckpointConfig(defaults.diffusionModel)
                    : { ...defaults, useGGUF: false, ggufDiffusionModel: "", ggufTextEncoder: "", spatioTemporalVAE: false };
                  setConfig((prev) => ({ ...prev, ...ckptConfig }));
                }}
                disabled={isRunning}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  (config.modelVersion || "2.0") === v
                    ? "bg-blue-500/20 text-blue-400 shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                v{v}
              </button>
            ))}
          </div>
          {/* Pipeline mode toggle */}
          <div className="flex items-center bg-muted/30 rounded-md p-0.5">
            {(["alternative", "official"] as LTX2PipelineMode[]).map((m) => (
              <button
                key={m}
                onClick={() => {
                  if (m === (config.pipelineMode === "official" ? "official" : "alternative")) return;
                  const newLoraStr = m === "official"
                    ? LTX2_OFFICIAL_LORA_STRENGTH.distilled
                    : 1.0;
                  setConfig((prev) => ({
                    ...prev,
                    pipelineMode: m,
                    distillLoRAStrength: newLoraStr,
                    negativePrompt: m === "official" ? LTX2_OFFICIAL_NEGATIVE : prev.negativePrompt,
                  }));
                }}
                disabled={isRunning}
                className={`relative flex flex-col items-center justify-center px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  (config.pipelineMode === "official" ? "official" : "alternative") === m
                    ? m === "official"
                      ? "bg-emerald-500/20 text-emerald-400 shadow-sm"
                      : "bg-blue-500/20 text-blue-400 shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                } ${
                  // "Advanced" = Official engine off the stock Lightricks recipe.
                  // Breathing red-orange glow (heartbeat), adapted from the Generate button.
                  m === "official" && (config.officialAdvanced ?? false) ? "vek-advanced-glow" : ""
                }`}
                title={m === "official" && (config.officialAdvanced ?? false)
                  ? "Advanced: off the stock Lightricks recipe (custom steps, sampler, audio refine)"
                  : undefined}
              >
                <span>{m === "official" ? "Official" : "Alternative"}</span>
                {m === "official" && (config.officialAdvanced ?? false) && (
                  <span className="-mt-0.5 text-[8px] font-semibold uppercase tracking-wide text-orange-400 leading-none">
                    Advanced
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowReferencePrep(true)}
            className="text-[9px] text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 px-1.5 py-0.5 rounded flex items-center gap-1 transition-colors"
            title="Reference Prep: extract subject, replace background with mid-gray, crop to target resolution"
          >
            <Crop className="w-3 h-3" /> Reference Prep
          </button>
          {comfyConnected === true && (
            <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> ComfyUI Connected
            </span>
          )}
          {comfyConnected === false && (
            <span className="text-[9px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> ComfyUI Offline
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* CENTER STAGE */}
        <div className="flex-1 overflow-y-auto min-w-0">
          <div className="p-4 space-y-4 max-w-3xl mx-auto">
          {/* A2V (Audio-to-Video) Mode */}
          {config.pipelineMode === "official" && (
            <div className={`${ltxCard("orange")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-orange-400 font-medium flex items-center gap-1.5">
                  <AudioLines className="w-3.5 h-3.5" /> Audio-to-Video (A2V)
                </span>
                <Switch
                  checked={!!config.a2vMode}
                  onCheckedChange={(v) => {
                    setConfig((prev) => ({
                      ...prev,
                      a2vMode: v,
                      enableAudio: v ? true : prev.enableAudio,
                    }));
                  }}
                  className="scale-75"
                  disabled={isRunning}
                />
              </div>
              {config.a2vMode && (
                <div className="space-y-2">
                  <p className="text-[9px] text-orange-400/60">
                    Upload an audio clip. The model will generate video conditioned on the audio content.
                    Audio is frozen in the latent space; only video is generated.
                  </p>
                  {a2vAudioPreview ? (
                    <div className="space-y-1.5">
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <audio src={a2vAudioPreview} controls className="w-full h-8" />

                      {/* Trim toggle */}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setA2vTrimEnabled(!a2vTrimEnabled)}
                          className={`flex items-center gap-1 text-[9px] px-2 py-0.5 rounded border transition-colors ${
                            a2vTrimEnabled
                              ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                              : "border-border/60 bg-muted/10 text-muted-foreground hover:text-foreground"
                          }`}
                          disabled={isRunning}
                        >
                          <Scissors className="w-3 h-3" />
                          {a2vTrimEnabled ? "Trim Active" : "Trim Audio"}
                        </button>
                        {a2vTrimEnabled && a2vTrimEnd > 0 && (
                          <span className="text-[8px] text-amber-400/60">
                            Using {(a2vTrimEnd - a2vTrimStart).toFixed(1)}s of {a2vAudioDuration?.toFixed(1) || "?"}s
                          </span>
                        )}
                      </div>

                      {a2vTrimEnabled && (
                        <AudioTrimmer
                          audioUrl={a2vAudioPreview}
                          maxDuration={a2vAudioDuration || 9999}
                          trimStart={a2vTrimStart}
                          trimEnd={a2vTrimEnd}
                          onTrimChange={(s, e) => { setA2vTrimStart(s); setA2vTrimEnd(e); }}
                          hideConfirm
                          contextLabel="Full"
                          disabled={isRunning}
                        />
                      )}

                      {/* Audio length intelligence: warn about mismatch */}
                      {a2vAudioDuration != null && (() => {
                        const videoDur = config.numFrames / config.frameRate;
                        const effectiveDur = a2vTrimEnabled && a2vTrimEnd > 0
                          ? (a2vTrimEnd - a2vTrimStart)
                          : a2vAudioDuration;
                        const diff = effectiveDur - videoDur;
                        const absDiff = Math.abs(diff);
                        const label = a2vTrimEnabled ? "Trimmed audio" : "Audio";
                        if (absDiff < 0.05) return (
                          <p className="text-[9px] text-emerald-400/70">{label} duration matches video ({videoDur.toFixed(1)}s)</p>
                        );
                        if (diff > 0) return (
                          <p className="text-[9px] text-amber-400/80">
                            {label} is {absDiff.toFixed(1)}s longer than video ({effectiveDur.toFixed(1)}s vs {videoDur.toFixed(1)}s). It will be auto-clipped on generate.
                          </p>
                        );
                        return (
                          <p className="text-[9px] text-sky-400/80">
                            {label} is {absDiff.toFixed(1)}s shorter than video ({effectiveDur.toFixed(1)}s vs {videoDur.toFixed(1)}s). Silence will be padded on generate.
                          </p>
                        );
                      })()}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] px-2 text-destructive"
                        onClick={() => {
                          setA2vAudioPreview(null);
                          setA2vAudioDuration(null);
                          setA2vTrimEnabled(false);
                          setA2vTrimStart(0);
                          setA2vTrimEnd(0);
                          update("a2vAudioFile", undefined);
                        }}
                        disabled={isRunning}
                      >
                        <X className="w-3 h-3 mr-1" /> Remove Audio
                      </Button>
                    </div>
                  ) : (
                    <label
                      className="flex items-center justify-center gap-2 w-full py-3 rounded-md border border-dashed border-orange-500/30 text-xs text-orange-400/70 hover:bg-orange-500/5 hover:border-orange-500/50 cursor-pointer transition-colors"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const f = e.dataTransfer.files?.[0];
                        if (f && (f.type.startsWith("audio/") || f.name.match(/\.(wav|mp3|flac|ogg)$/i))) {
                          const reader = new FileReader();
                          reader.onload = () => {
                            const dataUrl = reader.result as string;
                            setA2vAudioPreview(dataUrl);
                            const audio = new Audio(dataUrl);
                            audio.onloadedmetadata = () => setA2vAudioDuration(audio.duration);
                          };
                          reader.readAsDataURL(f);
                        }
                      }}
                    >
                      <Upload className="w-3.5 h-3.5" /> Drop audio or click to browse (WAV/MP3)
                      <input
                        ref={a2vFileRef}
                        type="file"
                        accept="audio/*,.wav,.mp3,.flac,.ogg"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) {
                            const reader = new FileReader();
                            reader.onload = () => {
                              const dataUrl = reader.result as string;
                              setA2vAudioPreview(dataUrl);
                              const audio = new Audio(dataUrl);
                              audio.onloadedmetadata = () => setA2vAudioDuration(audio.duration);
                            };
                            reader.readAsDataURL(f);
                          }
                          e.target.value = "";
                        }}
                        disabled={isRunning}
                      />
                    </label>
                  )}

                  {/* Audio Purpose Toggle */}
                  <div className="mt-2 pt-2 border-t border-orange-500/10 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-orange-400/70 font-medium">Audio Purpose</span>
                      <div className="flex items-center gap-1 rounded-md border border-orange-500/20 bg-black/30 p-0.5">
                        <button
                          type="button"
                          onClick={() => update("a2vPurpose", "lip_sync")}
                          disabled={isRunning}
                          className={`px-2 py-0.5 rounded text-[8px] transition-colors ${
                            (config.a2vPurpose ?? "lip_sync") === "lip_sync"
                              ? "bg-orange-500/30 text-orange-300 font-medium"
                              : "text-muted-foreground hover:text-orange-400/70"
                          }`}
                        >
                          🎤 Lip-Sync
                        </button>
                        <button
                          type="button"
                          onClick={() => update("a2vPurpose", "music_video")}
                          disabled={isRunning}
                          className={`px-2 py-0.5 rounded text-[8px] transition-colors ${
                            (config.a2vPurpose ?? "lip_sync") === "music_video"
                              ? "bg-teal-500/30 text-teal-300 font-medium"
                              : "text-muted-foreground hover:text-teal-400/70"
                          }`}
                        >
                          🎵 Music Video
                        </button>
                      </div>
                    </div>
                    <p className="text-[8px] text-orange-400/50 leading-relaxed">
                      {(config.a2vPurpose ?? "lip_sync") === "lip_sync" ? (
                        <>
                          <strong>Lip-Sync:</strong> Speech audio drives mouth movement. I2V reference is suspended to prevent conflicts.
                          NAG auto-suppresses subtitles from dialogue prompts. Describe only visual appearance. Do NOT include dialogue text.
                        </>
                      ) : (
                        <>
                          <strong>Music Video:</strong> Audio drives energy and mood. I2V guide frames remain active to anchor visuals.
                          No subtitle suppression overhead: normal render speed.
                        </>
                      )}
                    </p>

                    {/* NAG fine-tuning (visible in lip-sync mode or when manually enabled) */}
                    {((config.a2vPurpose ?? "lip_sync") === "lip_sync" || config.nagEnabled) && (
                      <div className="space-y-1.5 pl-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[8px] text-muted-foreground w-10">NAG</span>
                          <Slider
                            min={0} max={30} step={0.5}
                            value={[config.nagScale ?? 11]}
                            onValueChange={([v]) => update("nagScale", v)}
                            className="flex-1"
                            disabled={isRunning}
                          />
                          <span className="text-[8px] text-muted-foreground w-6 text-right">{config.nagScale ?? 11}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[8px] text-muted-foreground w-10">CFG</span>
                          <Slider
                            min={1} max={7} step={0.25}
                            value={[config.a2vCfg ?? 3]}
                            onValueChange={([v]) => update("a2vCfg", v)}
                            className="flex-1"
                            disabled={isRunning}
                          />
                          <span className="text-[8px] text-muted-foreground w-6 text-right">{config.a2vCfg ?? 3}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Autoregressive Long-Form: Top-Tier single-shot character consistency (LTXVLoopingSampler) */}
          {config.modelVersion === "2.3" && (
            <div className={`${ltxCard("cyan")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-cyan-400 font-medium flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> Autoregressive Long-Form (Top-Tier)
                  <span className="text-[8px] text-amber-400/70 font-normal italic">(Experimental Feature: Use with Caution)</span>
                </span>
                <Switch
                  checked={!!config.autoregressiveEnabled}
                  onCheckedChange={(v) => {
                    setConfig((prev) => ({
                      ...prev,
                      autoregressiveEnabled: v,
                      // Pre-configure the validated operating point + disable conflicting modes on enable
                      ...(v ? {
                        arTemporalTileSize: prev.arTemporalTileSize ?? 40,
                        arTemporalOverlap: prev.arTemporalOverlap ?? 24,
                        arAdainFactor: prev.arAdainFactor ?? 0.15,
                        ingredientsMode: false,
                        icLoraMode: false,
                        a2vMode: false,
                        continuityMode: "off" as const,
                        turboUpscale: false,
                      } : {}),
                    }));
                  }}
                  className="scale-75"
                  disabled={isRunning}
                />
              </div>
              <p className="text-[9px] text-cyan-400/60">
                One continuous <strong>autoregressive</strong> render (LTXVLoopingSampler) with latent-overlap
                temporal tiling: identity &amp; scene carry across the whole clip instead of lossy last-frame
                chaining. Draft with the distilled GGUF model (fast, compute-bound); switch to a full model
                (e.g. 10Eros) for final quality (slower, memory-bound). VIDEO-ONLY in v1.
              </p>
              {config.autoregressiveEnabled && (
                <div className="space-y-2.5">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-cyan-400/60">Temporal Tile Size</Label>
                      <span className="text-[9px] text-cyan-400 font-mono">{config.arTemporalTileSize ?? 40}</span>
                    </div>
                    <Slider
                      min={24}
                      max={96}
                      step={8}
                      value={[config.arTemporalTileSize ?? 40]}
                      onValueChange={([v]) => update("arTemporalTileSize", v)}
                      disabled={isRunning}
                    />
                    <p className="text-[8px] text-cyan-400/40">Frames per tile. 40 = compute-bound on 16GB; larger = fewer seams but more VRAM.</p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-cyan-400/60">Continuity Strength</Label>
                      <span className="text-[9px] text-cyan-400 font-mono">{(config.arTemporalOverlapCondStrength ?? 0.5).toFixed(2)}</span>
                    </div>
                    <Slider
                      min={0}
                      max={1}
                      step={0.05}
                      value={[config.arTemporalOverlapCondStrength ?? 0.5]}
                      onValueChange={([v]) => update("arTemporalOverlapCondStrength", v)}
                      disabled={isRunning}
                    />
                    <p className="text-[8px] text-cyan-400/40">How strongly each tile conditions on the previous tile&apos;s latents.</p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-cyan-400/60">AdaIN (drift / oversaturation)</Label>
                      <span className="text-[9px] text-cyan-400 font-mono">{(config.arAdainFactor ?? 0.15).toFixed(2)}</span>
                    </div>
                    <Slider
                      min={0}
                      max={0.5}
                      step={0.05}
                      value={[config.arAdainFactor ?? 0.15]}
                      onValueChange={([v]) => update("arAdainFactor", v)}
                      disabled={isRunning}
                    />
                    <p className="text-[8px] text-cyan-400/40">Curbs accumulated color drift on long runs. 0.1–0.3 recommended.</p>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[9px] text-cyan-400/60">Long-Memory Anchor (negative-index)</span>
                    <Switch
                      checked={!!config.arNegativeIndexEnabled}
                      onCheckedChange={(v) => update("arNegativeIndexEnabled", v)}
                      className="scale-75"
                      disabled={isRunning}
                    />
                  </div>
                  <p className="text-[8px] text-cyan-400/40">Off by default: the default graph matches the validated run exactly. When on, encodes the source image as a global identity memory fed to every tile (not just the previous one). Opt-in A/B: compare on vs off.</p>

                  {/* Temporal Overlap: frames shared between consecutive tiles. */}
                  <div className="space-y-1 pt-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-cyan-400/60">Temporal Overlap</Label>
                      <span className="text-[9px] text-cyan-400 font-mono">{config.arTemporalOverlap ?? 24}</span>
                    </div>
                    <Slider min={8} max={80} step={8} value={[config.arTemporalOverlap ?? 24]} onValueChange={([v]) => update("arTemporalOverlap", v)} disabled={isRunning} />
                    <p className="text-[8px] text-cyan-400/40">Frames shared between consecutive tiles (~1/3 of tile size). More = smoother seams, slower.</p>
                  </div>

                  {/* Conditioning-image strength for the first/keyframe images. */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-cyan-400/60">Cond Image Strength</Label>
                      <span className="text-[9px] text-cyan-400 font-mono">{(config.arCondImageStrength ?? 1.0).toFixed(2)}</span>
                    </div>
                    <Slider min={0} max={1} step={0.05} value={[config.arCondImageStrength ?? 1.0]} onValueChange={([v]) => update("arCondImageStrength", v)} disabled={isRunning} />
                    <p className="text-[8px] text-cyan-400/40">How strongly the source / keyframe image anchors frame 0.</p>
                  </div>

                  {/* Guiding strength (IC-LoRA guiding latents). */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-cyan-400/60">Guiding Strength</Label>
                      <span className="text-[9px] text-cyan-400 font-mono">{(config.arGuidingStrength ?? 1.0).toFixed(2)}</span>
                    </div>
                    <Slider min={0} max={1} step={0.05} value={[config.arGuidingStrength ?? 1.0]} onValueChange={([v]) => update("arGuidingStrength", v)} disabled={isRunning} />
                    <p className="text-[8px] text-cyan-400/40">Weight of IC-LoRA guiding latents when provided.</p>
                  </div>

                  {/* Spatial tiling: render above base resolution on constrained VRAM. */}
                  <details className="rounded border border-cyan-500/10 bg-cyan-500/5 px-2 py-1">
                    <summary className="text-[9px] text-cyan-400/70 cursor-pointer select-none">Spatial tiling (advanced, VRAM)</summary>
                    <div className="grid grid-cols-3 gap-2 pt-1.5">
                      <div className="space-y-0.5">
                        <Label className="text-[8px] text-cyan-400/50">H tiles: {config.arHorizontalTiles ?? 1}</Label>
                        <Slider min={1} max={6} step={1} value={[config.arHorizontalTiles ?? 1]} onValueChange={([v]) => update("arHorizontalTiles", v)} disabled={isRunning} />
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[8px] text-cyan-400/50">V tiles: {config.arVerticalTiles ?? 1}</Label>
                        <Slider min={1} max={6} step={1} value={[config.arVerticalTiles ?? 1]} onValueChange={([v]) => update("arVerticalTiles", v)} disabled={isRunning} />
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[8px] text-cyan-400/50">Overlap: {config.arSpatialOverlap ?? 1}</Label>
                        <Slider min={1} max={8} step={1} value={[config.arSpatialOverlap ?? 1]} onValueChange={([v]) => update("arSpatialOverlap", v)} disabled={isRunning} />
                      </div>
                    </div>
                    <p className="text-[8px] text-cyan-400/40 pt-1">Split each frame into tiles so only one is in VRAM at a time. 1×1 = off.</p>
                  </details>

                  {/* Advanced guidance override: deviates from the validated cfg=1 spike. */}
                  <div className="space-y-1 rounded border border-amber-500/20 bg-amber-500/5 p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-amber-300/80 font-medium">Advanced guidance override</span>
                      <Switch checked={!!config.arGuidanceOverride} onCheckedChange={(v) => update("arGuidanceOverride", v)} className="scale-75" disabled={isRunning} />
                    </div>
                    <p className="text-[8px] text-amber-400/50">
                      Off = validated distilled regime (CFG 1, STG 0), exact parity with the proven run.
                      On = drive the loop&apos;s guider from the CFG / STG sliders below. Deviates from the validated spike: expect longer renders and possible artifacts at high CFG.
                    </p>
                    {config.arGuidanceOverride && (
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <div className="space-y-0.5">
                          <Label className="text-[9px] text-amber-300/70">CFG: {(config.videoCfg ?? 3).toFixed(1)}</Label>
                          <Slider min={1} max={15} step={0.5} value={[config.videoCfg ?? 3]} onValueChange={([v]) => update("videoCfg", v)} disabled={isRunning} />
                        </div>
                        <div className="space-y-0.5">
                          <Label className="text-[9px] text-amber-300/70">STG: {(config.stg ?? 0).toFixed(2)}</Label>
                          <Slider min={0} max={1} step={0.05} value={[config.stg ?? 0]} onValueChange={([v]) => update("stg", v)} disabled={isRunning} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 10S Character Consistency: only shown when source image is set */}
          {config.sourceImage && (
            <div className={`${ltxCard("cyan")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-cyan-400 font-medium flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5" /> Character Consistency (10S Method)
                </span>
                <Switch
                  checked={!!config.likenessEnabled}
                  onCheckedChange={(v) => update("likenessEnabled", v)}
                  disabled={isRunning}
                />
              </div>
              <p className="text-[8px] text-muted-foreground/60">
                Hooks into the LTX2 DiT attention to stabilize character identity across the video.
                Upload a clear reference below, or leave empty to use the I2V source image.
              </p>

              {config.likenessEnabled && (
                <div className="space-y-2 pt-1">
                  {/* Character reference image upload */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-cyan-400/60">Character Reference Image</Label>
                      {config.likenessImage && (
                        <button
                          type="button"
                          className="text-[8px] text-destructive/70 hover:text-destructive"
                          onClick={() => { update("likenessImage", ""); setLikenessPreview(null); }}
                        >
                          ✕ Remove
                        </button>
                      )}
                    </div>
                    {likenessPreview ? (
                      <div className="flex justify-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={likenessPreview} alt="Character ref" className="max-h-24 rounded border border-cyan-500/30" />
                      </div>
                    ) : (
                      <div
                        className="flex items-center justify-center gap-1 rounded border border-dashed border-cyan-500/30 bg-cyan-500/5 py-3 text-[9px] text-cyan-400/50 cursor-pointer hover:border-cyan-400/50 hover:text-cyan-400/70 transition-colors"
                        onClick={() => document.getElementById("likeness-upload")?.click()}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          const f = e.dataTransfer.files?.[0];
                          if (f && f.type.startsWith("image/")) {
                            const reader = new FileReader();
                            reader.onload = () => { const d = reader.result as string; update("likenessImage", d); setLikenessPreview(d); };
                            reader.readAsDataURL(f);
                          }
                        }}
                      >
                        <Upload className="w-3 h-3" /> Drop reference image or click (optional)
                        <input
                          id="likeness-upload"
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) {
                              const reader = new FileReader();
                              reader.onload = () => { const d = reader.result as string; update("likenessImage", d); setLikenessPreview(d); };
                              reader.readAsDataURL(f);
                            }
                            e.target.value = "";
                          }}
                        />
                      </div>
                    )}
                    <p className="text-[7px] text-muted-foreground/40">
                      Optional: a clear character reference works best. Leave empty to use the I2V source image.
                    </p>
                  </div>

                  {/* Full Body Mode toggle */}
                  <div className="space-y-1 rounded border border-cyan-500/10 bg-cyan-500/5 p-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-cyan-400/60">Full Body Mode</Label>
                      <Switch
                        checked={(config.likenessFaceDetect ?? "auto") === "none"}
                        onCheckedChange={(v) => {
                          if (v) {
                            update("likenessFaceDetect", "none");
                            update("likenessRefMaskMode", "whole_frame");
                          } else {
                            update("likenessFaceDetect", "auto");
                            update("likenessRefMaskMode", "bbox_softfade");
                          }
                        }}
                        disabled={isRunning}
                      />
                    </div>
                    <p className="text-[7px] text-muted-foreground/40">
                      ON = entire reference used as identity target (body, clothing, posture). OFF = auto-detects face region only.
                    </p>

                    {/* Exposed underlying settings */}
                    <div className="space-y-1 pt-1">
                      <Label className="text-[8px] text-muted-foreground/50">
                        Detection: <span className="text-cyan-400/70">{config.likenessFaceDetect ?? "auto"}</span>
                      </Label>
                      <select
                        className="w-full rounded border border-cyan-500/20 bg-background px-2 py-0.5 text-[9px]"
                        value={config.likenessFaceDetect ?? "auto"}
                        onChange={(e) => update("likenessFaceDetect", e.target.value as "auto" | "none")}
                        disabled={isRunning}
                      >
                        <option value="auto">auto: detect face bbox (MediaPipe/OpenCV)</option>
                        <option value="none">none: whole frame as identity target</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[8px] text-muted-foreground/50">
                        Ref Mask: <span className="text-cyan-400/70">{config.likenessRefMaskMode ?? "bbox_softfade"}</span>
                      </Label>
                      <select
                        className="w-full rounded border border-cyan-500/20 bg-background px-2 py-0.5 text-[9px]"
                        value={config.likenessRefMaskMode ?? "bbox_softfade"}
                        onChange={(e) => update("likenessRefMaskMode", e.target.value as "bbox_softfade" | "bbox_only" | "whole_frame")}
                        disabled={isRunning}
                      >
                        <option value="bbox_softfade">bbox_softfade: Gaussian fade outside detected face</option>
                        <option value="bbox_only">bbox_only: hard mask outside face bbox</option>
                        <option value="whole_frame">whole_frame: no masking (full reference)</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-[9px] text-cyan-400/60">
                      Anchor Strength: {(config.likenessAnchorStrength ?? 0.25).toFixed(2)}
                    </Label>
                    <Slider
                      min={0} max={0.60} step={0.01}
                      value={[config.likenessAnchorStrength ?? 0.25]}
                      onValueChange={([v]) => update("likenessAnchorStrength", v)}
                      disabled={isRunning}
                    />
                    <p className="text-[8px] text-muted-foreground/50">
                      Pull toward reference identity. Author uses 0.50. README suggests 0.08–0.18 for subtle effect. Default 0.25 is a balanced start.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-[9px] text-cyan-400/60">
                      Late Block Falloff: {(config.likenessLateBlockFalloff ?? 0.4).toFixed(1)}
                    </Label>
                    <Slider
                      min={0} max={1.0} step={0.1}
                      value={[config.likenessLateBlockFalloff ?? 0.4]}
                      onValueChange={([v]) => update("likenessLateBlockFalloff", v)}
                      disabled={isRunning}
                    />
                    <p className="text-[8px] text-muted-foreground/50">
                      Reduce anchor effect in final 12 transformer blocks (detail layers). 0.3–0.6 reduces over-sharpening.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label className="text-[9px] text-cyan-400/60">
                      Similarity Threshold: {(config.likenessSimThreshold ?? 0.50).toFixed(2)}
                    </Label>
                    <Slider
                      min={0} max={1.0} step={0.05}
                      value={[config.likenessSimThreshold ?? 0.50]}
                      onValueChange={([v]) => update("likenessSimThreshold", v)}
                      disabled={isRunning}
                    />
                    <p className="text-[8px] text-muted-foreground/50">
                      Min cosine similarity for a token to receive pull. Lower = broader effect (more tokens stabilized).
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Character Consistency: Reference Sheet (Official IC-LoRA "Ingredients") */}
          {config.pipelineMode === "official" && config.modelVersion === "2.3" && (
            <div className={`${ltxCard("violet")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-violet-400 font-medium flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> Character Consistency: Reference Sheet
                </span>
                <Switch
                  checked={!!config.ingredientsMode}
                  onCheckedChange={(v) => {
                    setConfig((prev) => ({
                      ...prev,
                      ingredientsMode: v,
                      // Reference-sheet IC-LoRA owns the IC-LoRA guide path, disable conflicting modes
                      icLoraMode: v ? false : prev.icLoraMode,
                      a2vMode: v ? false : prev.a2vMode,
                    }));
                    if (!v) setReferenceSheetPreview(null);
                  }}
                  className="scale-75"
                  disabled={isRunning}
                />
              </div>
              {config.ingredientsMode && (
                <div className="space-y-2.5">
                  {/* Frame-bucket advisory: reference loops to full clip length at downscale ×1, so
                      going past the 121-frame trained bucket roughly doubles VRAM. Turns red past cap. */}
                  <p
                    className={`text-[8px] leading-snug rounded px-1.5 py-1 border ${
                      (config.numFrames ?? 0) > 121
                        ? "text-red-400 border-red-500/40 bg-red-500/10"
                        : "text-amber-400/70 border-amber-500/20 bg-amber-500/5"
                    }`}
                  >
                    {(config.numFrames ?? 0) > 121
                      ? `⚠ ${config.numFrames} frames exceeds the 121-frame cap. This LoRA loops the reference to the full clip length at full resolution (downscale ×1), so it roughly doubles VRAM and falls outside the 768×448·121f training bucket: expect OOM on 16GB. Recommend ≤121 frames (~5s @ 24fps).`
                      : `Recommended cap: ≤121 frames, the LoRA's trained bucket (768×448 · 121f · 24fps). Longer clips double VRAM (reference loops at downscale ×1) and drift from training.`}
                  </p>
                  <p className="text-[9px] text-violet-400/60">
                    Official Lightricks IC-LoRA. Upload one composite <strong>reference sheet</strong> (each
                    character as a face close-up + turnaround, each prop, and the location: clean panels on a
                    black background, no text). Its identities carry into the video. Best at the trained bucket:
                    <strong> 768×448, 121 frames, 24fps</strong>. Structure your prompt as
                    <em> &ldquo;Reference sheet: … / Generated video: …&rdquo;</em>.
                  </p>

                  {/* Reference sheet upload / preview */}
                  {referenceSheetPreview ? (
                    <div className="space-y-1.5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={referenceSheetPreview}
                        alt="Reference sheet"
                        className="w-full rounded-md bg-black/30 object-contain"
                        style={{ maxHeight: "12rem" }}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] px-2 text-destructive"
                        onClick={() => {
                          setReferenceSheetPreview(null);
                          update("referenceSheetImage", "");
                        }}
                        disabled={isRunning}
                      >
                        <X className="w-3 h-3 mr-1" /> Remove Reference Sheet
                      </Button>
                    </div>
                  ) : (
                    <label
                      className="flex items-center justify-center gap-2 w-full py-4 rounded-md border border-dashed border-violet-500/30 text-xs text-violet-400/70 hover:bg-violet-500/5 hover:border-violet-500/50 cursor-pointer transition-colors"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const f = e.dataTransfer.files?.[0];
                        if (f && (f.type.startsWith("image/") || f.name.match(/\.(png|jpg|jpeg|webp)$/i))) handleReferenceSheet(f);
                      }}
                    >
                      <Upload className="w-4 h-4" /> Drop reference sheet or click to browse
                      <input
                        type="file"
                        accept="image/*,.png,.jpg,.jpeg,.webp"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleReferenceSheet(f);
                        }}
                        disabled={isRunning}
                      />
                    </label>
                  )}

                  {/* IC-LoRA model selection */}
                  <div className="space-y-1">
                    <Label className="text-[10px] text-violet-400/80">Ingredients IC-LoRA</Label>
                    <LoraSelect
                      value={config.ingredientsLoRAName || ""}
                      onChange={(v) => update("ingredientsLoRAName", v)}
                      options={availableLoras}
                      compatMode="ltx2"
                      disabled={isRunning}
                      placeholder="Select ingredients IC-LoRA..."
                    />
                    <p className="text-[8px] text-violet-400/40">
                      Official <code>ltx-2.3-22b-ic-lora-ingredients</code> weights (loras/ folder).
                    </p>
                  </div>

                  {/* Reference strength */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-violet-400/80">Reference Strength</Label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {(config.referenceSheetStrength ?? 1.0).toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      min={0}
                      max={1}
                      step={0.05}
                      value={[config.referenceSheetStrength ?? 1.0]}
                      onValueChange={([v]) => update("referenceSheetStrength", v)}
                      disabled={isRunning}
                    />
                  </div>

                  {/* IC-LoRA weight strength */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-violet-400/80">IC-LoRA Weight</Label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {(config.ingredientsLoRAStrength ?? 1.4).toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      min={0}
                      max={2}
                      step={0.05}
                      value={[config.ingredientsLoRAStrength ?? 1.4]}
                      onValueChange={([v]) => update("ingredientsLoRAStrength", v)}
                      disabled={isRunning}
                    />
                    <p className="text-[8px] text-violet-400/40">Recommended 1.4.</p>
                  </div>

                  {/* Frame-0 source injection (I2V alongside the reference sheet) */}
                  <div className="rounded border border-violet-500/20 bg-violet-500/5 p-2 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-violet-300 font-medium">Inject source frame (I2V)</Label>
                      <Switch
                        checked={!!config.ingredientsUseSourceFrame}
                        onCheckedChange={(v) => update("ingredientsUseSourceFrame", v)}
                        disabled={isRunning || !config.sourceImage}
                      />
                    </div>
                    <p className="text-[8px] text-violet-400/50">
                      Anchors the source image at frame 0 <span className="text-violet-300">alongside</span> the reference sheet: high-quality image injection (I2V) instead of pure text-to-video.
                      {!config.sourceImage && <span className="text-amber-400/70"> Requires a source image.</span>}
                    </p>
                    {config.ingredientsUseSourceFrame && config.sourceImage && (
                      <div className="space-y-1 pt-0.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] text-violet-400/80">Source Frame Strength</Label>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {(config.ingredientsSourceFrameStrength ?? 0.65).toFixed(2)}
                          </span>
                        </div>
                        <Slider
                          min={0.1}
                          max={1}
                          step={0.05}
                          value={[config.ingredientsSourceFrameStrength ?? 0.65]}
                          onValueChange={([v]) => update("ingredientsSourceFrameStrength", v)}
                          disabled={isRunning}
                        />
                        <p className="text-[8px] text-violet-400/40">Recommended ~0.65. At 1.0 frame 0 is hard-locked to the source and can snap to the reference sheet on the next frame; lower lets the model blend the source into the reference-guided motion.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Motion Guide (IC-LoRA V2V) */}
          {config.pipelineMode === "official" && (
            <div className={`${ltxCard("fuchsia")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-fuchsia-400 font-medium flex items-center gap-1.5">
                  <Film className="w-3.5 h-3.5" /> Motion Guide (V2V)
                </span>
                <Switch
                  checked={!!config.icLoraMode}
                  onCheckedChange={(v) => {
                    setConfig((prev) => ({
                      ...prev,
                      icLoraMode: v,
                      // A2V conflicts (both control audio latent); I2V is compatible per official docs
                      a2vMode: v ? false : prev.a2vMode,
                    }));
                    if (!v) {
                      setGuideVideoPreview(null);
                      setGuideVideoDuration(null);
                    }
                  }}
                  className="scale-75"
                  disabled={isRunning}
                />
              </div>
              {config.icLoraMode && (
                <div className="space-y-2.5">
                  <p className="text-[9px] text-fuchsia-400/60">
                    Upload a reference video to guide motion &amp; structure. The model generates new content
                    following the motion/pose/depth of your guide video. Compatible with I2V source image
                    and guide frames for combined control. Describe what you want in the prompt.
                  </p>

                  {/* Guide video upload / preview */}
                  {guideVideoPreview ? (
                    <div className="space-y-1.5">
                      <VideoSlot
                        id="ltx2-guide-preview"
                        src={guideVideoPreview}
                        className="w-full rounded-md bg-black/30"
                        style={{ maxHeight: "10rem", width: "100%" }}
                        muted
                        loop
                      />
                      {guideVideoDuration != null && (
                        <p className="text-[9px] text-fuchsia-400/70">
                          Duration: {guideVideoDuration.toFixed(1)}s
                          {(() => {
                            const videoDur = config.numFrames / config.frameRate;
                            const diff = guideVideoDuration - videoDur;
                            if (Math.abs(diff) < 0.05) return ", matches output length";
                            if (diff > 0) return `, ${Math.abs(diff).toFixed(1)}s longer than output (will be clipped to ${config.numFrames} frames)`;
                            return `, ${Math.abs(diff).toFixed(1)}s shorter than output`;
                          })()}
                        </p>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] px-2 text-destructive"
                        onClick={() => {
                          setGuideVideoPreview(null);
                          setGuideVideoDuration(null);
                          update("guideVideoFile", "");
                        }}
                        disabled={isRunning}
                      >
                        <X className="w-3 h-3 mr-1" /> Remove Video
                      </Button>
                    </div>
                  ) : (
                    <label
                      className="flex items-center justify-center gap-2 w-full py-4 rounded-md border border-dashed border-fuchsia-500/30 text-xs text-fuchsia-400/70 hover:bg-fuchsia-500/5 hover:border-fuchsia-500/50 cursor-pointer transition-colors"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const f = e.dataTransfer.files?.[0];
                        if (f && (f.type.startsWith("video/") || f.name.match(/\.(mp4|webm|mov|avi|mkv)$/i))) {
                          const url = URL.createObjectURL(f);
                          setGuideVideoPreview(url);
                          const vid = document.createElement("video");
                          vid.src = url;
                          vid.onloadedmetadata = () => setGuideVideoDuration(vid.duration);
                          // Store file for upload at generate time
                          if (guideVideoFileRef.current) {
                            const dt = new DataTransfer();
                            dt.items.add(f);
                            guideVideoFileRef.current.files = dt.files;
                          }
                        }
                      }}
                    >
                      <Upload className="w-4 h-4" /> Drop video or click to browse
                      <input
                        ref={guideVideoFileRef}
                        type="file"
                        accept="video/*,.mp4,.webm,.mov,.avi,.mkv"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) {
                            const url = URL.createObjectURL(f);
                            setGuideVideoPreview(url);
                            const vid = document.createElement("video");
                            vid.src = url;
                            vid.onloadedmetadata = () => setGuideVideoDuration(vid.duration);
                          }
                        }}
                        disabled={isRunning}
                      />
                    </label>
                  )}

                  {/* IC-LoRA model selection */}
                  <div className="space-y-1">
                    <Label className="text-[10px] text-fuchsia-400/80">IC-LoRA Model</Label>
                    <LoraSelect
                      value={config.icLoraName || ""}
                      onChange={(v) => update("icLoraName", v)}
                      options={availableLoras}
                      compatMode="ltx2"
                      disabled={isRunning}
                      placeholder="Select IC-LoRA weights..."
                    />
                    <p className="text-[8px] text-fuchsia-400/40">
                      Use an IC-LoRA union control model (e.g. depth+canny). The model reads
                      latent_downscale_factor from metadata automatically.
                    </p>
                  </div>

                  {/* Guide strength */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-fuchsia-400/80">Guide Strength</Label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {(config.guideStrength ?? 1.0).toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      value={[config.guideStrength ?? 1.0]}
                      onValueChange={([v]) => update("guideStrength", v)}
                      min={0}
                      max={1}
                      step={0.05}
                      disabled={isRunning}
                      className="py-1"
                    />
                    <p className="text-[8px] text-fuchsia-400/40">
                      1.0 = strict motion adherence. Lower = more creative freedom.
                    </p>
                  </div>

                  {/* IC-LoRA weight strength */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-fuchsia-400/80">IC-LoRA Weight</Label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {(config.icLoraStrength ?? 1.0).toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      value={[config.icLoraStrength ?? 1.0]}
                      onValueChange={([v]) => update("icLoraStrength", v)}
                      min={0}
                      max={2}
                      step={0.05}
                      disabled={isRunning}
                      className="py-1"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Edit Video (V2V Inpaint), LTX 2.3 only, official pipeline */}
          {config.modelVersion === "2.3" && config.pipelineMode === "official" && (
            <div className={`${ltxCard("rose")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-rose-400 font-medium flex items-center gap-1.5">
                  <Edit3 className="w-3.5 h-3.5" /> Edit Video (V2V Inpaint)
                  <Badge variant="outline" className="text-[8px] h-4 border-rose-500/30 text-rose-400/70 ml-1">Slice 1a</Badge>
                </span>
                <Switch
                  checked={!!config.editVideoMode}
                  onCheckedChange={(v) => {
                    setConfig((prev) => ({
                      ...prev,
                      editVideoMode: v,
                      // Mutually exclusive with motion guide / a2v / motion tracks
                      icLoraMode: v ? false : prev.icLoraMode,
                      a2vMode: v ? false : prev.a2vMode,
                      motionTracks: v ? [] : prev.motionTracks,
                    }));
                    if (!v) {
                      setEditVideoPreview(null);
                      setEditVideoDuration(null);
                      setEditVideoFirstFrame(null);
                      setEditVideoFirstFrameComfy(null);
                      setEditVideoMaskPreview(null);
                      setEditVideoRefPreview(null);
                      setEditVideoFile(null);
                    }
                  }}
                  className="scale-75"
                  disabled={isRunning}
                />
              </div>

              {config.editVideoMode && (
                <div className="space-y-2.5">
                  <p className="text-[9px] text-rose-400/60">
                    Region-targeted video editing. Upload a source video, paint a mask on its first
                    frame to mark the area you want regenerated, optionally provide a reference image
                    for the new content, and the inpaint LoRA fills the masked region while preserving
                    everything else. Description goes in the main prompt.
                  </p>

                  {/* Pipeline toggle: A/B test Vek-Snap's original noise-mask path vs. the LoRA author's
                      magenta-fill graph (see `1_New_Workflow/NEW/ltx23_*_inpaint_v1.json`). */}
                  <div className="rounded-md border border-rose-500/15 bg-rose-500/5 p-2 space-y-1.5">
                    <Label className="text-[10px] text-rose-400/90 font-medium">Pipeline</Label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => update("editVideoPipeline", "noise-mask")}
                        disabled={isRunning}
                        className={`text-[10px] py-1.5 px-2 rounded border transition ${
                          (config.editVideoPipeline ?? "noise-mask") === "noise-mask"
                            ? "border-rose-500/60 bg-rose-500/15 text-rose-300"
                            : "border-rose-500/20 bg-transparent text-rose-400/70 hover:border-rose-500/40"
                        }`}
                      >
                        <div className="font-medium">Noise-Mask</div>
                        <div className="text-[8px] opacity-70 leading-tight">Original: SetLatentNoiseMask</div>
                      </button>
                      <button
                        type="button"
                        onClick={() => update("editVideoPipeline", "magenta-fill")}
                        disabled={isRunning}
                        className={`text-[10px] py-1.5 px-2 rounded border transition ${
                          config.editVideoPipeline === "magenta-fill"
                            ? "border-rose-500/60 bg-rose-500/15 text-rose-300"
                            : "border-rose-500/20 bg-transparent text-rose-400/70 hover:border-rose-500/40"
                        }`}
                      >
                        <div className="font-medium">Magenta-Fill</div>
                        <div className="text-[8px] opacity-70 leading-tight">Author pattern: color-fill + AddGuide</div>
                      </button>
                    </div>
                    {config.editVideoPipeline === "magenta-fill" && (
                      <div className="space-y-1 pt-0.5">
                        <Label className="text-[9px] text-rose-400/70">Fill Color</Label>
                        <div className="grid grid-cols-3 gap-1">
                          {(["auto", "magenta", "white"] as const).map((c) => (
                            <button
                              key={c}
                              type="button"
                              onClick={() => update("editVideoFillColor", c)}
                              disabled={isRunning}
                              className={`text-[9px] py-1 px-1.5 rounded border transition ${
                                (config.editVideoFillColor ?? "auto") === c
                                  ? "border-rose-500/60 bg-rose-500/15 text-rose-300"
                                  : "border-rose-500/20 bg-transparent text-rose-400/70 hover:border-rose-500/40"
                              }`}
                            >
                              {c === "auto" ? "Auto (LoRA)" : c === "magenta" ? "Magenta (r2v)" : "White (t2v)"}
                            </button>
                          ))}
                        </div>
                        <p className="text-[8px] text-rose-400/50 leading-tight">
                          Auto = magenta if LoRA name contains <code className="text-rose-300">r2v</code>, else white.
                          Magenta matches reference-targeted r2v LoRAs; white matches text-only t2v LoRAs.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Source video upload */}
                  {editVideoPreview ? (
                    <div className="space-y-1.5">
                      <VideoSlot
                        id="ltx2-edit-preview"
                        src={editVideoPreview}
                        className="w-full rounded-md bg-black/30"
                        style={{ maxHeight: "10rem", width: "100%" }}
                        muted
                        loop
                      />
                      {editVideoUploading && (
                        <p className="text-[9px] text-rose-400/70 flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" /> Caching source video so it survives tab switches…
                        </p>
                      )}
                      {editVideoDuration != null && (
                        <p className="text-[9px] text-rose-400/70">
                          Duration: {editVideoDuration.toFixed(1)}s
                          {(() => {
                            const out = config.numFrames / config.frameRate;
                            const diff = editVideoDuration - out;
                            if (Math.abs(diff) < 0.05) return ", matches output length";
                            if (diff > 0) return `, ${Math.abs(diff).toFixed(1)}s longer than output (will be clipped to ${config.numFrames} frames)`;
                            return `, ${Math.abs(diff).toFixed(1)}s shorter than output (output length will be limited)`;
                          })()}
                        </p>
                      )}
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] px-2 border-rose-500/30 text-rose-400 hover:bg-rose-500/10"
                          onClick={async () => {
                            const f = editVideoFile ?? editVideoFileRef.current?.files?.[0];
                            if (!f) return;
                            setEditVideoExtracting(true);
                            try {
                              const fd = new FormData();
                              fd.append("file", f);
                              const r = await fetch("/api/director/analyze-video", { method: "POST", body: fd });
                              if (!r.ok) throw new Error(await r.text());
                              const data = await r.json();
                              // Extracted first frame is staged in ComfyUI input/, fetch its bytes for the painter
                              setEditVideoFirstFrameComfy(data.firstFrameFile);
                              const imgRes = await fetch(getImageUrl(data.firstFrameFile, "", "input"));
                              if (imgRes.ok) {
                                const blob = await imgRes.blob();
                                const reader = new FileReader();
                                reader.onload = () => {
                                  setEditVideoFirstFrame(reader.result as string);
                                  setShowEditMaskPainter(true);
                                };
                                reader.readAsDataURL(blob);
                              }
                            } catch (err) {
                              console.error("First-frame extract failed", err);
                              alert("Failed to extract first frame: " + (err instanceof Error ? err.message : String(err)));
                            } finally {
                              setEditVideoExtracting(false);
                            }
                          }}
                          disabled={isRunning || editVideoExtracting}
                        >
                          {editVideoExtracting ? (
                            <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Extracting...</>
                          ) : editVideoMaskPreview ? (
                            <><Paintbrush className="w-3 h-3 mr-1" /> Re-paint Mask</>
                          ) : (
                            <><Paintbrush className="w-3 h-3 mr-1" /> Paint Mask on Frame 0</>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[10px] px-2 text-destructive"
                          onClick={() => {
                            setEditVideoPreview(null);
                            setEditVideoDuration(null);
                            setEditVideoFirstFrame(null);
                            setEditVideoFirstFrameComfy(null);
                            setEditVideoMaskPreview(null);
                            setEditVideoRefPreview(null);
                            setEditVideoRefPreviews({});
                            setEditVideoFile(null);
                            setMaskIsVideo(false);
                            setSam2Status(null);
                            update("editVideoSourceFile", "");
                            update("editVideoMaskFile", "");
                            update("editVideoReferenceImage", "");
                            update("editVideoReferenceImages", []);
                          }}
                          disabled={isRunning}
                        >
                          <X className="w-3 h-3 mr-1" /> Remove
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <label
                      className="flex items-center justify-center gap-2 w-full py-4 rounded-md border border-dashed border-rose-500/30 text-xs text-rose-400/70 hover:bg-rose-500/5 hover:border-rose-500/50 cursor-pointer transition-colors"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const f = e.dataTransfer.files?.[0];
                        if (f && (f.type.startsWith("video/") || f.name.match(/\.(mp4|webm|mov|avi|mkv)$/i))) {
                          handleEditVideoSelected(f);
                        }
                      }}
                    >
                      <Upload className="w-4 h-4" /> Drop source video to edit
                      <input
                        ref={editVideoFileRef}
                        type="file"
                        accept="video/*,.mp4,.webm,.mov,.avi,.mkv"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) {
                            handleEditVideoSelected(f);
                          }
                        }}
                        disabled={isRunning}
                      />
                    </label>
                  )}

                  {/* Mask preview */}
                  {editVideoMaskPreview && editVideoFirstFrame && (
                    <div className="space-y-1.5">
                      <Label className="text-[10px] text-rose-400/80">Painted Mask</Label>
                      <div className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={editVideoFirstFrame} alt="frame" className="w-full rounded border border-rose-500/30 max-h-32 object-contain bg-black/30" />
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={editVideoMaskPreview} alt="mask" className="absolute inset-0 w-full h-full object-contain mix-blend-screen opacity-60 pointer-events-none" />
                      </div>
                    </div>
                  )}

                  {/* Mask source selector: Slice 2 buttons disabled */}
                  <div className="space-y-1">
                    <Label className="text-[10px] text-rose-400/80">Mask Source</Label>
                    <div className="grid grid-cols-2 gap-1">
                      <Button
                        size="sm"
                        variant={config.editVideoMaskSource === "manual" ? "default" : "outline"}
                        className="h-6 text-[9px] px-1.5"
                        onClick={() => update("editVideoMaskSource", "manual")}
                        disabled={isRunning}
                      >
                        <Paintbrush className="w-3 h-3 mr-1" /> Manual
                      </Button>
                      {samCaps.sam2 && (
                      <Button
                        size="sm"
                        variant={config.editVideoMaskSource === "sam2-tracked" ? "default" : "outline"}
                        className="h-6 text-[9px] px-1.5"
                        onClick={() => update("editVideoMaskSource", "sam2-tracked")}
                        disabled={isRunning || !config.editVideoMaskFile || maskIsVideo}
                        title={
                          !config.editVideoMaskFile
                            ? "Paint or generate a frame-0 mask first"
                            : maskIsVideo
                              ? "Already tracked: re-paint to start over"
                              : "Propagate the frame-0 mask through the video using SAM2"
                        }
                      >
                        <Film className="w-3 h-3 mr-1" /> SAM2 Track
                      </Button>
                      )}
                    </div>
                  </div>

                  {/* SAM2 inline panel: propagates the frame-0 mask across the whole video */}
                  {config.editVideoMaskSource === "sam2-tracked" && (
                    <div className="rounded border border-cyan-500/30 bg-cyan-500/10 p-2 space-y-1.5">
                      <Label className="text-[10px] text-cyan-300 flex items-center gap-1">
                        <Film className="w-3 h-3" /> SAM2 Video Tracking
                      </Label>
                      <p className="text-[9px] text-cyan-300/70">
                        Takes your frame-0 mask and propagates it through every frame of the source video so the
                        inpainted region follows motion. Outputs a mask MP4 that the LTX 2.3 V2V graph loads as
                        an animated mask.
                      </p>
                      <div className="flex items-center gap-2">
                        <Label className="text-[9px] text-cyan-300/70 shrink-0">Model</Label>
                        <select
                          value={sam2Model}
                          onChange={(e) => setSam2Model(e.target.value as typeof sam2Model)}
                          disabled={isRunning || sam2Running}
                          className="h-6 text-[10px] px-1.5 rounded bg-background border border-cyan-500/30 text-cyan-100 flex-1"
                        >
                          <option value="sam2.1_hiera_tiny">tiny: fastest (~150 MB)</option>
                          <option value="sam2.1_hiera_small">small: balanced</option>
                          <option value="sam2.1_hiera_base_plus">base_plus: recommended</option>
                          <option value="sam2.1_hiera_large">large: best quality, slowest</option>
                        </select>
                      </div>
                      <Button
                        size="sm"
                        className="h-6 text-[10px] px-2 bg-cyan-500/30 hover:bg-cyan-500/40 text-cyan-100 border border-cyan-500/50 w-full"
                        onClick={async () => {
                          if (!editVideoFile && !editVideoFileRef.current?.files?.[0]) {
                            setSam2Status("Source video not available. Re-upload it.");
                            return;
                          }
                          if (!config.editVideoMaskFile) {
                            setSam2Status("No frame-0 mask to propagate.");
                            return;
                          }
                          setSam2Running(true);
                          setSam2Status("Uploading source video to ComfyUI...");
                          try {
                            // Ensure the source video is uploaded first so the SAM2 script can read it
                            let sourceVideoFile = config.editVideoSourceFile;
                            if (!sourceVideoFile) {
                              const f = editVideoFile ?? editVideoFileRef.current?.files?.[0];
                              if (!f) throw new Error("Source video file lost from memory");
                              // Same absolute-path requirement as the main generate flow, VHS_LoadVideoPath
                              // (used by node 660 downstream) refuses ComfyUI-input-relative strings.
                              const relPath = await uploadVideo(f);
                              sourceVideoFile = await resolveComfyInputAbsPath(relPath);
                              update("editVideoSourceFile", sourceVideoFile);
                            }

                            setSam2Status("Running SAM2 propagation (this can take 30–120 s)...");
                            const r = await fetch("/api/sam/sam2-track", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                sourceVideoFile,
                                maskFile: config.editVideoMaskFile,
                                model: sam2Model,
                                device: "cuda",
                                maxFrames: config.numFrames,
                              }),
                            });
                            const data = await r.json();
                            if (!r.ok || !data.ok) {
                              setSam2Status(
                                data.needsSetup
                                  ? `Setup needed: ${data.error}`
                                  : `Failed: ${data.error || "unknown error"}`
                              );
                              return;
                            }
                            // Replace the static PNG mask with the new animated MP4
                            update("editVideoMaskFile", data.maskVideoFile);
                            setMaskIsVideo(true);
                            setSam2Status(
                              `Tracked: ${data.nFrames} frame${data.nFrames === 1 ? "" : "s"} @ ${(data.fps ?? 0).toFixed(2)} fps. Mask: ${data.maskVideoFile}`
                            );
                          } catch (err) {
                            setSam2Status(`Error: ${err instanceof Error ? err.message : String(err)}`);
                          } finally {
                            setSam2Running(false);
                          }
                        }}
                        disabled={isRunning || sam2Running || !config.editVideoMaskFile || maskIsVideo}
                      >
                        {sam2Running ? (
                          <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Tracking...</>
                        ) : maskIsVideo ? (
                          <><Film className="w-3 h-3 mr-1" /> Already Tracked</>
                        ) : (
                          <><Film className="w-3 h-3 mr-1" /> Propagate Mask Through Video</>
                        )}
                      </Button>
                      {sam2Status && (
                        <p className={`text-[9px] ${sam2Status.startsWith("Tracked") ? "text-emerald-400/80" : sam2Status.startsWith("Setup") || sam2Status.startsWith("Failed") || sam2Status.startsWith("Error") || sam2Status.startsWith("No ") || sam2Status.startsWith("Source ") ? "text-amber-400/80" : "text-cyan-300/70"}`}>
                          {sam2Status}
                        </p>
                      )}
                      <p className="text-[8px] text-cyan-300/50">
                        First run downloads the SAM2.1 checkpoint (~150 MB for tiny) from <code>1038lab/sam2</code>
                        (open mirror, no login). Subsequent runs are offline.
                      </p>
                    </div>
                  )}

                  {/* Optional reference image */}
                  {/* ── Multi-Reference Image panel ──
                      Up to 4 reference images, each anchored at a chosen frame_idx. The V2V
                      Inpaint workflow injects them into LTXVAddGuideMulti so the masked R2V LoRA
                      receives identity cues at the requested timestamps. Use cases:
                        • One ref at frame 0 → classic single-reference (legacy behavior).
                        • Front + side + back at idx 0 / N/2 / N-1 → orbital body composite where
                          the model interpolates the rotation between views.
                        • Multiple wardrobe states at staggered frames → quick wardrobe transition.
                      Migration: legacy `editVideoReferenceImage` (single string) is auto-promoted
                      to the array on first edit. */}
                  {(() => {
                    const refs = (config.editVideoReferenceImages && config.editVideoReferenceImages.length > 0)
                      ? config.editVideoReferenceImages
                      : (config.editVideoReferenceImage
                          ? [{ file: config.editVideoReferenceImage, frameIdx: 0 }]
                          : []);
                    const maxFrame = Math.max(0, (config.numFrames ?? 97) - 1);
                    const setRefs = (next: Array<{ file: string; frameIdx: number; strength?: number }>) => {
                      update("editVideoReferenceImages", next);
                      // Promote out of legacy field once the user touches multi-ref
                      if (config.editVideoReferenceImage) update("editVideoReferenceImage", "");
                    };
                    const removeRef = (idx: number) => setRefs(refs.filter((_, i) => i !== idx));
                    const updateRef = (idx: number, patch: Partial<{ file: string; frameIdx: number; strength: number }>) =>
                      setRefs(refs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
                    const addRef = async (f: File) => {
                      try {
                        const filename = await uploadImage(f);
                        const reader = new FileReader();
                        reader.onload = () => setEditVideoRefPreviews((prev) => ({ ...prev, [filename]: reader.result as string }));
                        reader.readAsDataURL(f);
                        // Auto-distribute frame_idx across the timeline as more refs are added:
                        //   1st → 0, 2nd → maxFrame, 3rd → maxFrame/2, 4th → maxFrame/3.
                        // This matches the front/side/back keyframe pattern most users will want.
                        const defaults = [0, maxFrame, Math.round(maxFrame / 2), Math.round(maxFrame / 3)];
                        const newFrameIdx = defaults[refs.length] ?? 0;
                        setRefs([...refs, { file: filename, frameIdx: newFrameIdx }]);
                      } catch (err) {
                        console.error("Reference upload failed", err);
                      }
                    };

                    return (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] text-rose-400/80">
                            Reference Image{refs.length > 1 ? "s" : ""} (optional)
                            {refs.length > 0 && (
                              <span className="ml-1.5 text-[9px] text-rose-400/50">({refs.length}/4 keyframes)</span>
                            )}
                          </Label>
                          {refs.length > 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 text-[9px] px-1.5 text-destructive"
                              onClick={() => setRefs([])}
                              disabled={isRunning}
                              title="Remove all references"
                            >
                              <X className="w-3 h-3 mr-0.5" /> Clear
                            </Button>
                          )}
                        </div>

                        {/* Existing reference slots */}
                        {refs.length > 0 && (
                          <div className="grid grid-cols-2 gap-1.5">
                            {refs.map((ref, i) => (
                              <div key={`${ref.file}_${i}`} className="rounded border border-rose-500/30 bg-rose-500/5 p-1.5 space-y-1">
                                <div className="flex items-center justify-between">
                                  <span className="text-[9px] text-rose-300/80 font-medium">
                                    Keyframe {i + 1}
                                  </span>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-4 w-4 p-0 text-destructive"
                                    onClick={() => removeRef(i)}
                                    disabled={isRunning}
                                  >
                                    <Trash2 className="w-2.5 h-2.5" />
                                  </Button>
                                </div>
                                {editVideoRefPreviews[ref.file] ? (
                                  <div className="flex justify-center">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={editVideoRefPreviews[ref.file]}
                                      alt={`ref ${i + 1}`}
                                      className="max-h-16 rounded border border-rose-500/20"
                                    />
                                  </div>
                                ) : (
                                  <div className="h-16 flex items-center justify-center text-[8px] text-rose-300/40 italic">
                                    {ref.file}
                                  </div>
                                )}
                                <div className="flex items-center gap-1">
                                  <Label className="text-[8px] text-rose-300/70 shrink-0">@frame</Label>
                                  <input
                                    type="number"
                                    min={0}
                                    max={maxFrame}
                                    value={ref.frameIdx}
                                    onChange={(e) => {
                                      const v = Math.max(0, Math.min(maxFrame, Number(e.target.value) || 0));
                                      updateRef(i, { frameIdx: v });
                                    }}
                                    disabled={isRunning}
                                    className="h-5 w-full text-[9px] px-1 rounded bg-background border border-rose-500/20 text-rose-100"
                                  />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Add-reference dropzone (hidden when at 4) */}
                        {refs.length < 4 && (
                          <label className="flex items-center justify-center gap-1.5 w-full py-2 rounded-md border border-dashed border-rose-500/20 text-[10px] text-rose-400/60 hover:bg-rose-500/5 cursor-pointer transition-colors">
                            {refs.length === 0 ? (
                              <><ImageIcon className="w-3 h-3" /> Upload reference of new subject</>
                            ) : (
                              <><Plus className="w-3 h-3" /> Add another keyframe ({refs.length}/4)</>
                            )}
                            <input
                              ref={editRefImageFileRef}
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={async (e) => {
                                const f = e.target.files?.[0];
                                if (!f) return;
                                await addRef(f);
                                e.target.value = ""; // allow re-uploading the same filename
                              }}
                              disabled={isRunning}
                            />
                          </label>
                        )}

                        <p className="text-[8px] text-rose-400/40">
                          {refs.length <= 1
                            ? "Match the camera angle of your source video for best results. Leave empty for text-only edits."
                            : `Multi-keyframe mode: model interpolates between references across the masked region. Common pattern: front view @ 0, side @ ${Math.round(maxFrame / 2)}, back @ ${maxFrame}.`}
                        </p>
                      </div>
                    );
                  })()}

                  {/* Inpaint LoRA selector */}
                  <div className="space-y-1">
                    <Label className="text-[10px] text-rose-400/80">Inpaint LoRA</Label>
                    <LoraSelect
                      value={config.editVideoLoraName || ""}
                      onChange={(v) => update("editVideoLoraName", v)}
                      options={availableLoras}
                      compatMode="ltx2"
                      disabled={isRunning}
                      placeholder="Select inpaint LoRA..."
                    />
                    <details className="text-[8px] text-rose-400/40">
                      <summary className="cursor-pointer">Recommended files (Alissonerdx/LTX-LoRAs)</summary>
                      <ul className="mt-1 space-y-0.5 pl-3">
                        {LTX23_INPAINT_LORAS.map((l) => (
                          <li key={l.filename} className={availableLoras.includes(l.filename) ? "text-emerald-400/70" : ""}>
                            <code className="text-[8px]">{l.filename}</code>: {l.label}
                            {availableLoras.includes(l.filename) && <span className="ml-1">✓</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </div>

                  {/* LoRA strength */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-rose-400/80">LoRA Strength</Label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {(config.editVideoLoraStrength ?? 1.0).toFixed(2)}
                      </span>
                    </div>
                    <Slider
                      value={[config.editVideoLoraStrength ?? 1.0]}
                      onValueChange={([v]) => update("editVideoLoraStrength", v)}
                      min={0} max={2} step={0.05}
                      disabled={isRunning}
                      className="py-1"
                    />
                    <p className="text-[8px] text-rose-400/40">
                      Inpaint LoRAs are designed for full strength. Lower only if blending is too aggressive.
                    </p>
                  </div>

                  {/* Mask preprocessing controls */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[10px] text-rose-400/80">Blockify Size</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {config.editVideoBlockifyMaskSize === 0 ? "off" : config.editVideoBlockifyMaskSize ?? 8}
                        </span>
                      </div>
                      <Slider
                        value={[config.editVideoBlockifyMaskSize ?? 8]}
                        onValueChange={([v]) => update("editVideoBlockifyMaskSize", v)}
                        min={0} max={64} step={1}
                        disabled={isRunning}
                        className="py-1"
                      />
                      <p className="text-[8px] text-rose-400/40">8 = match training. 0 = disable.</p>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[10px] text-rose-400/80">Mask Grow</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {(config.editVideoMaskGrow ?? 8) >= 0 ? "+" : ""}{config.editVideoMaskGrow ?? 8}px
                        </span>
                      </div>
                      <Slider
                        value={[config.editVideoMaskGrow ?? 8]}
                        onValueChange={([v]) => update("editVideoMaskGrow", v)}
                        min={-16} max={64} step={1}
                        disabled={isRunning}
                        className="py-1"
                      />
                      <p className="text-[8px] text-rose-400/40">Expand the masked area for the new object to fit.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Motion Tracks (sparse spline paths → IC-LoRA motion control) */}
          {config.modelVersion === "2.3" && (
            <div className={`${ltxCard("cyan")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-cyan-400 font-medium flex items-center gap-1.5">
                  <Spline className="w-3.5 h-3.5" /> Motion Tracks
                </span>
                <Switch
                  checked={!!(config.motionTracks && config.motionTracks.length > 0)}
                  onCheckedChange={(v) => {
                    if (!v) {
                      setConfig((prev) => ({ ...prev, motionTracks: [] }));
                    }
                  }}
                  className="scale-75"
                  disabled={isRunning}
                />
              </div>

              <p className="text-[9px] text-cyan-400/60">
                Draw spline motion paths on the source image to guide object movement.
                Uses Lightricks IC-LoRA motion track control: no artifacts, no prompt roulette.
                Requires a source image and the motion-track IC-LoRA model.
              </p>

              {/* Track count + Edit button */}
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[9px] h-5 border-cyan-500/30 text-cyan-400/80">
                  {config.motionTracks?.length || 0} track{(config.motionTracks?.length || 0) !== 1 ? "s" : ""}
                  {config.motionTracks && config.motionTracks.length > 0 && (
                    <> · {config.motionTracks.reduce((s, t) => s + t.points.length, 0)} pts</>
                  )}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                  onClick={() => setShowTrackEditor(true)}
                  disabled={isRunning || !sourcePreview}
                >
                  <Spline className="w-3 h-3 mr-1" />
                  {config.motionTracks && config.motionTracks.length > 0 ? "Edit Tracks" : "Draw Tracks"}
                </Button>
                {!sourcePreview && (
                  <span className="text-[8px] text-amber-400/70">Upload source image first</span>
                )}
              </div>

              {/* Track preview mini-canvas */}
              {config.motionTracks && config.motionTracks.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1">
                    {config.motionTracks.map((track, idx) => (
                      <div key={track.id} className="flex items-center gap-1 text-[9px] text-muted-foreground">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: track.color }} />
                        <span style={{ opacity: track.enabled === false ? 0.4 : 1 }}>
                          {track.enabled === false ? "⊘ " : ""}{track.label || `Track ${idx + 1}`} ({track.points.length} pts)
                          {((track.startTime && track.startTime > 0) || (track.endTime && track.endTime > 0))
                            ? ` [${(track.startTime ?? 0).toFixed(1)}s–${(track.endTime && track.endTime > 0) ? track.endTime.toFixed(1) + "s" : "end"}]`
                            : ""}
                          {track.easing && track.easing !== "linear" ? ` ${track.easing}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 text-[9px] px-2 text-destructive/70 hover:text-destructive"
                    onClick={() => setConfig((prev) => ({ ...prev, motionTracks: [] }))}
                    disabled={isRunning}
                  >
                    <Trash2 className="w-3 h-3 mr-1" /> Clear All Tracks
                  </Button>
                </div>
              )}

              {/* IC-LoRA model for motion tracks */}
              <div className="space-y-1">
                <Label className="text-[10px] text-cyan-400/80">Motion Track IC-LoRA</Label>
                <LoraSelect
                  value={config.motionTrackLoRA || ""}
                  onChange={(v) => update("motionTrackLoRA", v)}
                  options={availableLoras}
                  compatMode="ltx2"
                  disabled={isRunning}
                  placeholder="Select motion track IC-LoRA..."
                />
                <p className="text-[8px] text-cyan-400/40">
                  Auto-detected from loras. Requires motion-track IC-LoRA.
                </p>
              </div>

              {/* Guide strength */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-cyan-400/80">Guide Strength</Label>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {(config.motionTrackGuideStrength ?? 1.0).toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[config.motionTrackGuideStrength ?? 1.0]}
                  onValueChange={([v]) => update("motionTrackGuideStrength", v)}
                  min={0}
                  max={1}
                  step={0.05}
                  disabled={isRunning}
                  className="py-1"
                />
              </div>

              {/* IC-LoRA weight strength */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-cyan-400/80">IC-LoRA Weight</Label>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {(config.motionTrackLoRAStrength ?? 1.0).toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[config.motionTrackLoRAStrength ?? 1.0]}
                  onValueChange={([v]) => update("motionTrackLoRAStrength", v)}
                  min={0}
                  max={2}
                  step={0.05}
                  disabled={isRunning}
                  className="py-1"
                />
              </div>
            </div>
          )}

          {/* Reference Prep Studio modal, standalone tool, not workflow-coupled. */}
          <ReferencePrepStudio
            open={showReferencePrep}
            onClose={() => setShowReferencePrep(false)}
          />

          {/* V2V Inpaint Mask Painter Overlay */}
          {showEditMaskPainter && editVideoFirstFrame && (
            <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
              <div className="w-full max-w-5xl h-[85vh] bg-background rounded-lg overflow-hidden">
                <MaskPainter
                  initialImageUrl={editVideoFirstFrame}
                  initialMaskUrl={editVideoMaskPreview || undefined}
                  onCancel={() => setShowEditMaskPainter(false)}
                  onMaskComplete={async (maskBlob) => {
                    // Convert mask blob to data URL for preview
                    const reader = new FileReader();
                    reader.onload = () => setEditVideoMaskPreview(reader.result as string);
                    reader.readAsDataURL(maskBlob);
                    // Upload mask to ComfyUI input/ as PNG with deterministic filename
                    try {
                      const maskFile = new File([maskBlob], `ltx2_edit_mask_${Date.now()}.png`, { type: "image/png" });
                      const filename = await uploadImage(maskFile);
                      update("editVideoMaskFile", filename);
                      setMaskIsVideo(false); // hand-painted PNG
                      setSam2Status(null); // invalidate any previous SAM2 result
                    } catch (err) {
                      console.error("Mask upload failed", err);
                      alert("Failed to upload mask: " + (err instanceof Error ? err.message : String(err)));
                    }
                    setShowEditMaskPainter(false);
                  }}
                />
              </div>
            </div>
          )}

          {/* Motion Track Editor Overlay */}
          {showTrackEditor && sourcePreview && (
            <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
              <div className="w-full max-w-4xl h-[80vh]">
                <MotionTrackEditor
                  tracks={config.motionTracks || []}
                  onTracksChange={(tracks: MotionTrack[]) => setConfig((prev) => ({ ...prev, motionTracks: tracks }))}
                  onClose={() => setShowTrackEditor(false)}
                  imageUrl={sourcePreview}
                  imageWidth={config.width}
                  imageHeight={config.height}
                />
              </div>
            </div>
          )}

          {/* Output Preview */}
          {outputUrl && (
            <div className={`${ltxCard("blue")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-blue-400 font-medium flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> Output
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[10px] px-2"
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = outputUrl;
                      a.download = `ltx2_${Date.now()}.mp4`;
                      a.click();
                    }}
                  >
                    <Download className="w-3 h-3 mr-1" /> Download
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[10px] px-2"
                    onClick={() => handleGenerate(false)}
                  >
                    <RefreshCw className="w-3 h-3 mr-1" /> Regenerate
                  </Button>
                </div>
              </div>
              {isPreview && (
                <div className="flex items-center gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5">
                  <Eye className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <p className="text-[9px] text-amber-400 flex-1">
                    Preview ({getPreviewResolution(config.width, config.height).width}×{getPreviewResolution(config.width, config.height).height}). Approve?
                  </p>
                  <Button
                    size="sm"
                    className="h-6 text-[10px] px-2.5 bg-blue-600 hover:bg-blue-500 text-white"
                    onClick={() => handleGenerate(false)}
                  >
                    <Maximize2 className="w-3 h-3 mr-1" /> Full Res ({config.width}×{config.height})
                  </Button>
                </div>
              )}
              <VideoSlot
                id="ltx2-output"
                src={outputUrl}
                className="w-full rounded border border-border/50"
                style={{ width: "100%" }}
                autoOpen={autoplay}
                loop
              />

              {/* A2V Audio Choice: let user pick original uploaded audio vs model-generated audio */}
              {a2vAudioFileUsed && outputVideoFile && generatedOutputUrl && (
                <div className="rounded border border-orange-500/20 bg-orange-500/5 p-2.5 space-y-2">
                  <p className="text-[10px] text-orange-400 font-medium flex items-center gap-1.5">
                    <AudioLines className="w-3.5 h-3.5" /> Audio Track
                  </p>
                  <p className="text-[8px] text-muted-foreground leading-relaxed">
                    The model generated new audio. You can keep it or replace it with your original uploaded audio.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={audioChoice === "generated" ? "default" : "outline"}
                      className={`flex-1 h-7 text-[10px] ${audioChoice === "generated" ? "bg-orange-600 hover:bg-orange-500 text-white" : ""}`}
                      disabled={swappingAudio}
                      onClick={() => {
                        if (audioChoice !== "generated" && generatedOutputUrl) {
                          setOutputUrl(generatedOutputUrl);
                          setAudioChoice("generated");
                        }
                      }}
                    >
                      <Volume2 className="w-3 h-3 mr-1" /> Generated Audio
                    </Button>
                    <Button
                      size="sm"
                      variant={audioChoice === "original" ? "default" : "outline"}
                      className={`flex-1 h-7 text-[10px] ${audioChoice === "original" ? "bg-orange-600 hover:bg-orange-500 text-white" : ""}`}
                      disabled={swappingAudio}
                      onClick={async () => {
                        if (audioChoice === "original") return;
                        setSwappingAudio(true);
                        setError(null);
                        try {
                          const res = await fetch("/api/director/swap-audio", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              videoFile: outputVideoFile,
                              audioFile: a2vAudioFileUsed,
                              mode: "original",
                            }),
                          });
                          if (!res.ok) {
                            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                            throw new Error(err.error || `Swap failed: HTTP ${res.status}`);
                          }
                          const blob = await res.blob();
                          const url = URL.createObjectURL(blob);
                          setOutputUrl(url);
                          setAudioChoice("original");
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Audio swap failed");
                        } finally {
                          setSwappingAudio(false);
                        }
                      }}
                    >
                      {swappingAudio ? (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      ) : (
                        <AudioLines className="w-3 h-3 mr-1" />
                      )}
                      Original Audio
                    </Button>
                  </div>
                  {audioChoice === "original" && (
                    <p className="text-[8px] text-orange-400/60 text-center">
                      Using your uploaded audio. Download to save this version.
                    </p>
                  )}
                </div>
              )}

              {/* Audio Denoise Post-Processing */}
              {config.enableAudio && (
                <div className="rounded border border-sky-500/20 bg-sky-500/5 p-2.5 space-y-2">
                  <p className="text-[10px] text-sky-400 font-medium flex items-center gap-1.5">
                    <AudioLines className="w-3.5 h-3.5" /> Audio Noise Reduction (FFmpeg)
                  </p>
                  <p className="text-[8px] text-muted-foreground leading-relaxed">
                    Applies spectral gating (afftdn), highpass at 80Hz, and lowpass at 14kHz to remove
                    background hiss and high-frequency artifacts from generated audio.
                  </p>

                  {/* Denoise controls */}
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-0.5">
                      <Label className="text-[9px] text-sky-400/70">
                        Reduction: {Math.round(denoiseAmount * 100)}%
                      </Label>
                      <Slider
                        min={0}
                        max={1}
                        step={0.05}
                        value={[denoiseAmount]}
                        onValueChange={([v]) => setDenoiseAmount(v)}
                        disabled={denoiseProcessing}
                      />
                    </div>
                    <div className="flex-1 space-y-0.5">
                      <Label className="text-[9px] text-sky-400/70">
                        Noise Floor: {denoiseNoiseFloor}dB
                      </Label>
                      <Slider
                        min={-60}
                        max={-10}
                        step={1}
                        value={[denoiseNoiseFloor]}
                        onValueChange={([v]) => setDenoiseNoiseFloor(v)}
                        disabled={denoiseProcessing}
                      />
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 h-7 text-[10px] border-sky-500/30 text-sky-400/80 hover:text-sky-400 hover:border-sky-500/50"
                      onClick={() => handleAudioDenoise("audio")}
                      disabled={denoiseProcessing}
                    >
                      {denoiseProcessing ? (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      ) : (
                        <Download className="w-3 h-3 mr-1" />
                      )}
                      Download Clean Audio
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 h-7 text-[10px] border-sky-500/30 text-sky-400/80 hover:text-sky-400 hover:border-sky-500/50"
                      onClick={() => handleAudioDenoise("merge")}
                      disabled={denoiseProcessing}
                    >
                      {denoiseProcessing ? (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      ) : (
                        <Download className="w-3 h-3 mr-1" />
                      )}
                      Download Clean MP4
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Z-Refine Panel: keyframe enhancement using Z-Image Turbo I2I */}
          {outputVideoFile && outputUrl && !isRunning && (
            <ZRefinePanel
              outputVideoFile={outputVideoFile}
              outputVideoUrl={outputUrl}
              videoPrompt={config.prompt}
              videoNegativePrompt={config.negativePrompt}
              videoFrameRate={config.frameRate}
              videoNumFrames={config.numFrames}
              videoWidth={config.width}
              videoHeight={config.height}
              videoSeed={config.seed}
              videoRandomSeed={config.randomSeed}
              disabled={isRunning}
              onInjectGuideFrames={(frames) => {
                // Populate the extra guide frames, user triggers regeneration manually
                setExtraGuideFrames(frames.map((f, i) => ({
                  id: `zrefine_${Date.now()}_${i}`,
                  previewUrl: getImageUrl(f.image, "", "input"),
                  comfyFile: f.image,
                  frameIdx: f.frameIdx,
                  strength: f.strength,
                })));
              }}
            />
          )}

          {/* Retake / Extend (native continuity editing), LTX 2.3, both pipelines */}
          {config.modelVersion === "2.3" && (
            <div className={`${ltxCard("indigo")} p-3 space-y-2.5`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-indigo-300 font-medium flex items-center gap-1.5">
                  <Film className="w-3.5 h-3.5" /> Retake / Extend
                  <Badge variant="outline" className="text-[8px] h-4 border-indigo-500/30 text-indigo-300/70 ml-1">Continuity</Badge>
                </span>
              </div>

              {/* Mode selector */}
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  { key: "off", label: "Off", Icon: null, desc: "Normal generation" },
                  { key: "retake", label: "Retake", Icon: Repeat, desc: "Regenerate a section" },
                  { key: "extend", label: "Extend", Icon: Scissors, desc: "Append new footage" },
                ] as const).map(({ key, label, Icon, desc }) => {
                  const active = (config.continuityMode ?? "off") === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={isRunning}
                      onClick={() => {
                        setConfig((prev) => {
                          const next: LTX2Config = {
                            ...prev,
                            continuityMode: key,
                            // Continuity is mutually exclusive with other source-conditioning modes
                            editVideoMode: key !== "off" ? false : prev.editVideoMode,
                            a2vMode: key !== "off" ? false : prev.a2vMode,
                            icLoraMode: key !== "off" ? false : prev.icLoraMode,
                            sourceImage: key !== "off" ? "" : prev.sourceImage,
                          };
                          if (key !== "off" && (prev.continuitySourceFrames ?? 0) > 0) {
                            Object.assign(next, applyContinuityFrameMath(key, prev.continuitySourceFrames!, prev.frameRate, prev.extendSeconds ?? 3));
                          }
                          return next;
                        });
                      }}
                      className={`text-[10px] py-1.5 px-2 rounded border transition flex flex-col items-center gap-0.5 ${
                        active
                          ? "border-indigo-500/60 bg-indigo-500/15 text-indigo-200"
                          : "border-indigo-500/20 bg-transparent text-indigo-300/70 hover:border-indigo-500/40"
                      }`}
                      title={desc}
                    >
                      <span className="font-medium flex items-center gap-1">{Icon && <Icon className="w-3 h-3" />}{label}</span>
                      <span className="text-[8px] opacity-70 leading-tight text-center">{desc}</span>
                    </button>
                  );
                })}
              </div>

              {config.continuityMode !== "off" && (
                <div className="space-y-2.5">
                  <p className="text-[9px] text-indigo-300/60">
                    {config.continuityMode === "retake"
                      ? "Load an existing clip and pick a time window to re-roll. Everything outside the window is frozen (kept verbatim); only the window is regenerated from the prompt + a new seed."
                      : "Load an existing clip and append new footage. The source is frozen and the model generates a seamless continuation from where it ends."}
                  </p>

                  {/* Source video upload */}
                  {continuityPreview ? (
                    <div className="space-y-1.5">
                      <VideoSlot id="ltx2-continuity-preview" src={continuityPreview} className="w-full rounded-md bg-black/30" style={{ maxHeight: "10rem", width: "100%" }} muted loop />
                      {continuityUploading && (
                        <p className="text-[9px] text-indigo-300/70 flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" /> Caching source video so it survives tab switches…
                        </p>
                      )}
                      {continuityDuration != null && (
                        <p className="text-[9px] text-indigo-300/70">
                          Source: {continuityDuration.toFixed(1)}s · {config.continuitySourceFrames ?? 0} frames @ {config.frameRate}fps
                        </p>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] px-2 text-destructive"
                        onClick={clearContinuity}
                        disabled={isRunning}
                      >
                        <X className="w-3 h-3 mr-1" /> Remove
                      </Button>
                    </div>
                  ) : (
                    <label
                      className="flex items-center justify-center gap-2 w-full py-4 rounded-md border border-dashed border-indigo-500/30 text-xs text-indigo-300/70 hover:bg-indigo-500/5 hover:border-indigo-500/50 cursor-pointer transition-colors"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const f = e.dataTransfer.files?.[0];
                        if (f && (f.type.startsWith("video/") || f.name.match(/\.(mp4|webm|mov|avi|mkv)$/i))) {
                          handleContinuityVideoSelected(f);
                        }
                      }}
                    >
                      <Upload className="w-4 h-4" /> Drop {config.continuityMode === "retake" ? "clip to retake" : "clip to extend"}
                      <input
                        ref={continuityFileRef}
                        type="file"
                        accept="video/*,.mp4,.webm,.mov,.avi,.mkv"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleContinuityVideoSelected(f);
                        }}
                        disabled={isRunning}
                      />
                    </label>
                  )}

                  {/* Retake window controls */}
                  {config.continuityMode === "retake" && continuityPreview && (() => {
                    const clipDur = (config.continuitySourceFrames ?? 0) / config.frameRate || continuityDuration || 0;
                    const start = config.retakeStart ?? 0;
                    const end = config.retakeEnd ?? clipDur;
                    return (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] text-indigo-300/80">Regenerate window</Label>
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {start.toFixed(1)}s → {end.toFixed(1)}s
                          </span>
                        </div>
                        <Slider
                          value={[start, end]}
                          onValueChange={([s, e]) => {
                            setConfig((prev) => ({ ...prev, retakeStart: +s.toFixed(2), retakeEnd: +e.toFixed(2) }));
                          }}
                          min={0}
                          max={Math.max(0.1, +clipDur.toFixed(2))}
                          step={0.1}
                          disabled={isRunning}
                          className="py-1"
                        />
                        <label className="flex items-center gap-2 cursor-pointer">
                          <Switch
                            checked={!!config.retakeRegenAudio}
                            onCheckedChange={(v) => update("retakeRegenAudio", v)}
                            className="scale-75"
                            disabled={isRunning || !config.enableAudio}
                          />
                          <span className="text-[9px] text-indigo-300/70">
                            Also regenerate audio inside the window {config.enableAudio ? "" : "(enable audio first)"}
                          </span>
                        </label>
                        <p className="text-[8px] text-indigo-300/40">
                          Frames outside {start.toFixed(1)}s–{end.toFixed(1)}s are frozen. Use a new seed for a different take.
                        </p>
                      </div>
                    );
                  })()}

                  {/* Extend controls */}
                  {config.continuityMode === "extend" && continuityPreview && (() => {
                    const addSec = config.extendSeconds ?? 3;
                    const addedFrames = (config.numFrames ?? 0) - (config.continuitySourceFrames ?? 0);
                    const totalDur = (config.numFrames ?? 0) / config.frameRate;
                    return (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] text-indigo-300/80">Append duration</Label>
                          <span className="text-[10px] text-muted-foreground font-mono">+{addSec.toFixed(1)}s</span>
                        </div>
                        <Slider
                          value={[addSec]}
                          onValueChange={([v]) => {
                            setConfig((prev) => {
                              const src = prev.continuitySourceFrames ?? 0;
                              const tail = align8(Math.round(v * prev.frameRate));
                              return { ...prev, extendSeconds: v, numFrames: src + tail };
                            });
                          }}
                          min={0.5}
                          max={10}
                          step={0.5}
                          disabled={isRunning}
                          className="py-1"
                        />
                        <p className="text-[8px] text-indigo-300/40">
                          Adds {addedFrames} frames → total {config.numFrames} frames ({totalDur.toFixed(1)}s). Longer extends drift further from the source.
                        </p>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Fast Model Path (SSD / NVMe override) */}
          <div className={`${ltxCard("cyan")} p-3 space-y-2`}>
            <button
              type="button"
              className="flex items-center gap-2 w-full text-left"
              onClick={() => setModelPathExpanded(!modelPathExpanded)}
            >
              {modelPathExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-cyan-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-cyan-400" />
              )}
              <HardDrive className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-[11px] text-cyan-400 font-medium">
                Fast Model Path (SSD)
              </span>
              {config.modelBasePath && (
                <span className="text-[9px] text-cyan-300/70 truncate max-w-[200px]">
                  {config.modelBasePath}
                </span>
              )}
            </button>

            {modelPathExpanded && (
              <div className="space-y-2 pt-1">
                <p className="text-[9px] text-cyan-400/60">
                  Point to a fast SSD/NVMe drive with copies of LTX-2 model files for faster loading.
                  Must mirror the ComfyUI folder structure (diffusion_models/, text_encoders/, vae/, loras/, checkpoints/).
                </p>
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-3.5 h-3.5 text-cyan-400/50 flex-shrink-0" />
                  <input
                    type="text"
                    value={modelPathInput}
                    onChange={(e) => setModelPathInput(e.target.value)}
                    placeholder="Path to models directory"
                    className="flex-1 h-7 rounded border border-cyan-500/30 bg-background px-2 text-[10px] font-mono ring-offset-background focus:outline-none focus:ring-1 focus:ring-cyan-500/50 placeholder:text-muted-foreground/40"
                    disabled={isRunning}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px] px-3 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                    onClick={() => validateModelPath(modelPathInput)}
                    disabled={isRunning || modelPathValidation.status === "checking"}
                  >
                    {modelPathValidation.status === "checking" ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      "Apply"
                    )}
                  </Button>
                  {config.modelBasePath && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[10px] px-2 text-destructive/70 hover:text-destructive"
                      onClick={() => {
                        setModelPathInput("");
                        validateModelPath("");
                      }}
                      disabled={isRunning}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  )}
                </div>

                {modelPathValidation.status === "valid" && (
                  <div className="flex items-start gap-1.5 text-[9px] text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <div>
                      <p>{modelPathValidation.message}</p>
                      <p className="text-emerald-400/60 mt-0.5">Restart ComfyUI for changes to take effect.</p>
                    </div>
                  </div>
                )}
                {modelPathValidation.status === "warning" && (
                  <div className="space-y-1">
                    <div className="flex items-start gap-1.5 text-[9px] text-amber-400">
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <div>
                        <p>{modelPathValidation.message}</p>
                        <p className="text-amber-400/60 mt-0.5">Path saved anyway. Restart ComfyUI to apply.</p>
                      </div>
                    </div>
                    {modelPathValidation.files && (
                      <div className="pl-5 space-y-0.5">
                        {modelPathValidation.files.filter((f) => !f.exists).map((f) => (
                          <p key={`${f.subfolder}/${f.filename}`} className="text-[8px] text-amber-400/60">
                            <XCircle className="w-2.5 h-2.5 inline mr-1" />
                            {f.subfolder}/{f.filename} {f.critical ? "(critical)" : "(optional)"}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {modelPathValidation.status === "error" && (
                  <div className="flex items-start gap-1.5 text-[9px] text-red-400">
                    <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <p>{modelPathValidation.message}</p>
                  </div>
                )}

                {modelPathValidation.files && modelPathValidation.status !== "error" && (
                  <div className="rounded border border-cyan-500/10 bg-background/50 p-2 space-y-0.5">
                    <p className="text-[8px] text-cyan-400/50 font-medium mb-1">Model Files:</p>
                    {modelPathValidation.files.map((f) => (
                      <div
                        key={`${f.subfolder}/${f.filename}`}
                        className="flex items-center gap-1.5 text-[8px]"
                      >
                        {f.exists ? (
                          <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400/70" />
                        ) : (
                          <XCircle className="w-2.5 h-2.5 text-red-400/70" />
                        )}
                        <span className={f.exists ? "text-muted-foreground" : "text-red-400/70"}>
                          {f.subfolder}/{f.filename}
                        </span>
                        {f.exists && f.sizeMB > 0 && (
                          <span className="text-muted-foreground/40 ml-auto">
                            {f.sizeMB > 1024 ? `${(f.sizeMB / 1024).toFixed(1)} GB` : `${f.sizeMB} MB`}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Info panel */}
          <div className="rounded-lg border border-border/30 bg-muted/20 p-3 space-y-1">
            <p className="text-[10px] text-muted-foreground font-medium flex items-center gap-1.5">
              <Settings2 className="w-3 h-3" /> Pipeline Info
            </p>
            <p className="text-[9px] text-muted-foreground">
              <strong>Model:</strong> {config.diffusionModel} (FP4/FP8)
            </p>
            <p className="text-[9px] text-muted-foreground">
              <strong>Text Encoder:</strong> {config.textEncoder} (CPU offloaded)
            </p>
            <p className="text-[9px] text-muted-foreground">
              <strong>Pipeline:</strong> {config.pipelineMode === "official" ? "Official Lightricks" : "Alternative Community"}
              {config.pipelineMode === "official" && <> &middot; {config.qualityTier === "full" ? `Full (${config.fullSteps ?? 15} steps)` : config.qualityTier === "test" ? `Test (${config.testVideoSteps ?? 3}+${config.testAudioSteps ?? 5} steps)` : `Distilled (${config.distilledSteps ?? 8} steps)`}</>}
              {config.perfectLoop && config.sourceImage && <> &middot; <span className="text-cyan-400">Loop</span></>}
            </p>
            <p className="text-[9px] text-muted-foreground">
              <strong>Sampler:</strong> {config.pipelineMode === "official"
                ? config.qualityTier === "full"
                  ? `ClownSampler_Beta (${config.fullSampler || "exponential/res_2s"}, η=${(config.fullEta ?? 0.25).toFixed(2)}) · ${config.fullSteps ?? 15} steps`
                  : config.qualityTier === "test"
                  ? `${config.testSampler || "euler"} + ${config.testVideoSteps ?? 3} video steps + ${config.testAudioSteps ?? 5} audio refine steps`
                  : `${config.testSampler || "euler"} + ManualSigmas (${config.distilledSteps ?? 8} distilled steps)`
                : "LCM + 8 distilled sigma steps + BasicGuider"}
            </p>
            <p className="text-[9px] text-muted-foreground">
              <strong>VAE:</strong> Tiled decode ({config.vaeTileSize}px tile, {config.vaeTemporalOverlap}f temporal overlap)
            </p>
            {config.pipelineMode !== "official" && (
              <p className="text-[9px] text-muted-foreground">
                <strong>FF Chunks:</strong> {config.ffChunks} &middot; <strong>Attention:</strong> V{config.videoScale} A{config.audioScale} A→V{config.audioToVideoScale} V→A{config.videoToAudioScale}
              </p>
            )}
            <p className="text-[9px] text-muted-foreground">
              <strong>Audio:</strong> {config.a2vMode ? "A2V (audio-guided video generation)" : config.enableAudio ? "Joint audio-video" : "Disabled"}
            </p>
          </div>
          </div>
        </div>

        {/* WORKFLOW CONTROLS: projected into the modern shell's right-hand
            "Workflow Controls" dock via portal. Falls back to rendering inline
            (as a flex sibling of the center stage) when the dock is collapsed or
            in the Classic UI, so controls are never lost. */}
        <WorkflowControls>
          <div className="space-y-4">
          {/* Prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] text-blue-400 font-medium">Prompt</Label>
              <div className="flex items-center gap-1.5">
                {llmError && (
                  <span className="text-[8px] text-red-400 max-w-[200px] truncate">{llmError}</span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[9px] px-2 text-emerald-400 hover:bg-emerald-500/10"
                  onClick={handleExpandPrompt}
                  disabled={isRunning || llmBusy !== "idle" || !hasPromptContent}
                  title="Expand prompt using Qwen3.5-9B LLM (4-bit, ~5GB VRAM, takes 30-120s)"
                >
                  {llmBusy === "expanding" ? (
                    <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Expanding...</>
                  ) : (
                    <><Wand2 className="w-3 h-3 mr-1" /> Expand Prompt</>
                  )}
                </Button>
                {llmBusy !== "idle" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[9px] px-2 text-red-400 hover:bg-red-500/10"
                    onClick={handleAbortLlm}
                    title="Kill the running LLM process"
                  >
                    <XCircle className="w-3 h-3 mr-1" /> Cancel
                  </Button>
                )}
              </div>
            </div>
            <textarea
              className="w-full min-h-[80px] rounded-md border border-blue-500/30 bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-blue-500/50 resize-y"
              placeholder="A cat jumping over a dog. High quality scene with vivid colors..."
              value={config.prompt}
              onChange={(e) => update("prompt", e.target.value)}
              disabled={isRunning}
            />
          </div>

          {/* Prompt Presets */}
          <div className="flex flex-wrap gap-1.5">
            {LTX2_PROMPT_PRESETS.map((p) => (
              <button
                key={p.label}
                className="px-2 py-1 rounded text-[10px] border border-blue-500/30 text-blue-400/80 hover:bg-blue-500/10 hover:border-blue-500/50 transition-colors disabled:opacity-50"
                onClick={() => update("prompt", p.prompt)}
                disabled={isRunning}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Style Preset + Auto Negative Prompt */}
          <div className={`${ltxCard("purple")} p-3 space-y-2.5`}>
            <div className="flex items-center gap-2">
              <Palette className="w-3.5 h-3.5 text-purple-400" />
              <Label className="text-[11px] text-purple-400 font-medium">Style Preset</Label>
            </div>
            <select
              className="w-full rounded-md border border-purple-500/30 bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-purple-500/50"
              value={config.stylePreset}
              onChange={(e) => update("stylePreset", e.target.value)}
              disabled={isRunning}
            >
              {STYLE_PRESET_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>{opt.label}</option>
              ))}
            </select>
            {config.stylePreset !== "none" && STYLE_PRESETS[config.stylePreset] && (
              <div className="space-y-1.5">
                <p className="text-[9px] text-purple-400/60 leading-relaxed">
                  {STYLE_PRESETS[config.stylePreset].description}
                </p>
                {STYLE_PRESETS[config.stylePreset].cameraAngle && (
                  <div className="flex gap-3 text-[9px] text-purple-400/50">
                    <span>📐 {STYLE_PRESETS[config.stylePreset].cameraAngle}</span>
                    {STYLE_PRESETS[config.stylePreset].cameraMovement && (
                      <span>🎥 {STYLE_PRESETS[config.stylePreset].cameraMovement}</span>
                    )}
                    <span>⏱ {STYLE_PRESETS[config.stylePreset].fps}fps</span>
                  </div>
                )}
              </div>
            )}
            {/* Auto-generated negative prompt preview */}
            <div className="space-y-1">
              <Label className="text-[9px] text-purple-400/50">Auto Negative Prompt</Label>
              <p className="text-[8px] text-muted-foreground/50 leading-relaxed max-h-12 overflow-y-auto">
                {buildNegativePrompt(config.prompt, config.stylePreset)}
              </p>
            </div>
          </div>

          {/* Checkpoint Selector */}
          <div className={`${ltxCard("indigo")} p-3 space-y-2`}>
            <div className="flex items-center gap-2">
              <HardDrive className="w-3.5 h-3.5 text-indigo-400" />
              <Label className="text-[11px] text-indigo-400 font-medium">Diffusion Model</Label>
            </div>
            <select
              className="w-full rounded-md border border-indigo-500/30 bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
              value={config.diffusionModel}
              onChange={(e) => {
                const ckptConfig = getLTX2CheckpointConfig(e.target.value);
                setConfig((prev) => ({ ...prev, ...ckptConfig }));
              }}
              disabled={isRunning}
            >
              {LTX2_CHECKPOINT_PRESETS.map((p) => (
                <option key={p.diffusionModel} value={p.diffusionModel}>
                  {p.label} (v{p.version})
                </option>
              ))}
            </select>
            {(() => {
              const active = LTX2_CHECKPOINT_PRESETS.find(p => p.diffusionModel === config.diffusionModel);
              return active ? (
                <p className="text-[9px] text-indigo-400/60 leading-relaxed">{active.description}</p>
              ) : (
                <p className="text-[9px] text-muted-foreground/50 font-mono truncate">{config.diffusionModel}</p>
              );
            })()}
            {isGGUFModel(config.diffusionModel) && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  GGUF
                </span>
                <span className="text-[9px] text-amber-400/60">
                  Low-VRAM mode: UnetLoaderGGUF + DualCLIPLoaderGGUF
                </span>
              </div>
            )}
            {config.spatioTemporalVAE && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                  ST-VAE
                </span>
                <span className="text-[9px] text-cyan-400/60">
                  Spatio-temporal tiled decode for 1080p+
                </span>
              </div>
            )}
            {config.samplingMode === "tiled" && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  TILED
                </span>
                <span className="text-[9px] text-emerald-400/60">
                  Tiled diffusion sampling ({config.tiledSamplingHTiles}×{config.tiledSamplingVTiles} tiles)
                </span>
              </div>
            )}
            {config.samplingMode === "2stage" && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  2-STAGE
                </span>
                <span className="text-[9px] text-amber-400/60">
                  Generate → {config.twoStageUpscaleFactor ?? 1.5}× upscale → refine (denoise {config.twoStageDenoise ?? 0.15})
                </span>
              </div>
            )}
          </div>

          {/* Official Pipeline Controls (only shown when official pipeline is selected) */}
          {config.pipelineMode === "official" && (
            <div className={`${ltxCard("emerald")} p-3 space-y-2.5`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                  <Label className="text-[11px] text-emerald-400 font-medium">Official Pipeline Settings</Label>
                  {(config.officialAdvanced ?? false) && (
                    <span className="px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-wide bg-orange-500/20 text-orange-300 leading-none">
                      Advanced
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Label className="text-[9px] text-muted-foreground">Advanced</Label>
                  <Switch
                    checked={config.officialAdvanced ?? false}
                    onCheckedChange={(v) => setConfig((prev) => ({
                      ...prev,
                      officialAdvanced: v,
                      // Leaving Advanced snaps back to the stock Lightricks distilled recipe.
                      ...(v ? {} : {
                        qualityTier: prev.qualityTier === "test" ? "distilled" : prev.qualityTier,
                        distilledSteps: 8,
                        testAudioSteps: 0,
                        testSampler: "euler",
                      }),
                    }))}
                    disabled={isRunning}
                    className="scale-75"
                  />
                </div>
              </div>

              {/* Quality Tier */}
              <div className="space-y-1.5">
                <Label className="text-[10px] text-emerald-400/70">Quality Tier</Label>
                <div className="flex items-center bg-muted/30 rounded-md p-0.5">
                  {(((config.officialAdvanced ?? false) ? ["test", "distilled", "full"] : ["distilled", "full"]) as LTX2QualityTier[]).map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        if (t === config.qualityTier) return;
                        setConfig((prev) => ({ ...prev, qualityTier: t, distillLoRAStrength: LTX2_OFFICIAL_LORA_STRENGTH[t] }));
                      }}
                      disabled={isRunning}
                      className={`flex-1 px-3 py-1 text-[10px] font-medium rounded transition-colors ${
                        config.qualityTier === t
                          ? "bg-emerald-500/20 text-emerald-400 shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t === "test" ? "Test" : t === "distilled" ? `Distilled (${config.distilledSteps ?? 8} steps)` : `Full Quality (${config.fullSteps ?? 15} steps)`}
                    </button>
                  ))}
                </div>
                <p className="text-[8px] text-emerald-400/50">
                  {config.qualityTier === "test"
                    ? `Test: ${config.testVideoSteps ?? 3} video + ${config.testAudioSteps ?? 5} audio steps · ${config.testSampler || "euler"} · BasicGuider`
                    : config.qualityTier === "distilled"
                    ? `Fast: ${config.testSampler || "euler"} + ManualSigmas (${config.distilledSteps ?? 8} distilled steps) · BasicGuider`
                    : `High quality: ClownSampler (${config.fullSampler || "exponential/res_2s"}, η=${(config.fullEta ?? 0.25).toFixed(2)}) · ${config.fullSteps ?? 15} steps · MultimodalGuider`}
                </p>
              </div>

              {/* Test Tier Tuning */}
              {config.qualityTier === "test" && (
                <div className="space-y-2 pl-2 border-l-2 border-emerald-500/20">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 space-y-1">
                      <Label className="text-[9px] text-emerald-400/60">Video Steps</Label>
                      <div className="flex items-center gap-2">
                        <Slider min={1} max={8} step={1} value={[config.testVideoSteps ?? 3]} onValueChange={([v]) => update("testVideoSteps", v)} disabled={isRunning} className="flex-1" />
                        <span className="text-[10px] text-emerald-400 font-mono w-4 text-right">{config.testVideoSteps ?? 3}</span>
                      </div>
                    </div>
                    <div className="flex-1 space-y-1">
                      <Label className="text-[9px] text-emerald-400/60">Audio Steps</Label>
                      <div className="flex items-center gap-2">
                        <Slider min={0} max={15} step={1} value={[config.testAudioSteps ?? 5]} onValueChange={([v]) => update("testAudioSteps", v)} disabled={isRunning} className="flex-1" />
                        <span className="text-[10px] text-emerald-400 font-mono w-4 text-right">{config.testAudioSteps ?? 5}</span>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[9px] text-emerald-400/60">Sampler</Label>
                    <select
                      value={config.testSampler || "euler"}
                      onChange={(e) => update("testSampler", e.target.value)}
                      disabled={isRunning}
                      className="w-full rounded-md border border-emerald-500/20 bg-background px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                    >
                      <option value="euler">euler (recommended)</option>
                      <option value="lcm">lcm</option>
                      <option value="euler_ancestral_cfg_pp">euler_ancestral_cfg_pp (original)</option>
                      <option value="dpmpp_2m">dpmpp_2m</option>
                      <option value="res_2s">res_2s (detail, can over-bake)</option>
                      <option value="heun">heun (2nd order)</option>
                    </select>
                  </div>
                  <p className="text-[8px] text-emerald-400/40">Audio steps=0 disables the audio refinement pass</p>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <button
                      onClick={handleApplyMagicSauce}
                      disabled={isRunning}
                      className="flex items-center gap-1 px-2 py-1 text-[9px] font-medium rounded bg-gradient-to-r from-orange-500/20 to-red-500/20 text-orange-300 hover:from-orange-500/30 hover:to-red-500/30 border border-orange-500/30 transition-all disabled:opacity-40"
                      title="Apply tested optimal settings: 5V+8A euler, LoRA 0.75, compression 15"
                    >
                      <Flame className="w-3 h-3" /> Apply Gooner Magic Sauce
                    </button>
                    <button
                      onClick={handleSaveSauce}
                      disabled={isRunning}
                      className="flex items-center gap-1 px-2 py-1 text-[9px] font-medium rounded bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 border border-cyan-500/20 transition-all disabled:opacity-40"
                      title="Save your current settings as a custom preset"
                    >
                      <Save className="w-3 h-3" /> Improve the Sauce (Save Settings)
                    </button>
                    <button
                      onClick={handleLoadSauce}
                      disabled={isRunning || !hasSavedSauce}
                      className="flex items-center gap-1 px-2 py-1 text-[9px] font-medium rounded bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 border border-violet-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      title={hasSavedSauce ? "Load your saved custom settings" : "No saved settings yet, save first!"}
                    >
                      <BookmarkCheck className="w-3 h-3" /> Apply My Sauce (Load Settings)
                    </button>
                  </div>
                </div>
              )}

              {/* Full Quality Tier Tuning */}
              {config.qualityTier === "full" && (
                <div className="space-y-2 pl-2 border-l-2 border-emerald-500/20">
                  <Label className="text-[9px] text-emerald-400/60 font-medium">Full Quality Tier Tuning</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-emerald-400/60">Steps: {config.fullSteps ?? 15}</Label>
                      <Slider min={8} max={30} step={1} value={[config.fullSteps ?? 15]} onValueChange={([v]) => update("fullSteps", v)} disabled={isRunning} />
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-emerald-400/60">Eta: {(config.fullEta ?? 0.25).toFixed(2)}</Label>
                      <Slider min={0} max={1} step={0.05} value={[config.fullEta ?? 0.25]} onValueChange={([v]) => update("fullEta", v)} disabled={isRunning} />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[9px] text-emerald-400/60">Sampler</Label>
                    <select
                      value={config.fullSampler || "exponential/res_2s"}
                      onChange={(e) => update("fullSampler", e.target.value)}
                      disabled={isRunning}
                      className="w-full rounded-md border border-emerald-500/20 bg-background px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                    >
                      <option value="exponential/res_2s">exponential/res_2s (recommended)</option>
                      <option value="res_2s">res_2s</option>
                      <option value="res_2m">res_2m</option>
                      <option value="dpmpp_2m">dpmpp_2m</option>
                      <option value="euler">euler</option>
                      <option value="euler_ancestral">euler_ancestral</option>
                      <option value="heun">heun</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[8px] text-emerald-400/50 hover:text-emerald-400"
                      onClick={() => setFullSchedulerExpanded(!fullSchedulerExpanded)}
                    >
                      {fullSchedulerExpanded ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
                      Scheduler Shift Parameters
                    </button>
                    {fullSchedulerExpanded && (
                      <div className="grid grid-cols-3 gap-2 pt-1">
                        <div className="space-y-0.5">
                          <Label className="text-[8px] text-emerald-400/50">Shift: {(config.schedulerShift ?? 2.05).toFixed(2)}</Label>
                          <Slider min={0.5} max={5.0} step={0.05} value={[config.schedulerShift ?? 2.05]} onValueChange={([v]) => update("schedulerShift", v)} disabled={isRunning} />
                        </div>
                        <div className="space-y-0.5">
                          <Label className="text-[8px] text-emerald-400/50">Base: {(config.schedulerBaseShift ?? 0.95).toFixed(2)}</Label>
                          <Slider min={0.1} max={3.0} step={0.05} value={[config.schedulerBaseShift ?? 0.95]} onValueChange={([v]) => update("schedulerBaseShift", v)} disabled={isRunning} />
                        </div>
                        <div className="space-y-0.5">
                          <Label className="text-[8px] text-emerald-400/50">Terminal: {(config.schedulerTerminal ?? 0.1).toFixed(2)}</Label>
                          <Slider min={0.01} max={0.5} step={0.01} value={[config.schedulerTerminal ?? 0.1]} onValueChange={([v]) => update("schedulerTerminal", v)} disabled={isRunning} />
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      update("fullSteps", 15);
                      update("fullEta", 0.25);
                      update("fullSampler", "exponential/res_2s");
                      update("schedulerShift", 2.05);
                      update("schedulerBaseShift", 0.95);
                      update("schedulerTerminal", 0.1);
                    }}
                    className="text-[8px] text-muted-foreground hover:text-emerald-400 flex items-center gap-0.5"
                  >
                    <RotateCcw className="w-2.5 h-2.5" /> Reset to Lightricks defaults
                  </button>
                </div>
              )}

              {/* Distilled Tier: stock when Advanced off; independent video/audio/sampler when on */}
              {config.qualityTier === "distilled" && (
                (config.officialAdvanced ?? false) ? (
                  <div className="space-y-2 pl-2 border-l-2 border-orange-500/30">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 space-y-1">
                        <Label className="text-[9px] text-emerald-400/60">Video Steps</Label>
                        <div className="flex items-center gap-2">
                          <Slider min={4} max={30} step={1} value={[config.distilledSteps ?? 8]} onValueChange={([v]) => update("distilledSteps", v)} disabled={isRunning} className="flex-1" />
                          <span className="text-[10px] text-emerald-400 font-mono w-5 text-right">{config.distilledSteps ?? 8}</span>
                        </div>
                      </div>
                      <div className="flex-1 space-y-1">
                        <Label className="text-[9px] text-emerald-400/60">Audio Steps</Label>
                        <div className="flex items-center gap-2">
                          <Slider min={0} max={15} step={1} value={[config.testAudioSteps ?? 5]} onValueChange={([v]) => update("testAudioSteps", v)} disabled={isRunning} className="flex-1" />
                          <span className="text-[10px] text-emerald-400 font-mono w-5 text-right">{config.testAudioSteps ?? 5}</span>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[9px] text-emerald-400/60">Sampler</Label>
                      <select
                        value={config.testSampler || "euler"}
                        onChange={(e) => update("testSampler", e.target.value)}
                        disabled={isRunning}
                        className="w-full rounded-md border border-emerald-500/20 bg-background px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
                      >
                        <option value="euler">euler (recommended)</option>
                        <option value="lcm">lcm</option>
                        <option value="euler_ancestral_cfg_pp">euler_ancestral_cfg_pp (original)</option>
                        <option value="dpmpp_2m">dpmpp_2m</option>
                        <option value="res_2s">res_2s (detail, can over-bake)</option>
                        <option value="heun">heun (2nd order)</option>
                      </select>
                    </div>
                    <p className="text-[8px] text-orange-400/50">
                      Off-spec: {config.distilledSteps ?? 8} steps{(config.testAudioSteps ?? 5) > 0 ? ` + ${config.testAudioSteps ?? 5}-step audio refine pass` : ""}. Stock distilled is 8 steps, single pass. Audio steps = 0 disables the refine pass.
                    </p>
                  </div>
                ) : (
                  <p className="text-[8px] text-emerald-400/40 pl-2 border-l-2 border-emerald-500/20">
                    Stock Lightricks distilled recipe (8 steps, euler, single pass). Turn on <span className="text-orange-300 font-semibold">Advanced</span> to tune video/audio steps and sampler.
                  </p>
                )
              )}

              {/* Negative Prompt */}
              <div className="space-y-1.5">
                <Label className="text-[10px] text-emerald-400/70">Negative Prompt</Label>
                <textarea
                  className="w-full min-h-[40px] rounded-md border border-emerald-500/20 bg-background px-2 py-1.5 text-[11px] ring-offset-background placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 resize-y"
                  placeholder="What to avoid in the output..."
                  value={config.negativePrompt}
                  onChange={(e) => update("negativePrompt", e.target.value)}
                  disabled={isRunning}
                />
              </div>
            </div>
          )}

          {/* Audio toggle */}
          <div className="flex gap-4 items-center py-2 border-t border-b border-border/50">
            <div className="flex items-center gap-2">
              {config.enableAudio ? (
                <Volume2 className="w-4 h-4 text-blue-400" />
              ) : (
                <VolumeX className="w-4 h-4 text-muted-foreground" />
              )}
              <Label className="text-[11px]">Audio</Label>
              <Switch
                checked={config.enableAudio}
                onCheckedChange={(v) => update("enableAudio", v)}
                disabled={isRunning}
              />
            </div>
            <span className="text-[9px] text-muted-foreground">
              8 steps &middot; LCM sampler &middot; No CFG (distilled)
            </span>
          </div>

          {/* Settings Grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* Resolution */}
            <div className="space-y-1.5 col-span-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Label className="text-[10px] text-muted-foreground">
                    Resolution ({config.width}×{config.height})
                  </Label>
                  {/* Sampling Mode selector: anti-repetition strategies for 1080p+ */}
                  <select
                    value={config.samplingMode || "standard"}
                    onChange={(e) => update("samplingMode", e.target.value as "standard" | "tiled" | "2stage")}
                    disabled={isRunning}
                    className={`text-[8px] font-bold px-1 py-0.5 rounded border transition-colors bg-background cursor-pointer ${
                      config.samplingMode === "tiled"
                        ? "text-emerald-400 border-emerald-500/30"
                        : config.samplingMode === "2stage"
                          ? "text-amber-400 border-amber-500/30"
                          : "text-muted-foreground/70 border-border/50"
                    }`}
                    title="Sampling mode. Standard: normal single-pass. Tiled: spatial tile splitting (fixes 2×2 repetition). 2-Stage: generate small → upscale → refine."
                  >
                    <option value="standard">STANDARD</option>
                    <option value="tiled">TILED</option>
                    <option value="2stage">2-STAGE</option>
                  </select>
                </div>
                <button
                  type="button"
                  className="text-[9px] text-blue-400/70 hover:text-blue-400"
                  onClick={() => setCustomRes(!customRes)}
                >
                  {customRes ? "Use presets" : "Custom"}
                </button>
              </div>
              {!customRes ? (
                <select
                  value={
                    activeRes
                      ? `${config.width}x${config.height}`
                      : "custom"
                  }
                  onChange={(e) => {
                    if (e.target.value === "custom") {
                      setCustomRes(true);
                      return;
                    }
                    const preset = LTX2_RESOLUTION_PRESETS.find(
                      (p) => `${p.width}x${p.height}` === e.target.value
                    );
                    if (preset) {
                      const resDefaults = getResolutionScaledDefaults(preset.width, preset.height);
                      setConfig((prev) => ({
                        ...prev,
                        width: preset.width,
                        height: preset.height,
                        ...resDefaults,
                      }));
                    }
                  }}
                  className="w-full h-8 rounded border border-border bg-background px-2 text-[11px]"
                  disabled={isRunning}
                >
                  {LTX2_RESOLUTION_PRESETS.map((p) => (
                    <option
                      key={`${p.width}x${p.height}`}
                      value={`${p.width}x${p.height}`}
                    >
                      {p.label}
                    </option>
                  ))}
                  {!activeRes && (
                    <option value="custom">
                      Custom ({config.width}×{config.height})
                    </option>
                  )}
                </select>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Label className="text-[9px] text-muted-foreground/70">Width</Label>
                      <input
                        type="number"
                        value={config.width}
                        onChange={(e) => {
                          const v = Math.max(128, Math.round((parseInt(e.target.value) || 512) / 32) * 32);
                          update("width", v);
                        }}
                        step={32}
                        min={128}
                        max={1920}
                        className="w-full h-7 rounded border border-border bg-background px-2 text-[11px] font-mono"
                        disabled={isRunning}
                      />
                    </div>
                    <div className="flex-1">
                      <Label className="text-[9px] text-muted-foreground/70">Height</Label>
                      <input
                        type="number"
                        value={config.height}
                        onChange={(e) => {
                          const v = Math.max(128, Math.round((parseInt(e.target.value) || 512) / 32) * 32);
                          update("height", v);
                        }}
                        step={32}
                        min={128}
                        max={1920}
                        className="w-full h-7 rounded border border-border bg-background px-2 text-[11px] font-mono"
                        disabled={isRunning}
                      />
                    </div>
                  </div>
                  {(config.width % 32 !== 0 || config.height % 32 !== 0) && (
                    <p className="text-[8px] text-amber-400 flex items-center gap-1">
                      <AlertTriangle className="w-2.5 h-2.5" />
                      Values should be multiples of 32 for best quality
                    </p>
                  )}
                  {(config.width > 1280 || config.height > 1280) && (
                    <p className="text-[8px] text-amber-400 flex items-center gap-1">
                      <AlertTriangle className="w-2.5 h-2.5" />
                      Resolutions above 720p require significant VRAM and may cause weight streaming
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      const resDefaults = getResolutionScaledDefaults(config.width, config.height);
                      setConfig((prev) => ({ ...prev, ...resDefaults }));
                    }}
                    className="text-[8px] text-blue-400/70 hover:text-blue-400 flex items-center gap-0.5"
                    disabled={isRunning}
                  >
                    <RotateCcw className="w-2.5 h-2.5" /> Auto-scale VAE/FF settings for {config.width}×{config.height}
                  </button>
                </div>
              )}
            </div>

            {/* Frames */}
            <div className="space-y-1.5">
              <Label className="text-[10px] text-muted-foreground">
                Frames (
                {(config.numFrames / config.frameRate).toFixed(1)}s @{" "}
                {config.frameRate}fps)
              </Label>
              <select
                value={LTX2_FRAME_PRESETS.some(p => p.value === config.numFrames) ? config.numFrames : "custom"}
                onChange={(e) => {
                  if (e.target.value !== "custom") update("numFrames", parseInt(e.target.value));
                }}
                className="w-full h-8 rounded border border-border bg-background px-2 text-[11px]"
                disabled={isRunning}
              >
                {LTX2_FRAME_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.value} (~{(p.value / config.frameRate).toFixed(1)}s)
                  </option>
                ))}
                <option value="custom">Custom...</option>
              </select>
              <div className="flex gap-2">
                <div className="flex-1">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={rawFrameInput}
                    onChange={(e) => setRawFrameInput(e.target.value)}
                    onBlur={() => {
                      const raw = parseInt(rawFrameInput);
                      if (!isNaN(raw) && raw > 0) {
                        const snapped = Math.round((raw - 1) / 8) * 8 + 1;
                        const clamped = Math.max(9, snapped);
                        update("numFrames", clamped);
                      } else {
                        setRawFrameInput(String(config.numFrames));
                      }
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    className="w-full h-7 rounded border border-border bg-background px-2 text-[10px]"
                    disabled={isRunning}
                    title="Exact frame count (snaps to 8n+1 on blur, e.g. 25, 33, 41...)"
                  />
                  <span className="text-[8px] text-muted-foreground/50">frames (8n+1)</span>
                </div>
                <div className="flex-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={rawSecInput}
                    onChange={(e) => setRawSecInput(e.target.value)}
                    onBlur={() => {
                      const secs = parseFloat(rawSecInput);
                      if (!isNaN(secs) && secs > 0) {
                        const rawFrames = Math.round(secs * config.frameRate);
                        const snapped = Math.round((rawFrames - 1) / 8) * 8 + 1;
                        const clamped = Math.max(9, snapped);
                        update("numFrames", clamped);
                      } else {
                        setRawSecInput((config.numFrames / config.frameRate).toFixed(1));
                      }
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    className="w-full h-7 rounded border border-border bg-background px-2 text-[10px]"
                    disabled={isRunning}
                    title="Duration in seconds (auto-snaps to valid frame count on blur)"
                  />
                  <span className="text-[8px] text-muted-foreground/50">seconds</span>
                </div>
              </div>
            </div>

            {/* FPS */}
            <div className="space-y-1.5">
              <Label className="text-[10px] text-muted-foreground">
                Frame Rate: {config.frameRate} fps
              </Label>
              <Slider
                value={[config.frameRate]}
                onValueChange={([v]) => update("frameRate", v)}
                min={8}
                max={120}
                step={1}
                disabled={isRunning}
              />
              <div className="flex gap-1 flex-wrap">
                {[24, 30, 60, 120].map((fps) => (
                  <button
                    key={fps}
                    className={`px-1.5 py-0.5 rounded text-[8px] border transition-colors ${
                      config.frameRate === fps
                        ? "bg-blue-600 border-blue-500 text-white"
                        : "border-border text-muted-foreground hover:border-blue-500/50"
                    }`}
                    onClick={() => update("frameRate", fps)}
                    disabled={isRunning}
                  >
                    {fps}fps
                  </button>
                ))}
              </div>
            </div>

            {/* Seed */}
            <div className="space-y-1.5 col-span-2">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] text-muted-foreground">
                  Seed
                </Label>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] text-muted-foreground">
                    Random
                  </span>
                  <Switch
                    checked={config.randomSeed}
                    onCheckedChange={(v) => update("randomSeed", v)}
                    className="scale-75"
                    disabled={isRunning}
                  />
                </div>
              </div>
              {!config.randomSeed && (
                <input
                  type="number"
                  value={config.seed}
                  onChange={(e) =>
                    update("seed", parseInt(e.target.value) || 0)
                  }
                  className="w-full h-8 rounded border border-border bg-background px-2 text-[11px]"
                  disabled={isRunning}
                />
              )}
            </div>
          </div>

          {/* VRAM & Render Time Estimation */}
          {vramEstimate && (
            <div className={`rounded-lg border p-3 space-y-1.5 ${
              vramEstimate.risk === "safe"
                ? "border-emerald-500/20 bg-emerald-500/5"
                : vramEstimate.risk === "warning"
                  ? "border-amber-500/20 bg-amber-500/5"
                  : "border-red-500/20 bg-red-500/5"
            }`}>
              <div className="flex items-center justify-between">
                <span className={`text-[10px] font-medium flex items-center gap-1.5 ${
                  vramEstimate.risk === "safe"
                    ? "text-emerald-400"
                    : vramEstimate.risk === "warning"
                      ? "text-amber-400"
                      : "text-red-400"
                }`}>
                  <Cpu className="w-3.5 h-3.5" /> VRAM Estimate
                </span>
                <span className={`text-[10px] font-medium flex items-center gap-1.5 ${
                  vramEstimate.risk === "safe"
                    ? "text-emerald-400"
                    : vramEstimate.risk === "warning"
                      ? "text-amber-400"
                      : "text-red-400"
                }`}>
                  <Timer className="w-3.5 h-3.5" /> {vramEstimate.renderTimeLabel}
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-muted/50 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    vramEstimate.risk === "safe"
                      ? "bg-emerald-500"
                      : vramEstimate.risk === "warning"
                        ? "bg-amber-500"
                        : "bg-red-500"
                  }`}
                  style={{
                    width: `${Math.min(100, (vramEstimate.estimatedPeakGB / vramEstimate.totalVramGB) * 100)}%`,
                  }}
                />
              </div>
              <p className={`text-[9px] ${
                vramEstimate.risk === "safe"
                  ? "text-emerald-400/80"
                  : vramEstimate.risk === "warning"
                    ? "text-amber-400/80"
                    : "text-red-400/80"
              }`}>
                {vramEstimate.message}
              </p>
              {vramEstimate.suggestion && (
                <p className="text-[8px] text-muted-foreground">
                  <Info className="w-2.5 h-2.5 inline mr-0.5" />
                  {vramEstimate.suggestion}
                </p>
              )}
            </div>
          )}

          {/* Source Image (I2V) */}
          <div className={`${ltxCard("blue")} p-3 space-y-2`}>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-blue-400 font-medium flex items-center gap-1.5">
                <ImageIcon className="w-3.5 h-3.5" /> Source Image (Image-to-Video)
              </span>
              {config.sourceImage && (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[9px] px-2 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={handleDescribeImage}
                    disabled={isRunning || llmBusy !== "idle"}
                    title="Describe this image using Qwen2.5-VL vision model (loads ~15GB, takes 30-60s)"
                  >
                    {llmBusy === "describing" ? (
                      <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Describing...</>
                    ) : (
                      <><Sparkles className="w-3 h-3 mr-1" /> Describe Image</>
                    )}
                  </Button>
                  {llmBusy === "describing" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[9px] px-2 text-red-400 hover:bg-red-500/10"
                      onClick={handleAbortLlm}
                      title="Kill the running LLM process"
                    >
                      <XCircle className="w-3 h-3 mr-1" /> Cancel
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[10px] px-2 text-destructive"
                    onClick={() => {
                      update("sourceImage", "");
                      setSourcePreview(null);
                      clearEndFrame();
                    }}
                  >
                    <X className="w-3 h-3 mr-1" /> Remove
                  </Button>
                </div>
              )}
            </div>
            {sourcePreview ? (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sourcePreview}
                  alt="Source"
                  className="max-h-32 rounded border border-border/50"
                />
              </div>
            ) : (
              <label
                className="flex items-center justify-center gap-2 w-full py-4 rounded-md border border-dashed border-blue-500/30 text-xs text-blue-400/70 hover:bg-blue-500/5 hover:border-blue-500/50 cursor-pointer transition-colors"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const f = e.dataTransfer.files?.[0];
                  if (f && f.type.startsWith("image/")) {
                    const reader = new FileReader();
                    reader.onload = () => {
                      const dataUrl = reader.result as string;
                      update("sourceImage", dataUrl);
                      setSourcePreview(dataUrl);
                    };
                    reader.readAsDataURL(f);
                  }
                }}
              >
                <Upload className="w-3.5 h-3.5" /> Upload image for I2V (optional,
                leave empty for T2V)
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleSourceImage}
                  disabled={isRunning}
                />
              </label>
            )}
          </div>

          {/* Guide Frames (keyframe guidance at specific times) */}
          {config.pipelineMode === "official" && (
            <div className={`${ltxCard("teal")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-teal-400 font-medium flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5" /> Guide Frames
                  <span className="text-[8px] text-teal-400/50 ml-0.5">pin images at specific times</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[10px] px-2 text-teal-400 hover:bg-teal-500/10"
                  onClick={addGuideFrame}
                  disabled={isRunning}
                >
                  <Plus className="w-3 h-3 mr-1" /> Add Guide Frame
                </Button>
              </div>

              {extraGuideFrames.length === 0 && (
                <p className="text-[9px] text-teal-400/50">
                  Add keyframe images to guide generation at specific moments. Each guide
                  steers the video toward that image at the specified time.
                </p>
              )}

              {extraGuideFrames.map((gf, idx) => (
                <div
                  key={gf.id}
                  className="rounded-md border border-teal-500/15 bg-teal-500/5 p-2.5 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-teal-400/80 font-medium">
                      Guide #{idx + 1}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 p-0 text-destructive hover:bg-red-500/10"
                      onClick={() => removeGuideFrame(gf.id)}
                      disabled={isRunning}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>

                  {/* Image upload area */}
                  {gf.previewUrl ? (
                    <div className="flex items-start gap-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={gf.previewUrl}
                        alt={`Guide ${idx + 1}`}
                        className="h-16 w-auto rounded border border-teal-500/20 bg-black/20 object-contain"
                      />
                      <div className="flex-1 space-y-1.5">
                        {/* Frame / Time linked inputs */}
                        <div className="grid grid-cols-2 gap-1.5">
                          <div className="space-y-0.5">
                            <Label className="text-[8px] text-teal-400/60">Frame</Label>
                            <input
                              type="number"
                              min={0}
                              max={config.numFrames - 1}
                              value={gf.frameIdx}
                              onChange={(e) => {
                                const f = Math.max(0, Math.min(config.numFrames - 1, parseInt(e.target.value) || 0));
                                updateGuideFrame(gf.id, { frameIdx: f });
                              }}
                              disabled={isRunning}
                              className="w-full rounded border border-teal-500/20 bg-background px-1.5 py-0.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-teal-500/40"
                            />
                          </div>
                          <div className="space-y-0.5">
                            <Label className="text-[8px] text-teal-400/60">Time (s)</Label>
                            <input
                              type="number"
                              min={0}
                              max={((config.numFrames - 1) / config.frameRate).toFixed(2)}
                              step={0.01}
                              value={(gf.frameIdx / config.frameRate).toFixed(2)}
                              onChange={(e) => {
                                const t = parseFloat(e.target.value) || 0;
                                const f = Math.max(0, Math.min(config.numFrames - 1, Math.round(t * config.frameRate)));
                                updateGuideFrame(gf.id, { frameIdx: f });
                              }}
                              disabled={isRunning}
                              className="w-full rounded border border-teal-500/20 bg-background px-1.5 py-0.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-teal-500/40"
                            />
                          </div>
                        </div>
                        {/* Strength */}
                        <div className="flex items-center gap-2">
                          <Label className="text-[8px] text-teal-400/60 whitespace-nowrap">Str</Label>
                          <Slider
                            value={[gf.strength]}
                            onValueChange={([v]) => updateGuideFrame(gf.id, { strength: v })}
                            min={0}
                            max={1}
                            step={0.05}
                            disabled={isRunning}
                            className="flex-1"
                          />
                          <span className="text-[9px] text-muted-foreground font-mono w-7 text-right">
                            {gf.strength.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <label
                      className="flex items-center justify-center gap-2 w-full py-2.5 rounded-md border border-dashed border-teal-500/25 text-[10px] text-teal-400/60 hover:bg-teal-500/5 hover:border-teal-500/40 cursor-pointer transition-colors"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const f = e.dataTransfer.files?.[0];
                        if (f && f.type.startsWith("image/")) handleGuideFrameImage(gf.id, f);
                      }}
                    >
                      <Upload className="w-3 h-3" /> Drop image or click
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleGuideFrameImage(gf.id, f);
                          e.target.value = "";
                        }}
                        disabled={isRunning}
                      />
                    </label>
                  )}

                  {!gf.previewUrl && (
                    <div className="grid grid-cols-2 gap-1.5">
                      <div className="space-y-0.5">
                        <Label className="text-[8px] text-teal-400/60">Frame</Label>
                        <input
                          type="number"
                          min={0}
                          max={config.numFrames - 1}
                          value={gf.frameIdx}
                          onChange={(e) => {
                            const f = Math.max(0, Math.min(config.numFrames - 1, parseInt(e.target.value) || 0));
                            updateGuideFrame(gf.id, { frameIdx: f });
                          }}
                          disabled={isRunning}
                          className="w-full rounded border border-teal-500/20 bg-background px-1.5 py-0.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-teal-500/40"
                        />
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[8px] text-teal-400/60">Time (s)</Label>
                        <input
                          type="number"
                          min={0}
                          max={((config.numFrames - 1) / config.frameRate).toFixed(2)}
                          step={0.01}
                          value={(gf.frameIdx / config.frameRate).toFixed(2)}
                          onChange={(e) => {
                            const t = parseFloat(e.target.value) || 0;
                            const f = Math.max(0, Math.min(config.numFrames - 1, Math.round(t * config.frameRate)));
                            updateGuideFrame(gf.id, { frameIdx: f });
                          }}
                          disabled={isRunning}
                          className="w-full rounded border border-teal-500/20 bg-background px-1.5 py-0.5 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-teal-500/40"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* End Frame (guidance): only shown when source image is set AND Perfect Loop is off */}
          {config.sourceImage && !config.perfectLoop && (
            <div className={`${ltxCard("emerald")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5" /> End Frame (guidance)
                  <span className="text-[8px] text-emerald-400/50 ml-1">optional: steers motion toward this frame</span>
                </span>
                {endFrameFile && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[10px] px-2 text-destructive"
                    onClick={clearEndFrame}
                    disabled={isRunning}
                  >
                    <X className="w-3 h-3 mr-1" /> Remove
                  </Button>
                )}
              </div>
              {endFramePreview ? (
                <>
                  <div className="flex justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={endFramePreview}
                      alt="End frame"
                      className="max-h-28 rounded border border-emerald-500/20 bg-black/20"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-emerald-400/70">
                        Start Frame Strength: {startFrameStrength.toFixed(2)}
                      </Label>
                      <Slider
                        min={0}
                        max={1}
                        step={0.05}
                        value={[startFrameStrength]}
                        onValueChange={([v]) => setStartFrameStrength(v)}
                        disabled={isRunning}
                      />
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-emerald-400/70">
                        End Frame Strength: {endFrameStrength.toFixed(2)}
                      </Label>
                      <Slider
                        min={0}
                        max={1}
                        step={0.05}
                        value={[endFrameStrength]}
                        onValueChange={([v]) => setEndFrameStrength(v)}
                        disabled={isRunning}
                      />
                    </div>
                  </div>
                  <p className="text-[8px] text-emerald-400/40 leading-snug">
                    Lower strength = softer guidance. Try 0.5–0.7 for end frame to slow motion toward the target pose.
                  </p>
                </>
              ) : (
                <label
                  className="flex items-center justify-center gap-2 w-full py-3 rounded-md border border-dashed border-emerald-500/30 text-xs text-emerald-400/70 hover:bg-emerald-500/5 hover:border-emerald-500/50 cursor-pointer transition-colors"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const f = e.dataTransfer.files?.[0];
                    if (f && f.type.startsWith("image/")) handleEndFrameUpload(f);
                  }}
                >
                  <Upload className="w-3.5 h-3.5" /> Upload end frame (optional, steers final frame)
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleEndFrameUpload(f);
                      e.target.value = "";
                    }}
                    disabled={isRunning}
                  />
                </label>
              )}
            </div>
          )}

          {/* Perfect Loop: only shown when source image is set */}
          {config.sourceImage && (
            <div className={`${ltxCard("cyan")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!config.perfectLoop}
                    onChange={(e) => update("perfectLoop", e.target.checked)}
                    disabled={isRunning}
                    className="rounded border-cyan-500/40 bg-background"
                  />
                  <span className="text-[11px] text-cyan-400 font-medium flex items-center gap-1.5">
                    <Repeat className="w-3.5 h-3.5" /> Perfect Loop
                  </span>
                </label>
                {config.perfectLoop && (
                  <span className="text-[8px] text-cyan-400/50 font-mono">
                    end strength: {(config.perfectLoopEndStrength ?? 0.85).toFixed(2)}
                  </span>
                )}
              </div>
              {config.perfectLoop && (
                <div className="space-y-1.5 pl-2 border-l-2 border-cyan-500/20">
                  <p className="text-[8px] text-cyan-400/50 leading-snug">
                    Injects the source image as both the first and last frame guide, so the video seamlessly loops back to the starting point. Use cyclical motion prompts for best results.
                  </p>
                  <div className="space-y-0.5">
                    <Label className="text-[9px] text-cyan-400/70">
                      End Frame Strength: {(config.perfectLoopEndStrength ?? 0.85).toFixed(2)}
                    </Label>
                    <Slider
                      min={0.5}
                      max={1.0}
                      step={0.05}
                      value={[config.perfectLoopEndStrength ?? 0.85]}
                      onValueChange={([v]) => update("perfectLoopEndStrength", v)}
                      disabled={isRunning}
                    />
                    <p className="text-[8px] text-cyan-400/40">
                      Lower = softer landing (more natural motion). 0.85 recommended. 1.0 = exact match.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Prompt Relay (Timeline Prompt Scheduling) ── */}
          <div className={`${ltxCard("teal")} p-3 space-y-2`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="w-3.5 h-3.5 text-teal-400" />
                <Label className="text-[11px] text-teal-400 font-medium cursor-pointer" htmlFor="promptRelay">
                  Prompt Timeline
                </Label>
              </div>
              <Switch
                id="promptRelay"
                checked={config.promptRelay ?? false}
                onCheckedChange={(v) => {
                  update("promptRelay", v);
                  // Initialize with 2 segments when first enabled
                  if (v && (!config.promptRelaySegments || config.promptRelaySegments.length === 0)) {
                    update("promptRelaySegments", [
                      { text: "", weight: 1 },
                      { text: "", weight: 1 },
                    ]);
                  }
                }}
                disabled={isRunning}
              />
            </div>
            <p className="text-[9px] text-muted-foreground">
              Split your prompt into time segments. Each segment&apos;s text (including LoRA triggers) only affects its portion of the video.
            </p>

            {config.promptRelay && (
              <div className="space-y-2 pt-1">
                {/* Global prompt */}
                <div className="space-y-1">
                  <Label className="text-[9px] text-teal-300/80">Global Prompt (anchors entire video)</Label>
                  <textarea
                    value={config.promptRelayGlobal ?? ""}
                    onChange={(e) => update("promptRelayGlobal", e.target.value)}
                    placeholder="Scene description, character, lighting, quality... (leave blank to use main prompt)"
                    rows={3}
                    className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs resize-y min-h-[3rem]"
                    disabled={isRunning}
                  />
                </div>

                {/* Timeline segments */}
                <div className="space-y-1.5">
                  <Label className="text-[9px] text-teal-300/80">Timeline Segments</Label>
                  {(config.promptRelaySegments ?? []).map((seg, i) => {
                    // Derive which enabled LoRAs have triggers (user-defined, registry, or built-in map)
                    const lorasWithTriggers = config.userLoras
                      .filter(l => l.enabled && l.name)
                      .map(l => {
                        const trigger = l.triggerWord?.trim() || getTriggerForLora(l.name);
                        return trigger ? { name: l.name, trigger } : null;
                      })
                      .filter(Boolean) as { name: string; trigger: string }[];

                    return (
                    <div key={i} className="rounded border border-teal-500/10 bg-background p-2 space-y-1.5">
                      <div className="flex gap-1.5 items-start">
                        <span className="text-[9px] text-teal-400/60 font-mono mt-1 w-4 flex-shrink-0">{i + 1}</span>
                        <textarea
                          value={seg.text}
                          onChange={(e) => {
                            const segs = [...(config.promptRelaySegments ?? [])];
                            segs[i] = { ...segs[i], text: e.target.value };
                            update("promptRelaySegments", segs);
                          }}
                          placeholder={`Segment ${i + 1} prompt (include LoRA triggers here to activate in this segment)`}
                          rows={3}
                          className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs resize-y min-h-[3.5rem]"
                          disabled={isRunning}
                        />
                        <div className="flex flex-col items-center gap-0.5 w-12 flex-shrink-0">
                          <Label className="text-[8px] text-muted-foreground">Weight</Label>
                          <input
                            type="number"
                            value={seg.weight}
                            onChange={(e) => {
                              const segs = [...(config.promptRelaySegments ?? [])];
                              segs[i] = { ...segs[i], weight: Math.max(1, parseInt(e.target.value) || 1) };
                              update("promptRelaySegments", segs);
                            }}
                            min={1}
                            max={100}
                            className="w-10 h-5 rounded border border-input bg-background px-1 text-center text-[9px] font-mono"
                            disabled={isRunning}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const segs = (config.promptRelaySegments ?? []).filter((_, j) => j !== i);
                            update("promptRelaySegments", segs);
                          }}
                          className="text-destructive/50 hover:text-destructive p-0.5 mt-1"
                          disabled={isRunning || (config.promptRelaySegments ?? []).length <= 2}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                      {/* Per-segment LoRA toggle chips: click to insert/remove trigger word */}
                      {lorasWithTriggers.length > 0 && (
                        <div className="flex flex-wrap gap-1 pl-5">
                          {lorasWithTriggers.map((lora) => {
                            const trigger = lora.trigger;
                            const isActive = seg.text.toLowerCase().includes(trigger.toLowerCase());
                            const loraShort = lora.name.replace(/\.(safetensors|ckpt|pt)$/i, "").split(/[/\\]/).pop() ?? lora.name;
                            return (
                              <button
                                key={lora.name}
                                type="button"
                                disabled={isRunning}
                                onClick={() => {
                                  const segs = [...(config.promptRelaySegments ?? [])];
                                  if (isActive) {
                                    // Remove trigger from this segment's text
                                    const regex = new RegExp(`\\s*,?\\s*${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,?`, "gi");
                                    segs[i] = { ...segs[i], text: segs[i].text.replace(regex, "").replace(/^,\s*/, "").replace(/,\s*$/, "").trim() };
                                  } else {
                                    // Add trigger to this segment's text
                                    const current = segs[i].text.trim();
                                    segs[i] = { ...segs[i], text: current ? `${current}, ${trigger}` : trigger };
                                  }
                                  update("promptRelaySegments", segs);
                                }}
                                className={`px-1.5 py-0.5 rounded text-[8px] font-medium border transition-colors ${
                                  isActive
                                    ? "bg-purple-500/20 border-purple-500/40 text-purple-300"
                                    : "bg-muted/30 border-border/30 text-muted-foreground/60 hover:border-purple-500/30 hover:text-purple-300/80"
                                }`}
                                title={`${isActive ? "Remove" : "Add"} trigger "${trigger}" ${isActive ? "from" : "to"} segment ${i + 1}\nLoRA: ${loraShort}`}
                              >
                                {loraShort.length > 16 ? loraShort.slice(0, 14) + "…" : loraShort}
                                {isActive ? " ✓" : ""}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => {
                      const segs = [...(config.promptRelaySegments ?? []), { text: "", weight: 1 }];
                      update("promptRelaySegments", segs);
                    }}
                    disabled={isRunning || (config.promptRelaySegments ?? []).length >= 8}
                    className="w-full rounded border border-dashed border-teal-500/20 py-1 text-[9px] text-muted-foreground hover:text-teal-300 hover:border-teal-500/40 transition-colors disabled:opacity-50"
                  >
                    <Plus className="w-3 h-3 inline mr-0.5" />
                    Add Segment ({(config.promptRelaySegments ?? []).length}/8)
                  </button>
                </div>

                {/* Epsilon (boundary sharpness) */}
                <div className="flex items-center gap-2">
                  <Label className="text-[9px] text-muted-foreground w-20 flex-shrink-0">Boundary</Label>
                  <Slider
                    min={0.001}
                    max={0.9}
                    step={0.01}
                    value={[config.promptRelayEpsilon ?? 0.001]}
                    onValueChange={([v]) => update("promptRelayEpsilon", v)}
                    className="flex-1"
                    disabled={isRunning}
                  />
                  <span className="text-[9px] font-mono w-10 text-right">
                    {(config.promptRelayEpsilon ?? 0.001) < 0.01 ? "Sharp" : (config.promptRelayEpsilon ?? 0.001) > 0.3 ? "Soft" : "Med"}
                  </span>
                </div>

                <p className="text-[8px] text-muted-foreground/60 italic">
                  Weights are proportional (e.g. 1:2:1 = 25%/50%/25% of video time).
                  Include LoRA trigger words only in segments where you want the LoRA effect.
                  Requires ComfyUI-PromptRelay installed.
                </p>
              </div>
            )}
          </div>

          {/* LoRA section */}
          <div className={`${ltxCard("purple")} p-3 space-y-2`}>
            <button
              type="button"
              className="flex items-center gap-2 w-full text-left"
              onClick={() => setLorasExpanded(!lorasExpanded)}
            >
              {lorasExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-purple-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-purple-400" />
              )}
              <Wand2 className="w-3.5 h-3.5 text-purple-400" />
              <span className="text-[11px] text-purple-400 font-medium">
                LoRAs
              </span>
              {config.userLoras.filter((l) => l.enabled && l.name).length > 0 && (
                <span className="text-[9px] text-purple-300">
                  ({config.userLoras.filter((l) => l.enabled && l.name).length} active)
                </span>
              )}
            </button>

            {lorasExpanded && (
              <div className="space-y-2 pt-1">
                {/* Distill LoRA file + strength */}
                <div className="rounded border border-purple-500/10 bg-background p-2 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-purple-300/80">
                      Distill LoRA
                    </Label>
                    <button
                      type="button"
                      onClick={() => {
                        const defaults = getLTX2CheckpointConfig(config.diffusionModel);
                        update("distillLoRA", defaults.distillLoRA ?? LTX23_MODEL_DEFAULTS.distillLoRA);
                        update("distillLoRAStrength", defaults.distillLoRAStrength ?? 0.75);
                      }}
                      className="text-muted-foreground/40 hover:text-muted-foreground"
                      title="Reset to recommended for current checkpoint"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  </div>
                  <select
                    className="w-full rounded-md border border-purple-500/20 bg-background px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                    value={config.distillLoRA}
                    onChange={(e) => update("distillLoRA", e.target.value)}
                    disabled={isRunning}
                  >
                    <option value="">None (standalone distilled model)</option>
                    {availableLoras
                      .filter((l) => l.toLowerCase().includes("distill"))
                      .map((l) => (
                        <option key={l} value={l}>{l.replace(/^LTX-2\.3\\/, "").replace(/\.safetensors$/, "")}</option>
                      ))}
                  </select>
                  <div className="flex items-center gap-2">
                    <Label className="text-[9px] text-purple-300/60 shrink-0">Strength</Label>
                    <Slider
                      min={0}
                      max={1.5}
                      step={0.05}
                      value={[config.distillLoRAStrength]}
                      onValueChange={([v]) => update("distillLoRAStrength", v)}
                      className="flex-1"
                      disabled={isRunning || !config.distillLoRA}
                    />
                    <input
                      type="number"
                      value={config.distillLoRAStrength.toFixed(2)}
                      onChange={(e) =>
                        update("distillLoRAStrength", parseFloat(e.target.value) || 0)
                      }
                      step={0.05}
                      min={0}
                      max={1.5}
                      className="w-14 h-6 rounded border border-input bg-background px-1 text-center text-[10px] font-mono"
                      disabled={isRunning || !config.distillLoRA}
                    />
                  </div>
                  <p className="text-[8px] text-muted-foreground/60">
                    {config.distillLoRA
                      ? "Enables distilled 8-step sampling. cond_safe variants recommended for I2V/finetunes."
                      : "No distill LoRA: model must have distillation baked in (standalone distilled or GGUF)."}
                  </p>
                </div>

                {availableLoras.length === 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    No LoRAs found in ComfyUI/models/loras/
                  </p>
                )}

                {config.userLoras.map((lora, index) => (
                  <div
                    key={index}
                    className={`rounded border p-2 space-y-1.5 ${
                      lora.enabled
                        ? "border-purple-500/20 bg-background"
                        : "border-border/30 bg-muted/20 opacity-60"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={lora.enabled}
                        onCheckedChange={(v) => updateLora(index, { enabled: v })}
                        className="scale-75"
                        disabled={isRunning}
                      />
                      <LoraSelect
                        value={lora.name}
                        options={availableLoras}
                        onChange={(name) => updateLora(index, { name })}
                        disabled={isRunning}
                        compatMode="ltx2"
                      />
                      <button
                        type="button"
                        onClick={() => removeLora(index)}
                        className="text-destructive/50 hover:text-destructive p-0.5"
                        disabled={isRunning}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {lora.enabled && lora.name && (
                      <>
                        {/* Strength slider: hidden when "Apply to All" schedule mode is active */}
                        {(config.loraScheduleMode ?? "none") !== "all" && (
                          <div className={`flex items-center gap-2 pl-1 ${lora.scheduled ? "opacity-40 pointer-events-none" : ""}`}>
                            <Label className="text-[10px] text-muted-foreground w-14 flex-shrink-0">
                              {lora.scheduled ? "(scheduled)" : "Strength"}
                            </Label>
                            <Slider
                              min={-2}
                              max={2}
                              step={0.05}
                              value={[lora.strengthModel]}
                              onValueChange={([v]) =>
                                updateLora(index, { strengthModel: v })
                              }
                              className="flex-1"
                              disabled={isRunning || !!lora.scheduled}
                            />
                            <DecimalInput
                              value={lora.strengthModel}
                              onChange={(v) => updateLora(index, { strengthModel: v })}
                              min={-2}
                              max={2}
                              decimals={2}
                              className="w-14 h-6 rounded border border-input bg-background px-1 text-center text-[10px] font-mono"
                              disabled={isRunning || !!lora.scheduled}
                            />
                          </div>
                        )}
                        {/* Trigger word input for Prompt Timeline per-segment chips */}
                        {config.promptRelay && (
                          <div className="flex items-center gap-2 pl-1">
                            <Label className="text-[10px] text-teal-400/70 w-14 flex-shrink-0">Trigger</Label>
                            <input
                              type="text"
                              value={lora.triggerWord ?? ""}
                              onChange={(e) => updateLora(index, { triggerWord: e.target.value })}
                              placeholder={getTriggerForLora(lora.name) || "type trigger word..."}
                              className="flex-1 h-6 rounded border border-input bg-background px-2 text-[10px]"
                              disabled={isRunning}
                            />
                          </div>
                        )}
                        {/* Per-LoRA scheduling controls (only in "per_lora" mode) */}
                        {(config.loraScheduleMode ?? "none") === "per_lora" && (
                          <>
                            <div className="flex items-center gap-2 pl-1 pt-1">
                              <Switch
                                checked={lora.scheduled ?? false}
                                onCheckedChange={(v) => updateLora(index, { scheduled: v })}
                                className="scale-[0.6]"
                                disabled={isRunning}
                              />
                              <span className="text-[9px] text-amber-400/80">
                                <Clock className="w-3 h-3 inline mr-0.5" />
                                Schedule across steps
                              </span>
                            </div>
                            {lora.scheduled && (
                              <div className="space-y-1.5 pl-1 pt-1 border-l-2 border-amber-500/20 ml-2">
                                <div className="flex items-center gap-2">
                                  <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">Start %</Label>
                                  <Slider min={0} max={1} step={0.05} value={[lora.scheduleStartPercent ?? 0]}
                                    onValueChange={([v]) => updateLora(index, { scheduleStartPercent: v })}
                                    className="flex-1" disabled={isRunning} />
                                  <span className="text-[9px] font-mono w-8 text-right">{((lora.scheduleStartPercent ?? 0) * 100).toFixed(0)}%</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">End %</Label>
                                  <Slider min={0} max={1} step={0.05} value={[lora.scheduleEndPercent ?? 1]}
                                    onValueChange={([v]) => updateLora(index, { scheduleEndPercent: v })}
                                    className="flex-1" disabled={isRunning} />
                                  <span className="text-[9px] font-mono w-8 text-right">{((lora.scheduleEndPercent ?? 1) * 100).toFixed(0)}%</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">Str. start</Label>
                                  <Slider min={0} max={2} step={0.05} value={[lora.scheduleStrengthStart ?? 0]}
                                    onValueChange={([v]) => updateLora(index, { scheduleStrengthStart: v })}
                                    className="flex-1" disabled={isRunning} />
                                  <span className="text-[9px] font-mono w-8 text-right">{(lora.scheduleStrengthStart ?? 0).toFixed(2)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">Str. end</Label>
                                  <Slider min={0} max={2} step={0.05} value={[lora.scheduleStrengthEnd ?? 1]}
                                    onValueChange={([v]) => updateLora(index, { scheduleStrengthEnd: v })}
                                    className="flex-1" disabled={isRunning} />
                                  <span className="text-[9px] font-mono w-8 text-right">{(lora.scheduleStrengthEnd ?? 1).toFixed(2)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">Interp</Label>
                                  <select
                                    value={lora.scheduleInterpolation ?? "linear"}
                                    onChange={(e) => updateLora(index, { scheduleInterpolation: e.target.value as "linear" | "ease_in" | "ease_out" })}
                                    className="flex-1 h-5 rounded border border-input bg-background px-1 text-[9px]"
                                    disabled={isRunning}
                                  >
                                    <option value="linear">Linear</option>
                                    <option value="ease_in">Ease In (slow→fast)</option>
                                    <option value="ease_out">Ease Out (fast→slow)</option>
                                  </select>
                                </div>
                                <p className="text-[8px] text-muted-foreground/60 italic">
                                  Values are absolute LoRA strength (not a multiplier).
                                  0%=first step, 100%=last step.
                                </p>
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                ))}

                {config.userLoras.length < 5 && availableLoras.length > 0 && (
                  <button
                    type="button"
                    onClick={addLora}
                    disabled={isRunning}
                    className="w-full rounded border border-dashed border-purple-500/20 py-1.5 text-[10px] text-muted-foreground hover:text-purple-300 hover:border-purple-500/40 transition-colors disabled:opacity-50"
                  >
                    <Plus className="w-3 h-3 inline mr-1" />
                    {config.userLoras.length === 0
                      ? "Add a LoRA (e.g. style, camera, motion)"
                      : `Add another LoRA (${config.userLoras.length}/5)`}
                  </button>
                )}

                {/* Trigger word guidance for selected LoRAs */}
                <LoRATriggerGuide
                  selectedLoras={config.userLoras.filter(l => l.enabled).map(l => l.name)}
                  onInsertToPrompt={(text) => {
                    const current = config.prompt.trim();
                    const sep = current ? ", " : "";
                    update("prompt", current + sep + text);
                  }}
                />

                {/* CivitAI trigger word scanner utility */}
                <LoRATriggerScanner />

                {/* Schedule Mode selector + global schedule panel */}
                {config.userLoras.filter(l => l.enabled && l.name).length > 0 && (
                  <div className="rounded border border-amber-500/15 bg-amber-500/5 p-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Clock className="w-3 h-3 text-amber-400" />
                      <Label className="text-[9px] text-amber-400/90 font-medium">Step Scheduling</Label>
                      <select
                        value={config.loraScheduleMode ?? "none"}
                        onChange={(e) => update("loraScheduleMode", e.target.value as "none" | "per_lora" | "all")}
                        className="ml-auto h-5 rounded border border-input bg-background px-1 text-[9px]"
                        disabled={isRunning}
                      >
                        <option value="none">Off</option>
                        <option value="per_lora">Per-LoRA</option>
                        <option value="all">Apply to All</option>
                      </select>
                    </div>
                    {(config.loraScheduleMode ?? "none") === "all" && (
                      <div className="space-y-1.5 pt-1 border-l-2 border-amber-500/20 ml-1 pl-2">
                        <p className="text-[8px] text-amber-300/70">Same schedule applied to all enabled LoRAs:</p>
                        <div className="flex items-center gap-2">
                          <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">Start %</Label>
                          <Slider min={0} max={1} step={0.05} value={[config.globalScheduleStartPercent ?? 0]}
                            onValueChange={([v]) => update("globalScheduleStartPercent", v)}
                            className="flex-1" disabled={isRunning} />
                          <span className="text-[9px] font-mono w-8 text-right">{((config.globalScheduleStartPercent ?? 0) * 100).toFixed(0)}%</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">End %</Label>
                          <Slider min={0} max={1} step={0.05} value={[config.globalScheduleEndPercent ?? 1]}
                            onValueChange={([v]) => update("globalScheduleEndPercent", v)}
                            className="flex-1" disabled={isRunning} />
                          <span className="text-[9px] font-mono w-8 text-right">{((config.globalScheduleEndPercent ?? 1) * 100).toFixed(0)}%</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">Str. start</Label>
                          <Slider min={0} max={2} step={0.05} value={[config.globalScheduleStrengthStart ?? 0]}
                            onValueChange={([v]) => update("globalScheduleStrengthStart", v)}
                            className="flex-1" disabled={isRunning} />
                          <span className="text-[9px] font-mono w-8 text-right">{(config.globalScheduleStrengthStart ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">Str. end</Label>
                          <Slider min={0} max={2} step={0.05} value={[config.globalScheduleStrengthEnd ?? 1]}
                            onValueChange={([v]) => update("globalScheduleStrengthEnd", v)}
                            className="flex-1" disabled={isRunning} />
                          <span className="text-[9px] font-mono w-8 text-right">{(config.globalScheduleStrengthEnd ?? 1).toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-[9px] text-muted-foreground w-16 flex-shrink-0">Interp</Label>
                          <select
                            value={config.globalScheduleInterpolation ?? "linear"}
                            onChange={(e) => update("globalScheduleInterpolation", e.target.value as "linear" | "ease_in" | "ease_out")}
                            className="flex-1 h-5 rounded border border-input bg-background px-1 text-[9px]"
                            disabled={isRunning}
                          >
                            <option value="linear">Linear</option>
                            <option value="ease_in">Ease In (slow→fast)</option>
                            <option value="ease_out">Ease Out (fast→slow)</option>
                          </select>
                        </div>
                        <p className="text-[8px] text-muted-foreground/60 italic">
                          Strength values are absolute (e.g. 0.70 = LoRA at 70% effect).
                          Ramps across denoising steps, not video time.
                        </p>
                      </div>
                    )}
                    {(config.loraScheduleMode ?? "none") === "per_lora" && (
                      <p className="text-[8px] text-muted-foreground/60 italic">
                        Toggle scheduling individually on each LoRA above.
                      </p>
                    )}
                  </div>
                )}

                <p className="text-[9px] text-muted-foreground">
                  Model-only weights (no CLIP). Distill LoRA applied automatically.
                </p>
              </div>
            )}
          </div>

          {/* Advanced Quality Controls */}
          <div className={`${ltxCard("orange")} p-3 space-y-2`}>
            <button
              type="button"
              className="flex items-center gap-2 w-full text-left"
              onClick={() => setAdvancedExpanded(!advancedExpanded)}
            >
              {advancedExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-orange-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-orange-400" />
              )}
              <Settings2 className="w-3.5 h-3.5 text-orange-400" />
              <span className="text-[11px] text-orange-400 font-medium">
                Advanced Quality Controls
              </span>
            </button>

            {advancedExpanded && (
              <div className="space-y-3 pt-1">
                {/* Attention Tuner */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] text-orange-400/80 font-medium">
                    Cross-Modal Attention Scaling
                  </Label>
                  <p className="text-[8px] text-muted-foreground/60">
                    Controls how strongly video and audio modalities attend to each other during diffusion.
                    These affect motion intensity and audio-video coherence. Alternative pipeline only.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Video Scale</Label>
                      <p className="text-[7px] text-muted-foreground/50">Self-attention weight for video. Higher = sharper frames, slightly less motion fluidity.</p>
                      <div className="flex items-center gap-1">
                        <Slider min={0} max={2} step={0.05} value={[config.videoScale]} onValueChange={([v]) => update("videoScale", v)} className="flex-1" disabled={isRunning} />
                        <span className="text-[9px] font-mono w-8 text-right text-muted-foreground">{config.videoScale.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Audio Scale</Label>
                      <p className="text-[7px] text-muted-foreground/50">Self-attention weight for audio. Set to 0 when audio generation is unwanted (e.g. music video with existing track).</p>
                      <div className="flex items-center gap-1">
                        <Slider min={0} max={2} step={0.05} value={[config.audioScale]} onValueChange={([v]) => update("audioScale", v)} className="flex-1" disabled={isRunning} />
                        <span className="text-[9px] font-mono w-8 text-right text-muted-foreground">{config.audioScale.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Audio→Video</Label>
                      <p className="text-[7px] text-muted-foreground/50">How much audio influences video generation. Lower reduces audio bleed artifacts in visuals.</p>
                      <div className="flex items-center gap-1">
                        <Slider min={0} max={2} step={0.05} value={[config.audioToVideoScale]} onValueChange={([v]) => update("audioToVideoScale", v)} className="flex-1" disabled={isRunning} />
                        <span className="text-[9px] font-mono w-8 text-right text-muted-foreground">{config.audioToVideoScale.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Video→Audio</Label>
                      <p className="text-[7px] text-muted-foreground/50">How much video influences audio generation. Lower decouples audio from visual content.</p>
                      <div className="flex items-center gap-1">
                        <Slider min={0} max={2} step={0.05} value={[config.videoToAudioScale]} onValueChange={([v]) => update("videoToAudioScale", v)} className="flex-1" disabled={isRunning} />
                        <span className="text-[9px] font-mono w-8 text-right text-muted-foreground">{config.videoToAudioScale.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      update("videoScale", 1.0);
                      update("audioScale", 1.0);
                      update("audioToVideoScale", 1.0);
                      update("videoToAudioScale", 1.0);
                    }}
                    className="text-[8px] text-muted-foreground hover:text-orange-400 flex items-center gap-0.5"
                  >
                    <RotateCcw className="w-2.5 h-2.5" /> Reset all to 1.0
                  </button>
                </div>

                {/* I2V Source Image Strength, all tiers, shown when source image set */}
                {config.sourceImage && (
                  <div className="space-y-1">
                    <Label className="text-[10px] text-orange-400/80 font-medium">
                      I2V Source Strength: {(config.i2vStrength ?? 1.0).toFixed(2)}
                    </Label>
                    <p className="text-[8px] text-muted-foreground/60">
                      How strongly the source image anchors generation. 1.0 = maximum fidelity, lower = more creative freedom.
                    </p>
                    <div className="flex items-center gap-1">
                      <Slider min={0.1} max={1.0} step={0.05} value={[config.i2vStrength ?? 1.0]} onValueChange={([v]) => update("i2vStrength", v)} className="flex-1" disabled={isRunning} />
                      <button type="button" onClick={() => update("i2vStrength", 1.0)} className="text-[8px] text-muted-foreground hover:text-orange-400 px-1"><RotateCcw className="w-2.5 h-2.5" /></button>
                    </div>
                  </div>
                )}

                {/* CFG / Rescale / STG, full quality tier only (test/distilled use BasicGuider, no CFG) */}
                {config.qualityTier === "full" && config.pipelineMode === "official" && (
                  <div className="space-y-1.5">
                    <Label className="text-[10px] text-orange-400/80 font-medium">
                      Classifier-Free Guidance (Full Tier)
                    </Label>
                    <p className="text-[8px] text-muted-foreground/60">
                      CFG controls prompt adherence (higher = stricter). Rescale prevents over-saturation. STG adds structural coherence.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-0.5">
                        <Label className="text-[9px] text-muted-foreground/70">Video CFG: {(config.videoCfg ?? LTX2_OFFICIAL_GUIDER_PARAMS.video.cfg).toFixed(1)}</Label>
                        <Slider min={1} max={15} step={0.5} value={[config.videoCfg ?? LTX2_OFFICIAL_GUIDER_PARAMS.video.cfg]} onValueChange={([v]) => update("videoCfg", v)} disabled={isRunning} />
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[9px] text-muted-foreground/70">Audio CFG: {(config.audioCfg ?? LTX2_OFFICIAL_GUIDER_PARAMS.audio.cfg).toFixed(1)}</Label>
                        <Slider min={1} max={15} step={0.5} value={[config.audioCfg ?? LTX2_OFFICIAL_GUIDER_PARAMS.audio.cfg]} onValueChange={([v]) => update("audioCfg", v)} disabled={isRunning} />
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[9px] text-muted-foreground/70">Video Rescale: {(config.videoCfgRescale ?? LTX2_OFFICIAL_GUIDER_PARAMS.video.rescale).toFixed(2)}</Label>
                        <Slider min={0} max={1} step={0.05} value={[config.videoCfgRescale ?? LTX2_OFFICIAL_GUIDER_PARAMS.video.rescale]} onValueChange={([v]) => update("videoCfgRescale", v)} disabled={isRunning} />
                      </div>
                      <div className="space-y-0.5">
                        <Label className="text-[9px] text-muted-foreground/70">Audio Rescale: {(config.audioCfgRescale ?? LTX2_OFFICIAL_GUIDER_PARAMS.audio.rescale).toFixed(2)}</Label>
                        <Slider min={0} max={1} step={0.05} value={[config.audioCfgRescale ?? LTX2_OFFICIAL_GUIDER_PARAMS.audio.rescale]} onValueChange={([v]) => update("audioCfgRescale", v)} disabled={isRunning} />
                      </div>
                      <div className="col-span-2 space-y-0.5">
                        <Label className="text-[9px] text-muted-foreground/70">STG (Spatio-Temporal Guidance): {(config.stg ?? 0.0).toFixed(2)}</Label>
                        <Slider min={0} max={1} step={0.05} value={[config.stg ?? 0.0]} onValueChange={([v]) => update("stg", v)} disabled={isRunning} />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        update("videoCfg", LTX2_OFFICIAL_GUIDER_PARAMS.video.cfg);
                        update("audioCfg", LTX2_OFFICIAL_GUIDER_PARAMS.audio.cfg);
                        update("videoCfgRescale", LTX2_OFFICIAL_GUIDER_PARAMS.video.rescale);
                        update("audioCfgRescale", LTX2_OFFICIAL_GUIDER_PARAMS.audio.rescale);
                        update("stg", 0.0);
                      }}
                      className="text-[8px] text-muted-foreground hover:text-orange-400 flex items-center gap-0.5"
                    >
                      <RotateCcw className="w-2.5 h-2.5" /> Reset to Lightricks defaults
                    </button>
                  </div>
                )}

                {/* VAE Tiling */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] text-orange-400/80 font-medium">
                    VAE Decode Tiling
                  </Label>
                  <p className="text-[8px] text-muted-foreground/60">
                    Controls how the VAE decodes latent frames into pixels. Spatial tiles handle resolution,
                    temporal settings handle motion across frames. <strong className="text-orange-400/80">Temporal settings are critical for motion
                    quality at higher resolutions</strong>: increase them proportionally when going above 720p.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Tile Size: {config.vaeTileSize}px</Label>
                      <p className="text-[7px] text-muted-foreground/50">Spatial tile size in pixels. Larger tiles see more context per decode. 512 for ≤720p, 1024 for 1080p+.</p>
                      <Slider min={256} max={1024} step={64} value={[config.vaeTileSize]} onValueChange={([v]) => update("vaeTileSize", v)} disabled={isRunning} />
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Overlap: {config.vaeOverlap}px</Label>
                      <p className="text-[7px] text-muted-foreground/50">Pixel overlap between spatial tiles. Higher reduces visible seams. 64 is generally sufficient.</p>
                      <Slider min={16} max={128} step={8} value={[config.vaeOverlap]} onValueChange={([v]) => update("vaeOverlap", v)} disabled={isRunning} />
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Temporal Size: {config.vaeTemporalSize}f</Label>
                      <p className="text-[7px] text-orange-400/70">Frames decoded per temporal chunk. Directly affects motion smoothness: too low causes jerky, unnatural movement. 64 for ≤720p, 128 for 1080p+.</p>
                      <Slider min={16} max={256} step={8} value={[config.vaeTemporalSize]} onValueChange={([v]) => update("vaeTemporalSize", v)} disabled={isRunning} />
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Temporal Overlap: {config.vaeTemporalOverlap}f</Label>
                      <p className="text-[7px] text-orange-400/70">Frame overlap between temporal chunks. Higher = smoother transitions between chunks, less motion stutter. 16 for ≤720p, 32 for 1080p+.</p>
                      <Slider min={4} max={64} step={4} value={[config.vaeTemporalOverlap]} onValueChange={([v]) => update("vaeTemporalOverlap", v)} disabled={isRunning} />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      update("vaeTileSize", 512);
                      update("vaeOverlap", 64);
                      update("vaeTemporalSize", 64);
                      update("vaeTemporalOverlap", 16);
                    }}
                    className="text-[8px] text-muted-foreground hover:text-orange-400 flex items-center gap-0.5"
                  >
                    <RotateCcw className="w-2.5 h-2.5" /> Reset to Alternative defaults
                  </button>
                </div>

                {/* Chunk Feedforward */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] text-orange-400/80 font-medium">
                    Feedforward Chunking
                  </Label>
                  <p className="text-[8px] text-muted-foreground/60">
                    Splits transformer feedforward layers into chunks to reduce peak VRAM. More chunks = less VRAM but
                    slightly slower. Essential for 1080p+ rendering. Does not affect quality.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Chunks: {config.ffChunks}</Label>
                      <p className="text-[7px] text-muted-foreground/50">Number of feedforward chunks. 4 for ≤720p, 6–8 for 1080p. Higher saves VRAM at cost of speed.</p>
                      <Slider min={1} max={8} step={1} value={[config.ffChunks]} onValueChange={([v]) => update("ffChunks", v)} disabled={isRunning} />
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground/70">Dim Threshold: {config.ffDimThreshold}</Label>
                      <p className="text-[7px] text-muted-foreground/50">Only chunk layers with hidden dim above this threshold. Lower = more layers chunked = less VRAM.</p>
                      <Slider min={1024} max={8192} step={512} value={[config.ffDimThreshold]} onValueChange={([v]) => update("ffDimThreshold", v)} disabled={isRunning} />
                    </div>
                  </div>
                </div>

                {/* I2V Compression */}
                {config.sourceImage && (
                  <div className="space-y-1">
                    <Label className="text-[10px] text-orange-400/80 font-medium">
                      I2V Image Compression: {config.imgCompression}
                    </Label>
                    <p className="text-[8px] text-muted-foreground/60">
                      Controls how aggressively the source image is compressed into the latent space.
                      Lower values (10–20) preserve fine detail from the source image. Higher values (30–50)
                      give the model more creative freedom to reinterpret the scene. Default 28 is a balanced midpoint.
                    </p>
                    <Slider min={0} max={100} step={1} value={[config.imgCompression]} onValueChange={([v]) => update("imgCompression", v)} disabled={isRunning} />
                  </div>
                )}

              </div>
            )}
          </div>

          {/* Turbo Upscale (half-res → 2x latent upscale → refine) */}
          {config.modelVersion === "2.3" && (
            <div className={`${ltxCard("orange")} p-3 space-y-2`}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-orange-400 font-medium flex items-center gap-1.5">
                  <Rocket className="w-3.5 h-3.5" /> Turbo Upscale
                </span>
                <Switch
                  checked={!!config.turboUpscale}
                  onCheckedChange={(v) => update("turboUpscale", v)}
                  className="scale-75"
                  disabled={isRunning}
                />
              </div>
              {config.turboUpscale && (
                <div className="space-y-2.5">
                  {/* Upscale method selector */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-orange-400/80">Upscale Method</Label>
                    </div>
                    <select
                      value={config.turboUpscaleMethod ?? TURBO_UPSCALE_DEFAULTS.method}
                      onChange={(e) => update("turboUpscaleMethod", e.target.value as "latent" | "rtx_vsr")}
                      className="w-full h-7 text-[10px] px-2 rounded bg-background border border-orange-500/20 text-orange-200"
                      disabled={isRunning}
                    >
                      <option value="latent">Latent Upscaler + Refinement (recommended)</option>
                      <option value="rtx_vsr">RTX Video Super Resolution (fast, no refinement)</option>
                    </select>
                  </div>
                  <p className="text-[9px] text-orange-400/60">
                    {(config.turboUpscaleMethod ?? TURBO_UPSCALE_DEFAULTS.method) === "rtx_vsr"
                      ? "Pixel-only upscale: fast but no detail generation. Model never sees full resolution: fine for previews, not for final output."
                      : `Lightricks two-stage: latent 2× upscale + ${config.turboUpscaleRefineSteps ?? TURBO_UPSCALE_DEFAULTS.refineSteps}-step refinement pass. Model generates new detail at full resolution.`}
                  </p>
                  {(() => {
                    const half = getTurboHalfResolution(config.width, config.height);
                    return (
                      <p className="text-[9px] text-orange-300/80 font-mono">
                        {config.width}×{config.height} → sample at {half.width}×{half.height} → upscale back to {config.width}×{config.height}
                      </p>
                    );
                  })()}

                  {/* Latent method settings (hidden when RTX VSR selected) */}
                  {(config.turboUpscaleMethod ?? TURBO_UPSCALE_DEFAULTS.method) === "latent" && (<>
                  {/* Refinement steps */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[10px] text-orange-400/80">Refine Steps</Label>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {config.turboUpscaleRefineSteps ?? TURBO_UPSCALE_DEFAULTS.refineSteps}
                      </span>
                    </div>
                    <Slider
                      value={[config.turboUpscaleRefineSteps ?? TURBO_UPSCALE_DEFAULTS.refineSteps]}
                      onValueChange={([v]) => update("turboUpscaleRefineSteps", v)}
                      min={1}
                      max={8}
                      step={1}
                      disabled={isRunning}
                      className="py-1"
                    />
                  </div>

                  {/* I2V reconditioning strength (only when source image is set) */}
                  {config.sourceImage && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[10px] text-orange-400/80">Recondition Strength</Label>
                        <span className="text-[10px] text-muted-foreground font-mono">
                          {(config.turboUpscaleRefineStrength ?? TURBO_UPSCALE_DEFAULTS.refineStrength).toFixed(2)}
                        </span>
                      </div>
                      <Slider
                        value={[config.turboUpscaleRefineStrength ?? TURBO_UPSCALE_DEFAULTS.refineStrength]}
                        onValueChange={([v]) => update("turboUpscaleRefineStrength", v)}
                        min={0}
                        max={1}
                        step={0.05}
                        disabled={isRunning}
                        className="py-1"
                      />
                      <p className="text-[8px] text-orange-400/40">
                        Re-inject source image after upscale. 1.0 = strong anchoring, lower = more freedom.
                      </p>
                    </div>
                  )}

                  {/* Advanced upscaler controls: Slice 1c additions for tuning when results are poor */}
                  <details className="text-[10px] text-orange-400/80">
                    <summary className="cursor-pointer select-none flex items-center gap-1">
                      <Settings2 className="w-3 h-3" /> Advanced Upscaler Controls
                    </summary>
                    <div className="mt-2 space-y-2.5 pl-3 border-l border-orange-500/20">
                      {/* Upscaler model selector */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] text-orange-400/80">Upscaler Model</Label>
                          {config.turboUpscaleModel && config.turboUpscaleModel !== TURBO_UPSCALE_DEFAULTS.model && (
                            <Button
                              size="sm" variant="ghost"
                              className="h-5 text-[9px] px-1.5 text-orange-400/70 hover:text-orange-300"
                              onClick={() => update("turboUpscaleModel", TURBO_UPSCALE_DEFAULTS.model)}
                              disabled={isRunning}
                            >
                              <RotateCcw className="w-3 h-3 mr-1" /> Default
                            </Button>
                          )}
                        </div>
                        <input
                          type="text"
                          value={config.turboUpscaleModel ?? TURBO_UPSCALE_DEFAULTS.model}
                          onChange={(e) => update("turboUpscaleModel", e.target.value)}
                          placeholder={TURBO_UPSCALE_DEFAULTS.model}
                          className="w-full h-7 text-[10px] px-2 rounded bg-background border border-orange-500/20 text-orange-200 font-mono"
                          disabled={isRunning}
                        />
                        <p className="text-[8px] text-orange-400/40">
                          Filename in <code>latent_upscale_models/</code>. Currently only one official Lightricks model exists for LTX 2.3.
                        </p>
                      </div>

                      {/* Sampler picker */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] text-orange-400/80">Refine Sampler</Label>
                          {config.turboUpscaleSampler && config.turboUpscaleSampler !== TURBO_UPSCALE_DEFAULTS.sampler && (
                            <Button
                              size="sm" variant="ghost"
                              className="h-5 text-[9px] px-1.5 text-orange-400/70 hover:text-orange-300"
                              onClick={() => update("turboUpscaleSampler", TURBO_UPSCALE_DEFAULTS.sampler)}
                              disabled={isRunning}
                            >
                              <RotateCcw className="w-3 h-3 mr-1" /> Default
                            </Button>
                          )}
                        </div>
                        <select
                          value={config.turboUpscaleSampler ?? TURBO_UPSCALE_DEFAULTS.sampler}
                          onChange={(e) => update("turboUpscaleSampler", e.target.value)}
                          className="w-full h-7 text-[10px] px-2 rounded bg-background border border-orange-500/20 text-orange-200"
                          disabled={isRunning}
                        >
                          <option value="euler_cfg_pp">euler_cfg_pp (default, CFG-aware)</option>
                          <option value="euler_ancestral_cfg_pp">euler_ancestral_cfg_pp (Lightricks official)</option>
                          <option value="euler">euler (vanilla)</option>
                          <option value="euler_ancestral">euler_ancestral (more variation)</option>
                          <option value="dpmpp_2m">dpmpp_2m (smooth)</option>
                          <option value="dpmpp_2m_sde">dpmpp_2m_sde (smooth, stochastic)</option>
                          <option value="dpmpp_3m_sde">dpmpp_3m_sde (sharp, stochastic)</option>
                          <option value="heun">heun (2nd order, 2× NFE)</option>
                          <option value="lms">lms (linear multistep)</option>
                        </select>
                        <p className="text-[8px] text-orange-400/40">
                          If upscale results look soft/blurry, try <code>euler_ancestral_cfg_pp</code>. If over-sharpened/noisy, try <code>dpmpp_2m</code>.
                        </p>
                      </div>

                      {/* Custom sigma schedule */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] text-orange-400/80">Custom Sigmas</Label>
                          {config.turboUpscaleCustomSigmas && (
                            <Button
                              size="sm" variant="ghost"
                              className="h-5 text-[9px] px-1.5 text-orange-400/70 hover:text-orange-300"
                              onClick={() => update("turboUpscaleCustomSigmas", "")}
                              disabled={isRunning}
                            >
                              <RotateCcw className="w-3 h-3 mr-1" /> Default
                            </Button>
                          )}
                        </div>
                        <input
                          type="text"
                          value={config.turboUpscaleCustomSigmas ?? ""}
                          onChange={(e) => update("turboUpscaleCustomSigmas", e.target.value)}
                          placeholder={TURBO_UPSCALE_DEFAULTS.refineSigmas.join(", ")}
                          className="w-full h-7 text-[10px] px-2 rounded bg-background border border-orange-500/20 text-orange-200 font-mono"
                          disabled={isRunning}
                        />
                        <p className="text-[8px] text-orange-400/40">
                          Comma-separated sigma schedule, descending to 0. Empty = auto from Refine Steps.
                          Default: <code>{TURBO_UPSCALE_DEFAULTS.refineSigmas.join(", ")}</code>.
                          Lower starting sigma (e.g. <code>0.6, 0.4, 0.2, 0.0</code>) = subtler refinement; higher (e.g. <code>0.95, 0.7, 0.4, 0.15, 0.0</code>) = more aggressive.
                        </p>
                      </div>
                    </div>
                  </details>
                  </>)}
                </div>
              )}
            </div>
          )}

          {/* Direct Sampling Toggle + Normalization Weights */}
          <div className={`${ltxCard("sky")} p-3 space-y-2`}>
            {/* Direct Sampling toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-sky-400" />
                <Label className="text-[11px] text-sky-400 font-medium cursor-pointer" htmlFor="directSampling">
                  Direct Sampling
                </Label>
              </div>
              <input
                id="directSampling"
                type="checkbox"
                checked={!!config.directSampling}
                onChange={(e) => update("directSampling", e.target.checked)}
                disabled={isRunning}
                className="h-3.5 w-3.5 rounded border-sky-500/40 accent-sky-500"
              />
            </div>
            <p className="text-[8px] text-muted-foreground/60 leading-relaxed">
              Bypasses the NormalizingSampler and uses SamplerCustomAdvanced directly.
              Skips per-step audio/video normalization, may produce cleaner results but
              can be less stable. When enabled, normalization weights below are ignored.
            </p>

            {/* Live Preview toggle */}
            <div className="flex items-center justify-between pt-1 border-t border-sky-500/10">
              <div className="flex items-center gap-2">
                <Eye className="w-3.5 h-3.5 text-sky-400" />
                <Label className="text-[11px] text-sky-400 font-medium cursor-pointer" htmlFor="livePreview">
                  Live Preview (Tiny VAE)
                </Label>
              </div>
              <input
                id="livePreview"
                type="checkbox"
                checked={!!config.livePreview}
                onChange={(e) => update("livePreview", e.target.checked)}
                disabled={isRunning || (!!livePreviewSupport && !livePreviewSupport.supported)}
                title={livePreviewSupport && !livePreviewSupport.supported
                  ? `Unavailable: ${!livePreviewSupport.nodePresent ? "the KJNodes LTX2SamplingPreviewOverride node" : "the Tiny VAE (taeltx2_3.safetensors)"} is not installed in ComfyUI.`
                  : undefined}
                className="h-3.5 w-3.5 rounded border-sky-500/40 accent-sky-500 disabled:opacity-40 disabled:cursor-not-allowed"
              />
            </div>
            {livePreviewSupport && !livePreviewSupport.supported ? (
              <p className="text-[8px] text-amber-400/80 leading-relaxed flex items-start gap-1">
                <AlertTriangle className="w-2.5 h-2.5 mt-0.5 shrink-0" />
                Live preview is unavailable: {!livePreviewSupport.nodePresent && !livePreviewSupport.vaePresent
                  ? "the Tiny VAE (taeltx2_3.safetensors) and the KJNodes preview node are"
                  : !livePreviewSupport.nodePresent
                    ? "the KJNodes preview node is"
                    : "the Tiny VAE (taeltx2_3.safetensors) is"} not installed in ComfyUI.
              </p>
            ) : (
              <p className="text-[8px] text-muted-foreground/60 leading-relaxed">
                Uses a ~23MB Tiny VAE for real-time preview frames during sampling.
                Adds minor VRAM overhead: disable if running near VRAM capacity.
              </p>
            )}
            {config.livePreview && (
              <div className="space-y-0.5 pl-2 border-l-2 border-sky-500/20">
                <Label className="text-[9px] text-sky-400/70">Preview Rate: every {config.previewRate ?? 8} steps</Label>
                <div className="flex items-center gap-2">
                  <Slider min={1} max={16} step={1} value={[config.previewRate ?? 8]} onValueChange={([v]) => update("previewRate", v)} disabled={isRunning} className="flex-1" />
                  <span className="text-[9px] font-mono text-sky-400 w-4 text-right">{config.previewRate ?? 8}</span>
                </div>
                <p className="text-[8px] text-muted-foreground/50">Lower = more frequent previews (more overhead). 1 = every step.</p>
              </div>
            )}

            {/* NAG (Negative Attention Guidance), standalone toggle for non-A2V subtitle suppression */}
            {!config.a2vMode && config.pipelineMode === "official" && (
              <div className="pt-1 border-t border-sky-500/10 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                    <Label className="text-[11px] text-sky-400 font-medium cursor-pointer" htmlFor="nagEnabled">
                      NAG (Subtitle Suppression)
                    </Label>
                  </div>
                  <input
                    id="nagEnabled"
                    type="checkbox"
                    checked={!!config.nagEnabled}
                    onChange={(e) => update("nagEnabled", e.target.checked)}
                    disabled={isRunning}
                    className="h-3.5 w-3.5 rounded border-sky-500/40 accent-sky-500"
                  />
                </div>
                <p className="text-[8px] text-muted-foreground/60 leading-relaxed">
                  Patches cross-attention to suppress subtitles/text. Uses CFG={config.a2vCfg ?? 3} instead of BasicGuider.
                  Required for distilled models where negative prompts have no effect.
                </p>
                {config.nagEnabled && (
                  <div className="space-y-1 pl-2 border-l-2 border-sky-500/20">
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] text-muted-foreground w-10">Scale</span>
                      <Slider min={0} max={30} step={0.5} value={[config.nagScale ?? 11]} onValueChange={([v]) => update("nagScale", v)} disabled={isRunning} className="flex-1" />
                      <span className="text-[8px] text-muted-foreground w-6 text-right">{config.nagScale ?? 11}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] text-muted-foreground w-10">CFG</span>
                      <Slider min={1} max={7} step={0.25} value={[config.a2vCfg ?? 3]} onValueChange={([v]) => update("a2vCfg", v)} disabled={isRunning} className="flex-1" />
                      <span className="text-[8px] text-muted-foreground w-6 text-right">{config.a2vCfg ?? 3}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Normalization Weights (collapsible, only relevant when direct sampling is OFF) */}
            <button
              type="button"
              className={`flex items-center gap-2 w-full text-left ${config.directSampling ? "opacity-40 pointer-events-none" : ""}`}
              onClick={() => setNormExpanded(!normExpanded)}
            >
              {normExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-sky-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-sky-400" />
              )}
              <AudioLines className="w-3.5 h-3.5 text-sky-400" />
              <span className="text-[11px] text-sky-400 font-medium">
                Normalization Weights
              </span>
            </button>

            {normExpanded && (
              <div className="space-y-3 pt-1">
                <p className="text-[9px] text-muted-foreground leading-relaxed">
                  Controls per-step latent scaling during diffusion sampling. Each comma-separated value
                  corresponds to one sampling step. Values &lt; 1.0 reduce that step&apos;s contribution,
                  which can prevent artifacts or tame specific modality noise. The number of values should
                  match the step count (8 for distilled, 15 for full quality).
                </p>

                {/* Video normalization */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-sky-400/80">Video Normalization</Label>
                    <button
                      type="button"
                      onClick={() => update("videoNormFactors", "1,1,1,1,1,1,1,1")}
                      className="text-[9px] text-muted-foreground hover:text-sky-400 flex items-center gap-0.5"
                      title="Reset to default (all 1s)"
                    >
                      <RotateCcw className="w-2.5 h-2.5" /> Reset
                    </button>
                  </div>
                  <input
                    type="text"
                    value={config.videoNormFactors}
                    onChange={(e) => update("videoNormFactors", e.target.value)}
                    className="w-full h-7 rounded border border-sky-500/20 bg-background px-2 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                    placeholder="1,1,1,1,1,1,1,1"
                    disabled={isRunning}
                  />
                  <p className="text-[8px] text-muted-foreground/60">
                    One value per step. All 1.0 = full contribution at every step (default). Reducing mid-steps
                    can improve temporal coherence. Values should stay between 0.1–1.0.
                  </p>
                </div>

                {/* Audio normalization */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-sky-400/80">Audio Normalization</Label>
                    <button
                      type="button"
                      onClick={() => update("audioNormFactors", "1,1,0.25,1,1,0.25,1,1")}
                      className="text-[9px] text-muted-foreground hover:text-sky-400 flex items-center gap-0.5"
                      title="Reset to Alternative defaults"
                    >
                      <RotateCcw className="w-2.5 h-2.5" /> Reset
                    </button>
                  </div>
                  <input
                    type="text"
                    value={config.audioNormFactors}
                    onChange={(e) => update("audioNormFactors", e.target.value)}
                    className="w-full h-7 rounded border border-sky-500/20 bg-background px-2 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                    placeholder="1,1,0.25,1,1,0.25,1,1"
                    disabled={isRunning}
                  />
                  <p className="text-[8px] text-muted-foreground/60">
                    Steps 3 &amp; 6 at 0.25 reduce white noise / clipping (Alternative recipe). Try lower values (0.1) for cleaner audio,
                    or all 1.0 for max fidelity. When audio is unwanted (e.g. music video with existing track), set all to 1.0
                    and instead set Audio Scale to 0 in the Attention section above.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Live Preview during generation */}
          {isRunning && livePreviewUrl && !outputUrl && (
            <div className={`${ltxCard("cyan")} p-3 space-y-2`}>
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                <span className="text-[11px] text-cyan-400 font-medium">Live Preview</span>
                <span className="text-[9px] text-cyan-400/50 ml-auto">Sampling in progress...</span>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={livePreviewUrl}
                alt="Live preview"
                className="w-full rounded border border-cyan-500/20 object-contain"
                style={{ maxHeight: "45vh" }}
              />
            </div>
          )}

          {/* Generate / Cancel: locked footer: pinned to the bottom of the dock so the
              action + live progress/ETA stay visible no matter which sections are scrolled. */}
          <div className="sticky bottom-0 z-10 mt-1 rounded-xl border border-blue-500/25 bg-[var(--sidebar)]/95 backdrop-blur p-2.5 space-y-2 shadow-[0_-4px_12px_rgba(0,0,0,0.25)]">
            {isRunning ? (
              <>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    onClick={handleCancel}
                  >
                    <Square className="w-3.5 h-3.5 mr-1.5" /> Cancel
                  </Button>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>{stage}</span>
                    <span>{progressPct > 0 ? `${progressPct}%` : ""}</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-300"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                  {progress > 0 && progressMax > 0 && (
                    <p className="text-[9px] text-muted-foreground text-center">
                      Step {progress} / {progressMax}
                    </p>
                  )}
                  {stepTimestamps.length >= 2 && progressMax > 0 && (
                    <LTX2ETACountdown stepTimestamps={stepTimestamps} progress={progress} progressMax={progressMax} />
                  )}
                </div>
              </>
            ) : (
              <>
              {comfyConnected === false && (
                <p className="text-[10px] text-destructive text-center mb-1">ComfyUI not connected, waiting for connection...</p>
              )}
              <div className="flex gap-2">
                <Button
                  className="flex-1 bg-blue-600 hover:bg-blue-500 text-white"
                  onClick={() => handleGenerate(false)}
                  disabled={!hasPromptContent || comfyConnected === false}
                >
                  <Play className="w-4 h-4 mr-2" />
                  {config.sourceImage ? "Generate" : "Generate"}
                </Button>
                <Button
                  className="bg-amber-600 hover:bg-amber-500 text-white"
                  onClick={() => handleGenerate(true)}
                  disabled={!hasPromptContent || comfyConnected === false}
                  title={`Preview at ${getPreviewResolution(config.width, config.height).width}×${getPreviewResolution(config.width, config.height).height} (half res)`}
                >
                  <Eye className="w-4 h-4 mr-1" />
                  Preview
                </Button>
              </div>
              <SendToQueueButton
                className="w-full mt-2"
                disabled={!hasPromptContent}
                getJob={() => {
                  const seed = config.seed >= 0 ? config.seed : Math.floor(Math.random() * 2 ** 32);
                  const wf = config.autoregressiveEnabled
                    ? buildLTX2AutoregressiveWorkflow(config, seed)
                    : config.pipelineMode === "official"
                      ? buildLTX2OfficialWorkflow(config, seed)
                      : buildLTX2Workflow(config, seed);
                  return { workflow: wf as Record<string, unknown>, name: `LTX-2 ${config.autoregressiveEnabled ? "Autoregressive" : config.pipelineMode === "official" ? "Official" : "Alternative"}`, outputKind: "video" };
                }}
              />
              {lastRenderTime && (
                <p className="text-[10px] text-center text-cyan-400/70 font-mono mt-1">
                  Last render: {lastRenderTime}
                </p>
              )}
              </>
            )}

            {error && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                {error}
              </div>
            )}
          </div>

          </div>
        </WorkflowControls>
      </div>
    </div>
  );
}
