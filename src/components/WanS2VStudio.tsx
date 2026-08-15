"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAutoplay } from "@/lib/use-autoplay";
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
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Loader2,
  AlertTriangle,
  Music,
  Image as ImageIcon,
  Lock,
  Unlock,
  Download,
} from "lucide-react";
import { VideoSlot } from "@/components/media/MediaPlayer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import AudioTrimmer from "@/components/AudioTrimmer";
import LoRATriggerGuide from "@/components/LoRATriggerGuide";
import LoraSelect from "@/components/LoraSelect";
import {
  WanS2VConfig,
  WAN_S2V_DEFAULTS,
  WAN_S2V_RESOLUTION_PRESETS,
  WAN_S2V_FRAME_PRESETS,
  WAN_S2V_STEP_PRESETS,
  WAN_S2V_MODELS,
  ComfyUIProgress,
  LoraEntry,
  WanPairedLoraEntry,
} from "@/lib/types";
import { buildWanS2VWorkflow } from "@/lib/workflow-builder";
import { useRegisterComfyWorkflow } from "@/components/ComfyOpenProvider";
import SendToQueueButton from "@/components/SendToQueueButton";
import {
  queuePrompt,
  getHistory,
  getImageUrl,
  interruptGeneration,
  connectComfyStream,
  uploadImage,
  uploadAudio,
  checkConnection,
} from "@/lib/comfyui-api";

interface WanS2VStudioProps {
  config: WanS2VConfig;
  onConfigChange: (config: WanS2VConfig) => void;
}

export default function WanS2VStudio({ config, onConfigChange }: WanS2VStudioProps) {
  const configRef = useRef(config);
  configRef.current = config;

  // Register this page's workflow with the global "Open in ComfyUI" button.
  useRegisterComfyWorkflow(() => ({
    workflow: buildWanS2VWorkflow(config) as Record<string, unknown>,
    name: "WAN 2.2 S2V",
  }));

  const setConfig = useCallback(
    (updater: WanS2VConfig | ((prev: WanS2VConfig) => WanS2VConfig)) => {
      const newConfig =
        typeof updater === "function" ? updater(configRef.current) : updater;
      configRef.current = newConfig;
      onConfigChange(newConfig);
    },
    [onConfigChange]
  );

  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [stage, setStage] = useState("");
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [autoplay] = useAutoplay();
  const [comfyConnected, setComfyConnected] = useState<boolean | null>(null);
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [lorasExpanded, setLorasExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [refImagePreview, setRefImagePreview] = useState<string | null>(null);
  const [audioObjectUrl, setAudioObjectUrl] = useState<string | null>(null);
  const [audioFileName, setAudioFileName] = useState<string>("");
  const [lockWarning, setLockWarning] = useState<string | null>(null);
  const [outputFileInfo, setOutputFileInfo] = useState<{ filename: string; subfolder: string } | null>(null);
  const [merging, setMerging] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const promptIdRef = useRef<string | null>(null);
  const clientIdRef = useRef<string>(
    `s2v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );

  const update = useCallback(
    <K extends keyof WanS2VConfig>(key: K, value: WanS2VConfig[K]) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    [setConfig]
  );

  // Check ComfyUI + fetch LoRAs on mount
  useEffect(() => {
    checkConnection().then(setComfyConnected);
    fetch(`/api/lora-files?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: string[]) => setAvailableLoras(list))
      .catch(() => {});
  }, []);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  // Reconstruct reference previews from the persisted ComfyUI input/ paths after a tab
  // switch unmounted/remounted this studio (or after a settings load). Path-based only,
  // no base64 is retained; the bytes live in ComfyUI's input/ folder (the "cached temp file").
  useEffect(() => {
    if (config.refImage && !refImagePreview) {
      setRefImagePreview(getImageUrl(config.refImage, "", "input"));
    }
    if (config.audioFile && !audioObjectUrl) {
      setAudioObjectUrl(getImageUrl(config.audioFile, "", "input"));
      if (!audioFileName) setAudioFileName(config.audioFile);
    }
  }, [config.refImage, config.audioFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Calculate video duration from current params
  const videoDuration = config.frames / config.fps;

  // ── Lock guard: prevent changing video-length params when audio is locked ──
  const guardLockedParam = useCallback(
    (paramName: string): boolean => {
      if (!config.audioLocked) return false; // not locked, allow change
      setLockWarning(
        `Cannot change ${paramName} while audio is trimmed. Remove audio first?`
      );
      return true; // blocked
    },
    [config.audioLocked]
  );

  const handleRemoveAudioAndUnlock = useCallback(() => {
    setConfig((prev) => ({
      ...prev,
      audioFile: "",
      audioTrimStart: 0,
      audioTrimEnd: 0,
      audioLocked: false,
    }));
    setAudioObjectUrl(null);
    setAudioFileName("");
    setLockWarning(null);
  }, [setConfig]);

  // ── Reference image upload ──
  const handleRefImage = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        setRefImagePreview(reader.result as string);
        // Upload to ComfyUI immediately
        uploadImage(file)
          .then((name) => update("refImage", name))
          .catch((err) => setError(`Image upload failed: ${err.message}`));
      };
      reader.readAsDataURL(file);
    },
    [update]
  );

  // ── Audio upload ──
  const handleAudioUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setError(null);
      try {
        const name = await uploadAudio(file);
        update("audioFile", name);
        setAudioFileName(file.name);
        // Create object URL for the trimmer's waveform display
        const url = URL.createObjectURL(file);
        setAudioObjectUrl(url);
        // Reset trim state
        setConfig((prev) => ({
          ...prev,
          audioFile: name,
          audioTrimStart: 0,
          audioTrimEnd: 0,
          audioLocked: false,
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Audio upload failed");
      }
    },
    [update, setConfig]
  );

  const handleTrimConfirm = useCallback(() => {
    setConfig((prev) => ({ ...prev, audioLocked: true }));
  }, [setConfig]);

  // ── LoRA management ──
  const addLora = () => {
    const usedNames = new Set(config.loras.map((l) => l.name));
    const firstUnused = availableLoras.find((n) => !usedNames.has(n));
    const entry: LoraEntry = { enabled: true, name: firstUnused || "", strengthModel: 1.0, strengthClip: 1.0 };
    setConfig((prev) => ({ ...prev, loras: [...prev.loras, entry] }));
  };

  const removeLora = (index: number) => {
    setConfig((prev) => ({ ...prev, loras: prev.loras.filter((_, i) => i !== index) }));
  };

  const updateLora = (index: number, patch: Partial<LoraEntry>) => {
    setConfig((prev) => ({
      ...prev,
      loras: prev.loras.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  };

  // ── Paired LoRA management ──
  const addPairedLora = () => {
    const entry: WanPairedLoraEntry = { enabled: true, highName: "", lowName: "", strength: 1.0 };
    setConfig((prev) => ({ ...prev, pairedLoras: [...prev.pairedLoras, entry] }));
  };

  const removePairedLora = (index: number) => {
    setConfig((prev) => ({ ...prev, pairedLoras: prev.pairedLoras.filter((_, i) => i !== index) }));
  };

  const updatePairedLora = (index: number, patch: Partial<WanPairedLoraEntry>) => {
    setConfig((prev) => ({
      ...prev,
      pairedLoras: prev.pairedLoras.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));
  };

  // ── Generation ──
  const handleGenerate = useCallback(async () => {
    if (!config.refImage) {
      setError("Please upload a reference image");
      return;
    }
    if (!config.audioFile) {
      setError("Please upload an audio file");
      return;
    }

    setIsRunning(true);
    setError(null);
    setOutputUrl(null);
    setOutputFileInfo(null);
    setProgress(0);
    setProgressMax(0);
    setStage("Building workflow...");

    try {
      const workflow = buildWanS2VWorkflow(config);
      setStage("Queuing to ComfyUI...");

      const clientId = clientIdRef.current;
      esRef.current?.close();
      esRef.current = connectComfyStream(
        clientId,
        (msg: ComfyUIProgress) => {
          if (msg.type === "progress" && msg.data) {
            setProgress(msg.data.value ?? 0);
            setProgressMax(msg.data.max ?? 0);
            setStage(`Sampling step ${msg.data.value}/${msg.data.max}`);
          } else if (msg.type === "executing" && msg.data) {
            if (msg.data.node === null) {
              fetchResult();
            } else {
              const nodeNames: Record<string, string> = {
                "2": "Loading text encoder...",
                "3": "Loading VAE...",
                "20": "Loading S2V UNET...",
                "21": "Loading low-Q UNET (pass 2)...",
                "60": "Loading audio encoder...",
                "63": "Encoding audio...",
                "6": "Building S2V conditioning...",
                "30": "Sampling...",
                "31": "Pass 2 sampling...",
                "8": "Decoding video...",
              };
              const nodeName = nodeNames[msg.data.node as string];
              if (nodeName) setStage(nodeName);
            }
          } else if (msg.type === "execution_error" && msg.data) {
            setError(
              (msg.data as Record<string, unknown>).exception_message as string ||
              "ComfyUI execution error"
            );
            setIsRunning(false);
          }
        },
        () => { /* closed */ },
        () => { /* error */ }
      );

      const result = await queuePrompt(workflow, clientId);
      promptIdRef.current = result.prompt_id;
      setStage("Waiting for ComfyUI...");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsRunning(false);
    }

    async function fetchResult() {
      const pid = promptIdRef.current;
      if (!pid) return;

      for (let i = 0; i < 60; i++) {
        try {
          const history = await getHistory(pid);
          if (history?.outputs) {
            // Check for video output (SaveVideo node 41) or image output (node 9)
            const videoOut = history.outputs["41"];
            const videoFile = videoOut?.images?.[0] || videoOut?.gifs?.[0];
            if (videoFile) {
              setOutputUrl(getImageUrl(videoFile.filename, videoFile.subfolder || "", videoFile.type || "output"));
              setOutputFileInfo({ filename: videoFile.filename, subfolder: videoFile.subfolder || "" });
              setStage("Complete!");
              setIsRunning(false);
              esRef.current?.close();
              return;
            }
            const imgOut = history.outputs["9"];
            if (imgOut?.images?.[0]) {
              const img = imgOut.images[0];
              setOutputUrl(getImageUrl(img.filename, img.subfolder || "", img.type || "output"));
              setOutputFileInfo({ filename: img.filename, subfolder: img.subfolder || "" });
              setStage("Complete!");
              setIsRunning(false);
              esRef.current?.close();
              return;
            }
          }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 1500));
      }
      setStage("Complete (output may be in ComfyUI)");
      setIsRunning(false);
      esRef.current?.close();
    }
  }, [config]);

  const handleCancel = useCallback(async () => {
    esRef.current?.close();
    try { await interruptGeneration(); } catch { /* ignore */ }
    setIsRunning(false);
    setStage("");
    setProgress(0);
    setProgressMax(0);
  }, []);

  const progressPct = progressMax > 0 ? Math.round((progress / progressMax) * 100) : 0;

  const activeRes = WAN_S2V_RESOLUTION_PRESETS.find(
    (p) => p.width === config.width && p.height === config.height
  );

  const activeSteps = WAN_S2V_STEP_PRESETS.find(
    (p) => p.pass1 === config.pass1Steps && p.total === config.totalSteps
  );

  const wanLoras = availableLoras.filter(
    (n) => n.toLowerCase().includes("wan")
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-violet-500/30 bg-violet-500/5">
        <div className="flex items-center gap-2">
          <Volume2 className="w-5 h-5 text-violet-400" />
          <h2 className="text-sm font-semibold text-violet-400">WAN 2.2 S2V Studio</h2>
          <span className="text-[9px] text-violet-400/60 bg-violet-500/10 px-1.5 py-0.5 rounded">
            Sound-to-Video + Lipsync
          </span>
        </div>
        <div className="flex items-center gap-2">
          {comfyConnected === true && (
            <span className="text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> ComfyUI
            </span>
          )}
          {comfyConnected === false && (
            <span className="text-[9px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Offline
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ═══ Left Panel: Controls ═══ */}
        <div className="w-[420px] flex-shrink-0 overflow-y-auto border-r border-violet-500/20 p-4 space-y-4">

          {/* ═══ Lock Warning Banner ═══ */}
          {lockWarning && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1 space-y-1.5">
                <p className="text-[11px] text-amber-300">{lockWarning}</p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] px-2 border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                    onClick={handleRemoveAudioAndUnlock}
                  >
                    Yes, remove audio
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[10px] px-2 text-muted-foreground"
                    onClick={() => setLockWarning(null)}
                  >
                    No, keep locked
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ═══ Prompt ═══ */}
          <div className="space-y-1.5">
            <Label className="text-[11px] text-violet-400 font-medium">Prompt</Label>
            <textarea
              className="w-full min-h-[70px] rounded-md border border-violet-500/30 bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/50 resize-y"
              placeholder="Character talking and singing, natural facial movements, expressive emotions..."
              value={config.prompt}
              onChange={(e) => update("prompt", e.target.value)}
              disabled={isRunning}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] text-muted-foreground font-medium">Negative Prompt</Label>
            <textarea
              className="w-full min-h-[36px] rounded-md border border-border/50 bg-background px-3 py-1.5 text-xs ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/30 resize-y"
              value={config.negativePrompt}
              onChange={(e) => update("negativePrompt", e.target.value)}
              disabled={isRunning}
            />
          </div>

          {/* ═══ Reference Image + Audio (side by side) ═══ */}
          <div className="grid grid-cols-2 gap-3">
            {/* Ref Image */}
            <div className="space-y-1.5">
              <Label className="text-[11px] text-violet-400 font-medium flex items-center gap-1">
                <ImageIcon className="w-3 h-3" /> Reference Image
              </Label>
              <div className="rounded border border-violet-500/20 bg-background/50 p-2 min-h-[120px] flex flex-col items-center justify-center gap-2">
                {refImagePreview ? (
                  <div className="relative w-full">
                    <img
                      src={refImagePreview}
                      alt="Reference"
                      className="w-full object-contain max-h-40 rounded"
                    />
                    <button
                      className="absolute top-1 right-1 bg-background/80 rounded p-0.5 hover:bg-destructive/20"
                      onClick={() => {
                        setRefImagePreview(null);
                        update("refImage", "");
                      }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <label
                    className="flex flex-col items-center gap-1 cursor-pointer text-muted-foreground hover:text-violet-400 transition-colors"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const f = e.dataTransfer.files?.[0];
                      if (f && f.type.startsWith("image/")) {
                        const reader = new FileReader();
                        reader.onload = () => setRefImagePreview(reader.result as string);
                        reader.readAsDataURL(f);
                        uploadImage(f)
                          .then((name) => update("refImage", name))
                          .catch(() => {});
                      }
                    }}
                  >
                    <Upload className="w-5 h-5" />
                    <span className="text-[9px]">Upload a created character image</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleRefImage}
                      disabled={isRunning}
                    />
                  </label>
                )}
              </div>
            </div>

            {/* Audio Upload */}
            <div className="space-y-1.5">
              <Label className="text-[11px] text-violet-400 font-medium flex items-center gap-1">
                <Music className="w-3 h-3" /> Audio File
                {config.audioLocked && <Lock className="w-3 h-3 text-amber-400 ml-1" />}
              </Label>
              <div className="rounded border border-violet-500/20 bg-background/50 p-2 min-h-[120px] flex flex-col items-center justify-center gap-2">
                {config.audioFile ? (
                  <div className="w-full space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-muted-foreground truncate max-w-[200px]">
                        {audioFileName || config.audioFile}
                      </span>
                      <button
                        className="bg-background/80 rounded p-0.5 hover:bg-destructive/20"
                        onClick={handleRemoveAudioAndUnlock}
                        disabled={isRunning}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                    {audioObjectUrl && (
                      <AudioTrimmer
                        audioUrl={audioObjectUrl}
                        maxDuration={videoDuration}
                        trimStart={config.audioTrimStart}
                        trimEnd={config.audioTrimEnd}
                        onTrimChange={(start, end) => {
                          setConfig((prev) => ({
                            ...prev,
                            audioTrimStart: start,
                            audioTrimEnd: end,
                          }));
                        }}
                        onTrimConfirm={handleTrimConfirm}
                        locked={config.audioLocked}
                        disabled={isRunning}
                      />
                    )}
                  </div>
                ) : (
                  <label
                    className="flex flex-col items-center gap-1 cursor-pointer text-muted-foreground hover:text-violet-400 transition-colors"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const f = e.dataTransfer.files?.[0];
                      if (f && f.type.startsWith("audio/")) {
                        uploadAudio(f)
                          .then((name) => {
                            update("audioFile", name);
                            setAudioFileName(f.name);
                            setAudioObjectUrl(URL.createObjectURL(f));
                            setConfig((prev) => ({ ...prev, audioFile: name, audioTrimStart: 0, audioTrimEnd: 0, audioLocked: false }));
                          })
                          .catch(() => {});
                      }
                    }}
                  >
                    <Music className="w-5 h-5" />
                    <span className="text-[9px]">Upload audio (mp3, wav, ogg)</span>
                    <input
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={handleAudioUpload}
                      disabled={isRunning}
                    />
                  </label>
                )}
              </div>
            </div>
          </div>

          {/* ═══ Video Parameters (lockable) ═══ */}
          <div className="space-y-2 rounded border border-violet-500/20 bg-violet-500/5 p-3">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] text-violet-400 font-medium flex items-center gap-1">
                <Film className="w-3 h-3" /> Video Parameters
                {config.audioLocked && (
                  <span className="text-[8px] text-amber-400 bg-amber-500/10 px-1 py-0.5 rounded ml-1 flex items-center gap-0.5">
                    <Lock className="w-2.5 h-2.5" /> Locked (audio trimmed)
                  </span>
                )}
              </Label>
              <span className="text-[9px] text-muted-foreground font-mono">
                {videoDuration.toFixed(1)}s @ {config.fps}fps
              </span>
            </div>

            {/* Resolution */}
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">Resolution</Label>
              <select
                className="w-full rounded-md border border-border/50 bg-background px-2 py-1 text-xs"
                value={activeRes ? `${activeRes.width}x${activeRes.height}` : "custom"}
                onChange={(e) => {
                  if (guardLockedParam("resolution")) return;
                  if (e.target.value === "custom") return;
                  const preset = WAN_S2V_RESOLUTION_PRESETS.find(
                    (p) => `${p.width}x${p.height}` === e.target.value
                  );
                  if (preset) {
                    setConfig((prev) => ({ ...prev, width: preset.width, height: preset.height }));
                  }
                }}
                disabled={isRunning}
              >
                {WAN_S2V_RESOLUTION_PRESETS.map((p) => (
                  <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom...</option>
              </select>
              {!activeRes && (
                <div className="flex items-center gap-1.5 mt-1">
                  <input
                    type="number"
                    className="w-20 rounded-md border border-border/50 bg-background px-2 py-1 text-xs text-center"
                    value={config.width}
                    min={128}
                    max={2048}
                    step={16}
                    onChange={(e) => {
                      if (guardLockedParam("resolution")) return;
                      const v = Math.round(parseInt(e.target.value) / 16) * 16;
                      if (v >= 128 && v <= 2048) update("width", v);
                    }}
                    disabled={isRunning}
                    placeholder="Width"
                  />
                  <span className="text-[9px] text-muted-foreground">×</span>
                  <input
                    type="number"
                    className="w-20 rounded-md border border-border/50 bg-background px-2 py-1 text-xs text-center"
                    value={config.height}
                    min={128}
                    max={2048}
                    step={16}
                    onChange={(e) => {
                      if (guardLockedParam("resolution")) return;
                      const v = Math.round(parseInt(e.target.value) / 16) * 16;
                      if (v >= 128 && v <= 2048) update("height", v);
                    }}
                    disabled={isRunning}
                    placeholder="Height"
                  />
                  <span className="text-[8px] text-muted-foreground/60">must be ×16</span>
                </div>
              )}
            </div>

            {/* Frames + FPS */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[9px] text-muted-foreground">Frames</Label>
                <select
                  className="w-full rounded-md border border-border/50 bg-background px-2 py-1 text-xs"
                  value={config.frames}
                  onChange={(e) => {
                    if (guardLockedParam("frames")) return;
                    update("frames", parseInt(e.target.value));
                  }}
                  disabled={isRunning}
                >
                  {WAN_S2V_FRAME_PRESETS.map((f) => (
                    <option key={f} value={f}>
                      {f} frames ({(f / config.fps).toFixed(1)}s)
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-[9px] text-muted-foreground">FPS</Label>
                <select
                  className="w-full rounded-md border border-border/50 bg-background px-2 py-1 text-xs"
                  value={config.fps}
                  onChange={(e) => {
                    if (guardLockedParam("FPS")) return;
                    update("fps", parseInt(e.target.value));
                  }}
                  disabled={isRunning}
                >
                  {[8, 12, 16, 24, 30].map((f) => (
                    <option key={f} value={f}>{f} fps</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Quality Preset */}
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">Quality Preset (Steps)</Label>
              <select
                className="w-full rounded-md border border-border/50 bg-background px-2 py-1 text-xs"
                value={activeSteps ? `${activeSteps.pass1}/${activeSteps.total}` : "custom"}
                onChange={(e) => {
                  const preset = WAN_S2V_STEP_PRESETS.find(
                    (p) => `${p.pass1}/${p.total}` === e.target.value
                  );
                  if (preset) {
                    setConfig((prev) => ({
                      ...prev,
                      pass1Steps: preset.pass1,
                      totalSteps: preset.total,
                    }));
                  }
                }}
                disabled={isRunning}
              >
                {WAN_S2V_STEP_PRESETS.map((p) => (
                  <option key={`${p.pass1}/${p.total}`} value={`${p.pass1}/${p.total}`}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* ═══ Models ═══ */}
          <div className="space-y-2 rounded border border-violet-500/20 bg-background/50 p-3">
            <Label className="text-[11px] text-violet-400 font-medium flex items-center gap-1">
              <Settings2 className="w-3 h-3" /> S2V Model
            </Label>
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">GGUF Model (from QuantStack/Wan2.2-S2V-14B-GGUF)</Label>
              <input
                className="w-full rounded-md border border-border/50 bg-background px-2 py-1 text-[10px] font-mono"
                value={config.highModel}
                onChange={(e) => {
                  update("highModel", e.target.value);
                  update("lowModel", e.target.value);
                }}
                disabled={isRunning}
              />
            </div>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {([
                { label: "Q3_K_M (11.4GB)", model: WAN_S2V_MODELS.S2V_Q3_K_M },
                { label: "Q4_0 (12.8GB)", model: WAN_S2V_MODELS.S2V_Q4_0 },
                { label: "Q4_K_S (13GB)", model: WAN_S2V_MODELS.S2V_Q4_K_S },
                { label: "Q4_K_M (13.9GB)", model: WAN_S2V_MODELS.S2V_Q4_K_M },
                { label: "Q5_0 (14.5GB)", model: WAN_S2V_MODELS.S2V_Q5_0 },
              ] as const).map((opt) => (
                <Button
                  key={opt.model}
                  size="sm"
                  variant="ghost"
                  className={`h-5 text-[8px] px-1.5 ${config.highModel === opt.model ? "text-violet-400 bg-violet-500/20" : "text-muted-foreground"}`}
                  onClick={() => {
                    update("highModel", opt.model);
                    update("lowModel", opt.model);
                  }}
                  disabled={isRunning}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>

          {/* ═══ LoRAs (collapsible) ═══ */}
          <div className="rounded border border-violet-500/20 bg-background/50">
            <button
              className="w-full flex items-center justify-between px-3 py-2 hover:bg-violet-500/5 transition-colors"
              onClick={() => setLorasExpanded(!lorasExpanded)}
            >
              <span className="text-[11px] text-violet-400 font-medium flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> LoRAs
                {(config.loras.length > 0 || config.pairedLoras.length > 0) && (
                  <span className="text-[8px] bg-violet-500/20 px-1 rounded">
                    {config.loras.length + config.pairedLoras.length}
                  </span>
                )}
              </span>
              {lorasExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>

            {lorasExpanded && (
              <div className="px-3 pb-3 space-y-3 border-t border-violet-500/10">
                {/* Standard LoRAs */}
                <div className="space-y-1.5 mt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">Standard LoRAs</span>
                    <Button size="sm" variant="ghost" className="h-5 text-[9px] px-1.5" onClick={addLora}>
                      <Plus className="w-3 h-3 mr-0.5" /> Add
                    </Button>
                  </div>
                  {config.loras.map((lora, i) => (
                    <div key={i} className="flex items-center gap-1.5 bg-background/50 rounded px-2 py-1">
                      <LoraSelect
                        value={lora.name}
                        options={availableLoras}
                        onChange={(name) => updateLora(i, { name })}
                        compatMode="wan_s2v"
                        placeholder="-- Select --"
                      />
                      <div className="flex items-center gap-1 w-28">
                        <span className="text-[8px] text-muted-foreground w-4">M</span>
                        <Slider
                          min={0} max={2} step={0.05}
                          value={[lora.strengthModel]}
                          onValueChange={([v]) => updateLora(i, { strengthModel: v })}
                          className="flex-1"
                        />
                        <span className="text-[8px] text-muted-foreground w-6">{lora.strengthModel.toFixed(2)}</span>
                      </div>
                      <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={() => removeLora(i)}>
                        <Trash2 className="w-3 h-3 text-destructive/60" />
                      </Button>
                    </div>
                  ))}
                </div>

                {/* Paired LoRAs */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-muted-foreground">Paired LoRAs (High→Pass1, Low→Pass2)</span>
                    <Button size="sm" variant="ghost" className="h-5 text-[9px] px-1.5" onClick={addPairedLora}>
                      <Plus className="w-3 h-3 mr-0.5" /> Add Pair
                    </Button>
                  </div>
                  {config.pairedLoras.map((pair, i) => (
                    <div key={i} className="bg-background/50 rounded px-2 py-1.5 space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[8px] text-emerald-400 w-3">H</span>
                        <LoraSelect
                          value={pair.highName}
                          options={wanLoras}
                          onChange={(name) => updatePairedLora(i, { highName: name })}
                          compatMode="wan_s2v"
                          placeholder="-- High --"
                        />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[8px] text-blue-400 w-3">L</span>
                        <LoraSelect
                          value={pair.lowName}
                          options={wanLoras}
                          onChange={(name) => updatePairedLora(i, { lowName: name })}
                          compatMode="wan_s2v"
                          placeholder="-- Low --"
                        />
                        <div className="flex items-center gap-1 w-24">
                          <Slider
                            min={0} max={2} step={0.05}
                            value={[pair.strength]}
                            onValueChange={([v]) => updatePairedLora(i, { strength: v })}
                            className="flex-1"
                          />
                          <span className="text-[8px] w-6">{pair.strength.toFixed(2)}</span>
                        </div>
                        <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={() => removePairedLora(i)}>
                          <Trash2 className="w-3 h-3 text-destructive/60" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Trigger word guidance for all selected LoRAs */}
                <LoRATriggerGuide
                  selectedLoras={[
                    ...config.loras.filter(l => l.enabled).map(l => l.name),
                    ...config.pairedLoras.filter(p => p.enabled).flatMap(p => [p.highName, p.lowName]),
                  ]}
                  onInsertToPrompt={(text) => {
                    const current = config.prompt.trim();
                    const sep = current ? ", " : "";
                    update("prompt", current + sep + text);
                  }}
                />
              </div>
            )}
          </div>

          {/* ═══ Advanced (collapsible) ═══ */}
          <div className="rounded border border-violet-500/20 bg-background/50">
            <button
              className="w-full flex items-center justify-between px-3 py-2 hover:bg-violet-500/5 transition-colors"
              onClick={() => setAdvancedExpanded(!advancedExpanded)}
            >
              <span className="text-[11px] text-muted-foreground font-medium flex items-center gap-1">
                <Settings2 className="w-3 h-3" /> Advanced
              </span>
              {advancedExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>

            {advancedExpanded && (
              <div className="px-3 pb-3 space-y-2 border-t border-violet-500/10 mt-0 pt-2">
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[9px] text-muted-foreground">CFG</Label>
                    <input
                      type="number"
                      step="0.5"
                      min="1"
                      max="20"
                      className="w-full rounded-md border border-border/50 bg-background px-2 py-1 text-xs"
                      value={config.cfg}
                      onChange={(e) => update("cfg", parseFloat(e.target.value) || 1)}
                      disabled={isRunning}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[9px] text-muted-foreground">Sampler</Label>
                    <select
                      className="w-full rounded-md border border-border/50 bg-background px-2 py-1 text-xs"
                      value={config.sampler}
                      onChange={(e) => update("sampler", e.target.value)}
                      disabled={isRunning}
                    >
                      {["uni_pc_bh2", "euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde"].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[9px] text-muted-foreground">Scheduler</Label>
                    <select
                      className="w-full rounded-md border border-border/50 bg-background px-2 py-1 text-xs"
                      value={config.scheduler}
                      onChange={(e) => update("scheduler", e.target.value)}
                      disabled={isRunning}
                    >
                      {["normal", "simple", "karras", "sgm_uniform", "beta"].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[9px] text-muted-foreground">Shift</Label>
                    <div className="flex items-center gap-2">
                      <Slider
                        min={1} max={20} step={0.5}
                        value={[config.shift]}
                        onValueChange={([v]) => update("shift", v)}
                        className="flex-1"
                        disabled={isRunning}
                      />
                      <span className="text-[9px] text-muted-foreground w-6 text-right">{config.shift}</span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[9px] text-muted-foreground">Seed</Label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        className="flex-1 rounded-md border border-border/50 bg-background px-2 py-1 text-xs"
                        value={config.seed}
                        onChange={(e) => update("seed", parseInt(e.target.value) || -1)}
                        disabled={isRunning || config.randomSeed}
                      />
                      <Button
                        size="sm"
                        variant={config.randomSeed ? "default" : "ghost"}
                        className="h-6 text-[9px] px-1.5"
                        onClick={() => update("randomSeed", !config.randomSeed)}
                      >
                        🎲
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ═══ Generate / Cancel ═══ */}
          <div className="flex items-center gap-2">
            {!isRunning ? (
              <Button
                className="flex-1 gap-1.5 bg-violet-600 hover:bg-violet-700 text-white"
                onClick={handleGenerate}
                disabled={!config.refImage || !config.audioFile}
              >
                <Play className="w-4 h-4" /> Generate S2V Video
              </Button>
            ) : (
              <Button
                className="flex-1 gap-1.5"
                variant="destructive"
                onClick={handleCancel}
              >
                <Square className="w-4 h-4" /> Cancel
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-9 px-2"
              title="Reset to defaults"
              onClick={() => {
                setConfig({ ...WAN_S2V_DEFAULTS });
                setRefImagePreview(null);
                setAudioObjectUrl(null);
                setAudioFileName("");
                setLockWarning(null);
              }}
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
          </div>
          {!isRunning && (
            <SendToQueueButton className="w-full mt-2" disabled={!config.refImage || !config.audioFile} getJob={() => ({ workflow: buildWanS2VWorkflow(config) as Record<string, unknown>, name: "WAN 2.2 S2V", outputKind: "video" })} />
          )}

        </div>

        {/* ═══ Right Panel: Preview / Output ═══ */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {/* Error banner */}
          {error && (
            <div className="mx-4 mt-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[10px] text-destructive flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex-1 flex flex-col items-center justify-center p-4">
            {outputUrl ? (
              <div className="w-full max-w-2xl space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[12px] font-medium text-violet-400">Generated S2V Video</p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">
                      {config.width}×{config.height} · {config.frames} frames · {videoDuration.toFixed(1)}s @{config.fps}fps
                    </p>
                  </div>
                  {outputFileInfo && config.audioFile && (
                    <Button
                      size="sm"
                      className="gap-1.5 bg-violet-600 hover:bg-violet-700 text-white text-[10px] h-8"
                      disabled={merging}
                      onClick={async () => {
                        setMerging(true);
                        try {
                          const res = await fetch("/api/s2v-merge", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              videoFilename: outputFileInfo.filename,
                              videoSubfolder: outputFileInfo.subfolder,
                              audioFilename: config.audioFile,
                            }),
                          });
                          if (!res.ok) {
                            const err = await res.json().catch(() => ({ error: "Merge failed" }));
                            throw new Error(err.error || "Merge failed");
                          }
                          const blob = await res.blob();
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `VekSnap_S2V_${Date.now()}.mp4`;
                          a.click();
                          URL.revokeObjectURL(url);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Download failed");
                        } finally {
                          setMerging(false);
                        }
                      }}
                    >
                      {merging
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Download className="w-3.5 h-3.5" />}
                      {merging ? "Merging..." : "Download with Audio"}
                    </Button>
                  )}
                </div>
                <VideoSlot
                  id="wans2v-output"
                  src={outputUrl}
                  className="w-full rounded-lg border border-violet-500/30"
                  style={{ width: "100%", maxHeight: "70vh" }}
                  autoOpen={autoplay}
                  loop
                />
              </div>
            ) : isRunning ? (
              <div className="text-center space-y-4 w-full max-w-md">
                <Loader2 className="w-12 h-12 text-violet-400 animate-spin mx-auto" />
                <div className="space-y-1">
                  <p className="text-[12px] font-medium text-foreground">{stage}</p>
                  {progressMax > 0 && (
                    <>
                      <div className="w-full bg-muted/30 rounded-full h-2 mt-2">
                        <div
                          className="bg-violet-500 h-2 rounded-full transition-all"
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Step {progress}/{progressMax} ({progressPct.toFixed(0)}%)
                      </p>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center space-y-3 text-muted-foreground/40">
                <Film className="w-14 h-14 mx-auto" />
                <div className="space-y-1">
                  <p className="text-[12px]">WAN 2.2 Sound-to-Video</p>
                  <p className="text-[10px]">
                    Upload a reference image and audio, then generate a lipsync video
                  </p>
                  <p className="text-[9px] text-muted-foreground/30">
                    {config.width}×{config.height} · {config.frames} frames · {videoDuration.toFixed(1)}s @{config.fps}fps
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
