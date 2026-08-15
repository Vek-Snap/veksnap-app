"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAutoplay } from "@/lib/use-autoplay";
import {
  Play,
  Square,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Film,
  Clapperboard,
  ArrowDown,
  ArrowUp,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Settings2,
  Cpu,
  Timer,
  Volume2,
  VolumeX,
  RefreshCw,
  GripVertical,
  Download,
  ImagePlus,
  X,
  FileAudio,
  Eye,
  Upload,
  SkipForward,
  RotateCcw,
  Pause,
  ArrowDownToLine,
  Wand2,
  BarChart3,
  Sparkles,
  User,
  Mic2,
  Combine,
  FileVideo,
  Shuffle,
  Sliders,
  Activity,
  FolderSearch,
  Rocket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  DirectorConfig,
  DirectorSegment,
  PreviewSize,
  DIRECTOR_DEFAULTS,
  LTX2_RESOLUTION_PRESETS,
  ltx2FrameCountForDuration,
  ltx2DurationForFrames,
  snapToLtx2FrameCount,
  resegmentAudioTimeline,
  LTX2Config,
  LTX2_CHECKPOINT_PRESETS,
  getLTX2CheckpointConfig,
  getResolutionScaledDefaults,
  ComfyUIProgress,
  createDirectorSegment,
  LTX2ModelVersion,
  LTX2PipelineMode,
  LTX2QualityTier,
  LTX2_OFFICIAL_NEGATIVE,
  LTX2_OFFICIAL_LORA_STRENGTH,
  getLTX2ModelDefaults,
  LTX23_MODEL_DEFAULTS,
  TURBO_UPSCALE_DEFAULTS,
  getTurboHalfResolution,
  applyStoryboardSchedule,
  applyEnergyBucketSchedule,
  autoFillSegmentPrompts,
  computeSegmentEnergy,
  MV_DEFAULT_TEMPLATES,
  classifyEnergy,
  EnergyLevel,
  MusicGenre,
  SubjectCount,
  MUSIC_GENRE_OPTIONS,
  SUBJECT_COUNT_OPTIONS,
  getGenreTemplates,
} from "@/lib/types";
import WaveformTimeline from "@/components/WaveformTimeline";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { cc } from "@/lib/continuum-theme";
import { buildLTX2Workflow, buildLTX2OfficialWorkflow, buildLTX2AutoregressiveWorkflow, buildFoleyAudioWorkflow, buildLipSyncWorkflow } from "@/lib/workflow-builder";
import { STYLE_PRESETS, STYLE_PRESET_OPTIONS, buildNegativePrompt, getPresetFps } from "@/lib/prompt-architect";
import { estimateLtx2Vram, fetchTotalVramMB, type LTX2VramEstimate } from "@/lib/vram-estimator";
import { useRenderStatus } from "@/lib/render-status-context";
import {
  queuePrompt,
  getHistory,
  getImageUrl,
  connectComfyStream,
  uploadImage,
  checkConnection,
} from "@/lib/comfyui-api";
import { ensureVramForStage } from "@/lib/vram-guard";
import {
  FOLEY_PROMPT_PRESETS,
  FOLEY_SAMPLERS,
  LoraEntry,
  GenerationParams,
  DEFAULT_PARAMS,
} from "@/lib/types";
import AudioForVideo from "@/components/AudioForVideo";
import SegmentCombiner from "@/components/SegmentCombiner";
import ScriptWriter from "@/components/ScriptWriter";
import LoraSelect from "@/components/LoraSelect";
import ZRefinePanel from "@/components/ZRefinePanel";
import { WorkflowControls } from "@/components/WorkflowControlsSlot";
import { VideoSlot } from "@/components/media/MediaPlayer";
import ImageLightbox, { type LightboxImage } from "@/components/ImageLightbox";
import { usePersistentState } from "@/hooks/usePersistedConfig";
import { usePersistentTextareaHeight } from "@/lib/prompt-heights";

// Segment prompt field: a resizable <textarea> whose drag-height is remembered
// per segment (and travels with the save-state). Extracted so the height hook
// runs at a stable component boundary rather than inside the segment .map().
function SegmentPromptField({ persistId, ...props }: { persistId: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const heightRef = usePersistentTextareaHeight(persistId);
  return <textarea ref={heightRef} {...props} />;
}

interface DirectorStudioProps {
  config: DirectorConfig;
  onConfigChange: (config: DirectorConfig) => void;
}

type PipelinePhase = "idle" | "generating" | "extracting" | "lip_sync" | "concatenating" | "foley" | "paused" | "complete" | "error";
type DirectorSubTab = "main" | "v2a" | "combine" | "script";

// Segment preview thumbnail heights (px) for the user-selectable preview size.
const PREVIEW_MAXH: Record<PreviewSize, number> = { sm: 128, md: 192, lg: 288, xl: 512 };
const PREVIEW_SIZE_OPTS: { value: PreviewSize; label: string }[] = [
  { value: "sm", label: "S" }, { value: "md", label: "M" }, { value: "lg", label: "L" }, { value: "xl", label: "XL" },
];

// Per-segment duration editor: two linked numeric fields (Frames <-> Seconds). Editing
// either recomputes the other against the master frame rate, snapping to LTX's 8n+1 math.
// Changes commit on blur / Enter (not per-keystroke) so the re-time confirmation isn't
// spammed mid-typing. The parent decides whether a commit triggers the re-slice dialog.
function SegmentDurationEditor({ numFrames, fps, disabled, syncKey, onCommit }: {
  numFrames: number;
  fps: number;
  disabled?: boolean;
  // Bumping this from the parent forces the fields back to `numFrames` even when
  // numFrames itself hasn't changed - used to revert an optimistic edit when the
  // re-time confirmation dialog is cancelled.
  syncKey?: number;
  onCommit: (newFrames: number) => void;
}) {
  const [framesStr, setFramesStr] = useState(String(numFrames));
  const [secsStr, setSecsStr] = useState(ltx2DurationForFrames(numFrames, fps).toFixed(2));

  // Re-sync the fields when the segment's frames or the master fps change from outside
  // (e.g. Prepare Segments, a re-slice, an fps switch, or a cancelled re-time). Uses
  // React's "adjust state during render" pattern (a prev-props sentinel) rather than an
  // effect, so there's no cascading-render lint and the fields update in the same commit.
  const [syncSentinel, setSyncSentinel] = useState({ numFrames, fps, syncKey });
  if (syncSentinel.numFrames !== numFrames || syncSentinel.fps !== fps || syncSentinel.syncKey !== syncKey) {
    setSyncSentinel({ numFrames, fps, syncKey });
    setFramesStr(String(numFrames));
    setSecsStr(ltx2DurationForFrames(numFrames, fps).toFixed(2));
  }

  const reset = () => {
    setFramesStr(String(numFrames));
    setSecsStr(ltx2DurationForFrames(numFrames, fps).toFixed(2));
  };
  const applySnapped = (snapped: number) => {
    setFramesStr(String(snapped));
    setSecsStr(ltx2DurationForFrames(snapped, fps).toFixed(2));
    if (snapped !== numFrames) onCommit(snapped);
  };
  const commitFrames = (raw: string) => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return reset();
    applySnapped(snapToLtx2FrameCount(n));
  };
  const commitSeconds = (raw: string) => {
    const s = parseFloat(raw);
    if (!Number.isFinite(s) || s <= 0) return reset();
    applySnapped(ltx2FrameCountForDuration(s, fps));
  };

  return (
    <div className="flex items-center gap-2">
      <Label className="text-[9px] text-muted-foreground/70 w-16">Duration</Label>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={25}
          step={8}
          value={framesStr}
          disabled={disabled}
          onChange={(e) => setFramesStr(e.target.value)}
          onBlur={(e) => commitFrames(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-16 h-6 rounded border border-border bg-background px-1.5 text-[10px]"
          title="Frame count (LTX requires 8n+1; value snaps on commit)"
        />
        <span className="text-[9px] text-muted-foreground/60">frames</span>
      </div>
      <div className="flex items-center gap-1">
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={secsStr}
          disabled={disabled}
          onChange={(e) => setSecsStr(e.target.value)}
          onBlur={(e) => commitSeconds(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-16 h-6 rounded border border-border bg-background px-1.5 text-[10px]"
          title="Video duration in seconds at the master frame rate (snaps to the nearest valid frame count)"
        />
        <span className="text-[9px] text-muted-foreground/60">sec @ {fps}fps</span>
      </div>
    </div>
  );
}

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

function DirectorETACountdown({ stepTimestamps, progress, progressMax }: {
  stepTimestamps: number[];
  progress: number;
  progressMax: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (stepTimestamps.length < 2 || progressMax <= 0) return null;

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
    <div className="rounded-lg border border-blue-500/20 bg-gradient-to-r from-blue-500/5 to-blue-500/5 p-2 mt-1">
      <div className="flex items-center justify-between mb-1">
        <span className={cc.fieldLabelRow}>
          <Timer className="w-3 h-3" /> ETA
        </span>
        <span className="text-[9px] text-muted-foreground font-mono">
          {(avgMs / 1000).toFixed(0)}s/step · last {(lastStepMs / 1000).toFixed(0)}s
        </span>
      </div>
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-xl font-mono font-bold text-blue-400 tabular-nums tracking-tight">
          {formatEtaTime(liveEta)}
        </span>
        <span className="text-[9px] text-blue-400/50">remaining</span>
      </div>
      <div className="flex justify-between mt-1 text-[8px] text-muted-foreground font-mono">
        <span>Elapsed: {formatEtaTime(elapsed)}</span>
        <span>{stepsRemaining} steps left</span>
      </div>
    </div>
  );
}

export default function DirectorStudio({ config, onConfigChange }: DirectorStudioProps) {
  const configRef = useRef(config);
  configRef.current = config;

  const setConfig = useCallback(
    (updater: DirectorConfig | ((prev: DirectorConfig) => DirectorConfig)) => {
      const newConfig =
        typeof updater === "function" ? updater(configRef.current) : updater;
      configRef.current = newConfig;
      onConfigChange(newConfig);
    },
    [onConfigChange]
  );

  const { startRender, updateRenderProgress, updateStage: updateHeaderStage, endRender } = useRenderStatus();

  // Pipeline state
  const [phase, setPhase] = useState<PipelinePhase>("idle");
  const [currentSegIdx, setCurrentSegIdx] = useState(0);
  const [segProgress, setSegProgress] = useState(0);
  const [segProgressMax, setSegProgressMax] = useState(0);
  const [segStage, setSegStage] = useState("");
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [finalOutputUrl, setFinalOutputUrl] = useState<string | null>(null);
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null);
  const [assemblingCurrent, setAssemblingCurrent] = useState(false);
  const [assemblingDirectory, setAssemblingDirectory] = useState(false);
  const [stepTimestamps, setStepTimestamps] = useState<number[]>([]);
  const cumulativeStepsRef = useRef(0);
  const prevChunkMaxRef = useRef(0);
  const [autoplay] = useAutoplay();

  // Sub-tab state
  const [subTab, setSubTab] = useState<DirectorSubTab>("main");

  // UI state
  const [comfyConnected, setComfyConnected] = useState<boolean | null>(null);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [vramEstimate, setVramEstimate] = useState<LTX2VramEstimate | null>(null);
  const [totalVramMB, setTotalVramMB] = useState<number | null>(null);
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [lorasExpanded, setLorasExpanded] = usePersistentState<boolean>("vs2:director:lorasExpanded", false);
  const [advancedExpanded, setAdvancedExpanded] = usePersistentState<boolean>("vs2:director:advancedExpanded", false);
  const [energyExpanded, setEnergyExpanded] = usePersistentState<boolean>("vs2:director:energyExpanded", true);
  const [autoPromptExpanded, setAutoPromptExpanded] = usePersistentState<boolean>("vs2:director:autoPromptExpanded", true);
  const [vramHidden, setVramHidden] = usePersistentState<boolean>("vs2:director:vramHidden", false);
  const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const [segImg, setSegImg] = usePersistentState<"sm" | "md" | "lg" | "xl">("vs2:director:segImg", "md");
  const SEG_IMG = { sm: "max-h-20", md: "max-h-28", lg: "max-h-44", xl: "max-h-72" } as const;
  // Open the enlarge viewer for a group of storyboard images, focused on startId.
  const openLightbox = (list: { id: string; preview?: string; label?: string }[], startId: string) => {
    const withPreview = list.filter((x) => x.preview);
    const imgs: LightboxImage[] = withPreview.map((x) => ({ url: x.preview!, label: x.label }));
    if (!imgs.length) return;
    const idx = withPreview.findIndex((x) => x.id === startId);
    setLightbox({ images: imgs, index: Math.max(0, idx) });
  };
  // Full ordered list of segment frame images (start + end) for lightbox cycling.
  const segmentFrameList = (): { id: string; preview?: string; label?: string }[] =>
    config.segments.flatMap((s, i) => {
      const arr: { id: string; preview?: string; label?: string }[] = [];
      if (s.sourceImagePreview) arr.push({ id: `seg${i}-start`, preview: s.sourceImagePreview, label: `Segment ${i + 1} · Start frame` });
      if (s.endImagePreview) arr.push({ id: `seg${i}-end`, preview: s.endImagePreview, label: `Segment ${i + 1} · End frame` });
      return arr;
    });
  const [foleyExpanded, setFoleyExpanded] = usePersistentState<boolean>("vs2:director:foleyExpanded", false);
  const [lipSyncExpanded, setLipSyncExpanded] = usePersistentState<boolean>("vs2:director:lipSyncExpanded", false);
  const [relipSyncing, setRelipSyncing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  // Character reference preview (10S Character Consistency)
  const [likenessPreview, setLikenessPreview] = useState<string | null>(null);
  const [llmBusy, setLlmBusy] = useState<Record<number, boolean>>({});
  const [llmError, setLlmError] = useState<string | null>(null);
  const [dragSbIdx, setDragSbIdx] = useState<number | null>(null);
  const [dragOverSbIdx, setDragOverSbIdx] = useState<number | null>(null);
  const [resumeFromSegment, setResumeFromSegment] = useState<number | null>(null);
  const [resumeToSegment, setResumeToSegment] = useState<number | null>(null);
  const resumeFromRef = useRef<number | null>(null);
  const resumeToRef = useRef<number | null>(null);

  // ComfyUI base directory: fetched from server (no hardcoded paths)
  const comfyBaseDirRef = useRef<string>("");
  useEffect(() => {
    fetch("/api/comfyui/base-dir").then(r => r.json()).then(d => {
      comfyBaseDirRef.current = d.baseDir;
    }).catch(() => {});
  }, []);

  // Foley pipeline refs
  const foleyEsRef = useRef<EventSource | null>(null);
  const foleyPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Lip sync pipeline refs
  const lipSyncEsRef = useRef<EventSource | null>(null);
  const lipSyncPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Interjection (pause between segments) state
  const pauseResolverRef = useRef<(() => void) | null>(null);
  const regenRequestedRef = useRef(false);
  // Mid-generation interjection: skip current segment or pause-to-adjust after it completes
  const skipCurrentRef = useRef(false);
  const adjustAfterCurrentRef = useRef(false);

  // Refs
  const esRef = useRef<EventSource | null>(null);
  const promptIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const clientIdRef = useRef<string>(
    `director_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );

  // Poll ComfyUI connection (5s while disconnected, 30s while connected)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const ok = await checkConnection();
      setComfyConnected(ok);
      timer = setTimeout(poll, ok ? 30000 : 5000);
    };
    poll();
    return () => clearTimeout(timer);
  }, []);

  // Check VRAM and LoRAs on mount
  useEffect(() => {
    fetchTotalVramMB().then(setTotalVramMB);
    fetch(`/api/lora-files?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: string[]) => setAvailableLoras(list))
      .catch(() => {});
  }, []);

  // ── Interjection handlers ──
  const handleContinue = useCallback(() => {
    regenRequestedRef.current = false;
    pauseResolverRef.current?.();
    pauseResolverRef.current = null;
  }, []);

  const handleRegenerate = useCallback(() => {
    regenRequestedRef.current = true;
    pauseResolverRef.current?.();
    pauseResolverRef.current = null;
  }, []);

  // Mid-generation: cancel the currently-rendering segment and pause on it for re-gen/review
  const handleCancelCurrentSegment = useCallback(() => {
    skipCurrentRef.current = true;
    import("@/lib/comfyui-api").then(({ interruptGeneration }) => interruptGeneration()).catch(() => {});
  }, []);

  // Mid-generation: let current segment finish, then pause to let user adjust settings
  const handleAdjustAfterCurrent = useCallback(() => {
    adjustAfterCurrentRef.current = true;
  }, []);

  const handleAssembleCurrent = useCallback(async () => {
    const segments = configRef.current.segments;
    const completed = segments
      .map((s, idx) => ({ url: s.outputUrl, idx }))
      .filter((e) => segments[e.idx].status === "complete" && e.url);

    if (completed.length < 2) {
      setPipelineError("Need at least 2 completed segments to assemble");
      return;
    }

    setAssemblingCurrent(true);
    setPipelineError(null);

    try {
      const res = await fetch("/api/director/concatenate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrls: completed.map((e) => e.url),
          segmentIndices: completed.map((e) => e.idx),
          crossfadeFrames: configRef.current.crossfadeFrames,
          frameRate: configRef.current.frameRate,
          trimOverlap: true,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Assembly failed" }));
        throw new Error(err.error);
      }

      const data = await res.json();
      setFinalOutputUrl(data.outputUrl);
      if (data.skippedCount > 0) {
        setPipelineError(`Warning: ${data.skippedCount} segment(s) skipped (missing files): ${data.skipped.join(", ")}`);
      }
    } catch (err) {
      setPipelineError(`Assemble: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setAssemblingCurrent(false);
    }
  }, []);

  // Assemble from directory: scans ltx2 output folder for numbered files and concatenates them
  const handleAssembleFromDirectory = useCallback(async () => {
    setAssemblingDirectory(true);
    setPipelineError(null);

    try {
      const res = await fetch("/api/director/assemble-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subfolder: "ltx2",
          preferAudio: true,
          frameRate: configRef.current.frameRate,
          trimOverlap: true, // storyboard pair mode generates overlap: end frame of seg N = start frame of seg N+1
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Directory assembly failed" }));
        throw new Error(err.error);
      }

      const data = await res.json();
      setFinalOutputUrl(data.outputUrl);
      setPipelineError(`Assembled ${data.meta.count} files from disk: ${data.files.join(", ")}`);
    } catch (err) {
      setPipelineError(`Dir Assemble: ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setAssemblingDirectory(false);
    }
  }, []);

  // Live VRAM estimation for a single segment (the bottleneck)
  useEffect(() => {
    if (!totalVramMB) return;
    // Estimate for one segment (they run sequentially so peak VRAM is per-segment)
    const maxFramesSeg = Math.max(...config.segments.map((s) => s.numFrames));
    const fakeConfig: LTX2Config = {
      ...DIRECTOR_DEFAULTS,
      width: config.width,
      height: config.height,
      numFrames: maxFramesSeg,
      frameRate: config.frameRate,
      enableAudio: config.audioMode === "joint",
      sourceImage: "",
      seed: 0,
      randomSeed: true,
      prompt: "",
      modelBasePath: "",
      modelVersion: config.modelVersion || "2.0",
      qualityTier: config.qualityTier || "distilled",
    };
    setVramEstimate(estimateLtx2Vram(fakeConfig, totalVramMB));
  }, [config.width, config.height, config.segments, config.audioMode, config.frameRate, config.qualityTier, totalVramMB]);

  // ── Segment management ──
  // New segments default to the configured master duration (in frames at the current fps),
  // matching the "Prepare Segments" cadence, instead of a hardcoded default.
  const masterSegmentFrames = () => ltx2FrameCountForDuration(configRef.current.segmentDuration, configRef.current.frameRate);
  const addSegment = () => {
    setConfig((prev) => ({
      ...prev,
      segments: [...prev.segments, createDirectorSegment({ numFrames: masterSegmentFrames() })],
    }));
  };

  const removeSegment = (idx: number) => {
    if (config.segments.length <= 1) return;
    setConfig((prev) => ({
      ...prev,
      segments: prev.segments.filter((_, i) => i !== idx),
    }));
  };

  const updateSegment = (idx: number, patch: Partial<DirectorSegment>) => {
    setConfig((prev) => ({
      ...prev,
      segments: prev.segments.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    }));
  };

  // ── Per-segment duration re-timing ──
  // Pending duration change awaiting the user's "this vs following" choice (only raised
  // when a master-audio timeline exists, otherwise the frame change applies immediately).
  const [durationChange, setDurationChange] = useState<{ segIdx: number; newFrames: number } | null>(null);
  // Bumped whenever a re-time is cancelled, forcing the SegmentDurationEditor fields to
  // snap back to the segment's actual numFrames so the typed-but-abandoned value doesn't
  // linger and desync the display from the real duration.
  const [durationRevertNonce, setDurationRevertNonce] = useState(0);
  const [resegmenting, setResegmenting] = useState(false);

  const cancelDurationChange = () => {
    setDurationChange(null);
    setDurationRevertNonce((n) => n + 1);
  };

  const commitSegmentDuration = (idx: number, newFrames: number) => {
    const c = configRef.current;
    const seg = c.segments[idx];
    if (!seg || newFrames === seg.numFrames) return;
    const timelineActive = !!(c.masterAudioFile && c.autoSegmentFromAudio && (c.masterAudioDuration ?? 0) > 0);
    if (timelineActive) {
      // Changing one segment's length shifts the rest of the song → ask the user how far
      // the new cadence should propagate before re-slicing.
      setDurationChange({ segIdx: idx, newFrames });
    } else {
      // No audio timeline to keep in sync, a plain frame change with no ripple.
      updateSegment(idx, { numFrames: newFrames });
    }
  };

  const applyDurationChange = async (mode: "this" | "following") => {
    const dc = durationChange;
    if (!dc) return;
    const c = configRef.current;
    const fps = c.frameRate;
    const trackDuration = c.masterAudioDuration || 0;
    setResegmenting(true);
    try {
      const { segments: newSegments, slicePlan, changedStartIdx } = resegmentAudioTimeline({
        segments: c.segments,
        editedIdx: dc.segIdx,
        newFrames: dc.newFrames,
        mode,
        fps,
        trackDuration,
        masterFrames: ltx2FrameCountForDuration(c.segmentDuration, fps),
      });

      // Re-slice ONLY the changed tail (segments from changedStartIdx onward) from the
      // ORIGINAL master track using the explicit-slice API, then map the results back.
      if (c.masterAudioFile && slicePlan.length > 0) {
        const resp = await fetch("/api/director/audio-slice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ masterAudioFile: c.masterAudioFile, slices: slicePlan }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: "Audio re-slice failed" }));
          throw new Error(err.error || "Audio re-slice failed");
        }
        const data = await resp.json();
        const returned: Array<{ audioFile: string; startTime: number; endTime: number; duration: number }> = data.segments || [];
        returned.forEach((slice, k) => {
          const target = newSegments[changedStartIdx + k];
          if (target) {
            target.audioSliceFile = slice.audioFile;
            target.audioStartTime = slice.startTime;
            target.audioEndTime = slice.endTime;
          }
        });
      }

      // Re-detect energy on the re-timed segments (their audio positions moved).
      const finalSegments = c.energyData && c.energyData.length > 0
        ? computeSegmentEnergy(newSegments, c.energyData, c.energyHighThreshold, c.energyMediumThreshold)
        : newSegments;

      setConfig((prev) => ({ ...prev, segments: finalSegments }));
      setDurationChange(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to re-time segments");
    } finally {
      setResegmenting(false);
    }
  };

  // ── Image upload for I2V source ──
  const handleImageUpload = useCallback(async (idx: number, file: File) => {
    // Create local preview
    const previewUrl = URL.createObjectURL(file);
    updateSegment(idx, { sourceImagePreview: previewUrl });

    try {
      // Upload to ComfyUI
      const comfyFilename = await uploadImage(file);
      updateSegment(idx, { sourceImage: comfyFilename });
    } catch (err) {
      updateSegment(idx, {
        sourceImage: "",
        sourceImagePreview: "",
        error: `Image upload failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, []);

  // ── LLM: Expand a segment's prompt via Qwen3.5-9B ──
  const handleExpandSegmentPrompt = useCallback(async (idx: number) => {
    const seg = configRef.current.segments[idx];
    if (!seg?.prompt.trim() || llmBusy[idx]) return;
    setLlmBusy((prev) => ({ ...prev, [idx]: true }));
    setLlmError(null);
    try {
      const styleKey = configRef.current.stylePreset || "none";
      const styleDesc = styleKey !== "none" && STYLE_PRESETS[styleKey]
        ? STYLE_PRESETS[styleKey].description
        : "";
      const res = await fetch("/api/prompt-expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: seg.prompt,
          style: styleDesc,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.expanded) {
        updateSegment(idx, { prompt: data.expanded });
      }
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : "Prompt expansion failed");
    } finally {
      setLlmBusy((prev) => ({ ...prev, [idx]: false }));
    }
  }, [llmBusy]);

  // ── LLM: Abort running process ──
  const handleAbortLlm = useCallback(async () => {
    try {
      await fetch("/api/llm-abort", { method: "POST" });
    } catch { /* ignore */ }
    setLlmBusy({});
    setLlmError("Cancelled by user");
  }, []);

  const clearSourceImage = useCallback((idx: number) => {
    const seg = configRef.current.segments[idx];
    if (seg?.sourceImagePreview) URL.revokeObjectURL(seg.sourceImagePreview);
    updateSegment(idx, { sourceImage: "", sourceImagePreview: "" });
  }, []);

  // ── End-frame image upload for last-frame guidance ──
  const handleEndImageUpload = useCallback(async (idx: number, file: File) => {
    const previewUrl = URL.createObjectURL(file);
    updateSegment(idx, { endImagePreview: previewUrl });
    try {
      const comfyFilename = await uploadImage(file);
      updateSegment(idx, { endImage: comfyFilename });
    } catch (err) {
      updateSegment(idx, {
        endImage: "",
        endImagePreview: "",
        error: `End image upload failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }, []);

  // ── Character reference upload (10S), ONE fixed reference shared across ALL segments ──
  // Eager-upload to ComfyUI input/ and store the filename (Continuum convention), so every
  // segment's buildSegmentConfig anchors identity to the same reference.
  const handleLikenessUpload = useCallback(async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    setLikenessPreview(previewUrl);
    try {
      const comfyFilename = await uploadImage(file);
      setConfig((prev) => ({ ...prev, likenessImage: comfyFilename }));
    } catch (err) {
      setLikenessPreview(null);
      setPipelineError(`Character reference upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [setConfig]);

  const clearEndImage = useCallback((idx: number) => {
    const seg = configRef.current.segments[idx];
    if (seg?.endImagePreview) URL.revokeObjectURL(seg.endImagePreview);
    updateSegment(idx, { endImage: "", endImagePreview: "" });
  }, []);

  // Reference Sheet (IC-LoRA "Ingredients"): ONE shared sheet uploaded once for the whole video.
  const [referenceSheetPreview, setReferenceSheetPreview] = useState<string | null>(null);
  const handleReferenceSheetUpload = useCallback(async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    setReferenceSheetPreview(previewUrl);
    try {
      const comfyFilename = await uploadImage(file);
      setConfig((prev) => ({ ...prev, referenceSheetImage: comfyFilename }));
    } catch (err) {
      setReferenceSheetPreview(null);
      setPipelineError(`Reference sheet upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [setConfig]);

  // Center navigation: jump the center scroll view to a given 1-based segment or the review surface.
  const [jumpTarget, setJumpTarget] = useState("");
  const scrollToSegment = useCallback((n: number) => {
    if (!Number.isFinite(n) || n < 1) return;
    const el = document.getElementById(`director-seg-${n - 1}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const scrollToReview = useCallback(() => {
    const el = document.querySelector('[id^="director-review"]');
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const moveSegment = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= config.segments.length) return;
    setConfig((prev) => {
      const segs = [...prev.segments];
      [segs[idx], segs[newIdx]] = [segs[newIdx], segs[idx]];
      return { ...prev, segments: segs };
    });
  };

  // ── Pipeline execution ──

  // Build an LTX2Config from DirectorConfig for a single segment
  // Uses configRef.current to always read fresh values (not stale closure)
  const buildSegmentConfig = (seg: DirectorSegment, sourceImage: string): LTX2Config => {
    const c = configRef.current;

    // Build guide frames: start image at frame 0, optional end image at last frame
    let guideFrames: { image: string; frameIdx: number; strength?: number }[] | undefined;
    if (sourceImage && seg.endImage) {
      guideFrames = [
        { image: sourceImage, frameIdx: 0, strength: 1.0 },
        { image: seg.endImage, frameIdx: seg.numFrames - 1, strength: 1.0 },
      ];
    }

    // Music Video mode: segment has a pre-sliced audio chunk → render in A2V mode
    // Audio is frozen in latent space; only video is generated to match the music.
    const hasAudioSlice = !!seg.audioSliceFile;

    return {
      prompt: seg.prompt,
      width: c.width,
      height: c.height,
      numFrames: seg.numFrames,
      frameRate: c.frameRate,
      seed: c.seed,
      randomSeed: c.randomSeed,
      sourceImage,
      guideFrames,
      enableAudio: hasAudioSlice ? true : c.audioMode === "joint",
      a2vMode: hasAudioSlice,
      a2vAudioFile: hasAudioSlice ? seg.audioSliceFile : undefined,
      a2vPurpose: "music_video",  // Director uses music video mode (guide + audio coexist)
      diffusionModel: c.diffusionModel,
      textEncoder: c.textEncoder,
      connectorModel: c.connectorModel,
      videoVae: c.videoVae,
      audioVae: c.audioVae,
      distillLoRA: c.distillLoRA,
      distillLoRAStrength: c.distillLoRAStrength,
      userLoras: c.userLoras,
      videoNormFactors: c.videoNormFactors,
      audioNormFactors: c.audioNormFactors,
      videoScale: c.videoScale,
      audioScale: c.audioScale,
      audioToVideoScale: c.audioToVideoScale,
      videoToAudioScale: c.videoToAudioScale,
      vaeTileSize: c.vaeTileSize,
      vaeOverlap: c.vaeOverlap,
      vaeTemporalSize: c.vaeTemporalSize,
      vaeTemporalOverlap: c.vaeTemporalOverlap,
      ffChunks: c.ffChunks,
      ffDimThreshold: c.ffDimThreshold,
      imgCompression: c.imgCompression,
      modelBasePath: c.modelBasePath || "",
      modelVersion: c.modelVersion || "2.0",
      pipelineMode: c.pipelineMode || "official",
      qualityTier: c.qualityTier || "distilled",
      officialAdvanced: c.officialAdvanced ?? true,
      negativePrompt: c.negativePrompt || "",
      stylePreset: c.stylePreset || "none",
      directSampling: c.directSampling ?? false,
      testVideoSteps: c.testVideoSteps ?? 3,
      testAudioSteps: c.testAudioSteps ?? 5,
      testSampler: c.testSampler || "euler",
      fullSteps: c.fullSteps ?? 15,
      fullSampler: c.fullSampler || "exponential/res_2s",
      videoCfg: c.videoCfg ?? 3,
      audioCfg: c.audioCfg ?? 7,
      distilledSteps: c.distilledSteps ?? 8,
      // Turbo Upscale: passed through so buildLTX2Workflow/Official emits the upscale
      // + refine pass. The builder auto-disables it for A2V (music-video) segments.
      turboUpscale: c.turboUpscale,
      turboUpscaleMethod: c.turboUpscaleMethod,
      turboUpscaleRefineSteps: c.turboUpscaleRefineSteps,
      turboUpscaleRefineStrength: c.turboUpscaleRefineStrength,
      turboUpscaleModel: c.turboUpscaleModel,
      turboUpscaleSampler: c.turboUpscaleSampler,
      turboUpscaleCustomSigmas: c.turboUpscaleCustomSigmas,
      // Character Consistency (10S): passed through so buildLTX2Workflow emits the 10S nodes.
      // A fixed likenessImage anchors identity across every segment (empty = per-segment frame).
      likenessEnabled: c.likenessEnabled,
      likenessImage: c.likenessImage,
      likenessAnchorStrength: c.likenessAnchorStrength,
      likenessSimThreshold: c.likenessSimThreshold,
      likenessLateBlockFalloff: c.likenessLateBlockFalloff,
      likenessFaceDetect: c.likenessFaceDetect,
      likenessRefMaskMode: c.likenessRefMaskMode,
      // Character Consistency: Reference Sheet (official IC-LoRA "Ingredients").
      // ONE shared reference sheet anchors character/prop/location identity across every segment.
      ingredientsMode: c.ingredientsMode,
      ingredientsLoRAName: c.ingredientsLoRAName,
      ingredientsLoRAStrength: c.ingredientsLoRAStrength,
      referenceSheetImage: c.referenceSheetImage,
      referenceSheetStrength: c.referenceSheetStrength,
      ingredientsUseSourceFrame: c.ingredientsUseSourceFrame,
      ingredientsSourceFrameStrength: c.ingredientsSourceFrameStrength,
      // End-frame anchor (segment-to-segment continuity). Auto-locks the last frame to this
      // segment's end image whenever one exists, unless the segment opts out (lockEndFrame ===
      // false) for deliberate creative drift. Strength governs graceful↔hard approach.
      ingredientsUseEndFrame: (seg.lockEndFrame ?? c.ingredientsUseEndFrame ?? true) && !!seg.endImage,
      ingredientsEndFrameStrength: c.ingredientsEndFrameStrength,
      ingredientsEndFrameImage: seg.endImage || "",
      // Autoregressive Long-Form (Top-Tier): routes each segment through
      // buildLTX2AutoregressiveWorkflow (LTXVLoopingSampler) when enabled.
      autoregressiveEnabled: c.autoregressiveEnabled,
      arTemporalTileSize: c.arTemporalTileSize,
      arTemporalOverlap: c.arTemporalOverlap,
      arTemporalOverlapCondStrength: c.arTemporalOverlapCondStrength,
      arCondImageStrength: c.arCondImageStrength,
      arAdainFactor: c.arAdainFactor,
      arGuidingStrength: c.arGuidingStrength,
      arNegativeIndexEnabled: c.arNegativeIndexEnabled,
      arNegativeIndexImage: c.arNegativeIndexImage,
      arNegativeIndexStrength: c.arNegativeIndexStrength,
      arHorizontalTiles: c.arHorizontalTiles,
      arVerticalTiles: c.arVerticalTiles,
      arSpatialOverlap: c.arSpatialOverlap,
    };
  };

  const generateSegment = useCallback(
    async (segIdx: number, sourceImage: string): Promise<{ outputUrl: string; lastFrameFile: string } | null> => {
      const seg = configRef.current.segments[segIdx];
      if (!seg) return null;

      updateSegment(segIdx, { status: "generating", error: null });
      setCurrentSegIdx(segIdx);
      setSegProgress(0);
      setSegProgressMax(0);
      setStepTimestamps([]);
      cumulativeStepsRef.current = 0;
      prevChunkMaxRef.current = 0;
      setSegStage(`Segment ${segIdx + 1}: Building workflow...`);
      startRender("Director", `Segment ${segIdx + 1}: Building workflow...`);

      const seed = configRef.current.randomSeed
        ? Math.floor(Math.random() * 2 ** 32)
        : configRef.current.seed < 0
          ? Math.floor(Math.random() * 2 ** 32)
          : configRef.current.seed;

      updateSegment(segIdx, { usedSeed: seed });

      const segConfig = buildSegmentConfig(seg, sourceImage);
      const workflow = segConfig.autoregressiveEnabled
        ? buildLTX2AutoregressiveWorkflow(segConfig, seed)
        : segConfig.pipelineMode === "official"
          ? buildLTX2OfficialWorkflow(segConfig, seed)
          : buildLTX2Workflow(segConfig, seed);

      return new Promise<{ outputUrl: string; lastFrameFile: string } | null>((resolve) => {
        const clientId = clientIdRef.current;
        esRef.current?.close();

        esRef.current = connectComfyStream(
          clientId,
          (msg: ComfyUIProgress) => {
            if (msg.type === "progress" && msg.data) {
              const chunkVal = msg.data.value ?? 0;
              const chunkMax = msg.data.max ?? 0;
              if (chunkMax !== prevChunkMaxRef.current && prevChunkMaxRef.current > 0) {
                cumulativeStepsRef.current += prevChunkMaxRef.current;
              }
              prevChunkMaxRef.current = chunkMax;
              const c = configRef.current;
              const tier = c.qualityTier || "distilled";
              const totalSteps = tier === "full"
                ? (c.fullSteps ?? 15)
                : tier === "test"
                  ? (c.testVideoSteps ?? 3) + (c.testAudioSteps ?? 5)
                  : (c.distilledSteps ?? 8);
              const globalStep = cumulativeStepsRef.current + chunkVal;
              setSegProgress(globalStep);
              setSegProgressMax(totalSteps);
              setSegStage(`Segment ${segIdx + 1}: Step ${globalStep}/${totalSteps}`);
              updateRenderProgress(globalStep, totalSteps, `Segment ${segIdx + 1}: Step ${globalStep}/${totalSteps}`, Date.now());
              setStepTimestamps((prev) => {
                const next = [...prev, Date.now()];
                return next.length > 100 ? next.slice(-100) : next;
              });
            } else if (msg.type === "executing" && msg.data) {
              if (msg.data.node === null) {
                // Execution done: fetch result
                fetchSegmentResult(segIdx).then(resolve);
              } else {
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
                };
                const nodeName = nodeNames[msg.data.node as string];
                if (nodeName) { setSegStage(`Segment ${segIdx + 1}: ${nodeName}`); updateHeaderStage(`Segment ${segIdx + 1}: ${nodeName}`); }
              }
            } else if (msg.type === "execution_error" && msg.data) {
              const errMsg = (msg.data as Record<string, unknown>).exception_message as string || "ComfyUI error";
              updateSegment(segIdx, { status: "error", error: errMsg });
              resolve(null);
            }
          },
          () => {
            // SSE closed, if prompt was queued, poll history as fallback
            // (connection can drop on long generations in dev mode)
            setTimeout(() => {
              const pid = promptIdRef.current;
              if (!pid) return;
              fetchSegmentResult(segIdx).then((result) => {
                if (result) resolve(result);
                // If still no result, the generation may still be running on a reconnected stream
              });
            }, 3000);
          },
          () => {
            // SSE error: same fallback
            setTimeout(() => {
              const pid = promptIdRef.current;
              if (!pid) return;
              fetchSegmentResult(segIdx).then((result) => {
                if (result) resolve(result);
              });
            }, 3000);
          },
          (dataUrl: string) => {
            setLivePreviewUrl(dataUrl);
          }
        );

        queuePrompt(workflow, clientId).then((result) => {
          promptIdRef.current = result.prompt_id;
          setSegStage(`Segment ${segIdx + 1}: Waiting for ComfyUI...`);
        }).catch((err) => {
          updateSegment(segIdx, { status: "error", error: err instanceof Error ? err.message : String(err) });
          resolve(null);
        });
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const fetchSegmentResult = async (segIdx: number): Promise<{ outputUrl: string; lastFrameFile: string } | null> => {
    const pid = promptIdRef.current;
    if (!pid) return null;

    for (let i = 0; i < 30; i++) {
      try {
        const history = await getHistory(pid);
        if (history?.outputs) {
          const vhsOutput = history.outputs["17"];
          if (vhsOutput?.gifs?.[0]) {
            const gif = vhsOutput.gifs[0];
            const url = getImageUrl(gif.filename, gif.subfolder || "", gif.type || "output");

            // Extract last frame for I2V chaining
            updateSegment(segIdx, { status: "extracting" });
            setSegStage(`Segment ${segIdx + 1}: Extracting last frame...`);

            let lastFrameFile = "";
            try {
              const extractRes = await fetch("/api/director/extract-frame", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  videoUrl: url,
                  framePosition: "last",
                }),
              });
              if (extractRes.ok) {
                const data = await extractRes.json();
                lastFrameFile = data.filename || "";
              }
            } catch { /* continue without last frame */ }

            updateSegment(segIdx, {
              status: "complete",
              outputUrl: url,
              lastFrameFile,
            });

            esRef.current?.close();
            return { outputUrl: url, lastFrameFile };
          }
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }

    updateSegment(segIdx, { status: "error", error: "Timeout waiting for output" });
    esRef.current?.close();
    return null;
  };

  // ── Lip Sync: run LatentSync 1.6 on a segment's video + audio ──
  const runLipSyncForSegment = useCallback(async (segIdx: number, videoUrl: string, audioSliceFile: string): Promise<string> => {
    const cfg = configRef.current;
    console.log(`[Director] Lip sync entry: segment=${segIdx + 1}, enabled=${cfg.lipSyncEnabled}, audioFile="${audioSliceFile}", videoUrl="${videoUrl}"`);
    if (!cfg.lipSyncEnabled) {
      console.warn(`[Director] Lip sync skipped: lipSyncEnabled is false`);
      return videoUrl;
    }

    setPhase("lip_sync");
    setSegStage(`Segment ${segIdx + 1}: Lip sync (LatentSync 1.6)...`);
    setSegProgress(0);
    setSegProgressMax(0);

    try {
      // Parse video URL to get absolute path for ComfyUI
      const parsed = new URL(videoUrl, "http://localhost");
      const filename = parsed.searchParams.get("filename") || "";
      const subfolder = parsed.searchParams.get("subfolder") || "";
      const comfyDir = comfyBaseDirRef.current;
      const videoPath = subfolder
        ? `${comfyDir}/output/${subfolder}/${filename}`
        : `${comfyDir}/output/${filename}`;
      console.log(`[Director] Lip sync resolved path: "${videoPath}", audio: "${audioSliceFile}"`);

      // Build lip sync workflow
      const lipSyncSeed = cfg.randomSeed ? Math.floor(Math.random() * 2147483647) : cfg.seed;
      const workflow = buildLipSyncWorkflow({
        videoPath,
        audioPath: audioSliceFile,
        seed: lipSyncSeed,
        inferenceSteps: cfg.lipSyncInferenceSteps,
        lipsExpression: cfg.lipSyncExpression,
        faceRestore: cfg.lipSyncFaceRestore,
        faceRestoreFidelity: cfg.lipSyncFaceRestoreFidelity,
        faceDetection: cfg.lipSyncFaceDetection,
        frameRate: cfg.frameRate,
      });

      // Connect SSE for progress
      if (lipSyncEsRef.current) { lipSyncEsRef.current.close(); lipSyncEsRef.current = null; }
      lipSyncEsRef.current = connectComfyStream(
        clientIdRef.current,
        (msg: ComfyUIProgress) => {
          if (msg.type === "progress" && msg.data) {
            setSegProgress(msg.data.value ?? 0);
            setSegProgressMax(msg.data.max ?? 0);
            setSegStage(`Segment ${segIdx + 1}: Lip sync step ${msg.data.value}/${msg.data.max}`);
          }
        }
      );

      // Queue workflow
      const response = await queuePrompt(workflow, clientIdRef.current);

      // Poll for completion (timeout: 5 minutes per segment)
      const result = await new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          if (lipSyncPollRef.current) clearInterval(lipSyncPollRef.current);
          resolve(null);
        }, 300000);

        lipSyncPollRef.current = setInterval(async () => {
          try {
            const history = await getHistory(response.prompt_id);
            if (history?.status?.completed) {
              if (lipSyncPollRef.current) clearInterval(lipSyncPollRef.current);
              clearTimeout(timeout);
              // Get output from VHS_VideoCombine node "10"
              const vhsOutput = history.outputs?.["10"];
              if (vhsOutput?.gifs?.[0]) {
                const gif = vhsOutput.gifs[0];
                resolve(getImageUrl(gif.filename, gif.subfolder || "", gif.type || "output"));
              } else {
                resolve(null);
              }
            }
          } catch { /* retry */ }
        }, 2000);
      });

      if (lipSyncEsRef.current) { lipSyncEsRef.current.close(); lipSyncEsRef.current = null; }

      if (result) {
        updateSegment(segIdx, { outputUrl: result });
        return result;
      }

      // Non-fatal: return original if lip sync fails
      updateSegment(segIdx, { error: "Lip sync timed out or failed" });
      return videoUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Lip sync failed";
      updateSegment(segIdx, { error: `LipSync: ${msg}` });
      return videoUrl;
    }
  }, []);

  const handleRelipSync = useCallback(async () => {
    const seg = configRef.current.segments[currentSegIdx];
    if (!seg?.outputUrl || !seg?.audioSliceFile) return;
    setRelipSyncing(true);
    try {
      const result = await runLipSyncForSegment(currentSegIdx, seg.outputUrl, seg.audioSliceFile);
      if (result !== seg.outputUrl) {
        updateSegment(currentSegIdx, { outputUrl: result, error: null });
        setConfig((prev) => ({ ...prev }));
      }
    } catch (err) {
      updateSegment(currentSegIdx, { error: `Re-lip-sync: ${err instanceof Error ? err.message : "Failed"}` });
    } finally {
      setRelipSyncing(false);
    }
  }, [currentSegIdx, runLipSyncForSegment, updateSegment, setConfig]);

  const handleGenerate = useCallback(async () => {
    cancelledRef.current = false;
    skipCurrentRef.current = false;
    adjustAfterCurrentRef.current = false;
    setPhase("generating");
    setPipelineError(null);
    setFinalOutputUrl(null);
    setLivePreviewUrl(null);

    const startIdx = resumeFromRef.current ?? 0;
    const endIdx = resumeToRef.current != null ? Math.min(resumeToRef.current, configRef.current.segments.length - 1) : configRef.current.segments.length - 1;
    resumeFromRef.current = null;
    resumeToRef.current = null;
    setResumeFromSegment(null);
    setResumeToSegment(null);

    // Reset only segments in the [startIdx, endIdx] range; preserve everything else
    setConfig((prev) => ({
      ...prev,
      segments: prev.segments.map((s, idx) =>
        idx < startIdx || idx > endIdx
          ? s // preserve segments outside the render range
          : {
              ...s,
              status: "pending" as const,
              outputUrl: null,
              lastFrameFile: null,
              error: null,
            }
      ),
    }));

    // Collect outputs from previously-completed segments (for final concatenation)
    const segmentOutputs: string[] = [];
    let lastFrameFile = "";
    for (let k = 0; k < startIdx; k++) {
      const prevSeg = configRef.current.segments[k];
      if (prevSeg?.outputUrl) segmentOutputs.push(prevSeg.outputUrl);
      if (prevSeg?.lastFrameFile) lastFrameFile = prevSeg.lastFrameFile;
    }

    // Generate each segment sequentially (startIdx through endIdx inclusive)
    for (let i = startIdx; i <= endIdx; i++) {
      if (cancelledRef.current) break;

      // Resolve source image based on chaining mode:
      //   "storyboard": always use storyboard-assigned image (no degradation)
      //   "chain": fall back to last generated frame (classic I2V chaining)
      //   "manual": only use user-uploaded sourceImage
      const seg = configRef.current.segments[i];
      const chainingMode = configRef.current.chainingMode || "chain";
      let sourceImage = "";
      if (chainingMode === "storyboard") {
        // Storyboard mode: always use the storyboard-assigned sourceImage.
        // Each segment is anchored by clean reference images, preventing quality degradation.
        sourceImage = seg.sourceImage;
      } else if (chainingMode === "chain") {
        // Chain mode: use user-uploaded sourceImage if present,
        // otherwise chain from last frame of previous segment.
        sourceImage = seg.sourceImage
          ? seg.sourceImage
          : i === 0
            ? ""
            : lastFrameFile;
      } else {
        // Manual mode: only use explicitly-set sourceImage
        sourceImage = seg.sourceImage;
      }

      // Reset mid-generation flags for this segment
      skipCurrentRef.current = false;
      adjustAfterCurrentRef.current = false;

      setPhase("generating");
      const result = await generateSegment(i, sourceImage);

      if (!result) {
        // Check if cancel-segment was requested mid-generation, pause in place for review
        if (skipCurrentRef.current) {
          skipCurrentRef.current = false;
          updateSegment(i, { status: "pending", error: "Cancelled by user, ready to re-generate" });
          setPhase("paused");
          setCurrentSegIdx(i);
          setSegStage(`Segment ${i + 1} cancelled, re-generate or continue to next`);

          await new Promise<void>((resolve) => {
            pauseResolverRef.current = resolve;
          });

          if (cancelledRef.current) break;

          // User chose re-gen: retry this segment
          if (regenRequestedRef.current) {
            regenRequestedRef.current = false;
            i--;
            continue;
          }
          // User chose continue: skip this segment and move to next
          continue;
        }
        // Check if regen was requested via interjection
        if (regenRequestedRef.current) {
          regenRequestedRef.current = false;
          i--; // retry this segment
          continue;
        }
        setPhase("error");
        setPipelineError(`Segment ${i + 1} failed`);
        return;
      }

      let outputUrl = result.outputUrl;

      // Lip sync post-processing (if enabled, per-segment timing, and segment has audio)
      let lipSyncError: string | null = null;
      if (configRef.current.lipSyncEnabled && configRef.current.lipSyncTiming === "per_segment" && seg.audioSliceFile) {
        const preLipSyncUrl = outputUrl;
        outputUrl = await runLipSyncForSegment(i, outputUrl, seg.audioSliceFile);
        if (outputUrl === preLipSyncUrl) {
          // Lip sync returned the original URL, it either failed or was skipped
          lipSyncError = configRef.current.segments[i]?.error || "Lip sync did not produce output";
          console.warn(`[Director] Segment ${i + 1}: Lip sync failed: ${lipSyncError}`);
        }
        updateSegment(i, { outputUrl });
      } else if (configRef.current.lipSyncEnabled && !seg.audioSliceFile) {
        console.warn(`[Director] Segment ${i + 1}: Lip sync enabled but no audioSliceFile, skipping`);
      }

      segmentOutputs.push(outputUrl);
      lastFrameFile = result.lastFrameFile;

      // Mark segment complete before potential pause (preserve lip sync error if any)
      updateSegment(i, { status: "complete", error: lipSyncError });

      // Mid-generation "Adjust Settings": force pause even if pauseBetweenSegments is off
      if (adjustAfterCurrentRef.current && !configRef.current.pauseBetweenSegments) {
        adjustAfterCurrentRef.current = false;
        setPhase("paused");
        setCurrentSegIdx(i);
        setSegStage(`Segment ${i + 1} complete, adjust settings, then continue`);

        await new Promise<void>((resolve) => {
          pauseResolverRef.current = resolve;
        });

        if (cancelledRef.current) break;

        if (regenRequestedRef.current) {
          regenRequestedRef.current = false;
          segmentOutputs.pop();
          i--;
          continue;
        }
      }

      // Pause for user interjection if enabled (including last segment so user can review lip sync / quality)
      if (configRef.current.pauseBetweenSegments) {
        setPhase("paused");
        setCurrentSegIdx(i);
        const isLast = i >= configRef.current.segments.length - 1;
        setSegStage(isLast
          ? `Segment ${i + 1} complete, review output, then continue to finalize`
          : `Segment ${i + 1} complete, review and continue when ready`);

        // Wait for user to click Continue or Re-generate
        await new Promise<void>((resolve) => {
          pauseResolverRef.current = resolve;
        });

        if (cancelledRef.current) break;

        // If user requested re-generation, go back and redo this segment
        if (regenRequestedRef.current) {
          regenRequestedRef.current = false;
          segmentOutputs.pop(); // remove this segment's output
          i--; // retry
          continue;
        }
      }
    }

    if (cancelledRef.current) {
      setPhase("idle");
      endRender();
      return;
    }

    // Concatenate all segments (store URL locally for foley use)
    let resolvedFinalUrl = "";
    if (segmentOutputs.length > 1) {
      setPhase("concatenating");
      setSegStage("Concatenating segments...");

      try {
        const concatRes = await fetch("/api/director/concatenate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoUrls: segmentOutputs,
            crossfadeFrames: configRef.current.crossfadeFrames,
            frameRate: configRef.current.frameRate,
          }),
        });

        if (!concatRes.ok) {
          const err = await concatRes.json().catch(() => ({ error: "Concatenation failed" }));
          throw new Error(err.error);
        }

        const data = await concatRes.json();
        resolvedFinalUrl = data.outputUrl;
        setFinalOutputUrl(resolvedFinalUrl);
      } catch (err) {
        setPhase("error");
        setPipelineError(err instanceof Error ? err.message : "Concatenation failed");
        return;
      }
    } else if (segmentOutputs.length === 1) {
      resolvedFinalUrl = segmentOutputs[0];
      setFinalOutputUrl(resolvedFinalUrl);
    }

    // ── Post-assembly Lip Sync (runs once on the final concatenated video) ──
    if (
      configRef.current.lipSyncEnabled &&
      configRef.current.lipSyncTiming === "post_assembly" &&
      configRef.current.masterAudioFile &&
      resolvedFinalUrl
    ) {
      const audioPath = `${comfyBaseDirRef.current}/input/${configRef.current.masterAudioFile}`;
      const preLipSyncUrl = resolvedFinalUrl;
      resolvedFinalUrl = await runLipSyncForSegment(0, resolvedFinalUrl, audioPath);
      if (resolvedFinalUrl !== preLipSyncUrl) {
        setFinalOutputUrl(resolvedFinalUrl);
      } else {
        console.warn("[Director] Post-assembly lip sync did not produce output, using original");
      }
    }

    // ── Foley pass (post-processing audio generation) ──
    const cfg = configRef.current;

    if (cfg.audioMode === "foley" && cfg.foleyPrompt.trim() && resolvedFinalUrl) {
      setPhase("foley");
      setSegStage("Foley: Staging video frames...");
      setSegProgress(0);
      setSegProgressMax(0);

      try {
        const videoUrlForFoley = resolvedFinalUrl;

        // Stage frames for foley
        const stageRes = await fetch("/api/director/foley-stage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoUrl: videoUrlForFoley }),
        });
        if (!stageRes.ok) {
          const err = await stageRes.json().catch(() => ({}));
          throw new Error(err.error || "Failed to stage frames for foley");
        }
        const stageData = await stageRes.json();

        // Make room for the Foley model. Measured + strategy-aware (see lib/vram-guard.ts):
        // never an unconditional flush; reports its decision through the segment stage label.
        await ensureVramForStage("foley", (msg) => setSegStage(msg));

        // Build foley workflow using GenerationParams shape
        const foleyParams: GenerationParams = {
          ...DEFAULT_PARAMS,
          fps: stageData.fps || cfg.frameRate,
          frames: stageData.frameCount || Math.round(cfg.frameRate * (stageData.duration || 4)),
          foleyPrompt: cfg.foleyPrompt,
          foleyNegativePrompt: cfg.foleyNegativePrompt,
          foleySteps: cfg.foleySteps,
          foleyCfg: cfg.foleyCfg,
          foleySampler: cfg.foleySampler,
          seed: cfg.randomSeed ? Math.floor(Math.random() * 2 ** 32) : cfg.seed,
          randomSeed: cfg.randomSeed,
        };
        const foleyWorkflow = buildFoleyAudioWorkflow(foleyParams, stageData.directory);

        // Open SSE for foley progress
        if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }
        foleyEsRef.current = connectComfyStream(
          clientIdRef.current,
          (msg: ComfyUIProgress) => {
            if (msg.type === "progress" && msg.data) {
              setSegProgress(msg.data.value ?? 0);
              setSegProgressMax(msg.data.max ?? 0);
              setSegStage(`Foley: Step ${msg.data.value}/${msg.data.max}`);
            }
          }
        );

        setSegStage("Foley: Generating audio...");
        const foleyResponse = await queuePrompt(foleyWorkflow, clientIdRef.current);

        // Poll for foley completion
        const foleyResult = await new Promise<{ audioFilename: string; audioSubfolder: string } | null>((resolve) => {
          const timeout = setTimeout(() => {
            if (foleyPollRef.current) clearInterval(foleyPollRef.current);
            resolve(null);
          }, 600000); // 10 min timeout

          foleyPollRef.current = setInterval(async () => {
            try {
              const history = await getHistory(foleyResponse.prompt_id);
              if (history?.status?.completed) {
                if (foleyPollRef.current) clearInterval(foleyPollRef.current);
                clearTimeout(timeout);
                if (history.outputs) {
                  for (const nodeOutput of Object.values(history.outputs)) {
                    const no = nodeOutput as Record<string, unknown>;
                    const audioArr = no.audio as Array<{ filename: string; subfolder: string }> | undefined;
                    if (audioArr && audioArr.length > 0) {
                      resolve({ audioFilename: audioArr[0].filename, audioSubfolder: audioArr[0].subfolder });
                      return;
                    }
                  }
                }
                resolve(null);
              }
            } catch { /* keep polling */ }
          }, 2000);
        });

        if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }

        if (foleyResult && cancelledRef.current === false) {
          // Merge foley audio with video
          setSegStage("Foley: Merging audio into video...");

          // Determine video source for merge
          const videoSource = segmentOutputs.length > 1
            ? (() => {
                // Parse concat output URL to get ComfyUI path
                try {
                  const parsed = new URL(videoUrlForFoley, "http://localhost");
                  return {
                    type: "comfyui" as const,
                    filename: parsed.searchParams.get("filename") || "",
                    subfolder: parsed.searchParams.get("subfolder") || "",
                  };
                } catch {
                  return { type: "upload" as const, path: videoUrlForFoley };
                }
              })()
            : (() => {
                try {
                  const parsed = new URL(segmentOutputs[0], "http://localhost");
                  return {
                    type: "comfyui" as const,
                    filename: parsed.searchParams.get("filename") || "",
                    subfolder: parsed.searchParams.get("subfolder") || "",
                  };
                } catch {
                  return { type: "upload" as const, path: segmentOutputs[0] };
                }
              })();

          const mergeRes = await fetch("/api/foley-merge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videoSource,
              audioFilename: foleyResult.audioFilename,
              audioSubfolder: foleyResult.audioSubfolder,
            }),
          });

          if (mergeRes.ok) {
            // foley-merge returns binary MP4: create blob URL
            const blob = await mergeRes.blob();
            const mergedUrl = URL.createObjectURL(blob);
            setFinalOutputUrl(mergedUrl);
          }
          // If merge fails, keep the silent video as finalOutputUrl
        }
      } catch (err) {
        // Foley failure is non-fatal: keep the silent video
        console.warn("Foley pass failed:", err);
        if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }
        if (foleyPollRef.current) { clearInterval(foleyPollRef.current); foleyPollRef.current = null; }
      }
    }

    setPhase("complete");
    setSegStage("Director pipeline complete!");
    endRender();
  }, [generateSegment, setConfig, startRender, updateRenderProgress, endRender]);

  // Generate a single specific segment (outside the full pipeline loop)
  const handleGenerateSingle = useCallback(async (segIdx: number) => {
    const seg = configRef.current.segments[segIdx];
    if (!seg || !seg.prompt.trim()) return;

    cancelledRef.current = false;
    skipCurrentRef.current = false;
    setPhase("generating");
    setPipelineError(null);
    setLivePreviewUrl(null);

    // Resolve source image based on chaining mode and timeline position
    const chainingMode = configRef.current.chainingMode || "chain";
    let sourceImage = "";
    if (chainingMode === "storyboard") {
      sourceImage = seg.sourceImage;
    } else if (chainingMode === "chain") {
      if (seg.sourceImage) {
        sourceImage = seg.sourceImage;
      } else if (segIdx > 0) {
        const prevSeg = configRef.current.segments[segIdx - 1];
        sourceImage = prevSeg?.lastFrameFile || "";
      }
    } else {
      sourceImage = seg.sourceImage;
    }

    const result = await generateSegment(segIdx, sourceImage);

    if (!result) {
      if (skipCurrentRef.current) {
        skipCurrentRef.current = false;
        updateSegment(segIdx, { status: "pending", error: "Cancelled by user" });
      } else {
        updateSegment(segIdx, { status: "error", error: "Generation failed" });
      }
      setPhase("idle");
      endRender();
      return;
    }

    let outputUrl = result.outputUrl;

    // Lip sync if applicable
    if (configRef.current.lipSyncEnabled && configRef.current.lipSyncTiming === "per_segment" && seg.audioSliceFile) {
      outputUrl = await runLipSyncForSegment(segIdx, outputUrl, seg.audioSliceFile);
      updateSegment(segIdx, { outputUrl });
    }

    updateSegment(segIdx, { status: "complete", lastFrameFile: result.lastFrameFile });
    setPhase("idle");
    setSegStage(`Segment ${segIdx + 1} generated`);
    endRender();
  }, [generateSegment, runLipSyncForSegment, updateSegment, endRender]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    skipCurrentRef.current = false;
    adjustAfterCurrentRef.current = false;
    esRef.current?.close();
    if (foleyEsRef.current) { foleyEsRef.current.close(); foleyEsRef.current = null; }
    if (foleyPollRef.current) { clearInterval(foleyPollRef.current); foleyPollRef.current = null; }
    // If paused, resolve the pause so the loop can exit
    pauseResolverRef.current?.();
    pauseResolverRef.current = null;
    setPhase("idle");
    setSegStage("Cancelled");
    endRender();
    import("@/lib/comfyui-api").then(({ interruptGeneration }) => interruptGeneration()).catch(() => {});
  }, [endRender]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  const isPaused = phase === "paused";
  const isRunning = phase !== "idle" && phase !== "complete" && phase !== "error" && phase !== "paused";

  const activeRes = LTX2_RESOLUTION_PRESETS.find(
    (p) => p.width === config.width && p.height === config.height
  );

  const totalFrames = config.segments.reduce((sum, s) => sum + s.numFrames, 0);
  const totalDuration = totalFrames / config.frameRate;
  const completedSegs = config.segments.filter((s) => s.status === "complete").length;

  const progressPct = segProgressMax > 0 ? Math.round((segProgress / segProgressMax) * 100) : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-blue-500/30 bg-blue-500/5">
        <div className="flex items-center gap-2">
          <Clapperboard className={cc.iconBlue} />
          {/* Model version toggle */}
          <div className="flex items-center bg-muted/30 rounded-md p-0.5">
            {(["2.0", "2.3"] as LTX2ModelVersion[]).map((v) => (
              <button
                key={v}
                onClick={() => {
                  if (v === (config.modelVersion || "2.0")) return;
                  setConfig((prev) => ({ ...prev, ...getLTX2ModelDefaults(v) }));
                }}
                disabled={phase !== "idle" && phase !== "complete" && phase !== "error"}
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
                disabled={phase !== "idle" && phase !== "complete" && phase !== "error"}
                className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                  (config.pipelineMode === "official" ? "official" : "alternative") === m
                    ? m === "official"
                      ? "bg-emerald-500/20 text-emerald-400 shadow-sm"
                      : "bg-blue-500/20 text-blue-400 shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {m === "official" ? "Official" : "Alternative"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {subTab === "main" && (
            <span className="text-[9px] text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded">
              {config.segments.length} segments &middot; {totalDuration.toFixed(1)}s total
            </span>
          )}
          {comfyConnected === true && (
            <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> ComfyUI
            </span>
          )}
          {comfyConnected === false && (
            <span className={cc.statusOffline}>
              <span className={cc.statusOfflineDot} /> Offline
            </span>
          )}
        </div>
      </div>

      {/* Sub-tab navigation */}
      <div className="flex border-b border-border/30 bg-muted/5">
        <button
          onClick={() => setSubTab("main")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors border-b-2 ${
            subTab === "main"
              ? "border-blue-500 text-blue-400 bg-blue-500/5"
              : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10"
          }`}
        >
          <Film className="w-3 h-3 inline mr-1" />
          Main Pipeline
        </button>
        <button
          onClick={() => setSubTab("v2a")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors border-b-2 ${
            subTab === "v2a"
              ? "border-violet-500 text-violet-400 bg-violet-500/5"
              : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10"
          }`}
        >
          <Volume2 className="w-3 h-3 inline mr-1" />
          Audio for Video
        </button>
        <button
          onClick={() => setSubTab("combine")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors border-b-2 ${
            subTab === "combine"
              ? "border-teal-500 text-teal-400 bg-teal-500/5"
              : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10"
          }`}
        >
          <Combine className="w-3 h-3 inline mr-1" />
          Combine
        </button>
        <button
          onClick={() => setSubTab("script")}
          className={`flex-1 py-2 text-[10px] font-medium transition-colors border-b-2 ${
            subTab === "script"
              ? "border-cyan-500 text-cyan-400 bg-cyan-500/5"
              : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/10"
          }`}
        >
          <Wand2 className="w-3 h-3 inline mr-1" />
          Script Writer
        </button>
      </div>

      {/* V2A sub-tab */}
      {subTab === "v2a" && (
        <AudioForVideo directorConfig={config} />
      )}

      {/* Combine sub-tab */}
      {subTab === "combine" && (
        <SegmentCombiner />
      )}

      {/* Script Writer sub-tab */}
      {subTab === "script" && (
        <ScriptWriter
          onPopulateSegments={(segments) => {
            const newSegments = segments.map((seg, i) => ({
              id: `script-${Date.now()}-${i}`,
              prompt: seg.prompt,
              dialogue: seg.dialogue || "",
              numFrames: seg.frames,
              sourceImage: "",
              sourceImagePreview: "",
              endImage: "",
              endImagePreview: "",
              status: "pending" as const,
              outputUrl: null,
              lastFrameFile: null,
              error: null,
            }));
            setConfig((prev) => ({ ...prev, segments: newSegments }));
            setSubTab("main");
          }}
        />
      )}

      {/* Main pipeline sub-tab */}
      {subTab === "main" && <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Click-to-enlarge lightbox (keyframe pool / energy buckets / segment frames), ← → cycles the group */}
        {lightbox && (
          <ImageLightbox
            images={lightbox.images}
            index={lightbox.index}
            onClose={() => setLightbox(null)}
            onNavigate={(i) => setLightbox((lb) => (lb ? { ...lb, index: i } : lb))}
          />
        )}
        {/* Per-segment duration re-time confirmation (raised only when a master-audio
            timeline is active; re-slices the song for the chosen propagation mode). */}
        <Dialog open={!!durationChange} onOpenChange={(o) => { if (!o && !resegmenting) cancelDurationChange(); }}>
          {/* No `relative`: DialogContent is fixed+centered; `relative` would let tailwind-merge
              drop `fixed` and push it to the page bottom. */}
          <DialogContent showCloseButton={false}>
            {!resegmenting && (
              <button type="button" onClick={cancelDurationChange} aria-label="Cancel re-time"
                title="Cancel - keep the current duration"
                className="absolute top-4 right-4 rounded-xs text-red-500 hover:text-red-400 opacity-90 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-red-500/50">
                <X className="w-4 h-4" />
              </button>
            )}
            {durationChange && (() => {
              const c = configRef.current;
              const fps = c.frameRate;
              const editedSeg = c.segments[durationChange.segIdx];
              const oldSecs = editedSeg ? ltx2DurationForFrames(editedSeg.numFrames, fps) : 0;
              const newSecs = ltx2DurationForFrames(durationChange.newFrames, fps);
              const following = Math.max(0, c.segments.length - durationChange.segIdx - 1);
              return (
                <>
                  <DialogHeader>
                    <DialogTitle>Re-time segment {durationChange.segIdx + 1}?</DialogTitle>
                    <DialogDescription asChild>
                      <div className="space-y-2 text-left">
                        <p>
                          Changing this segment from <span className="font-mono">{oldSecs.toFixed(2)}s</span> to{" "}
                          <span className="font-mono">{newSecs.toFixed(2)}s</span> ({durationChange.newFrames} frames)
                          shifts the rest of the song. The master audio will be re-sliced and re-mapped for every
                          following segment, and the number of trailing segments may change
                          {following > 0 ? ` (currently ${following} follow this one).` : "."}
                        </p>
                        <p className="text-[12px] text-muted-foreground">
                          A longer duration reduces how many segments remain, displaced images return to your keyframe
                          pool (they are not deleted). A shorter duration adds new segments with no image pre-selected.
                        </p>
                        <p className="text-[12px]">Apply the new duration to:</p>
                      </div>
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter className="sm:justify-between gap-2">
                    <Button variant="outline" disabled={resegmenting} onClick={() => applyDurationChange("this")}>
                      Only this segment
                    </Button>
                    <Button disabled={resegmenting} onClick={() => applyDurationChange("following")}>
                      {resegmenting ? (<><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Re-slicing…</>) : "This + all following"}
                    </Button>
                  </DialogFooter>
                </>
              );
            })()}
          </DialogContent>
        </Dialog>
        {/* ── Storyboard Images: kept CENTERED; the keyframe pool & drag-ordering need room. ── */}
        <div className={cc.card}>
          <div className="flex items-center justify-between">
            <Label className={cc.sectionLabel}>
              <Film className="w-3 h-3" /> Storyboard Images
            </Label>
            <span className="text-[8px] text-muted-foreground/50">
              {config.storyboardImages.length} keyframes &middot; {config.chainingMode} chaining
            </span>
          </div>

          {/* Storyboard images */}
          <div className="space-y-1">
            <Label className={cc.fieldLabel}>Keyframe Images</Label>
            <div className="flex flex-wrap gap-1.5">
              {config.storyboardImages.map((sb, idx) => (
                <div
                  key={sb.id}
                  className={`relative group w-16 h-16 cursor-grab active:cursor-grabbing ${
                    dragSbIdx === idx ? "opacity-40" : dragOverSbIdx === idx ? cc.dragRing : ""
                  }`}
                  draggable={!isRunning}
                  onDragStart={(e) => {
                    setDragSbIdx(idx);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => { e.preventDefault(); setDragOverSbIdx(idx); }}
                  onDragLeave={() => setDragOverSbIdx(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragSbIdx !== null && dragSbIdx !== idx) {
                      setConfig((prev) => {
                        const imgs = [...prev.storyboardImages];
                        const [moved] = imgs.splice(dragSbIdx, 1);
                        imgs.splice(idx, 0, moved);
                        return { ...prev, storyboardImages: imgs };
                      });
                    }
                    setDragSbIdx(null);
                    setDragOverSbIdx(null);
                  }}
                  onDragEnd={() => { setDragSbIdx(null); setDragOverSbIdx(null); }}
                >
                  {sb.preview ? (
                    <img
                      src={sb.preview}
                      alt={sb.label || `Keyframe ${idx + 1}`}
                      className={cc.sbImg}
                      draggable={false}
                      onClick={() => openLightbox(config.storyboardImages, sb.id)}
                      title="Click to enlarge · ← → to cycle"
                    />
                  ) : (
                    <div className={cc.sbImgEmpty}>
                      {idx + 1}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (sb.preview) URL.revokeObjectURL(sb.preview);
                      setConfig((prev) => ({
                        ...prev,
                        storyboardImages: prev.storyboardImages.filter((_, i) => i !== idx),
                      }));
                    }}
                    className="absolute -top-1 -right-1 bg-black/80 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    disabled={isRunning}
                  >
                    <X className="w-2.5 h-2.5 text-red-400" />
                  </button>
                  <span className={cc.sbTag}>
                    {sb.label || `#${idx + 1}`}
                  </span>
                </div>
              ))}
              {/* Add keyframe button */}
              <label className={cc.sbAddTile}>
                <Plus className={cc.sbAddIcon} />
                <span className={cc.sbAddText}>Add</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  multiple
                  disabled={isRunning}
                  onChange={async (e) => {
                    const files = Array.from(e.target.files || []);
                    if (!files.length) return;
                    const newImages = await Promise.all(
                      files.map(async (file) => {
                        const filename = await uploadImage(file);
                        const preview = URL.createObjectURL(file);
                        return {
                          id: `sb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                          image: filename,
                          preview,
                          label: "",
                        };
                      })
                    );
                    setConfig((prev) => ({
                      ...prev,
                      storyboardImages: [...prev.storyboardImages, ...newImages],
                    }));
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {config.storyboardImages.length > 0 && (
              <div className="flex gap-1.5">
                {config.storyboardImages.length > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className={cc.outlineBtnXs}
                    disabled={isRunning}
                    onClick={() => {
                      setConfig((prev) => {
                        const shuffled = [...prev.storyboardImages];
                        for (let i = shuffled.length - 1; i > 0; i--) {
                          const j = Math.floor(Math.random() * (i + 1));
                          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                        }
                        return { ...prev, storyboardImages: shuffled };
                      });
                    }}
                    title="Randomize the order of storyboard keyframe images"
                  >
                    <Shuffle className="w-3 h-3" /> Shuffle Images
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[9px] px-2 border-red-500/30 text-red-400 hover:bg-red-500/10"
                  disabled={isRunning}
                  onClick={() => {
                    config.storyboardImages.forEach((sb) => {
                      if (sb.preview) URL.revokeObjectURL(sb.preview);
                    });
                    setConfig((prev) => ({ ...prev, storyboardImages: [] }));
                  }}
                  title="Remove all storyboard keyframe images"
                >
                  <Trash2 className="w-3 h-3" /> Clear All
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Pipeline config → projected into the modern shell's "Workflow Controls" dock.
            Falls back to inline when the dock is collapsed, so controls are never lost. */}
        <WorkflowControls><div className="space-y-4">
        {/* ── Storyboard & Audio Settings ── */}
        <div className={cc.card}>
          <div className="flex items-center justify-between">
            <Label className={cc.sectionLabel}>
              <Film className="w-3 h-3" /> Storyboard &amp; Audio Settings
            </Label>
            <span className="text-[8px] text-muted-foreground/50">
              {config.storyboardImages.length} keyframes &middot; {config.chainingMode} chaining
            </span>
          </div>

          {/* Schedule mode + Chaining mode */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className={cc.fieldLabel}>Schedule</Label>
              <select
                value={config.storyboardSchedule}
                onChange={(e) => setConfig((prev) => ({ ...prev, storyboardSchedule: e.target.value as "pair" | "single" | "manual" }))}
                className="w-full text-[10px] bg-background border border-border/30 rounded px-1.5 py-1"
                disabled={isRunning}
              >
                <option value="pair">Pair (overlapping)</option>
                <option value="single">Single (one per seg)</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className={cc.fieldLabel}>Chaining</Label>
              <select
                value={config.chainingMode}
                onChange={(e) => setConfig((prev) => ({ ...prev, chainingMode: e.target.value as "storyboard" | "chain" | "manual" }))}
                className="w-full text-[10px] bg-background border border-border/30 rounded px-1.5 py-1"
                disabled={isRunning}
              >
                <option value="storyboard">Storyboard (no degradation)</option>
                <option value="chain">Chain (last frame)</option>
                <option value="manual">Manual</option>
              </select>
            </div>
          </div>

          {/* Master Audio upload (Music Video mode) */}
          <div className="space-y-1">
            <Label className={cc.fieldLabelRow}>
              <FileAudio className="w-2.5 h-2.5" /> Master Audio (Music Video)
            </Label>
            {config.masterAudioFile ? (
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-muted-foreground flex-1 truncate">
                  {config.masterAudioName || config.masterAudioFile}
                  {config.masterAudioDuration ? ` (${config.masterAudioDuration.toFixed(1)}s)` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => setConfig((prev) => ({
                    ...prev,
                    masterAudioFile: undefined,
                    masterAudioName: undefined,
                    masterAudioPreview: undefined,
                    masterAudioDuration: undefined,
                    autoSegmentFromAudio: false,
                  }))}
                  disabled={isRunning}
                  className="text-red-400/60 hover:text-red-400"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <label className={cc.uploadTile}>
                <Upload className="w-3 h-3" /> Upload audio track
                <input
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  disabled={isRunning}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    console.log(`[Director] Uploading audio: "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
                    setUploadProgress(0);
                    try {
                      const filename = await uploadImage(file, (pct) => {
                        setUploadProgress(pct);
                        if (pct % 20 === 0) console.log(`[Director] Upload progress: ${pct}%`);
                      });
                      setUploadProgress(null);
                      console.log(`[Director] Upload complete: "${filename}"`);
                      const preview = URL.createObjectURL(file);
                      setConfig((prev) => ({
                        ...prev,
                        masterAudioFile: filename,
                        masterAudioName: file.name,
                        masterAudioPreview: preview,
                        autoSegmentFromAudio: true,
                      }));
                      e.target.value = "";
                      // Auto-analyze for waveform + energy + beats right after upload
                      console.log("[Director] Analyzing audio for waveform + energy + beats...");
                      const analyzeResp = await fetch("/api/director/audio-analyze", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ audioFile: filename }),
                      });
                      if (analyzeResp.ok) {
                        const analysis = await analyzeResp.json();
                        console.log(`[Director] Audio analysis complete: ${analysis.duration?.toFixed(1)}s, ${analysis.beats?.length || 0} beats`);
                        setConfig((prev) => ({
                          ...prev,
                          waveformPeaks: analysis.peaks,
                          energyData: analysis.energy,
                          beatMarkers: analysis.beats,
                          masterAudioDuration: analysis.duration,
                          segments: computeSegmentEnergy(prev.segments, analysis.energy, prev.energyHighThreshold, prev.energyMediumThreshold),
                        }));
                      }
                    } catch (err) {
                      setUploadProgress(null);
                      console.error("[Director] Audio upload/analyze failed:", err);
                      alert(`Upload failed: ${err instanceof Error ? err.message : "Unknown error"}`);
                    }
                  }}
                />
              </label>
            )}
            {uploadProgress !== null && (
              <div className="w-full space-y-1">
                <div className="flex items-center gap-2">
                  <Loader2 className={cc.spinnerBlue} />
                  <span className="text-[9px] text-blue-400">
                    {uploadProgress < 100
                      ? `Uploading... ${uploadProgress}%`
                      : "Analyzing waveform & energy..."}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-blue-950/50 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Frame rate + Segment duration + Prepare button */}
          {config.masterAudioFile && (
            <div className="space-y-1">
            <div className="flex items-end gap-2">
              <div className="w-24 space-y-1">
                <Label className={cc.fieldLabel}>Frame Rate</Label>
                <select
                  value={config.frameRate}
                  onChange={(e) => setConfig((prev) => ({ ...prev, frameRate: parseInt(e.target.value, 10) || 24 }))}
                  className="w-full text-[10px] bg-background border border-border/30 rounded px-1.5 py-1"
                  disabled={isRunning}
                >
                  <option value={24}>24 fps</option>
                  <option value={25}>25 fps</option>
                  <option value={30}>30 fps</option>
                </select>
              </div>
              <div className="flex-1 space-y-1">
                <Label className={cc.fieldLabel}>Segment Duration (s)</Label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={0.5}
                  value={config.segmentDuration}
                  onChange={(e) => setConfig((prev) => ({ ...prev, segmentDuration: parseFloat(e.target.value) || 4 }))}
                  className="w-full text-[10px] bg-background border border-border/30 rounded px-1.5 py-1"
                  disabled={isRunning}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className={cc.outlineBtn}
                disabled={isRunning || !config.masterAudioFile}
                onClick={async () => {
                  try {
                    // Pin the segment length to the LTX 8n+1 frame math at the chosen fps so
                    // that the audio slice duration EXACTLY equals the video duration
                    // (numFrames/fps). `stepDuration` advances by the trimmed contribution
                    // (numFrames-1)/fps so the song stays contiguous after the assembler drops
                    // the 1-frame guide overlap. This eliminates the 9.9s-vs-10s drift at any fps.
                    const fps = config.frameRate;
                    const pinnedFrames = ltx2FrameCountForDuration(config.segmentDuration, fps);
                    const sliceDuration = pinnedFrames / fps;              // exact video duration
                    const stepDuration = (pinnedFrames - 1) / fps;         // contiguous after overlap trim
                    // Slice audio via API
                    const resp = await fetch("/api/director/audio-slice", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        masterAudioFile: config.masterAudioFile,
                        sliceDuration,
                        stepDuration,
                      }),
                    });
                    if (!resp.ok) {
                      const err = await resp.json().catch(() => ({ error: "Audio slice failed" }));
                      alert(err.error);
                      return;
                    }
                    const data = await resp.json();
                    // Preserve existing prompts where possible
                    const existingPrompts = config.segments.map((s) => s.prompt);
                    // Generate segments from audio slices + storyboard. Full-length slices snap
                    // back to `pinnedFrames`; only a shorter trailing slice gets its own count.
                    const newSegments = data.segments.map((slice: { audioFile: string; startTime: number; endTime: number; duration: number }, i: number) => {
                      const numFrames = ltx2FrameCountForDuration(slice.duration, fps);
                      return createDirectorSegment({
                        prompt: existingPrompts[i] || "",
                        numFrames,
                        audioSliceFile: slice.audioFile,
                        audioStartTime: slice.startTime,
                        audioEndTime: slice.endTime,
                      });
                    });
                    // Apply storyboard schedule
                    const scheduled = config.storyboardImages.length > 0 && config.storyboardSchedule !== "manual"
                      ? applyStoryboardSchedule(newSegments, config.storyboardImages, config.storyboardSchedule)
                      : newSegments;
                    setConfig((prev) => ({
                      ...prev,
                      masterAudioDuration: data.totalDuration,
                      autoSegmentFromAudio: true,
                      segments: scheduled,
                    }));

                    // Auto-analyze audio for waveform + energy + beats
                    try {
                      const analyzeResp = await fetch("/api/director/audio-analyze", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ audioFile: config.masterAudioFile }),
                      });
                      if (analyzeResp.ok) {
                        const analysis = await analyzeResp.json();
                        setConfig((prev) => ({
                          ...prev,
                          waveformPeaks: analysis.peaks,
                          energyData: analysis.energy,
                          beatMarkers: analysis.beats,
                          masterAudioDuration: analysis.duration,
                          segments: computeSegmentEnergy(prev.segments, analysis.energy, prev.energyHighThreshold, prev.energyMediumThreshold),
                        }));
                      }
                    } catch {
                      // Audio analysis is non-critical: waveform just won't show
                    }
                  } catch (err) {
                    alert(err instanceof Error ? err.message : "Failed to prepare segments");
                  }
                }}
              >
                <Wand2 className="w-3 h-3 mr-1" /> Prepare Segments
              </Button>
            </div>
            {(() => {
              const fps = config.frameRate;
              const pinnedFrames = ltx2FrameCountForDuration(config.segmentDuration, fps);
              const segDur = pinnedFrames / fps;
              const step = (pinnedFrames - 1) / fps;
              const trackLen = config.masterAudioDuration || 0;
              const segCount = trackLen > 0 && step > 0 ? Math.ceil(trackLen / step) : 0;
              return (
                <p className="text-[9px] text-blue-300/70 leading-tight">
                  Pinned to LTX frames: <span className="font-mono">{pinnedFrames}f = {segDur.toFixed(2)}s</span>/segment @ {fps}fps
                  {segCount > 0 && <> &middot; ~{segCount} segments for {trackLen.toFixed(1)}s track</>}
                </p>
              );
            })()}
            </div>
          )}

          <p className="text-[8px] text-muted-foreground/40 leading-tight">
            Upload keyframe images to anchor visual consistency. In &ldquo;Pair&rdquo; mode, each segment transitions between
            consecutive images (img1→img2, img2→img3, …). Upload a master audio to auto-slice into segments for music video generation.
          </p>
        </div>

        {/* ── Waveform Timeline ── */}
        {config.masterAudioFile && config.waveformPeaks && config.waveformPeaks.length > 0 && (
          <div className="rounded-lg border border-blue-500/20 bg-black/20 p-2 space-y-1">
            <Label className="text-[9px] text-blue-400/70 flex items-center gap-1">
              <BarChart3 className="w-2.5 h-2.5" /> Audio Timeline
              {config.beatMarkers && (
                <span className={cc.hint50Ml}>{config.beatMarkers.length} onsets detected</span>
              )}
            </Label>
            <WaveformTimeline
              peaks={config.waveformPeaks}
              duration={config.masterAudioDuration || 0}
              segments={config.segments.map((seg) => ({
                id: seg.id,
                startTime: seg.audioStartTime || 0,
                endTime: seg.audioEndTime || 0,
                label: seg.prompt ? seg.prompt.slice(0, 20) : undefined,
              }))}
              beats={config.beatMarkers}
              energy={config.energyData}
              height={72}
              onSegmentClick={(idx) => {
                // Scroll to and highlight the clicked segment card
                const el = document.getElementById(`director-seg-${idx}`);
                if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            />
          </div>
        )}

        {/* ── Auto-Prompt (Music Video) ── */}
        {config.masterAudioFile && config.energyData && config.energyData.length > 0 && (
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-blue-400 font-medium"
                onClick={() => setAutoPromptExpanded(!autoPromptExpanded)}
              >
                {autoPromptExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <Sparkles className="w-3 h-3" /> Auto-Prompt
              </button>
              <span className="text-[7px] text-muted-foreground/40">
                fills empty prompts based on audio energy
              </span>
            </div>
            {autoPromptExpanded && (<>

            {/* Character description */}
            <div className="space-y-1">
              <Label className="text-[9px] text-blue-400/70 flex items-center gap-1">
                <User className="w-2.5 h-2.5" /> Character Description
              </Label>
              <input
                type="text"
                placeholder="e.g. A woman with long dark hair in a black dress"
                value={config.characterDescription}
                onChange={(e) => setConfig((prev) => ({ ...prev, characterDescription: e.target.value }))}
                className="w-full text-[10px] bg-background border border-border/30 rounded px-2 py-1.5 placeholder:text-muted-foreground/30"
                disabled={isRunning}
              />
              <p className="text-[7px] text-muted-foreground/40">
                Replaces {"{character}"} in prompt templates. Leave blank for generic &ldquo;a performer&rdquo;.
              </p>
            </div>

            {/* Music Genre + Subject Count selectors */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[9px] text-blue-400/70">Music Genre</Label>
                <select
                  value={config.musicGenre || "generic"}
                  onChange={(e) => {
                    const genre = e.target.value as MusicGenre;
                    const subjects = config.subjectCount || "one";
                    setConfig((prev) => ({
                      ...prev,
                      musicGenre: genre,
                      promptTemplates: getGenreTemplates(genre, subjects),
                    }));
                  }}
                  disabled={isRunning}
                  className="w-full h-7 rounded border border-blue-500/30 bg-background px-2 text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                >
                  {MUSIC_GENRE_OPTIONS.map((g) => (
                    <option key={g.value} value={g.value}>{g.label}</option>
                  ))}
                </select>
                <p className="text-[7px] text-muted-foreground/40">
                  {MUSIC_GENRE_OPTIONS.find((g) => g.value === (config.musicGenre || "generic"))?.description}
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-[9px] text-blue-400/70">Subjects in Frame</Label>
                <select
                  value={config.subjectCount || "one"}
                  onChange={(e) => {
                    const subjects = e.target.value as SubjectCount;
                    const genre = config.musicGenre || "generic";
                    setConfig((prev) => ({
                      ...prev,
                      subjectCount: subjects,
                      promptTemplates: getGenreTemplates(genre, subjects),
                    }));
                  }}
                  disabled={isRunning}
                  className="w-full h-7 rounded border border-blue-500/30 bg-background px-2 text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                >
                  {SUBJECT_COUNT_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
                <p className="text-[7px] text-muted-foreground/40">
                  Drives solo close-up framing vs. group/crew framing.
                </p>
              </div>
            </div>

            {/* Prompt templates preview */}
            <div className="space-y-1">
              <Label className="text-[9px] text-blue-400/70">Energy Templates (genre-aware)</Label>
              <div className="grid grid-cols-3 gap-1">
                {(config.promptTemplates || getGenreTemplates(config.musicGenre || "generic", config.subjectCount || "one")).map((t) => (
                  <div
                    key={t.id}
                    className={`rounded border p-1.5 text-[8px] leading-tight ${
                      t.energyLevel === "high"
                        ? "border-red-500/30 bg-red-500/5 text-red-400/70"
                        : t.energyLevel === "medium"
                          ? "border-amber-500/30 bg-amber-500/5 text-amber-400/70"
                          : "border-emerald-500/30 bg-emerald-500/5 text-emerald-400/70"
                    }`}
                  >
                    <div className="font-medium mb-0.5">{t.label}</div>
                    <div className="text-[7px] text-muted-foreground/50 line-clamp-2">{t.prompt}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Auto-fill button */}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] px-3 border-blue-500/30 text-blue-400 hover:bg-blue-500/10"
                disabled={isRunning || !config.energyData?.length}
                onClick={() => {
                  // Always resolve from current genre+subjectCount so the user gets the latest selection,
                  // even if config.promptTemplates is stale.
                  const templates = getGenreTemplates(
                    config.musicGenre || "generic",
                    config.subjectCount || "one",
                  );
                  const filled = autoFillSegmentPrompts(
                    config.segments,
                    config.energyData || [],
                    templates,
                    config.characterDescription,
                    config.energyHighThreshold,
                    config.energyMediumThreshold,
                  );
                  setConfig((prev) => ({ ...prev, promptTemplates: templates, segments: filled }));
                }}
              >
                <Sparkles className="w-3 h-3 mr-1" /> Auto-Fill Empty Prompts
              </Button>
              <span className="text-[7px] text-muted-foreground/40">
                {config.segments.filter((s) => !s.prompt?.trim()).length} of {config.segments.length} segments need prompts
              </span>
            </div>
            </>)}
          </div>
        )}

        {/* ── Energy Sensitivity & Analysis ── */}
        {config.masterAudioFile && config.energyData && config.energyData.length > 0 && (
          <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-3">
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="flex items-center gap-1 text-[11px] text-cyan-400 font-medium"
                onClick={() => setEnergyExpanded(!energyExpanded)}
              >
                {energyExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <Activity className="w-3 h-3" /> Energy Sensitivity
              </button>
              {(() => {
                const rmsVals = config.energyData!.map((e) => e.rms).filter((v) => v > 0);
                const mean = rmsVals.length ? rmsVals.reduce((a, b) => a + b, 0) / rmsVals.length : 0;
                const max = rmsVals.length ? Math.max(...rmsVals) : 0;
                return (
                  <span className="text-[8px] text-muted-foreground/60">
                    RMS avg: {mean.toFixed(3)} &middot; max: {max.toFixed(3)}
                  </span>
                );
              })()}
            </div>

            {energyExpanded && (<>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-[9px] text-cyan-400/70">
                  High Threshold: {config.energyHighThreshold.toFixed(3)}
                </Label>
                <Slider
                  min={0.01}
                  max={0.5}
                  step={0.005}
                  value={[config.energyHighThreshold]}
                  onValueChange={([v]) => setConfig((prev) => ({ ...prev, energyHighThreshold: v }))}
                  disabled={isRunning}
                />
                <p className="text-[7px] text-muted-foreground/40">RMS above this = &quot;high&quot; energy</p>
              </div>
              <div className="space-y-1">
                <Label className="text-[9px] text-cyan-400/70">
                  Medium Threshold: {config.energyMediumThreshold.toFixed(3)}
                </Label>
                <Slider
                  min={0.005}
                  max={0.3}
                  step={0.005}
                  value={[config.energyMediumThreshold]}
                  onValueChange={([v]) => setConfig((prev) => ({ ...prev, energyMediumThreshold: v }))}
                  disabled={isRunning}
                />
                <p className="text-[7px] text-muted-foreground/40">RMS above this = &quot;medium&quot; energy</p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] px-3 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                disabled={isRunning}
                onClick={async () => {
                  try {
                    const analyzeResp = await fetch("/api/director/audio-analyze", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ audioFile: config.masterAudioFile }),
                    });
                    if (!analyzeResp.ok) throw new Error("Analysis failed");
                    const analysis = await analyzeResp.json();
                    setConfig((prev) => ({
                      ...prev,
                      waveformPeaks: analysis.peaks,
                      energyData: analysis.energy,
                      beatMarkers: analysis.beats,
                      masterAudioDuration: analysis.duration,
                      segments: computeSegmentEnergy(prev.segments, analysis.energy, prev.energyHighThreshold, prev.energyMediumThreshold),
                    }));
                  } catch (err) {
                    console.error("[Director] Re-analyze failed:", err);
                  }
                }}
                title="Re-analyze the master audio file with current sensitivity settings"
              >
                <RefreshCw className="w-3 h-3 mr-1" /> Re-Analyze Audio
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] px-3 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10"
                disabled={isRunning}
                onClick={() => {
                  setConfig((prev) => ({
                    ...prev,
                    segments: computeSegmentEnergy(prev.segments, prev.energyData || [], prev.energyHighThreshold, prev.energyMediumThreshold),
                  }));
                }}
                title="Re-classify segment energy levels using current thresholds (no re-analysis)"
              >
                <BarChart3 className="w-3 h-3 mr-1" /> Re-Classify
              </Button>
            </div>

            {/* Per-segment energy distribution summary */}
            {(() => {
              const low = config.segments.filter((s) => (s.energyOverride || s.detectedEnergy || "low") === "low").length;
              const med = config.segments.filter((s) => (s.energyOverride || s.detectedEnergy || "low") === "medium").length;
              const high = config.segments.filter((s) => (s.energyOverride || s.detectedEnergy || "low") === "high").length;
              return (
                <p className="text-[8px] text-muted-foreground/60">
                  Distribution: <span className="text-emerald-400">{low} low</span> · <span className="text-amber-400">{med} medium</span> · <span className="text-red-400">{high} high</span>
                </p>
              );
            })()}
            </>)}
          </div>
        )}

        </div></WorkflowControls>

        {/* ── Energy Image Buckets ── */}
        {config.storyboardImages.length > 0 && config.energyData && config.energyData.length > 0 && (
          <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 space-y-3">
            <Label className="text-[11px] text-violet-400 font-medium flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> Energy Image Buckets
            </Label>
            <p className="text-[8px] text-muted-foreground/50">
              Assign storyboard images to energy categories. During auto-fill, segments will use images from the matching energy bucket.
            </p>

            {(["low", "medium", "high"] as EnergyLevel[]).map((level) => {
              const bucketImages = config.storyboardImages.filter((sb) => sb.energyBucket === level);
              const bucketStyles = {
                low:    { border: "border-emerald-500/20", bg: "bg-emerald-500/5", text: "text-emerald-400", btnHover: "hover:bg-emerald-500/10", imgBorder: "border-emerald-500/30", emptyText: "text-emerald-400/30" },
                medium: { border: "border-amber-500/20",  bg: "bg-amber-500/5",  text: "text-amber-400",  btnHover: "hover:bg-amber-500/10",  imgBorder: "border-amber-500/30",  emptyText: "text-amber-400/30"  },
                high:   { border: "border-red-500/20",    bg: "bg-red-500/5",    text: "text-red-400",    btnHover: "hover:bg-red-500/10",    imgBorder: "border-red-500/30",    emptyText: "text-red-400/30"    },
              };
              const s = bucketStyles[level];
              const icon = level === "high" ? "⚡" : level === "medium" ? "◆" : "○";
              return (
                <div key={level} className={`rounded border ${s.border} ${s.bg} p-2 space-y-1.5`}>
                  <div className="flex items-center justify-between">
                    <span className={`text-[10px] font-medium ${s.text}`}>
                      {icon} {level.charAt(0).toUpperCase() + level.slice(1)} Energy ({bucketImages.length})
                    </span>
                    <div className="flex gap-1">
                      {bucketImages.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className={`h-5 text-[8px] px-1.5 ${s.text} ${s.btnHover}`}
                          disabled={isRunning}
                          onClick={() => {
                            setConfig((prev) => {
                              const shuffled = [...prev.storyboardImages];
                              const indices = shuffled.map((sb, i) => sb.energyBucket === level ? i : -1).filter((i) => i >= 0);
                              const items = indices.map((i) => shuffled[i]);
                              for (let i = items.length - 1; i > 0; i--) {
                                const j = Math.floor(Math.random() * (i + 1));
                                [items[i], items[j]] = [items[j], items[i]];
                              }
                              indices.forEach((idx, k) => { shuffled[idx] = items[k]; });
                              return { ...prev, storyboardImages: shuffled };
                            });
                          }}
                          title={`Shuffle images within ${level} bucket`}
                        >
                          <Shuffle className="w-2.5 h-2.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {bucketImages.map((sb) => (
                      <div key={sb.id} className="relative group w-12 h-12">
                        {sb.preview ? (
                          <img src={sb.preview} alt={sb.label || sb.id} className={`w-full h-full object-cover rounded border ${s.imgBorder} cursor-zoom-in`} onClick={() => openLightbox(bucketImages, sb.id)} title="Click to enlarge · ← → to cycle" />
                        ) : (
                          <div className={`w-full h-full rounded border ${s.border} ${s.bg} flex items-center justify-center ${s.emptyText} text-[7px]`}>
                            {sb.label || sb.id.slice(-4)}
                          </div>
                        )}
                        <button
                          type="button"
                          className="absolute -top-1 -right-1 bg-black/80 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-[7px]"
                          disabled={isRunning}
                          onClick={() => {
                            setConfig((prev) => ({
                              ...prev,
                              storyboardImages: prev.storyboardImages.map((si) =>
                                si.id === sb.id ? { ...si, energyBucket: undefined } : si
                              ),
                            }));
                          }}
                          title="Remove from this bucket"
                        >
                          <X className="w-2 h-2 text-red-400" />
                        </button>
                      </div>
                    ))}
                    {bucketImages.length === 0 && (
                      <span className={`text-[8px] ${s.emptyText} italic`}>No images assigned</span>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Unassigned images: click to assign to a bucket */}
            {(() => {
              const unassigned = config.storyboardImages.filter((sb) => !sb.energyBucket);
              if (unassigned.length === 0) return null;
              return (
                <div className="rounded border border-border/30 p-2 space-y-1.5">
                  <span className="text-[10px] text-muted-foreground/70">
                    Unassigned ({unassigned.length}): click an image, then pick a bucket
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {unassigned.map((sb) => (
                      <div key={sb.id} className="relative group w-12 h-12">
                        {sb.preview ? (
                          <img src={sb.preview} alt={sb.label || sb.id} className="w-full h-full object-cover rounded border border-border/30 cursor-zoom-in" onClick={() => openLightbox(unassigned, sb.id)} title="Click to enlarge · ← → to cycle" />
                        ) : (
                          <div className="w-full h-full rounded border border-border/20 bg-muted/10 flex items-center justify-center text-muted-foreground/30 text-[7px]">
                            {sb.label || sb.id.slice(-4)}
                          </div>
                        )}
                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded flex items-center justify-center gap-0.5">
                          {(["low", "medium", "high"] as EnergyLevel[]).map((lvl) => {
                            const c = lvl === "high" ? "text-red-400" : lvl === "medium" ? "text-amber-400" : "text-emerald-400";
                            const sym = lvl === "high" ? "H" : lvl === "medium" ? "M" : "L";
                            return (
                              <button
                                key={lvl}
                                type="button"
                                className={`${c} text-[8px] font-bold px-1 py-0.5 rounded hover:bg-white/10`}
                                disabled={isRunning}
                                onClick={() => {
                                  setConfig((prev) => ({
                                    ...prev,
                                    storyboardImages: prev.storyboardImages.map((s) =>
                                      s.id === sb.id ? { ...s, energyBucket: lvl } : s
                                    ),
                                  }));
                                }}
                                title={`Assign to ${lvl} energy bucket`}
                              >
                                {sym}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Apply energy buckets to segments */}
            {config.segments.length > 0 && config.storyboardImages.some((sb) => sb.energyBucket) && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full text-[10px] px-3 border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
                disabled={isRunning || !config.segments.some((s) => s.detectedEnergy || s.energyOverride)}
                onClick={() => {
                  setConfig((prev) => ({
                    ...prev,
                    segments: applyEnergyBucketSchedule(
                      prev.segments,
                      prev.storyboardImages,
                      prev.storyboardSchedule,
                    ),
                  }));
                }}
                title="Assign storyboard images to segments based on their energy level: each segment receives images from its matching energy bucket in order"
              >
                <Sparkles className="w-3 h-3 mr-1" /> Apply Buckets to Segments
              </Button>
            )}
          </div>
        )}

        {/* Segments */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className={cc.sectionLabelPlain}>
              Segments
              {config.autoSegmentFromAudio && config.masterAudioFile && (
                <span className="ml-1 text-[9px] text-blue-400/60 font-normal">(from audio)</span>
              )}
            </Label>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className={cc.outlineBtnSm}
                onClick={addSegment}
                disabled={isRunning}
              >
                <Plus className="w-3 h-3 mr-1" /> Add Segment
              </Button>
              {config.segments.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 border-red-500/30 text-red-400 hover:bg-red-500/10"
                  disabled={isRunning}
                  onClick={() => {
                    config.segments.forEach((seg) => {
                      if (seg.sourceImagePreview) URL.revokeObjectURL(seg.sourceImagePreview);
                      if (seg.endImagePreview) URL.revokeObjectURL(seg.endImagePreview);
                    });
                    setConfig((prev) => ({
                      ...prev,
                      segments: [createDirectorSegment({ numFrames: masterSegmentFrames() })],
                    }));
                  }}
                  title="Remove all segments and reset to a single empty segment"
                >
                  <Trash2 className="w-3 h-3 mr-1" /> Clear All
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className={cc.outlineBtnSm}
                disabled={isRunning || config.segments.length === 0}
                onClick={() => {
                  setConfig((prev) => ({
                    ...prev,
                    segments: prev.segments.map((seg) => ({
                      ...seg,
                      prompt: "",
                      dialogue: "",
                    })),
                  }));
                }}
                title="Clear all segment prompts but keep images, audio slices, and other data intact. Useful for re-running Auto-Fill with a new approach."
              >
                <Trash2 className="w-3 h-3 mr-1" /> Clear All Prompts
              </Button>
            </div>
          </div>

          {/* Preview presentation controls (size + fit), govern the generated segment previews below */}
          {config.segments.some((s) => s.outputUrl) && (
            <div className="flex items-center flex-wrap gap-x-3 gap-y-1.5 rounded-md border border-blue-500/25 bg-blue-500/5 px-3 py-2">
              <span className="text-[11px] font-semibold text-blue-300/90">Preview Size</span>
              <div className="flex items-center gap-0.5 rounded-md border border-border/50 bg-background/50 p-0.5">
                {PREVIEW_SIZE_OPTS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setConfig((prev) => ({ ...prev, previewSize: o.value }))}
                    className={`px-2.5 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                      config.previewSize === o.value ? "bg-blue-500/25 text-blue-300" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <span className="text-[11px] font-semibold text-blue-300/90 ml-1">Fit</span>
              <button
                type="button"
                onClick={() => setConfig((prev) => ({ ...prev, previewFit: prev.previewFit === "contain" ? "cover" : "contain" }))}
                className="px-2.5 py-0.5 rounded-md border border-border/50 text-[11px] font-medium text-muted-foreground hover:border-blue-500/50 hover:text-blue-300 transition-colors"
                title="How segment previews fill their frame. Fit: show the whole frame (letterbox). Fill: crop to fill the box."
              >
                {config.previewFit === "contain" ? "Fit: whole frame" : "Fill: crop"}
              </button>
            </div>
          )}

          {/* Frame-image size (source/end keyframes) + click-to-enlarge */}
          {config.segments.some((s) => s.sourceImagePreview || s.endImagePreview) && (
            <div className="flex items-center flex-wrap gap-x-3 gap-y-1.5 rounded-md border border-blue-500/25 bg-blue-500/5 px-3 py-2">
              <span className="text-[11px] font-semibold text-blue-300/90">Frame Image Size</span>
              <div className="flex items-center gap-0.5 rounded-md border border-border/50 bg-background/50 p-0.5">
                {(["sm", "md", "lg", "xl"] as const).map((sz) => (
                  <button
                    key={sz}
                    type="button"
                    onClick={() => setSegImg(sz)}
                    className={`px-2.5 py-0.5 rounded text-[11px] font-semibold transition-colors ${segImg === sz ? "bg-blue-500/25 text-blue-300" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {sz.toUpperCase()}
                  </button>
                ))}
              </div>
              <span className="text-[10px] text-muted-foreground/50">Click a frame to enlarge · ← → to cycle</span>
            </div>
          )}

          {config.segments.map((seg, idx) => (
            <div
              key={seg.id}
              id={`director-seg-${idx}`}
              className={`rounded-lg border p-3 space-y-2 transition-colors ${
                seg.status === "complete"
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : seg.status === "generating" || seg.status === "extracting"
                    ? "border-blue-500/30 bg-blue-500/5"
                    : seg.status === "error"
                      ? "border-red-500/30 bg-red-500/5"
                        : "border-border/30 bg-muted/10"
              }`}
            >
              {/* Segment header */}
              <div className="flex items-center gap-2">
                <GripVertical className="w-3 h-3 text-muted-foreground/30" />
                <span className="text-[10px] font-medium text-blue-400/80 w-6">
                  #{idx + 1}
                </span>
                {/* Status indicator */}
                {seg.status === "complete" && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                {(seg.status === "generating" || seg.status === "extracting") && (
                  <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
                )}
                {seg.status === "error" && <XCircle className="w-3 h-3 text-red-400" />}

                <span className="flex-1 text-[9px] text-muted-foreground flex items-center gap-1 flex-wrap">
                  {(seg.numFrames / config.frameRate).toFixed(1)}s &middot; {seg.numFrames}f
                  {seg.audioSliceFile && (
                    <span className="text-[8px] bg-blue-500/15 text-blue-400/80 px-1 rounded">
                      ♪ {seg.audioStartTime?.toFixed(1)}–{seg.audioEndTime?.toFixed(1)}s
                    </span>
                  )}
                  {seg.storyboardStartIdx !== undefined && (
                    <span className="text-[8px] bg-blue-500/10 text-blue-400/60 px-1 rounded">
                      img {(seg.storyboardStartIdx ?? 0) + 1}{seg.storyboardEndIdx !== undefined ? `→${seg.storyboardEndIdx + 1}` : ""}
                    </span>
                  )}
                  {(seg.detectedEnergy || seg.energyOverride) && (() => {
                    const level = seg.energyOverride || seg.detectedEnergy || "low";
                    const isOverridden = !!seg.energyOverride && seg.energyOverride !== seg.detectedEnergy;
                    const cycleEnergy = () => {
                      if (isRunning) return;
                      const order: EnergyLevel[] = ["low", "medium", "high"];
                      const nextIdx = (order.indexOf(level) + 1) % order.length;
                      const next = order[nextIdx];
                      // If cycling back to detected level, clear override
                      const newOverride = next === seg.detectedEnergy ? undefined : next;
                      setConfig((prev) => ({
                        ...prev,
                        segments: prev.segments.map((s, i) =>
                          i === idx ? { ...s, energyOverride: newOverride } : s
                        ),
                      }));
                    };
                    return (
                      <button
                        type="button"
                        onClick={cycleEnergy}
                        disabled={isRunning}
                        title={`Energy: ${level}${isOverridden ? ` (detected: ${seg.detectedEnergy})` : ""}, click to cycle`}
                        className={`text-[8px] px-1 rounded cursor-pointer transition-colors ${
                          level === "high" ? "bg-red-500/15 text-red-400/70 hover:bg-red-500/25" :
                          level === "medium" ? "bg-amber-500/15 text-amber-400/70 hover:bg-amber-500/25" :
                          "bg-emerald-500/10 text-emerald-400/60 hover:bg-emerald-500/20"
                        } ${isOverridden ? "ring-1 ring-amber-400/40" : ""} disabled:cursor-default`}
                      >
                        {level === "high" ? "⚡" : level === "medium" ? "◆" : "○"} {level}{isOverridden ? "*" : ""}
                      </button>
                    );
                  })()}
                </span>

                {/* Reorder + delete */}
                <button
                  type="button"
                  onClick={() => moveSegment(idx, -1)}
                  disabled={idx === 0 || isRunning}
                  className="p-0.5 text-muted-foreground/40 hover:text-muted-foreground disabled:opacity-30"
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => moveSegment(idx, 1)}
                  disabled={idx === config.segments.length - 1 || isRunning}
                  className="p-0.5 text-muted-foreground/40 hover:text-muted-foreground disabled:opacity-30"
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
                {config.segments.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeSegment(idx)}
                    disabled={isRunning}
                    className="p-0.5 text-destructive/40 hover:text-destructive disabled:opacity-30"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleGenerateSingle(idx)}
                  disabled={isRunning || !seg.prompt.trim()}
                  className="p-0.5 text-blue-400/40 hover:text-blue-400 disabled:opacity-30"
                  title={`Generate segment ${idx + 1} now (uses ${config.chainingMode} chaining${idx > 0 ? `, prev seg ${idx} as source` : ""})`}
                >
                  <Play className="w-3 h-3" />
                </button>
              </div>

              {/* Source Image (I2V) */}
              <div className="space-y-1">
                <Label className="text-[9px] text-muted-foreground/70 flex items-center gap-1">
                  <ImagePlus className="w-2.5 h-2.5" />
                  {idx === 0 ? "Starting Frame (I2V)" : "Override Frame (I2V)"}
                  {seg.storyboardStartIdx !== undefined && seg.sourceImage && (
                    <span className="text-[8px] text-blue-400/50 ml-1">from storyboard</span>
                  )}
                  {idx > 0 && !seg.sourceImage && config.chainingMode === "chain" && (
                    <span className="text-[8px] text-blue-400/50 ml-1">auto-chained from previous</span>
                  )}
                </Label>
                {seg.sourceImage && seg.sourceImagePreview ? (
                  <div className="relative group">
                    <img
                      src={seg.sourceImagePreview}
                      alt="Source frame"
                      className={`w-full ${SEG_IMG[segImg]} object-contain rounded border border-blue-500/20 bg-black/20 cursor-zoom-in`}
                      onClick={() => openLightbox(segmentFrameList(), `seg${idx}-start`)}
                      title="Click to enlarge · ← → to cycle"
                    />
                    <button
                      type="button"
                      onClick={() => clearSourceImage(idx)}
                      disabled={isRunning}
                      className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                    <p className="text-[9px] text-blue-400/60 mt-0.5 truncate">{seg.sourceImage}</p>
                  </div>
                ) : (
                  <label
                    className={`flex items-center justify-center gap-1.5 w-full h-16 rounded border border-dashed cursor-pointer transition-colors ${
                      isRunning
                        ? "border-border/20 bg-muted/5 cursor-not-allowed opacity-50"
                        : "border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10 hover:border-blue-500/50"
                    }`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const f = e.dataTransfer.files?.[0];
                      if (f && f.type.startsWith("image/")) handleImageUpload(idx, f);
                    }}
                  >
                    <ImagePlus className="w-4 h-4 text-blue-400/40" />
                    <span className={cc.accentText50sm}>
                      {idx === 0 ? "Upload starting frame" : "Upload override frame (optional)"}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      disabled={isRunning}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleImageUpload(idx, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>

              {/* End Frame (last-frame guidance) */}
              <div className="space-y-1">
                <Label className="text-[9px] text-muted-foreground/70 flex items-center gap-1">
                  <ImagePlus className="w-2.5 h-2.5" />
                  End Frame (guidance)
                  <span className="text-[8px] text-emerald-400/50 ml-1">optional: steers motion toward this frame</span>
                </Label>
                {seg.endImage && seg.endImagePreview ? (
                  <div className="relative group">
                    <img
                      src={seg.endImagePreview}
                      alt="End frame"
                      className={`w-full ${SEG_IMG[segImg]} object-contain rounded border border-emerald-500/20 bg-black/20 cursor-zoom-in`}
                      onClick={() => openLightbox(segmentFrameList(), `seg${idx}-end`)}
                      title="Click to enlarge · ← → to cycle"
                    />
                    <button
                      type="button"
                      onClick={() => clearEndImage(idx)}
                      disabled={isRunning}
                      className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white/80 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                    <p className="text-[8px] text-emerald-400/60 mt-0.5 truncate">{seg.endImage}</p>
                  </div>
                ) : (
                  <label
                    className={`flex items-center justify-center gap-1.5 w-full h-12 rounded border border-dashed cursor-pointer transition-colors ${
                      isRunning
                        ? "border-border/20 bg-muted/5 cursor-not-allowed opacity-50"
                        : "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 hover:border-emerald-500/50"
                    }`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const f = e.dataTransfer.files?.[0];
                      if (f && f.type.startsWith("image/")) handleEndImageUpload(idx, f);
                    }}
                  >
                    <ImagePlus className="w-3.5 h-3.5 text-emerald-400/40" />
                    <span className="text-[9px] text-emerald-400/50">
                      Upload end frame (optional)
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      disabled={isRunning}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleEndImageUpload(idx, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>

              {/* Per-segment end-frame anchor override (only meaningful in reference-sheet mode
                  with an end image present). Lets the user drift a specific segment while the
                  rest of the video stays locked for continuity. */}
              {config.ingredientsMode && seg.endImage && (
                <div className="flex items-center justify-between rounded border border-violet-500/20 bg-violet-500/5 px-2 py-1">
                  <Label className="text-[9px] text-violet-300/80 flex items-center gap-1">
                    Lock end frame
                    <span className="text-[8px] text-muted-foreground/50">
                      {(seg.lockEndFrame ?? config.ingredientsUseEndFrame ?? true) ? "continuity" : "creative drift"}
                    </span>
                  </Label>
                  <Switch
                    checked={seg.lockEndFrame ?? config.ingredientsUseEndFrame ?? true}
                    onCheckedChange={(v) => updateSegment(idx, { lockEndFrame: v })}
                    disabled={isRunning}
                    className="scale-75"
                  />
                </div>
              )}

              {/* Scene prompt */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[9px] text-muted-foreground/70">Scene Prompt</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 text-[8px] px-1.5 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={() => handleExpandSegmentPrompt(idx)}
                    disabled={isRunning || !!llmBusy[idx] || !seg.prompt.trim()}
                    title="Expand this segment's prompt using Qwen3.5-9B"
                  >
                    {llmBusy[idx] ? (
                      <><Loader2 className="w-2.5 h-2.5 mr-0.5 animate-spin" /> Expanding...</>
                    ) : (
                      <><Wand2 className="w-2.5 h-2.5 mr-0.5" /> Expand</>
                    )}
                  </Button>
                  {llmBusy[idx] && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 text-[8px] px-1.5 text-red-400 hover:bg-red-500/10"
                      onClick={handleAbortLlm}
                      title="Kill the running LLM process"
                    >
                      <XCircle className="w-2.5 h-2.5 mr-0.5" /> Cancel
                    </Button>
                  )}
                </div>
                <SegmentPromptField
                  persistId={`dir-seg-${seg.id}`}
                  value={seg.prompt}
                  onChange={(e) => updateSegment(idx, { prompt: e.target.value })}
                  placeholder={idx === 0
                    ? "A cinematic establishing shot of a sunlit forest path, camera slowly pushing forward..."
                    : "Camera continues forward, revealing a clearing with a lake..."
                  }
                  className="w-full min-h-[50px] rounded border border-border bg-background px-2 py-1.5 text-[11px] resize-y placeholder:text-muted-foreground/30"
                  disabled={isRunning}
                />
              </div>

              {/* Duration: linked Frames/Seconds numeric fields (replaces the old preset
                  dropdown). Editing either recomputes the other via the master frame rate,
                  snapped to LTX's 8n+1 math; committing raises the re-time flow when a
                  master-audio timeline is active. */}
              <SegmentDurationEditor
                numFrames={seg.numFrames}
                fps={config.frameRate}
                disabled={isRunning || resegmenting}
                syncKey={durationRevertNonce}
                onCommit={(newFrames) => commitSegmentDuration(idx, newFrames)}
              />

              {/* Error display */}
              {seg.error && (
                <p className="text-[9px] text-red-400 flex items-center gap-1">
                  <XCircle className="w-2.5 h-2.5" /> {seg.error}
                </p>
              )}

              {/* Segment preview: centered within the segment section */}
              {seg.outputUrl && (
                <div className="flex justify-center">
                  <VideoSlot
                    id={`director-seg-${idx}`}
                    src={seg.outputUrl}
                    poster={seg.lastFrameFile ? getImageUrl(seg.lastFrameFile, "", "input") : undefined}
                    className={`rounded border border-border/30 ${config.previewFit === "cover" ? "w-full" : ""}`}
                    style={config.previewFit === "cover"
                      ? { height: PREVIEW_MAXH[config.previewSize], width: "100%", maxWidth: "100%" }
                      : { maxHeight: PREVIEW_MAXH[config.previewSize], maxWidth: "100%" }}
                    fit={config.previewFit}
                    muted
                    loop
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ══ Pipeline Settings + Generate/Assemble → projected into the right dock ══ */}
        <WorkflowControls><div className="space-y-4">

        {/* Center navigation helper */}
        <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 p-2.5 space-y-1.5">
          <p className="text-[10px] font-semibold text-blue-300/90 flex items-center gap-1.5">
            <ArrowDownToLine className="w-3.5 h-3.5" /> Jump to Segment
          </p>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              max={config.segments.length}
              value={jumpTarget}
              onChange={(e) => setJumpTarget(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") scrollToSegment(parseInt(jumpTarget)); }}
              placeholder="#"
              className="w-16 h-7 rounded border border-border bg-background px-2 text-[11px]"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[10px] border-blue-500/30 text-blue-300 hover:bg-blue-500/10"
              onClick={() => scrollToSegment(parseInt(jumpTarget))}
            >
              Go
            </Button>
            {isPaused && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] border-amber-500/40 text-amber-400 hover:bg-amber-500/10 animate-pulse"
                onClick={scrollToReview}
              >
                <Pause className="w-3 h-3 mr-1" /> Jump to Review
              </Button>
            )}
          </div>
          <p className="text-[9px] text-muted-foreground/60">Scrolls the center view so that segment sits at the top.</p>
        </div>

        {/* Settings (collapsible) */}
        <div className={cc.cardSoft2}>
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left"
            onClick={() => setSettingsExpanded(!settingsExpanded)}
          >
            {settingsExpanded ? (
              <ChevronDown className={cc.iconBlue} />
            ) : (
              <ChevronRight className={cc.iconBlue} />
            )}
            <Settings2 className={cc.iconBlue} />
            <span className={cc.sectionLabelPlain}>
              Pipeline Settings
            </span>
            <span className="text-[9px] text-muted-foreground ml-auto">
              {config.width}×{config.height} &middot; {config.frameRate}fps &middot; {config.audioMode}
            </span>
          </button>

          {settingsExpanded && (
            <div className="space-y-3 pt-1">
              {/* Checkpoint Selector */}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Diffusion Model</Label>
                <select
                  value={config.diffusionModel}
                  onChange={(e) => {
                    const ckptConfig = getLTX2CheckpointConfig(e.target.value);
                    setConfig((prev) => ({ ...prev, ...ckptConfig }));
                  }}
                  className="w-full h-8 rounded border border-border bg-background px-2 text-[11px]"
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
                    <p className="text-[8px] text-muted-foreground/60">{active.description}</p>
                  ) : null;
                })()}
              </div>

              {/* Resolution */}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Resolution</Label>
                <select
                  value={activeRes ? `${config.width}x${config.height}` : "custom"}
                  onChange={(e) => {
                    if (e.target.value === "custom") return; // just show custom inputs
                    const preset = LTX2_RESOLUTION_PRESETS.find(
                      (p) => `${p.width}x${p.height}` === e.target.value
                    );
                    if (preset) {
                      const resDefaults = getResolutionScaledDefaults(preset.width, preset.height);
                      setConfig((prev) => ({ ...prev, width: preset.width, height: preset.height, ...resDefaults }));
                    }
                  }}
                  className="w-full h-8 rounded border border-border bg-background px-2 text-[11px]"
                  disabled={isRunning}
                >
                  {LTX2_RESOLUTION_PRESETS.map((p) => (
                    <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>
                      {p.label}
                    </option>
                  ))}
                  <option value="custom">Custom...</option>
                </select>
                {!activeRes && (
                  <div className="flex gap-1.5 items-center">
                    <input
                      type="number"
                      min={256}
                      max={2048}
                      step={32}
                      value={config.width}
                      onChange={(e) => {
                        const v = Math.max(256, Math.round((parseInt(e.target.value) || 512) / 32) * 32);
                        setConfig((prev) => ({ ...prev, width: v }));
                      }}
                      className="flex-1 h-7 rounded border border-border bg-background px-1.5 text-[10px] text-center"
                      disabled={isRunning}
                      title="Width (snaps to multiples of 32)"
                    />
                    <span className="text-[9px] text-muted-foreground/50">×</span>
                    <input
                      type="number"
                      min={256}
                      max={2048}
                      step={32}
                      value={config.height}
                      onChange={(e) => {
                        const v = Math.max(256, Math.round((parseInt(e.target.value) || 512) / 32) * 32);
                        setConfig((prev) => ({ ...prev, height: v }));
                      }}
                      className="flex-1 h-7 rounded border border-border bg-background px-1.5 text-[10px] text-center"
                      disabled={isRunning}
                      title="Height (snaps to multiples of 32)"
                    />
                    <span className="text-[8px] text-muted-foreground/40">{config.width}×{config.height}</span>
                  </div>
                )}
              </div>

              {/* Style Preset */}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Style Preset</Label>
                <select
                  value={config.stylePreset || "none"}
                  onChange={(e) => setConfig((prev) => ({ ...prev, stylePreset: e.target.value }))}
                  className="w-full h-8 rounded border border-border bg-background px-2 text-[11px]"
                  disabled={isRunning}
                >
                  {STYLE_PRESET_OPTIONS.map((opt) => (
                    <option key={opt.key} value={opt.key}>{opt.label}</option>
                  ))}
                </select>
                {config.stylePreset && config.stylePreset !== "none" && STYLE_PRESETS[config.stylePreset] && (
                  <div className="space-y-1 pt-0.5">
                    <p className="text-[8px] text-muted-foreground/60 leading-relaxed">
                      {STYLE_PRESETS[config.stylePreset].description}
                    </p>
                    {STYLE_PRESETS[config.stylePreset].cameraAngle && (
                      <div className="flex gap-2 text-[8px] text-muted-foreground/50">
                        <span>Camera: {STYLE_PRESETS[config.stylePreset].cameraAngle}</span>
                        {STYLE_PRESETS[config.stylePreset].cameraMovement && (
                          <span>Move: {STYLE_PRESETS[config.stylePreset].cameraMovement}</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Negative Prompt: its own box, independent of model tier / sampler selection */}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Negative Prompt</Label>
                <textarea
                  className="w-full min-h-[44px] rounded border border-border bg-background px-2 py-1.5 text-[10px] resize-y focus:outline-none focus:ring-1 focus:ring-blue-500/50 placeholder:text-muted-foreground/40"
                  placeholder="Describe what to avoid (e.g. blurry, distorted, worst quality, jittery)…"
                  value={config.negativePrompt}
                  onChange={(e) => setConfig((prev) => ({ ...prev, negativePrompt: e.target.value }))}
                  disabled={isRunning}
                />
              </div>

              {/* Official Pipeline: Quality Tier + sampling controls */}
              {config.pipelineMode === "official" && (
                <div className="rounded border border-emerald-500/15 bg-emerald-500/5 p-2 space-y-2">
                  <Label className="text-[10px] text-emerald-400/80 font-medium">Official Pipeline</Label>
                  <div className="flex items-center bg-muted/30 rounded-md p-0.5">
                    {(["test", "distilled", "full"] as LTX2QualityTier[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          if (t === config.qualityTier) return;
                          setConfig((prev) => ({ ...prev, qualityTier: t, distillLoRAStrength: LTX2_OFFICIAL_LORA_STRENGTH[t] }));
                        }}
                        disabled={isRunning}
                        className={`flex-1 px-2 py-0.5 text-[9px] font-medium rounded transition-colors ${
                          config.qualityTier === t
                            ? "bg-emerald-500/20 text-emerald-400 shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {t === "test" ? "Test (3)" : t === "distilled" ? "Distilled (8)" : "Full (15)"}
                      </button>
                    ))}
                  </div>
                  {/* ── Tier-specific sampling controls ── */}
                  {(config.qualityTier === "test" || config.qualityTier === "distilled") && (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[9px] text-emerald-400/60">Video Steps</Label>
                        <input
                          type="number" min={1} max={30} step={1}
                          value={config.qualityTier === "test" ? config.testVideoSteps : config.distilledSteps}
                          onChange={(e) => {
                            const v = parseInt(e.target.value) || 3;
                            if (config.qualityTier === "test") {
                              setConfig((prev) => ({ ...prev, testVideoSteps: v }));
                            } else {
                              setConfig((prev) => ({ ...prev, distilledSteps: v }));
                            }
                          }}
                          className="w-full h-7 rounded border border-emerald-500/20 bg-background px-2 text-[10px]"
                          disabled={isRunning}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-emerald-400/60">Audio Steps</Label>
                        <input
                          type="number" min={0} max={30} step={1}
                          value={config.testAudioSteps}
                          onChange={(e) => setConfig((prev) => ({ ...prev, testAudioSteps: parseInt(e.target.value) || 0 }))}
                          className="w-full h-7 rounded border border-emerald-500/20 bg-background px-2 text-[10px]"
                          disabled={isRunning}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-emerald-400/60">Sampler</Label>
                        <select
                          value={config.testSampler}
                          onChange={(e) => setConfig((prev) => ({ ...prev, testSampler: e.target.value }))}
                          className="w-full h-7 rounded border border-emerald-500/20 bg-background px-2 text-[10px]"
                          disabled={isRunning}
                        >
                          <option value="euler">euler</option>
                          <option value="euler_ancestral">euler_ancestral</option>
                          <option value="dpmpp_2m">dpmpp_2m</option>
                          <option value="uni_pc">uni_pc</option>
                        </select>
                      </div>
                    </div>
                  )}
                  {config.qualityTier === "full" && (
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[9px] text-emerald-400/60">Steps</Label>
                        <input
                          type="number" min={8} max={30} step={1}
                          value={config.fullSteps}
                          onChange={(e) => setConfig((prev) => ({ ...prev, fullSteps: parseInt(e.target.value) || 15 }))}
                          className="w-full h-7 rounded border border-emerald-500/20 bg-background px-2 text-[10px]"
                          disabled={isRunning}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-emerald-400/60">Sampler</Label>
                        <select
                          value={config.fullSampler}
                          onChange={(e) => setConfig((prev) => ({ ...prev, fullSampler: e.target.value }))}
                          className="w-full h-7 rounded border border-emerald-500/20 bg-background px-2 text-[10px]"
                          disabled={isRunning}
                        >
                          <option value="exponential/res_2s">exponential/res_2s</option>
                          <option value="euler">euler</option>
                          <option value="dpmpp_2m">dpmpp_2m</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-emerald-400/60">Video CFG</Label>
                        <input
                          type="number" min={1} max={10} step={0.5}
                          value={config.videoCfg}
                          onChange={(e) => setConfig((prev) => ({ ...prev, videoCfg: parseFloat(e.target.value) || 3 }))}
                          className="w-full h-7 rounded border border-emerald-500/20 bg-background px-2 text-[10px]"
                          disabled={isRunning}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-emerald-400/60">Audio CFG</Label>
                        <input
                          type="number" min={1} max={15} step={0.5}
                          value={config.audioCfg}
                          onChange={(e) => setConfig((prev) => ({ ...prev, audioCfg: parseFloat(e.target.value) || 7 }))}
                          className="w-full h-7 rounded border border-emerald-500/20 bg-background px-2 text-[10px]"
                          disabled={isRunning}
                        />
                      </div>
                    </div>
                  )}
                  {/* Direct Sampling toggle */}
                  <div className="flex items-center justify-between">
                    <Label className="text-[9px] text-emerald-400/60">Direct Sampling (bypass NormalizingSampler)</Label>
                    <Switch
                      checked={config.directSampling}
                      onCheckedChange={(v) => setConfig((prev) => ({ ...prev, directSampling: v }))}
                      disabled={isRunning}
                      className="scale-75"
                    />
                  </div>
                </div>
              )}

              {/* Turbo Upscale (half-res → 2x latent upscale → refine), 2.3 only.
                  Shared across all segments; the builder auto-disables it for A2V
                  (music-video) segments where audio is frozen. */}
              {config.modelVersion === "2.3" && (
                <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-orange-400 font-medium flex items-center gap-1.5">
                      <Rocket className="w-3.5 h-3.5" /> Turbo Upscale
                    </span>
                    <Switch
                      checked={!!config.turboUpscale}
                      onCheckedChange={(v) => setConfig((prev) => ({ ...prev, turboUpscale: v }))}
                      className="scale-75"
                      disabled={isRunning}
                    />
                  </div>
                  {config.turboUpscale && (
                    <div className="space-y-2.5">
                      <div className="space-y-1">
                        <Label className="text-[10px] text-orange-400/80">Upscale Method</Label>
                        <select
                          value={config.turboUpscaleMethod ?? TURBO_UPSCALE_DEFAULTS.method}
                          onChange={(e) => setConfig((prev) => ({ ...prev, turboUpscaleMethod: e.target.value as "latent" | "rtx_vsr" }))}
                          className="w-full h-7 text-[10px] px-2 rounded bg-background border border-orange-500/20 text-orange-200"
                          disabled={isRunning}
                        >
                          <option value="latent">Latent Upscaler + Refinement (recommended)</option>
                          <option value="rtx_vsr">RTX Video Super Resolution (fast, no refinement)</option>
                        </select>
                      </div>
                      <p className="text-[9px] text-orange-400/60">
                        {(config.turboUpscaleMethod ?? TURBO_UPSCALE_DEFAULTS.method) === "rtx_vsr"
                          ? "Pixel-only upscale: fast but no detail generation. Fine for previews, not final output."
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
                      <p className="text-[8px] text-orange-400/40">
                        Applies to every non-music-video segment. Audio-driven (A2V) segments render at full resolution automatically.
                      </p>

                      {(config.turboUpscaleMethod ?? TURBO_UPSCALE_DEFAULTS.method) === "latent" && (<>
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <Label className="text-[10px] text-orange-400/80">Refine Steps</Label>
                            <span className="text-[10px] text-muted-foreground font-mono">
                              {config.turboUpscaleRefineSteps ?? TURBO_UPSCALE_DEFAULTS.refineSteps}
                            </span>
                          </div>
                          <Slider
                            value={[config.turboUpscaleRefineSteps ?? TURBO_UPSCALE_DEFAULTS.refineSteps]}
                            onValueChange={([v]) => setConfig((prev) => ({ ...prev, turboUpscaleRefineSteps: v }))}
                            min={1} max={8} step={1}
                            disabled={isRunning}
                            className="py-1"
                          />
                        </div>

                        <details className="text-[10px] text-orange-400/80">
                          <summary className="cursor-pointer select-none flex items-center gap-1">
                            <Settings2 className="w-3 h-3" /> Advanced Upscaler Controls
                          </summary>
                          <div className="mt-2 space-y-2.5 pl-3 border-l border-orange-500/20">
                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <Label className="text-[10px] text-orange-400/80">Upscaler Model</Label>
                                {config.turboUpscaleModel && config.turboUpscaleModel !== TURBO_UPSCALE_DEFAULTS.model && (
                                  <Button
                                    size="sm" variant="ghost"
                                    className="h-5 text-[9px] px-1.5 text-orange-400/70 hover:text-orange-300"
                                    onClick={() => setConfig((prev) => ({ ...prev, turboUpscaleModel: TURBO_UPSCALE_DEFAULTS.model }))}
                                    disabled={isRunning}
                                  >
                                    <RotateCcw className="w-3 h-3 mr-1" /> Default
                                  </Button>
                                )}
                              </div>
                              <input
                                type="text"
                                value={config.turboUpscaleModel ?? TURBO_UPSCALE_DEFAULTS.model}
                                onChange={(e) => setConfig((prev) => ({ ...prev, turboUpscaleModel: e.target.value }))}
                                placeholder={TURBO_UPSCALE_DEFAULTS.model}
                                className="w-full h-7 text-[10px] px-2 rounded bg-background border border-orange-500/20 text-orange-200 font-mono"
                                disabled={isRunning}
                              />
                            </div>

                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <Label className="text-[10px] text-orange-400/80">Refine Sampler</Label>
                                {config.turboUpscaleSampler && config.turboUpscaleSampler !== TURBO_UPSCALE_DEFAULTS.sampler && (
                                  <Button
                                    size="sm" variant="ghost"
                                    className="h-5 text-[9px] px-1.5 text-orange-400/70 hover:text-orange-300"
                                    onClick={() => setConfig((prev) => ({ ...prev, turboUpscaleSampler: TURBO_UPSCALE_DEFAULTS.sampler }))}
                                    disabled={isRunning}
                                  >
                                    <RotateCcw className="w-3 h-3 mr-1" /> Default
                                  </Button>
                                )}
                              </div>
                              <select
                                value={config.turboUpscaleSampler ?? TURBO_UPSCALE_DEFAULTS.sampler}
                                onChange={(e) => setConfig((prev) => ({ ...prev, turboUpscaleSampler: e.target.value }))}
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
                            </div>

                            <div className="space-y-1">
                              <div className="flex items-center justify-between">
                                <Label className="text-[10px] text-orange-400/80">Custom Sigmas</Label>
                                {config.turboUpscaleCustomSigmas && (
                                  <Button
                                    size="sm" variant="ghost"
                                    className="h-5 text-[9px] px-1.5 text-orange-400/70 hover:text-orange-300"
                                    onClick={() => setConfig((prev) => ({ ...prev, turboUpscaleCustomSigmas: "" }))}
                                    disabled={isRunning}
                                  >
                                    <RotateCcw className="w-3 h-3 mr-1" /> Default
                                  </Button>
                                )}
                              </div>
                              <input
                                type="text"
                                value={config.turboUpscaleCustomSigmas ?? ""}
                                onChange={(e) => setConfig((prev) => ({ ...prev, turboUpscaleCustomSigmas: e.target.value }))}
                                placeholder={TURBO_UPSCALE_DEFAULTS.refineSigmas.join(", ")}
                                className="w-full h-7 text-[10px] px-2 rounded bg-background border border-orange-500/20 text-orange-200 font-mono"
                                disabled={isRunning}
                              />
                              <p className="text-[8px] text-orange-400/40">
                                Comma-separated sigma schedule, descending to 0. Empty = auto from Refine Steps.
                              </p>
                            </div>
                          </div>
                        </details>
                      </>)}
                    </div>
                  )}
                </div>
              )}

              {/* Frame rate */}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">
                  Frame Rate: {config.frameRate} fps
                </Label>
                <Slider
                  value={[config.frameRate]}
                  onValueChange={([v]) => setConfig((prev) => ({ ...prev, frameRate: v }))}
                  min={8} max={30} step={1}
                  disabled={isRunning}
                />
              </div>

              {/* Audio Mode */}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Audio Mode</Label>
                <div className="flex gap-1.5">
                  {(["none", "joint", "foley"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setConfig((prev) => ({ ...prev, audioMode: mode }))}
                      disabled={isRunning}
                      className={`flex-1 h-7 rounded text-[10px] border transition-colors ${
                        config.audioMode === mode
                          ? "border-blue-500/50 bg-blue-500/10 text-blue-400"
                          : "border-border bg-background text-muted-foreground hover:border-blue-500/30"
                      }`}
                    >
                      {mode === "none" && <><VolumeX className="w-3 h-3 inline mr-1" />Silent</>}
                      {mode === "joint" && <><Volume2 className="w-3 h-3 inline mr-1" />Joint</>}
                      {mode === "foley" && <><Film className="w-3 h-3 inline mr-1" />Foley</>}
                    </button>
                  ))}
                </div>
                <p className="text-[8px] text-muted-foreground/60">
                  {config.audioMode === "none" && "No audio: video only generation (fastest, least VRAM)"}
                  {config.audioMode === "joint" && "LTX-2 generates audio per segment, may have hard cuts at boundaries"}
                  {config.audioMode === "foley" && "Generate video silently, then run HunyuanVideo-Foley for coherent audio (recommended)"}
                </p>
              </div>

              {/* Pause between segments toggle */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Pause className={cc.iconBlue} />
                  <Label className="text-[10px] text-muted-foreground">
                    Pause Between Segments
                  </Label>
                </div>
                <Switch
                  checked={config.pauseBetweenSegments}
                  onCheckedChange={(v) => setConfig((prev) => ({ ...prev, pauseBetweenSegments: v }))}
                  disabled={isRunning}
                  className="scale-75"
                />
              </div>
              <p className="text-[8px] text-muted-foreground/60 -mt-1">
                Review each segment output before continuing. Edit prompts, re-generate, or proceed.
              </p>

              {/* Seed */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">Seed</Label>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-muted-foreground">Random</span>
                    <Switch
                      checked={config.randomSeed}
                      onCheckedChange={(v) => setConfig((prev) => ({ ...prev, randomSeed: v }))}
                      className="scale-75"
                      disabled={isRunning}
                    />
                  </div>
                </div>
                {!config.randomSeed && (
                  <input
                    type="number"
                    value={config.seed}
                    onChange={(e) => setConfig((prev) => ({ ...prev, seed: parseInt(e.target.value) || 0 }))}
                    className="w-full h-8 rounded border border-border bg-background px-2 text-[11px]"
                    disabled={isRunning}
                  />
                )}
                {/* Lock behavior explainer: clarifies whether the seed changes per segment */}
                <p className="text-[8px] leading-snug text-muted-foreground/60">
                  {config.randomSeed
                    ? "Random ON: a NEW seed is drawn for every segment (identities/compositions vary run-to-run)."
                    : config.seed < 0
                      ? "Seed is negative: treated as random per segment. Set a value ≥ 0 to lock."
                      : <>Locked: seed <span className="text-emerald-400/80 font-medium">{config.seed}</span> is reused for <span className="text-emerald-400/80">every</span> segment.</>}
                </p>
                {/* Resolved per-segment seeds actually used (esp. useful in Random mode) */}
                {config.segments.some((s) => typeof s.usedSeed === "number") && (
                  <div className="rounded border border-border/40 bg-background/40 p-1.5 space-y-1">
                    <Label className="text-[8px] text-muted-foreground/70">Seeds used (last run)</Label>
                    <div className="flex flex-col gap-0.5 max-h-24 overflow-y-auto">
                      {config.segments.map((s, i) =>
                        typeof s.usedSeed === "number" ? (
                          <div key={s.id} className="flex items-center justify-between gap-2 text-[9px]">
                            <span className="text-muted-foreground/70">Seg {i + 1}</span>
                            <span className="font-mono text-foreground/80 tabular-nums">{s.usedSeed}</span>
                            <button
                              type="button"
                              className="text-[8px] text-emerald-400/70 hover:text-emerald-400 disabled:opacity-40"
                              disabled={isRunning}
                              title="Lock this seed for all segments (turns Random off)"
                              onClick={() => setConfig((prev) => ({ ...prev, randomSeed: false, seed: s.usedSeed as number }))}
                            >
                              Lock
                            </button>
                          </div>
                        ) : null
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Character Consistency (10S Method), identity across ALL segments ── */}
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-cyan-400 font-medium flex items-center gap-1.5">
                    <Eye className="w-3.5 h-3.5" /> Character Consistency (10S Method)
                  </span>
                  <Switch
                    checked={!!config.likenessEnabled}
                    onCheckedChange={(v) => setConfig((prev) => ({
                      ...prev,
                      likenessEnabled: v,
                      ...(v && (prev.pipelineMode || "official") === "official"
                        ? { pipelineMode: "alternative" as LTX2PipelineMode, distillLoRAStrength: 1.0 }
                        : {}),
                    }))}
                    disabled={isRunning}
                  />
                </div>
                <p className="text-[8px] text-muted-foreground/60 leading-snug">
                  Hooks the LTX-2 DiT attention to hold one character&apos;s identity across every segment.
                  Upload a single clear reference below. That character is anchored through the whole piece.
                </p>
                {config.likenessEnabled && (config.pipelineMode || "official") === "official" && (
                  <p className="text-[8px] text-amber-400/70 leading-snug">
                    Runs on the Alternative pipeline, switched automatically. (The 10S identity nodes are Alternative-only.)
                  </p>
                )}
                {config.likenessEnabled && (
                  <div className="space-y-2 pt-1">
                    {/* Character reference upload */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-[9px] text-cyan-400/60">Character Reference Image</Label>
                        {config.likenessImage && (
                          <button type="button" className="text-[8px] text-destructive/70 hover:text-destructive"
                            onClick={() => { setConfig((prev) => ({ ...prev, likenessImage: "" })); setLikenessPreview(null); }}>
                            ✕ Remove
                          </button>
                        )}
                      </div>
                      {(likenessPreview || config.likenessImage) ? (
                        <div className="flex justify-center">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={likenessPreview || getImageUrl(config.likenessImage!, "", "input")} alt="Character ref" className="max-h-24 rounded border border-cyan-500/30" />
                        </div>
                      ) : (
                        <div
                          className="flex items-center justify-center gap-1 rounded border border-dashed border-cyan-500/30 bg-cyan-500/5 py-3 text-[9px] text-cyan-400/50 cursor-pointer hover:border-cyan-400/50 hover:text-cyan-400/70 transition-colors"
                          onClick={() => document.getElementById("director-likeness-upload")?.click()}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && f.type.startsWith("image/")) handleLikenessUpload(f); }}
                        >
                          <Upload className="w-3 h-3" /> Drop character reference or click
                          <input id="director-likeness-upload" type="file" accept="image/*" className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLikenessUpload(f); e.target.value = ""; }} />
                        </div>
                      )}
                      <p className="text-[7px] text-muted-foreground/40">
                        One clear reference is best. Leave empty to fall back to each segment&apos;s own source frame (identity will drift).
                      </p>
                    </div>

                    {/* Full Body Mode */}
                    <div className="space-y-1 rounded border border-cyan-500/10 bg-cyan-500/5 p-2">
                      <div className="flex items-center justify-between">
                        <Label className="text-[9px] text-cyan-400/60">Full Body Mode</Label>
                        <Switch
                          checked={(config.likenessFaceDetect ?? "auto") === "none"}
                          onCheckedChange={(v) => setConfig((prev) => ({
                            ...prev,
                            likenessFaceDetect: v ? "none" : "auto",
                            likenessRefMaskMode: v ? "whole_frame" : "bbox_softfade",
                          }))}
                          disabled={isRunning}
                        />
                      </div>
                      <p className="text-[7px] text-muted-foreground/40">
                        ON = entire reference used (body, clothing, posture). OFF = auto-detects the face region only.
                      </p>
                      <div className="space-y-1 pt-1">
                        <Label className="text-[8px] text-muted-foreground/50">Detection: <span className="text-cyan-400/70">{config.likenessFaceDetect ?? "auto"}</span></Label>
                        <select className="w-full rounded border border-cyan-500/20 bg-background px-2 py-0.5 text-[9px]"
                          value={config.likenessFaceDetect ?? "auto"}
                          onChange={(e) => setConfig((prev) => ({ ...prev, likenessFaceDetect: e.target.value as "auto" | "none" }))}
                          disabled={isRunning}>
                          <option value="auto">auto: detect face bbox (MediaPipe/OpenCV)</option>
                          <option value="none">none: whole frame as identity target</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[8px] text-muted-foreground/50">Ref Mask: <span className="text-cyan-400/70">{config.likenessRefMaskMode ?? "bbox_softfade"}</span></Label>
                        <select className="w-full rounded border border-cyan-500/20 bg-background px-2 py-0.5 text-[9px]"
                          value={config.likenessRefMaskMode ?? "bbox_softfade"}
                          onChange={(e) => setConfig((prev) => ({ ...prev, likenessRefMaskMode: e.target.value as "bbox_softfade" | "bbox_only" | "whole_frame" }))}
                          disabled={isRunning}>
                          <option value="bbox_softfade">bbox_softfade: Gaussian fade outside detected face</option>
                          <option value="bbox_only">bbox_only: hard mask outside face bbox</option>
                          <option value="whole_frame">whole_frame: no masking (full reference)</option>
                        </select>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[9px] text-cyan-400/60">Anchor Strength: {(config.likenessAnchorStrength ?? 0.25).toFixed(2)}</Label>
                      <Slider min={0} max={0.60} step={0.01} value={[config.likenessAnchorStrength ?? 0.25]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, likenessAnchorStrength: v }))} disabled={isRunning} />
                      <p className="text-[8px] text-muted-foreground/50">Pull toward the reference identity. 0.08–0.18 is subtle; 0.25 is a balanced start.</p>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[9px] text-cyan-400/60">Late Block Falloff: {(config.likenessLateBlockFalloff ?? 0.4).toFixed(1)}</Label>
                      <Slider min={0} max={1.0} step={0.1} value={[config.likenessLateBlockFalloff ?? 0.4]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, likenessLateBlockFalloff: v }))} disabled={isRunning} />
                      <p className="text-[8px] text-muted-foreground/50">Reduce the anchor in the final detail layers. 0.3–0.6 avoids over-sharpening.</p>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[9px] text-cyan-400/60">Similarity Threshold: {(config.likenessSimThreshold ?? 0.50).toFixed(2)}</Label>
                      <Slider min={0} max={1.0} step={0.05} value={[config.likenessSimThreshold ?? 0.50]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, likenessSimThreshold: v }))} disabled={isRunning} />
                      <p className="text-[8px] text-muted-foreground/50">Min cosine similarity for a token to receive pull. Lower = broader effect.</p>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Autoregressive Long-Form (Top-Tier single-shot character consistency) ── */}
              {config.modelVersion === "2.3" && (
                <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-cyan-400 font-medium flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" /> Autoregressive Long-Form (Top-Tier)
                    </span>
                    <Switch
                      checked={!!config.autoregressiveEnabled}
                      onCheckedChange={(v) => setConfig((prev) => ({
                        ...prev,
                        autoregressiveEnabled: v,
                        // Pre-configure the validated operating point + disable conflicting modes on enable
                        ...(v ? {
                          arTemporalTileSize: prev.arTemporalTileSize ?? 40,
                          arTemporalOverlap: prev.arTemporalOverlap ?? 24,
                          arAdainFactor: prev.arAdainFactor ?? 0.15,
                          ingredientsMode: false,
                        } : {}),
                      }))}
                      className="scale-75"
                      disabled={isRunning}
                    />
                  </div>
                  <p className="text-[9px] text-cyan-400/60">
                    Renders each segment as ONE continuous <strong>autoregressive</strong> pass
                    (LTXVLoopingSampler) with latent-overlap temporal tiling, identity &amp; scene carry across
                    the whole segment instead of lossy last-frame chaining. Draft with the distilled GGUF model
                    (fast, compute-bound); switch to a full model (e.g. 10Eros) for final quality (slower,
                    memory-bound). <span className="text-cyan-300">(Experimental Feature: Use with Caution)</span> VIDEO-ONLY in v1.
                  </p>
                  {config.autoregressiveEnabled && (
                    <div className="space-y-2.5">
                      <div className="space-y-1">
                        <Label className="text-[9px] text-cyan-400/60">Temporal Tile Size: {config.arTemporalTileSize ?? 40}</Label>
                        <Slider min={24} max={96} step={8} value={[config.arTemporalTileSize ?? 40]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, arTemporalTileSize: v }))} disabled={isRunning} />
                        <p className="text-[8px] text-muted-foreground/50">Frames per tile. 40 = compute-bound on 16GB; larger = fewer seams but more VRAM.</p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-cyan-400/60">Continuity Strength: {(config.arTemporalOverlapCondStrength ?? 0.5).toFixed(2)}</Label>
                        <Slider min={0} max={1} step={0.05} value={[config.arTemporalOverlapCondStrength ?? 0.5]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, arTemporalOverlapCondStrength: v }))} disabled={isRunning} />
                        <p className="text-[8px] text-muted-foreground/50">How strongly each tile conditions on the previous tile&apos;s latents.</p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-cyan-400/60">AdaIN (drift / oversaturation): {(config.arAdainFactor ?? 0.15).toFixed(2)}</Label>
                        <Slider min={0} max={0.5} step={0.05} value={[config.arAdainFactor ?? 0.15]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, arAdainFactor: v }))} disabled={isRunning} />
                        <p className="text-[8px] text-muted-foreground/50">Curbs accumulated color drift on long runs. 0.1–0.3 recommended.</p>
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-[9px] text-cyan-400/60">Long-Memory Anchor (negative-index)</span>
                        <Switch
                          checked={!!config.arNegativeIndexEnabled}
                          onCheckedChange={(v) => setConfig((prev) => ({ ...prev, arNegativeIndexEnabled: v }))}
                          className="scale-75"
                          disabled={isRunning}
                        />
                      </div>
                      <p className="text-[8px] text-muted-foreground/50">Off by default: the default graph matches the validated run exactly. When on, encodes each segment&apos;s source frame as a global identity memory fed to every tile (not just the previous one). Opt-in A/B: compare on vs off.</p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Character Consistency: Reference Sheet (Official IC-LoRA "Ingredients") ── */}
              {config.modelVersion === "2.3" && (config.pipelineMode || "official") === "official" && (
                <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-violet-400 font-medium flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" /> Character Consistency: Reference Sheet
                    </span>
                    <Switch
                      checked={!!config.ingredientsMode}
                      onCheckedChange={(v) => setConfig((prev) => ({
                        ...prev,
                        ingredientsMode: v,
                        // Autoregressive shares the sampler path, keep it exclusive with the reference sheet.
                        // 10S Likeness STACKS with the reference sheet (Advanced), so it is NOT disabled here.
                        ...(v ? { autoregressiveEnabled: false } : {}),
                      }))}
                      disabled={isRunning}
                    />
                  </div>
                  <p className="text-[8px] text-muted-foreground/50 leading-snug">
                    Official Lightricks IC-LoRA. ONE composite reference sheet (character turnarounds, props, location on a
                    black background, no text) anchors those identities across every segment. Best at the trained bucket:
                    768×448, 121 frames, 24fps. Prompt as &ldquo;Reference sheet: … / Generated video: …&rdquo;.
                  </p>
                  {config.ingredientsMode && (
                    <div className="space-y-2.5">
                      {/* Frame-bucket advisory: the Ingredients LoRA loops the reference to the full
                          segment length at full resolution (downscale ×1), so segments beyond its
                          121-frame trained bucket roughly double VRAM. Turns red past the cap. */}
                      <p
                        className={`text-[8px] leading-snug rounded px-1.5 py-1 border ${
                          config.segments.some((s) => s.numFrames > 121)
                            ? "text-red-400 border-red-500/40 bg-red-500/10"
                            : "text-amber-400/70 border-amber-500/20 bg-amber-500/5"
                        }`}
                      >
                        {config.segments.some((s) => s.numFrames > 121)
                          ? `⚠ ${config.segments.filter((s) => s.numFrames > 121).length} segment${
                              config.segments.filter((s) => s.numFrames > 121).length > 1 ? "s" : ""
                            } exceed the 121-frame cap (longest ${Math.max(
                              ...config.segments.map((s) => s.numFrames),
                            )}f). This LoRA loops the reference to the full segment length at full resolution (downscale ×1), so long segments roughly double VRAM and fall outside the 768×448·121f training bucket. Expect OOM on 16GB. Recommend ≤121 frames/segment (~5s @ 24fps).`
                          : `Recommended cap: ≤121 frames per segment, the LoRA's trained bucket (768×448 · 121f · 24fps). Longer segments double VRAM (reference loops at downscale ×1) and drift from training.`}
                      </p>
                      {/* Reference sheet upload / preview */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-[9px] text-violet-400/60">Reference Sheet</Label>
                          {config.referenceSheetImage && (
                            <button type="button" className="text-[8px] text-destructive/70 hover:text-destructive"
                              onClick={() => { setConfig((prev) => ({ ...prev, referenceSheetImage: "" })); setReferenceSheetPreview(null); }}>
                              ✕ Remove
                            </button>
                          )}
                        </div>
                        {(referenceSheetPreview || config.referenceSheetImage) ? (
                          <div className="flex justify-center">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={referenceSheetPreview || getImageUrl(config.referenceSheetImage!, "", "input")} alt="Reference sheet" className="max-h-32 rounded border border-violet-500/30 object-contain" />
                          </div>
                        ) : (
                          <div
                            className="flex items-center justify-center gap-1 rounded border border-dashed border-violet-500/30 bg-violet-500/5 py-3 text-[9px] text-violet-400/50 cursor-pointer hover:border-violet-400/50 hover:text-violet-400/70 transition-colors"
                            onClick={() => document.getElementById("director-refsheet-upload")?.click()}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f && f.type.startsWith("image/")) handleReferenceSheetUpload(f); }}
                          >
                            <Upload className="w-3 h-3" /> Drop reference sheet or click
                            <input id="director-refsheet-upload" type="file" accept="image/*" className="hidden"
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleReferenceSheetUpload(f); e.target.value = ""; }} />
                          </div>
                        )}
                      </div>

                      {/* IC-LoRA model selection */}
                      <div className="space-y-1">
                        <Label className="text-[9px] text-violet-400/60">Ingredients IC-LoRA</Label>
                        <LoraSelect
                          value={config.ingredientsLoRAName || ""}
                          options={availableLoras}
                          onChange={(name) => setConfig((prev) => ({ ...prev, ingredientsLoRAName: name }))}
                          compatMode="ltx2"
                          disabled={isRunning}
                          placeholder="Select ingredients IC-LoRA..."
                        />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-[9px] text-violet-400/60">Reference Strength: {(config.referenceSheetStrength ?? 1.0).toFixed(2)}</Label>
                        <Slider min={0} max={1} step={0.05} value={[config.referenceSheetStrength ?? 1.0]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, referenceSheetStrength: v }))} disabled={isRunning} />
                      </div>

                      <div className="space-y-1">
                        <Label className="text-[9px] text-violet-400/60">IC-LoRA Weight: {(config.ingredientsLoRAStrength ?? 1.4).toFixed(2)}</Label>
                        <Slider min={0} max={2} step={0.05} value={[config.ingredientsLoRAStrength ?? 1.4]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, ingredientsLoRAStrength: v }))} disabled={isRunning} />
                        <p className="text-[8px] text-muted-foreground/50">Recommended 1.4.</p>
                      </div>

                      {/* Frame-0 source injection (I2V alongside the reference sheet) */}
                      <div className="rounded border border-violet-500/20 bg-violet-500/5 p-2 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] text-violet-300 font-medium">Inject source frame (I2V)</Label>
                          <Switch
                            checked={!!config.ingredientsUseSourceFrame}
                            onCheckedChange={(v) => setConfig((prev) => ({ ...prev, ingredientsUseSourceFrame: v }))}
                            disabled={isRunning}
                          />
                        </div>
                        <p className="text-[8px] text-muted-foreground/60">
                          Anchors each segment&apos;s source frame (chained last-frame / storyboard / manual start) at frame 0
                          <span className="text-violet-300"> alongside</span> the reference sheet: high-quality image injection instead of pure text-to-video. Recommended for Continuum chaining.
                        </p>
                        {config.ingredientsUseSourceFrame && (
                          <div className="space-y-1 pt-0.5">
                            <Label className="text-[9px] text-violet-400/60">Source Frame Strength: {(config.ingredientsSourceFrameStrength ?? 0.65).toFixed(2)}</Label>
                            <Slider min={0.1} max={1} step={0.05} value={[config.ingredientsSourceFrameStrength ?? 0.65]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, ingredientsSourceFrameStrength: v }))} disabled={isRunning} />
                            <p className="text-[8px] text-muted-foreground/50">Recommended ~0.65 for chaining. At 1.0 frame 0 is hard-locked to the source, which can snap to the reference sheet on the next frame; lower lets the model blend the source into the reference-guided motion.</p>
                          </div>
                        )}
                      </div>

                      {/* End-frame anchor (I2V): mirror of the source frame, for the LAST frame */}
                      <div className="rounded border border-violet-500/20 bg-violet-500/5 p-2 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[10px] text-violet-300 font-medium">Anchor end frame (continuity)</Label>
                          <Switch
                            checked={config.ingredientsUseEndFrame ?? true}
                            onCheckedChange={(v) => setConfig((prev) => ({ ...prev, ingredientsUseEndFrame: v }))}
                            disabled={isRunning}
                          />
                        </div>
                        <p className="text-[8px] text-muted-foreground/60">
                          Default for every segment: when a segment has an <span className="text-violet-300">end image</span> (chained next-segment start / storyboard end), the model is steered toward it at the last frame for smooth segment-to-segment continuity. Each segment can override this to drift freely.
                        </p>
                        {(config.ingredientsUseEndFrame ?? true) && (
                          <div className="space-y-1 pt-0.5">
                            <Label className="text-[9px] text-violet-400/60">End Frame Strength: {(config.ingredientsEndFrameStrength ?? 0.65).toFixed(2)}</Label>
                            <Slider min={0.1} max={1} step={0.05} value={[config.ingredientsEndFrameStrength ?? 0.65]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, ingredientsEndFrameStrength: v }))} disabled={isRunning} />
                            <p className="text-[8px] text-muted-foreground/50">Recommended ~0.65 for graceful transitions. LTX &ldquo;sees&rdquo; the end frame across the clip and interpolates toward it; lower = softer approach, 1.0 = hard-lock the final frame (can snap if far from the natural trajectory).</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Foley Audio Settings (shown when audioMode === "foley") ── */}
              {config.audioMode === "foley" && (
                <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3 space-y-2">
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full text-left"
                    onClick={() => setFoleyExpanded(!foleyExpanded)}
                  >
                    {foleyExpanded ? <ChevronDown className="w-3.5 h-3.5 text-sky-400" /> : <ChevronRight className="w-3.5 h-3.5 text-sky-400" />}
                    <Volume2 className="w-3.5 h-3.5 text-sky-400" />
                    <span className="text-[11px] text-sky-400 font-medium">Foley Audio</span>
                    {config.foleyPrompt && <span className="text-[8px] text-sky-400/50 ml-auto truncate max-w-[120px]">{config.foleyPrompt.slice(0, 30)}...</span>}
                  </button>

                  {foleyExpanded && (
                    <div className="space-y-2 pt-1">
                      <div>
                        <Label className="text-[10px] text-sky-400/70">Audio Description</Label>
                        <textarea
                          value={config.foleyPrompt}
                          onChange={(e) => setConfig((prev) => ({ ...prev, foleyPrompt: e.target.value }))}
                          placeholder="Describe the sounds: ambient noise, footsteps, wind..."
                          rows={3}
                          className="w-full mt-1 rounded border border-sky-500/30 bg-background px-2 py-1.5 text-[11px] placeholder:text-muted-foreground/40 resize-none"
                          disabled={isRunning}
                        />
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {FOLEY_PROMPT_PRESETS.map((p) => (
                            <button
                              key={p.label}
                              type="button"
                              onClick={() => setConfig((prev) => ({ ...prev, foleyPrompt: p.prompt }))}
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
                          value={config.foleyNegativePrompt}
                          onChange={(e) => setConfig((prev) => ({ ...prev, foleyNegativePrompt: e.target.value }))}
                          className="w-full mt-1 h-7 rounded border border-sky-500/30 bg-background px-2 text-[10px]"
                          disabled={isRunning}
                        />
                      </div>
                      <div className="flex gap-2">
                        <div className="flex-1 space-y-1">
                          <Label className="text-[9px] text-sky-400/60">Steps: {config.foleySteps}</Label>
                          <Slider value={[config.foleySteps]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, foleySteps: v }))} min={25} max={150} step={5} disabled={isRunning} />
                        </div>
                        <div className="flex-1 space-y-1">
                          <Label className="text-[9px] text-sky-400/60">CFG: {config.foleyCfg}</Label>
                          <Slider value={[config.foleyCfg]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, foleyCfg: v }))} min={1} max={10} step={0.5} disabled={isRunning} />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-sky-400/60">Sampler</Label>
                        <select
                          value={config.foleySampler}
                          onChange={(e) => setConfig((prev) => ({ ...prev, foleySampler: e.target.value }))}
                          className="w-full h-7 rounded border border-sky-500/30 bg-background px-2 text-[10px]"
                          disabled={isRunning}
                        >
                          {FOLEY_SAMPLERS.map((s) => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                          ))}
                        </select>
                      </div>
                      <p className="text-[8px] text-sky-400/40">
                        Generates motion-synced audio after all segments are concatenated. Requires HunyuanVideo-Foley custom nodes.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Lip Sync (LatentSync 1.6) ── */}
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 space-y-2">
                <div
                  role="button"
                  tabIndex={0}
                  className="flex items-center gap-2 w-full text-left cursor-pointer"
                  onClick={() => setLipSyncExpanded(!lipSyncExpanded)}
                >
                  {lipSyncExpanded ? <ChevronDown className="w-3.5 h-3.5 text-rose-400" /> : <ChevronRight className="w-3.5 h-3.5 text-rose-400" />}
                  <Mic2 className="w-3.5 h-3.5 text-rose-400" />
                  <span className="text-[11px] text-rose-400 font-medium">Lip Sync</span>
                  <div className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    {config.lipSyncEnabled && <span className="text-[8px] text-rose-400/60 bg-rose-500/10 px-1.5 py-0.5 rounded">Active</span>}
                    <Switch
                      checked={config.lipSyncEnabled}
                      onCheckedChange={(v) => setConfig((prev) => ({ ...prev, lipSyncEnabled: v }))}
                      disabled={isRunning}
                      className="scale-75"
                    />
                  </div>
                </div>

                {lipSyncExpanded && (
                  <div className="space-y-2 pt-1">
                    <p className="text-[8px] text-rose-400/50">
                      Applies LatentSync 1.6 lip sync for realistic mouth movements. Requires master audio (Music Video mode).
                    </p>
                    <div className="space-y-1">
                      <Label className="text-[9px] text-rose-400/60">Timing</Label>
                      <select
                        value={config.lipSyncTiming}
                        onChange={(e) => setConfig((prev) => ({ ...prev, lipSyncTiming: e.target.value as "per_segment" | "post_assembly" }))}
                        className="w-full h-7 rounded border border-rose-500/30 bg-background px-2 text-[10px]"
                        disabled={isRunning || !config.lipSyncEnabled}
                      >
                        <option value="post_assembly">After Assembly (recommended)</option>
                        <option value="per_segment">Per Segment</option>
                      </select>
                      <p className="text-[7px] text-rose-400/40">
                        {config.lipSyncTiming === "post_assembly"
                          ? "Runs lip sync once on the final video, avoids reloading LTX between segments (~6.5 GB VRAM)."
                          : "Runs lip sync after each segment, forces LTX model reload between segments. Slower but allows per-segment review."}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[9px] text-rose-400/60">Inference Steps</Label>
                        <div className="flex items-center gap-2">
                          <Slider
                            min={10} max={50} step={5}
                            value={[config.lipSyncInferenceSteps]}
                            onValueChange={([v]) => setConfig((prev) => ({ ...prev, lipSyncInferenceSteps: v }))}
                            disabled={isRunning || !config.lipSyncEnabled}
                            className="flex-1"
                          />
                          <span className="text-[9px] text-muted-foreground w-5 text-right">{config.lipSyncInferenceSteps}</span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-rose-400/60">Expression Intensity</Label>
                        <div className="flex items-center gap-2">
                          <Slider
                            min={1.0} max={3.0} step={0.1}
                            value={[config.lipSyncExpression]}
                            onValueChange={([v]) => setConfig((prev) => ({ ...prev, lipSyncExpression: v }))}
                            disabled={isRunning || !config.lipSyncEnabled}
                            className="flex-1"
                          />
                          <span className="text-[9px] text-muted-foreground w-5 text-right">{config.lipSyncExpression.toFixed(1)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[9px] text-rose-400/60">Face Restoration</Label>
                        <select
                          value={config.lipSyncFaceRestore}
                          onChange={(e) => setConfig((prev) => ({ ...prev, lipSyncFaceRestore: e.target.value as "gfpgan" | "none" }))}
                          className="w-full h-7 rounded border border-rose-500/30 bg-background px-2 text-[10px]"
                          disabled={isRunning || !config.lipSyncEnabled}
                        >
                          <option value="gfpgan">GFPGAN v1.4</option>
                          <option value="none">None</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[9px] text-rose-400/60">
                          Restore Strength
                        </Label>
                        <div className="flex items-center gap-2">
                          <Slider
                            min={0} max={1} step={0.05}
                            value={[config.lipSyncFaceRestoreFidelity]}
                            onValueChange={([v]) => setConfig((prev) => ({ ...prev, lipSyncFaceRestoreFidelity: v }))}
                            disabled={isRunning || !config.lipSyncEnabled || config.lipSyncFaceRestore === "none"}
                            className="flex-1"
                          />
                          <span className="text-[9px] text-muted-foreground w-5 text-right">{config.lipSyncFaceRestoreFidelity.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[9px] text-rose-400/60">Face Detection</Label>
                      <select
                        value={config.lipSyncFaceDetection}
                        onChange={(e) => setConfig((prev) => ({ ...prev, lipSyncFaceDetection: e.target.value }))}
                        className="w-full h-7 rounded border border-rose-500/30 bg-background px-2 text-[10px]"
                        disabled={isRunning || !config.lipSyncEnabled || config.lipSyncFaceRestore === "none"}
                      >
                        <option value="retinaface_resnet50">RetinaFace ResNet50</option>
                        <option value="retinaface_mobile0.25">RetinaFace Mobile</option>
                      </select>
                    </div>
                  </div>
                )}
              </div>

              {/* ── LoRA Management ── */}
              <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 p-3 space-y-2">
                <button
                  type="button"
                  className="flex items-center gap-2 w-full text-left"
                  onClick={() => setLorasExpanded(!lorasExpanded)}
                >
                  {lorasExpanded ? <ChevronDown className="w-3.5 h-3.5 text-purple-400" /> : <ChevronRight className="w-3.5 h-3.5 text-purple-400" />}
                  <span className="text-[11px] text-purple-400 font-medium">LoRAs</span>
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
                        <Label className="text-[10px] text-purple-300/80">Distill LoRA</Label>
                        <button
                          type="button"
                          onClick={() => {
                            const defaults = getLTX2CheckpointConfig(config.diffusionModel);
                            setConfig((prev) => ({
                              ...prev,
                              distillLoRA: defaults.distillLoRA ?? LTX23_MODEL_DEFAULTS.distillLoRA,
                              distillLoRAStrength: defaults.distillLoRAStrength ?? 0.75,
                            }));
                          }}
                          className="text-muted-foreground/40 hover:text-muted-foreground"
                          title="Reset to recommended for current checkpoint"
                        >
                          <RotateCcw className="w-2.5 h-2.5" />
                        </button>
                      </div>
                      <select
                        className="w-full rounded-md border border-purple-500/20 bg-background px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-purple-500/50"
                        value={config.distillLoRA}
                        onChange={(e) => setConfig((prev) => ({ ...prev, distillLoRA: e.target.value }))}
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
                          min={0} max={1.5} step={0.05}
                          value={[config.distillLoRAStrength]}
                          onValueChange={([v]) => setConfig((prev) => ({ ...prev, distillLoRAStrength: v }))}
                          className="flex-1"
                          disabled={isRunning || !config.distillLoRA}
                        />
                        <span className="text-[10px] text-purple-300 w-8 text-right">{config.distillLoRAStrength.toFixed(2)}</span>
                      </div>
                      <p className="text-[8px] text-muted-foreground/60">
                        {config.distillLoRA
                          ? "cond_safe variants recommended for I2V/finetunes (zeroed attention layers)."
                          : "No distill LoRA: model must have distillation baked in."}
                      </p>
                    </div>

                    {/* User LoRAs */}
                    {config.userLoras.map((lora, i) => (
                      <div key={i} className="rounded border border-purple-500/10 bg-background p-2 space-y-1.5">
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={lora.enabled}
                            onCheckedChange={(v) => {
                              const updated = [...config.userLoras];
                              updated[i] = { ...updated[i], enabled: v };
                              setConfig((prev) => ({ ...prev, userLoras: updated }));
                            }}
                            className="scale-[0.6]"
                            disabled={isRunning}
                          />
                          <LoraSelect
                            value={lora.name}
                            options={availableLoras}
                            onChange={(name) => {
                              const updated = [...config.userLoras];
                              updated[i] = { ...updated[i], name };
                              setConfig((prev) => ({ ...prev, userLoras: updated }));
                            }}
                            disabled={isRunning}
                            compatMode="director"
                          />
                          <button
                            type="button"
                            onClick={() => setConfig((prev) => ({ ...prev, userLoras: prev.userLoras.filter((_, idx) => idx !== i) }))}
                            className="p-0.5 text-destructive/40 hover:text-destructive"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <Label className="text-[9px] text-purple-300/60 w-16">Strength</Label>
                          <Slider
                            min={0} max={2} step={0.05}
                            value={[lora.strengthModel]}
                            onValueChange={([v]) => {
                              const updated = [...config.userLoras];
                              updated[i] = { ...updated[i], strengthModel: v };
                              setConfig((prev) => ({ ...prev, userLoras: updated }));
                            }}
                            className="flex-1"
                            disabled={isRunning}
                          />
                          <span className="text-[9px] text-purple-300 w-8 text-right">{lora.strengthModel.toFixed(2)}</span>
                        </div>
                      </div>
                    ))}

                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-[10px] border-purple-500/30 text-purple-400 hover:bg-purple-500/10"
                      onClick={() => {
                        const usedNames = new Set(config.userLoras.map((l) => l.name));
                        const firstUnused = availableLoras.find((n) => !usedNames.has(n));
                        const entry: LoraEntry = { enabled: true, name: firstUnused || "", strengthModel: 1.0, strengthClip: 1.0 };
                        setConfig((prev) => ({ ...prev, userLoras: [...prev.userLoras, entry] }));
                      }}
                      disabled={isRunning || availableLoras.length === 0}
                    >
                      <Plus className="w-3 h-3 mr-1" /> Add LoRA
                    </Button>
                  </div>
                )}
              </div>

              {/* ── Advanced Settings ── */}
              <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-2">
                <button
                  type="button"
                  className="flex items-center gap-2 w-full text-left"
                  onClick={() => setAdvancedExpanded(!advancedExpanded)}
                >
                  {advancedExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                  <span className="text-[11px] text-muted-foreground font-medium">Advanced / Normalization</span>
                </button>

                {advancedExpanded && (
                  <div className="space-y-2 pt-1">
                    {/* Normalization factors */}
                    <div className="space-y-1">
                      <Label className="text-[9px] text-muted-foreground/70">Video Norm Factors</Label>
                      <p className="text-[7px] text-muted-foreground/40">Per-step video latent scaling. All 1.0 = default. Reducing mid-steps can improve temporal coherence.</p>
                      <input
                        type="text"
                        value={config.videoNormFactors}
                        onChange={(e) => setConfig((prev) => ({ ...prev, videoNormFactors: e.target.value }))}
                        className="w-full h-7 rounded border border-border bg-background px-2 text-[10px] font-mono"
                        disabled={isRunning}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[9px] text-muted-foreground/70">Audio Norm Factors</Label>
                      <p className="text-[7px] text-muted-foreground/40">Per-step audio latent scaling. Steps 3 &amp; 6 at 0.25 tame white noise (Alternative recipe).</p>
                      <input
                        type="text"
                        value={config.audioNormFactors}
                        onChange={(e) => setConfig((prev) => ({ ...prev, audioNormFactors: e.target.value }))}
                        className="w-full h-7 rounded border border-border bg-background px-2 text-[10px] font-mono"
                        disabled={isRunning}
                      />
                    </div>

                    {/* Attention scales */}
                    <p className="text-[7px] text-muted-foreground/50 -mb-1">
                      Cross-modal attention: controls how video/audio attend to each other. Alternative pipeline only.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[8px] text-muted-foreground/60">Video Scale: {config.videoScale.toFixed(1)}</Label>
                        <p className="text-[7px] text-muted-foreground/40">Video self-attention. Higher = sharper, less fluid.</p>
                        <Slider value={[config.videoScale]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, videoScale: v }))} min={0} max={2} step={0.1} disabled={isRunning} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[8px] text-muted-foreground/60">Audio Scale: {config.audioScale.toFixed(1)}</Label>
                        <p className="text-[7px] text-muted-foreground/40">Audio self-attention. 0 = mute generated audio.</p>
                        <Slider value={[config.audioScale]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, audioScale: v }))} min={0} max={2} step={0.1} disabled={isRunning} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[8px] text-muted-foreground/60">A→V Scale: {config.audioToVideoScale.toFixed(1)}</Label>
                        <p className="text-[7px] text-muted-foreground/40">Audio bleeding into video. Lower = cleaner visuals.</p>
                        <Slider value={[config.audioToVideoScale]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, audioToVideoScale: v }))} min={0} max={2} step={0.1} disabled={isRunning} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[8px] text-muted-foreground/60">V→A Scale: {config.videoToAudioScale.toFixed(1)}</Label>
                        <p className="text-[7px] text-muted-foreground/40">Video influence on audio. Lower = decoupled.</p>
                        <Slider value={[config.videoToAudioScale]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, videoToAudioScale: v }))} min={0} max={2} step={0.1} disabled={isRunning} />
                      </div>
                    </div>

                    {/* VAE Tiling: with behavior descriptors */}
                    <p className="text-[7px] text-muted-foreground/50 -mb-1">
                      VAE Decode: Spatial tiles handle resolution, <strong className="text-amber-400/70">temporal settings are critical for motion quality</strong> at higher resolutions.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[8px] text-muted-foreground/60">VAE Tile: {config.vaeTileSize}px</Label>
                        <p className="text-[7px] text-muted-foreground/40">512 for ≤720p, 1024 for 1080p+</p>
                        <Slider value={[config.vaeTileSize]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, vaeTileSize: v }))} min={128} max={1024} step={64} disabled={isRunning} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[8px] text-muted-foreground/60">VAE Overlap: {config.vaeOverlap}px</Label>
                        <p className="text-[7px] text-muted-foreground/40">Reduces seams between spatial tiles</p>
                        <Slider value={[config.vaeOverlap]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, vaeOverlap: v }))} min={0} max={256} step={16} disabled={isRunning} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[8px] text-amber-400/70">Temporal Size: {config.vaeTemporalSize}f</Label>
                        <p className="text-[7px] text-amber-400/50">Frames per chunk: too low = jerky motion. 64 for ≤720p, 128+ for 1080p</p>
                        <Slider value={[config.vaeTemporalSize]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, vaeTemporalSize: v }))} min={8} max={256} step={8} disabled={isRunning} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[8px] text-amber-400/70">Temporal Overlap: {config.vaeTemporalOverlap}f</Label>
                        <p className="text-[7px] text-amber-400/50">Higher = smoother chunk transitions. 16 for ≤720p, 32+ for 1080p</p>
                        <Slider value={[config.vaeTemporalOverlap]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, vaeTemporalOverlap: v }))} min={0} max={64} step={4} disabled={isRunning} />
                      </div>
                    </div>

                    {/* FeedForward chunks */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[8px] text-muted-foreground/60">FF Chunks: {config.ffChunks}</Label>
                        <p className="text-[7px] text-muted-foreground/40">Splits feedforward layers. More = less VRAM. No quality impact.</p>
                        <Slider value={[config.ffChunks]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, ffChunks: v }))} min={1} max={8} step={1} disabled={isRunning} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[8px] text-muted-foreground/60">I2V Compression: {config.imgCompression}</Label>
                        <p className="text-[7px] text-muted-foreground/40">Lower = more source fidelity. Higher = more creative freedom.</p>
                        <Slider value={[config.imgCompression]} onValueChange={([v]) => setConfig((prev) => ({ ...prev, imgCompression: v }))} min={1} max={50} step={1} disabled={isRunning} />
                      </div>
                    </div>

                    {/* Model base path */}
                    <div className="space-y-1">
                      <Label className="text-[9px] text-muted-foreground/70">Model Base Path (SSD fast-path)</Label>
                      <input
                        type="text"
                        value={config.modelBasePath}
                        onChange={(e) => setConfig((prev) => ({ ...prev, modelBasePath: e.target.value }))}
                        placeholder="Path to models directory"
                        className="w-full h-7 rounded border border-border bg-background px-2 text-[10px] font-mono placeholder:text-muted-foreground/30"
                        disabled={isRunning}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Generate / Cancel / Interjection Controls, locked footer: pinned to the bottom
            of the dock so the action + live progress/ETA stay visible while scrolling. */}
        <div className="sticky bottom-0 z-10 mt-1 rounded-xl border border-blue-500/25 bg-[var(--sidebar)]/95 backdrop-blur p-2.5 space-y-2 shadow-[0_-4px_12px_rgba(0,0,0,0.25)]">
          {isPaused ? (
            /* ── Paused state: user interjection controls ── */
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
              <p className="text-[11px] text-amber-400 font-medium flex items-center gap-1.5">
                <Pause className="w-3.5 h-3.5" /> Segment {currentSegIdx + 1} Complete: Review
              </p>
              <p className="text-[9px] text-muted-foreground">
                Review the output below. Edit prompts for upcoming segments, then continue or re-generate.
              </p>
              {config.segments[currentSegIdx]?.outputUrl && (
                <VideoSlot
                  id={`director-review-${currentSegIdx}`}
                  src={config.segments[currentSegIdx].outputUrl!}
                  poster={config.segments[currentSegIdx].lastFrameFile ? getImageUrl(config.segments[currentSegIdx].lastFrameFile!, "", "input") : undefined}
                  className="rounded border border-blue-500/20"
                  style={{ maxHeight: "45vh", maxWidth: "100%" }}
                  autoOpen={autoplay}
                  loop
                />
              )}
              {/* Per-segment Z-Refine during pause */}
              {config.segments[currentSegIdx]?.outputUrl && (
                <ZRefinePanel
                  outputVideoFile={config.segments[currentSegIdx].outputUrl!}
                  outputVideoUrl={config.segments[currentSegIdx].outputUrl!}
                  videoPrompt={config.segments[currentSegIdx].prompt}
                  videoNegativePrompt={config.negativePrompt || ""}
                  videoFrameRate={config.frameRate}
                  videoNumFrames={config.segments[currentSegIdx].numFrames}
                  videoWidth={config.width}
                  videoHeight={config.height}
                  videoSeed={config.seed}
                  videoRandomSeed={config.randomSeed}
                  disabled={false}
                  onInjectGuideFrames={(frames) => {
                    // Update this segment's guide frames with refined images
                    const segIdx = currentSegIdx;
                    const seg = config.segments[segIdx];
                    if (!seg) return;
                    // Use first refined frame as source image, last as end image
                    const sorted = [...frames].sort((a, b) => a.frameIdx - b.frameIdx);
                    const updates: Partial<DirectorSegment> = {};
                    if (sorted.length > 0) {
                      updates.sourceImage = sorted[0].image;
                      updates.sourceImagePreview = getImageUrl(sorted[0].image, "", "input");
                    }
                    if (sorted.length > 1) {
                      updates.endImage = sorted[sorted.length - 1].image;
                      updates.endImagePreview = getImageUrl(sorted[sorted.length - 1].image, "", "input");
                    }
                    updateSegment(segIdx, updates);
                  }}
                />
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
                  onClick={handleContinue}
                >
                  <SkipForward className="w-3.5 h-3.5 mr-1.5" />
                  {currentSegIdx >= config.segments.length - 1
                    ? "Finalize Output"
                    : `Continue to Segment ${currentSegIdx + 2}`}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                  onClick={handleRegenerate}
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1" /> Re-gen
                </Button>
                {config.lipSyncEnabled && config.segments[currentSegIdx]?.audioSliceFile && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10"
                    onClick={handleRelipSync}
                    disabled={relipSyncing}
                  >
                    {relipSyncing
                      ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Syncing...</>
                      : <><Mic2 className="w-3.5 h-3.5 mr-1" /> Re-lip sync</>}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="border-teal-500/30 text-teal-400 hover:bg-teal-500/10"
                  onClick={handleAssembleCurrent}
                  disabled={assemblingCurrent || completedSegs < 2}
                  title={completedSegs < 2 ? "Need at least 2 completed segments" : `Assemble ${completedSegs} segments into a preview video`}
                >
                  {assemblingCurrent
                    ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Assembling...</>
                    : <><Film className="w-3.5 h-3.5 mr-1" /> Assemble</>}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleCancel}
                >
                  <Square className="w-3 h-3" />
                </Button>
              </div>
              <div className="flex justify-between text-[9px] text-muted-foreground/70">
                <span>{completedSegs}/{config.segments.length} segments done</span>
                <span>Prompts editable while paused</span>
              </div>
            </div>
          ) : isRunning ? (
            /* ── Running state: progress + cancel + mid-gen interjections ── */
            <>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  onClick={handleCancel}
                >
                  <Square className="w-3.5 h-3.5 mr-1.5" /> Cancel Pipeline
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-orange-500/30 text-orange-400 hover:bg-orange-500/10"
                  onClick={handleCancelCurrentSegment}
                  disabled={skipCurrentRef.current}
                  title="Cancel the current segment and pause for review: you can re-generate or continue"
                >
                  <XCircle className="w-3.5 h-3.5 mr-1" /> Cancel Segment
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-sky-500/30 text-sky-400 hover:bg-sky-500/10"
                  onClick={handleAdjustAfterCurrent}
                  disabled={adjustAfterCurrentRef.current}
                  title="Let the current segment finish, then pause so you can adjust settings"
                >
                  <Sliders className="w-3.5 h-3.5 mr-1" /> Adjust After
                </Button>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{segStage}</span>
                  <span>{completedSegs}/{config.segments.length} segments</span>
                </div>
                <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-amber-500 rounded-full transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
              {adjustAfterCurrentRef.current && (
                <p className="text-[9px] text-sky-400 flex items-center gap-1">
                  <Sliders className="w-3 h-3" /> Will pause after this segment for settings adjustment
                </p>
              )}
              {stepTimestamps.length >= 2 && segProgressMax > 0 && (
                <DirectorETACountdown stepTimestamps={stepTimestamps} progress={segProgress} progressMax={segProgressMax} />
              )}
              {/* Live Preview during segment generation */}
              {livePreviewUrl && (
                <div className="rounded border border-blue-500/20 bg-blue-500/5 p-2 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    <span className="text-[10px] text-blue-400 font-medium">Live Preview</span>
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={livePreviewUrl}
                    alt="Live preview"
                    className="w-full rounded border border-blue-500/20 object-contain"
                    style={{ maxHeight: "30vh" }}
                  />
                </div>
              )}
            </>
          ) : (
            /* ── Idle state: generate button + resume ── */
            <div className="space-y-2">
              <Button
                size="sm"
                className={`w-full text-white transition-colors ${
                  config.segments.some((s) => s.prompt.trim()) && comfyConnected !== false
                    ? "bg-blue-600 hover:bg-blue-500 vek-generate-glow"
                    : "bg-blue-600/40"
                }`}
                onClick={() => { resumeFromRef.current = null; resumeToRef.current = null; setResumeFromSegment(null); setResumeToSegment(null); handleGenerate(); }}
                disabled={
                  !config.segments.some((s) => s.prompt.trim()) ||
                  comfyConnected === false
                }
              >
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Generate {config.segments.length} Segment{config.segments.length > 1 ? "s" : ""} ({totalDuration.toFixed(1)}s)
              </Button>

              {/* Assemble from loaded save state, shown when 2+ segments are complete in idle */}
              {completedSegs >= 2 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full border-teal-500/30 text-teal-400 hover:bg-teal-500/10"
                  onClick={handleAssembleCurrent}
                  disabled={assemblingCurrent}
                  title={`Assemble ${completedSegs} completed segments into a preview video`}
                >
                  {assemblingCurrent
                    ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Assembling...</>
                    : <><Film className="w-3.5 h-3.5 mr-1" /> Assemble {completedSegs} Segments</>}
                </Button>
              )}

              {/* Assemble from disk: scans ltx2 output folder, ignores save-state tracking */}
              <Button
                size="sm"
                variant="outline"
                className="w-full border-orange-500/30 text-orange-400 hover:bg-orange-500/10"
                onClick={handleAssembleFromDirectory}
                disabled={assemblingDirectory}
                title="Scan the ltx2 output directory for numbered files and assemble them in order: ignores save-state tracking"
              >
                {assemblingDirectory
                  ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> Scanning &amp; Assembling…</>
                  : <><FolderSearch className="w-3.5 h-3.5 mr-1" /> Assemble from Disk</>}
              </Button>

              {/* Resume / Range render, shown when 2+ segments exist */}
              {config.segments.length > 1 && (
                <div className="space-y-1.5 rounded border border-teal-500/20 bg-teal-500/5 p-2">
                  <p className="text-[9px] text-teal-400/70 font-medium">Render Range</p>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] text-muted-foreground/60 shrink-0">From</span>
                    <select
                      value={resumeFromSegment ?? ""}
                      onChange={(e) => {
                        const v = e.target.value ? parseInt(e.target.value) : null;
                        resumeFromRef.current = v;
                        setResumeFromSegment(v);
                        // Auto-clamp "to" if it's now before "from"
                        if (v !== null && resumeToSegment !== null && resumeToSegment < v) {
                          resumeToRef.current = v;
                          setResumeToSegment(v);
                        }
                      }}
                      className="flex-1 h-6 rounded border border-teal-500/30 bg-background px-1.5 text-[9px] text-teal-400"
                    >
                      <option value="">Seg...</option>
                      {config.segments.map((seg, idx) => (
                        <option key={idx} value={idx}>
                          {idx + 1}{seg.status === "complete" ? " ✓" : seg.outputUrl ? " ●" : ""}
                        </option>
                      ))}
                    </select>
                    <span className="text-[9px] text-muted-foreground/60 shrink-0">through</span>
                    <select
                      value={resumeToSegment ?? ""}
                      onChange={(e) => { const v = e.target.value ? parseInt(e.target.value) : null; resumeToRef.current = v; setResumeToSegment(v); }}
                      className="flex-1 h-6 rounded border border-teal-500/30 bg-background px-1.5 text-[9px] text-teal-400"
                    >
                      <option value="">End</option>
                      {config.segments.map((seg, idx) => (
                        <option key={idx} value={idx} disabled={resumeFromSegment !== null && idx < resumeFromSegment}>
                          {idx + 1}{seg.status === "complete" ? " ✓" : seg.outputUrl ? " ●" : ""}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[9px] px-2.5 border-teal-500/30 text-teal-400 hover:bg-teal-500/10 shrink-0"
                      disabled={
                        resumeFromSegment === null ||
                        !config.segments.some((s) => s.prompt.trim()) ||
                        comfyConnected === false
                      }
                      onClick={() => { resumeFromRef.current = resumeFromSegment; resumeToRef.current = resumeToSegment; handleGenerate(); }}
                      title={resumeFromSegment !== null
                        ? `Render segments ${resumeFromSegment + 1}${resumeToSegment != null ? `–${resumeToSegment + 1}` : ` to end`}, preserving everything outside the range`
                        : "Select a start segment"}
                    >
                      <Play className="w-3 h-3 mr-1" /> Resume{resumeFromSegment !== null ? ` ${resumeFromSegment + 1}${resumeToSegment != null ? `–${resumeToSegment + 1}` : "+"}` : ""}
                    </Button>
                  </div>
                  {resumeFromSegment !== null && (
                    <p className="text-[8px] text-teal-400/50">
                      Will render {resumeToSegment != null ? resumeToSegment - resumeFromSegment + 1 : config.segments.length - resumeFromSegment} segment{(resumeToSegment != null ? resumeToSegment - resumeFromSegment + 1 : config.segments.length - resumeFromSegment) !== 1 ? "s" : ""}.
                      Segments outside this range are preserved.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {pipelineError && (
            <p className="text-[9px] text-red-400 flex items-center gap-1">
              <XCircle className="w-3 h-3" /> {pipelineError}
            </p>
          )}

          {/* VRAM estimator: pinned to the bottom of the locked footer unit; user can Hide it. */}
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
                  vramEstimate.risk === "safe" ? "text-emerald-400"
                  : vramEstimate.risk === "warning" ? "text-amber-400" : "text-red-400"
                }`}>
                  <Cpu className="w-3.5 h-3.5" /> VRAM per segment
                </span>
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] font-medium flex items-center gap-1.5 ${
                    vramEstimate.risk === "safe" ? "text-emerald-400"
                    : vramEstimate.risk === "warning" ? "text-amber-400" : "text-red-400"
                  }`}>
                    <Timer className="w-3.5 h-3.5" /> ~{vramEstimate.renderTimeLabel}/seg
                  </span>
                  <button
                    type="button"
                    onClick={() => setVramHidden(!vramHidden)}
                    className="text-muted-foreground/50 hover:text-foreground transition-colors"
                    title={vramHidden ? "Show VRAM details" : "Hide VRAM details"}
                  >
                    {vramHidden ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                </div>
              </div>
              {!vramHidden && (<>
              <div className="w-full h-2 rounded-full bg-muted/50 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    vramEstimate.risk === "safe" ? "bg-emerald-500"
                    : vramEstimate.risk === "warning" ? "bg-amber-500" : "bg-red-500"
                  }`}
                  style={{ width: `${Math.min(100, (vramEstimate.estimatedPeakGB / vramEstimate.totalVramGB) * 100)}%` }}
                />
              </div>
              <p className={`text-[9px] ${
                vramEstimate.risk === "safe" ? "text-emerald-400/80"
                : vramEstimate.risk === "warning" ? "text-amber-400/80" : "text-red-400/80"
              }`}>
                {vramEstimate.message}
              </p>
              </>)}
            </div>
          )}
        </div>

        </div></WorkflowControls>

        {/* Final Output */}
        {finalOutputUrl && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
            <p className="text-[11px] text-emerald-400 font-medium flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" /> Final Output
            </p>
            <VideoSlot
              id="director-final"
              src={finalOutputUrl}
              className="rounded border border-emerald-500/20"
              style={{ maxHeight: "45vh", maxWidth: "100%" }}
              autoOpen={autoplay}
              loop
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  const resp = await fetch(finalOutputUrl);
                  const blob = await resp.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `VekSnap_Director_${Date.now()}.mp4`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch { /* ignore */ }
              }}
              className="flex items-center justify-center gap-1.5 w-full h-7 rounded border border-emerald-500/30 text-[10px] text-emerald-400 hover:bg-emerald-500/10 transition-colors"
            >
              <Download className="w-3 h-3" /> Download Final Video
            </button>
          </div>
        )}

        {/* Z-Refine Panel: final output keyframe enhancement */}
        {finalOutputUrl && !isRunning && !isPaused && (
          <ZRefinePanel
            outputVideoFile={finalOutputUrl}
            outputVideoUrl={finalOutputUrl}
            videoPrompt={config.segments.map((s) => s.prompt).filter(Boolean).join(" | ")}
            videoNegativePrompt={config.negativePrompt || ""}
            videoFrameRate={config.frameRate}
            videoNumFrames={totalFrames}
            videoWidth={config.width}
            videoHeight={config.height}
            videoSeed={config.seed}
            videoRandomSeed={config.randomSeed}
            disabled={isRunning}
            onInjectGuideFrames={(frames) => {
              // In Director mode, inject refined frames as storyboard images
              // This allows re-generation with enhanced keyframes as anchors
              const newStoryboardImages = frames.map((f) => ({
                id: `zrefine_sb_${Date.now()}_${f.frameIdx}`,
                image: f.image,
                preview: getImageUrl(f.image, "", "input"),
                label: `Z-Refined f${f.frameIdx}`,
              }));
              setConfig((prev) => ({
                ...prev,
                storyboardImages: [
                  ...prev.storyboardImages,
                  ...newStoryboardImages,
                ],
              }));
            }}
          />
        )}

      </div>}
    </div>
  );
}
