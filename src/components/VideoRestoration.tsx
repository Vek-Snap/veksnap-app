"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Upload,
  Play,
  Square,
  Settings2,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertTriangle,
  Sparkles,
  Zap,
  Sun,
  Volume2,
  RefreshCw,
  FolderOpen,
  Info,
  Download,
  Eye,
  X,
  SplitSquareHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  VideoRestorationConfig,
  VIDEO_RESTORATION_DEFAULTS,
  RESTORE_ENGINE_OPTIONS,
  SEEDVR2_MODELS,
  ESRGAN_MODELS,
  RESTORE_OUTPUT_CODECS,
  RESTORE_FPS_PRESETS,
  RESTORE_RESOLUTION_PRESETS,
  RestoreEngine,
} from "@/lib/types";

interface VideoRestorationProps {
  config: VideoRestorationConfig;
  onConfigChange: (config: VideoRestorationConfig) => void;
}

type RestoreStatus = "idle" | "probing" | "preprocessing" | "restoring" | "postprocessing" | "encoding" | "complete" | "error";
type SetupStatus = "unknown" | "checking" | "missing" | "ready";

export default function VideoRestoration({
  config,
  onConfigChange,
}: VideoRestorationProps) {
  const configRef = useRef(config);
  configRef.current = config;

  const [status, setStatus] = useState<RestoreStatus>("idle");
  const [setupStatus, setSetupStatus] = useState<SetupStatus>("unknown");
  const [setupDetails, setSetupDetails] = useState<{ seedvr2: boolean; esrgan: boolean; ffmpeg: boolean }>({ seedvr2: false, esrgan: false, ffmpeg: false });
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [eta, setEta] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [preProcessExpanded, setPreProcessExpanded] = useState(true);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewOriginal, setPreviewOriginal] = useState<string | null>(null);
  const [previewProcessed, setPreviewProcessed] = useState<string | null>(null);
  const [previewTimestamp, setPreviewTimestamp] = useState(0);
  const [previewMode, setPreviewMode] = useState<"side" | "original" | "processed">("side");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragCounterRef = useRef(0);

  const update = useCallback(
    <K extends keyof VideoRestorationConfig>(key: K, value: VideoRestorationConfig[K]) => {
      const newConfig = { ...configRef.current, [key]: value };
      configRef.current = newConfig;
      onConfigChange(newConfig);
    },
    [onConfigChange]
  );

  // Check setup status on mount
  useEffect(() => {
    checkSetup();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkSetup() {
    setSetupStatus("checking");
    try {
      const res = await fetch("/api/restore/setup");
      if (!res.ok) throw new Error("Setup check failed");
      const data = await res.json();
      setSetupDetails(data);
      setSetupStatus(data.seedvr2 || data.esrgan ? "ready" : "missing");
    } catch {
      setSetupStatus("missing");
    }
  }

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounterRef.current = 0;

    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("video/")) {
      processVideoFile(file);
    }
  }, []);

  async function processVideoFile(file: File) {
    setStatus("probing");
    setError(null);

    try {
      const formData = new FormData();
      formData.append("video", file);

      const res = await fetch("/api/restore/probe", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to probe video");
      }

      const probe = await res.json();
      update("inputVideoPath", probe.path);
      update("inputVideoName", file.name);
      update("inputDuration", probe.duration);
      update("inputFps", probe.fps);
      update("inputWidth", probe.width);
      update("inputHeight", probe.height);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load video");
      setStatus("error");
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    processVideoFile(file);
    // Reset file input so same file can be re-selected
    e.target.value = "";
  }

  async function handlePreview() {
    if (!config.inputVideoPath) return;
    setPreviewLoading(true);
    setPreviewOriginal(null);
    setPreviewProcessed(null);

    try {
      const res = await fetch("/api/restore/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoPath: config.inputVideoPath,
          timestamp: previewTimestamp,
          denoiseEnabled: config.denoiseEnabled,
          denoiseStrength: config.denoiseStrength,
          brightnessAdjust: config.brightnessAdjust,
          contrastAdjust: config.contrastAdjust,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Preview failed");
      }

      const data = await res.json();
      setPreviewOriginal(data.original);
      setPreviewProcessed(data.processed || data.original);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleRestore() {
    if (!config.inputVideoPath) {
      setError("No video selected");
      return;
    }

    setStatus("restoring");
    setError(null);
    setProgress(0);
    setProgressLabel("Starting restoration...");
    setOutputPath(null);

    try {
      const res = await fetch("/api/restore/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to start restoration");
      }

      const { jobId } = await res.json();

      // Poll for progress
      pollRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/restore/status?jobId=${jobId}`);
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();

          setProgress(pollData.progress ?? 0);
          setProgressLabel(pollData.label ?? "");
          setEta(pollData.eta ?? null);

          if (pollData.status === "complete") {
            if (pollRef.current) clearInterval(pollRef.current);
            setStatus("complete");
            setOutputPath(pollData.outputPath ?? null);
          } else if (pollData.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setStatus("error");
            setError(pollData.error ?? "Unknown error");
          } else {
            // Map substatus to our status
            if (pollData.status === "preprocessing") setStatus("preprocessing");
            else if (pollData.status === "restoring") setStatus("restoring");
            else if (pollData.status === "postprocessing") setStatus("postprocessing");
            else if (pollData.status === "encoding") setStatus("encoding");
          }
        } catch { /* ignore poll errors */ }
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restoration failed");
      setStatus("error");
    }
  }

  function handleStop() {
    if (pollRef.current) clearInterval(pollRef.current);
    fetch("/api/restore/stop", { method: "POST" }).catch(() => {});
    setStatus("idle");
    setProgressLabel("Cancelled");
  }

  const isRunning = status === "preprocessing" || status === "restoring" || status === "postprocessing" || status === "encoding";
  const hasInput = !!config.inputVideoPath;

  return (
    <div
      className="space-y-4 p-3"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-rose-400 flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          Video Restoration
        </h3>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] gap-1"
            onClick={checkSetup}
          >
            <RefreshCw className="w-3 h-3" /> Check Setup
          </Button>
          {setupStatus === "ready" && (
            <span className="text-[10px] text-emerald-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Ready
            </span>
          )}
          {setupStatus === "missing" && (
            <span className="text-[10px] text-amber-400 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Setup needed
            </span>
          )}
          {setupStatus === "checking" && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Checking...
            </span>
          )}
        </div>
      </div>

      <p className="text-[10px] text-rose-400/70">
        Restore old, dark, and grainy video footage using AI. SeedVR2 provides diffusion-based restoration
        with detail recovery; Real-ESRGAN offers fast traditional upscaling.
      </p>

      {/* Setup warning */}
      {setupStatus === "missing" && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 space-y-1.5">
          <p className="text-[10px] text-amber-400 font-medium flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" /> Setup Required
          </p>
          <p className="text-[9px] text-amber-400/70">
            {!setupDetails.seedvr2 && "SeedVR2 ComfyUI node not installed. "}
            {!setupDetails.esrgan && "Real-ESRGAN not configured. "}
            {!setupDetails.ffmpeg && "ffmpeg not found. "}
          </p>
          <p className="text-[9px] text-amber-400/70">
            Run the setup script: <code className="bg-amber-500/20 px-1 rounded">Download_SeedVR2.bat</code> in the application root folder.
          </p>
        </div>
      )}

      {/* ── Engine Selection ── */}
      <div className="space-y-2">
        <Label className="text-[10px] font-medium text-rose-400/80">Restoration Engine</Label>
        <div className="grid grid-cols-2 gap-2">
          {RESTORE_ENGINE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => update("engine", opt.value)}
              className={`rounded border p-2 text-left transition-colors ${
                config.engine === opt.value
                  ? "border-rose-500/50 bg-rose-500/10"
                  : "border-border/50 hover:border-rose-500/30"
              }`}
            >
              <p className="text-[10px] font-medium">{opt.label}</p>
              <p className="text-[8px] text-muted-foreground mt-0.5">{opt.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* ── Input Video ── */}
      <div className="space-y-2">
        <Label className="text-[10px] font-medium text-rose-400/80">Input Video</Label>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={handleFileSelect}
        />
        {hasInput ? (
          <div className="rounded border border-rose-500/20 bg-rose-500/5 p-2 space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-medium truncate max-w-[180px]">{config.inputVideoName}</p>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 text-[9px]"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Change
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 text-[9px] text-destructive hover:text-destructive"
                  onClick={() => {
                    update("inputVideoPath", "");
                    update("inputVideoName", "");
                    update("inputDuration", 0);
                    update("inputFps", 0);
                    update("inputWidth", 0);
                    update("inputHeight", 0);
                    setPreviewOriginal(null);
                    setPreviewProcessed(null);
                    setPreviewTimestamp(0);
                    setError(null);
                    setOutputPath(null);
                  }}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            </div>
            <div className="flex gap-3 text-[9px] text-muted-foreground">
              <span>{config.inputWidth}×{config.inputHeight}</span>
              <span>{config.inputFps.toFixed(1)} fps</span>
              <span>{config.inputDuration.toFixed(1)}s</span>
            </div>
          </div>
        ) : (
          <button
            className={`w-full h-20 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-1.5 transition-colors ${
              isDragging
                ? "border-rose-500 bg-rose-500/15 text-rose-400"
                : "border-rose-500/30 text-rose-400/70 hover:text-rose-400 hover:border-rose-500/50"
            }`}
            onClick={() => fileInputRef.current?.click()}
            disabled={status === "probing"}
          >
            {status === "probing" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> <span className="text-[10px]">Analyzing video...</span></>
            ) : isDragging ? (
              <><Download className="w-5 h-5" /> <span className="text-[10px] font-medium">Drop video here</span></>
            ) : (
              <><Upload className="w-5 h-5" /> <span className="text-[10px]">Drop video file here or click to browse</span></>
            )}
          </button>
        )}
      </div>

      {/* ── Engine-specific settings ── */}
      {config.engine === "seedvr2" && (
        <div className="space-y-2 rounded border border-rose-500/20 bg-rose-500/5 p-2">
          <p className="text-[10px] text-rose-400 font-medium flex items-center gap-1">
            <Sparkles className="w-3 h-3" /> SeedVR2 Settings
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">Model</Label>
              <select
                value={config.seedvrModel}
                onChange={(e) => update("seedvrModel", e.target.value)}
                className="w-full h-7 rounded border border-rose-500/20 bg-background px-2 text-[10px]"
              >
                {SEEDVR2_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label} ({m.vram})</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">Output Resolution</Label>
              <select
                value={`${config.seedvrOutputWidth}x${config.seedvrOutputHeight}`}
                onChange={(e) => {
                  const preset = RESTORE_RESOLUTION_PRESETS.find(
                    (p) => `${p.width}x${p.height}` === e.target.value
                  );
                  if (preset) {
                    update("seedvrOutputWidth", preset.width);
                    update("seedvrOutputHeight", preset.height);
                  }
                }}
                className="w-full h-7 rounded border border-rose-500/20 bg-background px-2 text-[10px]"
              >
                {RESTORE_RESOLUTION_PRESETS.map((p) => (
                  <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>{p.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">Spatial Tile Size</Label>
              <select
                value={config.seedvrTileSize}
                onChange={(e) => update("seedvrTileSize", parseInt(e.target.value))}
                className="w-full h-7 rounded border border-rose-500/20 bg-background px-2 text-[10px]"
              >
                {[128, 192, 256, 320, 384, 512].map((s) => (
                  <option key={s} value={s}>{s}px {s <= 192 ? "(low VRAM)" : s >= 384 ? "(fast)" : "(balanced)"}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">Temporal Chunk</Label>
              <select
                value={config.seedvrTemporalSize}
                onChange={(e) => update("seedvrTemporalSize", parseInt(e.target.value))}
                className="w-full h-7 rounded border border-rose-500/20 bg-background px-2 text-[10px]"
              >
                {[4, 6, 8, 12, 16].map((f) => (
                  <option key={f} value={f}>{f} frames {f <= 6 ? "(low VRAM)" : f >= 12 ? "(better consistency)" : ""}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Switch
                checked={config.seedvrColorFix}
                onCheckedChange={(v) => update("seedvrColorFix", v)}
                className="scale-75"
              />
              <span className="text-[9px] text-muted-foreground">Color correction</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Switch
                checked={config.seedvrRandomSeed}
                onCheckedChange={(v) => update("seedvrRandomSeed", v)}
                className="scale-75"
              />
              <span className="text-[9px] text-muted-foreground">Random seed</span>
            </div>
          </div>

          {/* ── Z-Image Turbo repair PRE-PASS (Phase 2b) ── */}
          <div className={`mt-1 rounded border p-2 space-y-2 ${config.zimageRepairEnabled ? "border-amber-500/40 bg-amber-500/5" : "border-border/40"}`}>
            <div className="flex items-center gap-1.5">
              <Switch
                checked={config.zimageRepairEnabled}
                onCheckedChange={(v) => update("zimageRepairEnabled", v)}
                className="scale-75"
              />
              <span className={`text-[10px] font-medium ${config.zimageRepairEnabled ? "text-amber-300" : "text-muted-foreground"}`}>
                Z-Image repair pre-pass
              </span>
            </div>
            {!config.zimageRepairEnabled && (
              <p className="text-[9px] text-muted-foreground/70 leading-tight">
                Repairs semantic artifacts (melted teeth, warped eyes, mushy detail) on every frame
                with Z-Image Turbo <em>before</em> SeedVR2, whose temporal pass then removes the
                per-frame flicker the repairs introduce. Requires ComfyUI running.
              </p>
            )}
            {config.zimageRepairEnabled && (
              <>
                <div className="flex items-center gap-2">
                  <Label className="text-[9px] text-muted-foreground w-14">Mode</Label>
                  <select
                    value={config.zimageRepairMode}
                    onChange={(e) => update("zimageRepairMode", e.target.value as "face" | "enhance")}
                    className="flex-1 h-7 rounded border border-amber-500/20 bg-background px-2 text-[10px]"
                  >
                    <option value="face">Face Repair (region-targeted, faces only)</option>
                    <option value="enhance">Enhance Details (whole frame)</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-[9px] text-muted-foreground w-14">Strength</Label>
                  <Slider
                    value={[config.zimageRepairDenoise]}
                    onValueChange={([v]) => update("zimageRepairDenoise", v)}
                    min={0}
                    max={0.5}
                    step={0.01}
                    className="flex-1"
                  />
                  <span className="text-[9px] text-muted-foreground w-10 text-right">
                    {config.zimageRepairDenoise > 0 ? config.zimageRepairDenoise.toFixed(2) : "auto"}
                  </span>
                </div>
                <div className="space-y-1">
                  <Label className="text-[9px] text-muted-foreground">Subject context (optional)</Label>
                  <input
                    type="text"
                    value={config.zimageRepairPrompt}
                    onChange={(e) => update("zimageRepairPrompt", e.target.value)}
                    placeholder="e.g. young woman, red coat"
                    className="w-full h-7 rounded border border-amber-500/20 bg-background px-2 text-[10px]"
                  />
                </div>
                <p className="text-[8px] text-muted-foreground/60 leading-tight">
                  Strength <strong>auto</strong> uses the safe restoration default. Higher values
                  repair harder but risk re-imagining. Fully resumable and cancellable.
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {config.engine === "realesrgan" && (
        <div className="space-y-2 rounded border border-rose-500/20 bg-rose-500/5 p-2">
          <p className="text-[10px] text-rose-400 font-medium flex items-center gap-1">
            <Zap className="w-3 h-3" /> Real-ESRGAN Settings
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">Model</Label>
              <select
                value={config.esrganModel}
                onChange={(e) => update("esrganModel", e.target.value)}
                className="w-full h-7 rounded border border-rose-500/20 bg-background px-2 text-[10px]"
              >
                {ESRGAN_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">Scale</Label>
              <select
                value={config.esrganScale}
                onChange={(e) => update("esrganScale", parseInt(e.target.value))}
                className="w-full h-7 rounded border border-rose-500/20 bg-background px-2 text-[10px]"
              >
                <option value={2}>2x (better for noisy source)</option>
                <option value={4}>4x (maximum upscale)</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* ── Pre-Processing (collapsible) ── */}
      <div className="rounded border border-border/50">
        <div className="flex items-center justify-between p-2 hover:bg-muted/30 transition-colors">
          <button
            className="flex-1 flex items-center gap-1.5"
            onClick={() => setPreProcessExpanded(!preProcessExpanded)}
          >
            <span className="text-[10px] font-medium flex items-center gap-1.5">
              <Sun className="w-3 h-3 text-amber-400" /> Pre-Processing (ffmpeg)
            </span>
          </button>
          <div className="flex items-center gap-1">
            {preProcessExpanded && (
              <button
                className="text-[8px] text-muted-foreground hover:text-amber-400 flex items-center gap-0.5 px-1 py-0.5 rounded hover:bg-amber-500/10 transition-colors"
                title="Restore defaults"
                onClick={() => {
                  update("denoiseEnabled", VIDEO_RESTORATION_DEFAULTS.denoiseEnabled);
                  update("denoiseStrength", VIDEO_RESTORATION_DEFAULTS.denoiseStrength);
                  update("brightnessAdjust", VIDEO_RESTORATION_DEFAULTS.brightnessAdjust);
                  update("contrastAdjust", VIDEO_RESTORATION_DEFAULTS.contrastAdjust);
                }}
              >
                <RotateCcw className="w-2.5 h-2.5" /> Defaults
              </button>
            )}
            <button onClick={() => setPreProcessExpanded(!preProcessExpanded)}>
              {preProcessExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
          </div>
        </div>
        {preProcessExpanded && (
          <div className="p-2 pt-0 space-y-2">
            <div className="flex items-center gap-2">
              <Switch
                checked={config.denoiseEnabled}
                onCheckedChange={(v) => update("denoiseEnabled", v)}
                className="scale-75"
              />
              <span className="text-[9px]">Denoise (nlmeans)</span>
              {config.denoiseEnabled && (
                <div className="flex-1 flex items-center gap-2">
                  <Slider
                    value={[config.denoiseStrength]}
                    onValueChange={([v]) => update("denoiseStrength", v)}
                    min={1}
                    max={30}
                    step={1}
                    className="flex-1"
                  />
                  <span className="text-[9px] text-muted-foreground w-6 text-right">{config.denoiseStrength}</span>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[9px]">Brightness</span>
                <span className="text-[9px] text-muted-foreground">{config.brightnessAdjust > 0 ? "+" : ""}{config.brightnessAdjust.toFixed(2)}</span>
              </div>
              <Slider
                value={[config.brightnessAdjust]}
                onValueChange={([v]) => update("brightnessAdjust", v)}
                min={-1}
                max={1}
                step={0.05}
              />
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[9px]">Contrast</span>
                <span className="text-[9px] text-muted-foreground">{config.contrastAdjust.toFixed(2)}x</span>
              </div>
              <Slider
                value={[config.contrastAdjust]}
                onValueChange={([v]) => update("contrastAdjust", v)}
                min={0.5}
                max={2.0}
                step={0.05}
              />
            </div>

            {/* ── Single-Frame Preview ── */}
            {hasInput && (
              <div className="space-y-2 pt-1 border-t border-border/30">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-medium text-amber-400 flex items-center gap-1">
                    <Eye className="w-3 h-3" /> Preview Frame
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-5 text-[9px] px-2 gap-1 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                    onClick={handlePreview}
                    disabled={previewLoading || isRunning}
                  >
                    {previewLoading ? (
                      <><Loader2 className="w-2.5 h-2.5 animate-spin" /> Generating...</>
                    ) : (
                      <><Eye className="w-2.5 h-2.5" /> {previewOriginal ? "Refresh" : "Preview"}</>
                    )}
                  </Button>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[8px] text-muted-foreground">Timestamp</span>
                    <span className="text-[8px] text-muted-foreground font-mono">
                      {previewTimestamp.toFixed(1)}s / {config.inputDuration.toFixed(1)}s
                    </span>
                  </div>
                  <Slider
                    value={[previewTimestamp]}
                    onValueChange={([v]) => setPreviewTimestamp(v)}
                    min={0}
                    max={Math.max(0.1, config.inputDuration - 0.1)}
                    step={0.1}
                  />
                </div>

                {/* Before / After display */}
                {(previewOriginal || previewLoading) && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-center gap-1">
                      {["original", "side", "processed"].map((m) => (
                        <button
                          key={m}
                          onClick={() => setPreviewMode(m as typeof previewMode)}
                          className={`text-[8px] px-2 py-0.5 rounded transition-colors ${
                            previewMode === m
                              ? "bg-amber-500/20 text-amber-400"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {m === "original" ? "Before" : m === "processed" ? "After" : "Side by Side"}
                        </button>
                      ))}
                    </div>

                    {previewLoading ? (
                      <div className="flex items-center justify-center h-32 rounded border border-border/30 bg-black/20">
                        <div className="text-center">
                          <Loader2 className="w-5 h-5 animate-spin text-amber-400 mx-auto" />
                          <p className="text-[9px] text-muted-foreground mt-1">Extracting & processing frame...</p>
                        </div>
                      </div>
                    ) : previewMode === "side" ? (
                      <div className="grid grid-cols-2 gap-1">
                        <div className="space-y-0.5">
                          <span className="text-[8px] text-muted-foreground block text-center">Original</span>
                          {previewOriginal && (
                            <img src={previewOriginal} alt="Original" className="w-full rounded border border-border/30 bg-black" />
                          )}
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[8px] text-amber-400 block text-center">Processed</span>
                          {previewProcessed && (
                            <img src={previewProcessed} alt="Processed" className="w-full rounded border border-amber-500/30 bg-black" />
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-0.5">
                        <span className="text-[8px] text-center block">
                          {previewMode === "original" ? (
                            <span className="text-muted-foreground">Original</span>
                          ) : (
                            <span className="text-amber-400">Processed</span>
                          )}
                        </span>
                        {previewMode === "original" && previewOriginal && (
                          <img src={previewOriginal} alt="Original" className="w-full rounded border border-border/30 bg-black" />
                        )}
                        {previewMode === "processed" && previewProcessed && (
                          <img src={previewProcessed} alt="Processed" className="w-full rounded border border-amber-500/30 bg-black" />
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Output Settings (collapsible) ── */}
      <div className="rounded border border-border/50">
        <button
          className="w-full flex items-center justify-between p-2 hover:bg-muted/30 transition-colors"
          onClick={() => setOutputExpanded(!outputExpanded)}
        >
          <span className="text-[10px] font-medium flex items-center gap-1.5">
            <Settings2 className="w-3 h-3 text-sky-400" /> Output Settings
          </span>
          {outputExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {outputExpanded && (
          <div className="p-2 pt-0 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[9px] text-muted-foreground">Codec</Label>
                <select
                  value={config.outputCodec}
                  onChange={(e) => update("outputCodec", e.target.value as VideoRestorationConfig["outputCodec"])}
                  className="w-full h-7 rounded border border-sky-500/20 bg-background px-2 text-[10px]"
                >
                  {RESTORE_OUTPUT_CODECS.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-[9px] text-muted-foreground">Format</Label>
                <select
                  value={config.outputFormat}
                  onChange={(e) => update("outputFormat", e.target.value as "mp4" | "mkv")}
                  className="w-full h-7 rounded border border-sky-500/20 bg-background px-2 text-[10px]"
                >
                  <option value="mp4">MP4 (universal)</option>
                  <option value="mkv">MKV (lossless container)</option>
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">Target Frame Rate</Label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={240}
                  step="any"
                  value={config.targetFps || ""}
                  placeholder={config.inputFps > 0 ? `Match input (${config.inputFps})` : "Match input"}
                  onChange={(e) => update("targetFps", e.target.value === "" ? 0 : parseFloat(e.target.value))}
                  className="flex-1 h-7 rounded border border-sky-500/20 bg-background px-2 text-[10px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-[9px] text-muted-foreground shrink-0">fps</span>
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {[
                  { value: 0, label: "Match Input" },
                  { value: 23.976, label: "23.976" },
                  { value: 24, label: "24" },
                  { value: 29.97, label: "29.97" },
                  { value: 30, label: "30" },
                  { value: 59.94, label: "59.94" },
                  { value: 60, label: "60" },
                ].map((p) => (
                  <button
                    key={p.value}
                    onClick={() => update("targetFps", p.value)}
                    className={`text-[8px] px-1.5 py-0.5 rounded border transition-colors ${
                      config.targetFps === p.value
                        ? "border-sky-500 bg-sky-500/20 text-sky-300"
                        : "border-border/50 text-muted-foreground hover:bg-muted/30"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {config.targetFps > 0 && config.inputFps > 0 && config.inputDuration > 0 && (
                <p className="text-[9px] text-muted-foreground">
                  {Math.ceil(config.inputDuration * config.targetFps)} frames
                  {config.inputFps > config.targetFps && (
                    <span className="text-emerald-400 ml-1">
                      ({Math.round((1 - config.targetFps / config.inputFps) * 100)}% fewer frames to process)
                    </span>
                  )}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[9px]">Quality (CRF, lower = better)</span>
                <span className="text-[9px] text-muted-foreground">{config.outputCrf}</span>
              </div>
              <Slider
                value={[config.outputCrf]}
                onValueChange={([v]) => update("outputCrf", v)}
                min={10}
                max={30}
                step={1}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={config.preserveAudio}
                onCheckedChange={(v) => update("preserveAudio", v)}
                className="scale-75"
              />
              <span className="text-[9px]">Preserve original audio</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Progress ── */}
      {isRunning && (
        <div className="space-y-1.5 rounded border border-rose-500/20 bg-rose-500/5 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-rose-400 font-medium flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> {progressLabel || "Processing..."}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {eta && <span className="text-rose-400/70 mr-2">{eta}</span>}
              {Math.round(progress)}%
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-rose-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-2">
          <p className="text-[10px] text-red-400 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> {error}
          </p>
        </div>
      )}

      {/* ── Output ── */}
      {status === "complete" && outputPath && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/10 p-2 space-y-1">
          <p className="text-[10px] text-emerald-400 font-medium">Restoration Complete!</p>
          <p className="text-[9px] text-emerald-400/70 font-mono break-all">{outputPath}</p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[9px] gap-1 border-emerald-500/30 text-emerald-400"
            onClick={() => {
              // Open containing folder
              fetch("/api/restore/open-output", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: outputPath }),
              }).catch(() => {});
            }}
          >
            <FolderOpen className="w-3 h-3" /> Open Folder
          </Button>
        </div>
      )}

      {/* ── Action Buttons ── */}
      <div className="flex gap-2">
        {isRunning ? (
          <Button
            variant="destructive"
            size="sm"
            className="flex-1 h-9 gap-2"
            onClick={handleStop}
          >
            <Square className="w-4 h-4" /> Stop
          </Button>
        ) : (
          <Button
            size="sm"
            className="flex-1 h-9 gap-2 bg-rose-600 hover:bg-rose-500 text-white"
            onClick={handleRestore}
            disabled={!hasInput || setupStatus === "missing"}
          >
            <Play className="w-4 h-4" />
            {status === "complete" ? "Restore Again" : "Start Restoration"}
          </Button>
        )}
      </div>

      {/* ── Info box ── */}
      <div className="rounded border border-muted/50 bg-muted/10 p-2 space-y-1">
        <p className="text-[9px] text-muted-foreground flex items-center gap-1">
          <Info className="w-3 h-3 flex-shrink-0" />
          <strong>Pipeline:</strong> ffmpeg pre-process → {config.engine === "seedvr2" && config.zimageRepairEnabled ? `Z-Image ${config.zimageRepairMode} repair → ` : ""}{config.engine === "seedvr2" ? "SeedVR2 (ComfyUI)" : "Real-ESRGAN (ncnn)"} → ffmpeg encode
        </p>
        <p className="text-[8px] text-muted-foreground/60">
          {config.engine === "seedvr2"
            ? "SeedVR2 uses diffusion to recover detail that doesn't exist in the source. Best for heavily degraded footage. Requires ~12-14 GB VRAM."
            : "Real-ESRGAN is a traditional upscaler. Fast but won't hallucinate new detail. Works on any GPU with Vulkan support."
          }
        </p>
      </div>
    </div>
  );
}
