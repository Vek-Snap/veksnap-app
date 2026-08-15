"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useAutoplay } from "@/lib/use-autoplay";
import {
  Play,
  Upload,
  ImageIcon,
  Music,
  Mic2,
  Settings2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Volume2,
} from "lucide-react";
import { VideoSlot } from "@/components/media/MediaPlayer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  LTX2Config,
  LTX2_DEFAULTS,
  LTX23_MODEL_DEFAULTS,
} from "@/lib/types";
import {
  uploadImage,
  uploadAudio,
  queuePrompt,
  getHistory,
  getImageUrl,
  connectComfyStream,
  checkConnection,
} from "@/lib/comfyui-api";
import type { ComfyUIProgress } from "@/lib/types";
import { buildLTX2OfficialWorkflow } from "@/lib/workflow-builder";

// ── Constants ──

const TALKING_HEAD_LORA = "LTX-2.3-22b-AV-LoRA-talking-head-v1.safetensors";
const DEFAULT_LORA_STRENGTH = 1.0;

const RESOLUTION_PRESETS = [
  { label: "1280×704", w: 1280, h: 704 },  // LoRA author recommended for I2V+Audio
  { label: "1280×736", w: 1280, h: 736 },  // LoRA author recommended for I2V only
  { label: "960×544", w: 960, h: 544 },
  { label: "768×512", w: 768, h: 512 },
];

const DURATION_PRESETS = [
  { label: "3s", frames: 81 },    // 25fps × 3s ≈ 75 → next 8n+1 = 81
  { label: "5s", frames: 129 },   // 25fps × 5s = 125 → next 8n+1 = 129
  { label: "8s", frames: 201 },   // 25fps × 8s = 200 → next 8n+1 = 201
  { label: "10s", frames: 257 },  // 25fps × 10s = 250 → next 8n+1 = 257
];

const PROMPT_STARTERS = [
  'A character talking directly to the camera, natural head movements, professional lighting. The character is talking, and they say: "[transcript]"',
  'A singer performing an emotional ballad, slight swaying, warm studio lighting. Mouth partially open during speech with lips moving naturally.',
  'A news anchor delivering breaking news, steady gaze, clean studio background. Smooth continuous motion, cinematic, realistic, sharp focus on subject.',
  'A character speaking in a calm voice, simple dark background, cinematic lighting. The character is talking, and they say: "[transcript]"',
];

// ── Component ──

export default function LipSyncStudio() {
  // Source inputs
  const [sourceImagePreview, setSourceImagePreview] = useState<string | null>(null);
  const [sourceImageFile, setSourceImageFile] = useState<string>("");
  const [audioPreview, setAudioPreview] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<string>("");
  const audioInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Generation params
  const [prompt, setPrompt] = useState("A character talking directly to the camera, natural head movements, soft lighting. Mouth partially open during speech with lips moving naturally. Smooth continuous motion, cinematic, realistic.");
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(704);
  const [numFrames, setNumFrames] = useState(201);  // ~8s at 25fps
  const [frameRate] = useState(25);  // LoRA author: 25fps for I2V+Audio
  const [seed, setSeed] = useState(-1);
  const [randomSeed, setRandomSeed] = useState(true);
  const [loraStrength, setLoraStrength] = useState(DEFAULT_LORA_STRENGTH);
  const [directSampling, setDirectSampling] = useState(true);

  // Advanced
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [negativePrompt, setNegativePrompt] = useState("worst quality, inconsistent motion, blurry, jittery, distorted");

  // Generation state
  const [isRunning, setIsRunning] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [autoplay] = useAutoplay();
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null);

  // Refs
  const clientIdRef = useRef(`lipsync-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const promptIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const cumulativeStepsRef = useRef(0);
  const prevChunkMaxRef = useRef(0);

  // ComfyUI connection check. Use the shared checkConnection() (source of truth:
  // /api/services) like every other studio. The old inline fetch hit the ComfyUI
  // proxy root and read a non-existent `status` field, so comfyConnected was
  // permanently false: which pinned canGenerate to false and left the Generate
  // button disabled forever.
  const [comfyConnected, setComfyConnected] = useState<boolean | null>(null);
  useEffect(() => {
    checkConnection().then(setComfyConnected).catch(() => setComfyConnected(false));
  }, []);

  // ── File Handlers ──

  const handleImageUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSourceImagePreview(reader.result as string);
    reader.readAsDataURL(file);
    // Upload to ComfyUI
    try {
      const name = await uploadImage(file);
      setSourceImageFile(name);
    } catch (err) {
      setError(`Image upload failed: ${err}`);
    }
  }, []);

  const handleAudioUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAudioPreview(reader.result as string);
    reader.readAsDataURL(file);
    // Upload to ComfyUI
    try {
      const name = await uploadAudio(file);
      setAudioFile(name);
    } catch (err) {
      setError(`Audio upload failed: ${err}`);
    }
  }, []);

  // ── Generate ──

  const handleGenerate = useCallback(async () => {
    if (!sourceImageFile || !audioFile) {
      setError("Please upload both a source image and an audio file.");
      return;
    }
    if (!prompt.trim()) {
      setError("Please enter a video prompt.");
      return;
    }

    setIsRunning(true);
    setError(null);
    setOutputUrl(null);
    setLivePreviewUrl(null);
    setProgress(0);
    setProgressMax(0);
    cumulativeStepsRef.current = 0;
    prevChunkMaxRef.current = 0;
    setStage("Building lip-sync workflow...");

    try {
      const genSeed = randomSeed || seed < 0
        ? Math.floor(Math.random() * 2 ** 32)
        : seed;

      // Normalize audio length to match video duration
      const targetDuration = numFrames / frameRate;
      let normalizedAudioFile = audioFile;
      try {
        setStage("Normalizing audio length...");
        const normRes = await fetch("/api/director/normalize-audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioFile, targetDuration }),
        });
        if (normRes.ok) {
          const normData = await normRes.json();
          if (normData.action === "clipped" || normData.action === "padded") {
            normalizedAudioFile = normData.audioFile;
          }
        }
      } catch {
        // Use original if normalization fails
      }

      // Build LTX2Config with lip-sync presets
      const ltxConfig: LTX2Config = {
        ...LTX2_DEFAULTS,
        // LTX 2.3 models
        diffusionModel: LTX23_MODEL_DEFAULTS.diffusionModel,
        textEncoder: LTX23_MODEL_DEFAULTS.textEncoder,
        connectorModel: LTX23_MODEL_DEFAULTS.connectorModel,
        videoVae: LTX23_MODEL_DEFAULTS.videoVae,
        audioVae: LTX23_MODEL_DEFAULTS.audioVae,
        distillLoRA: LTX23_MODEL_DEFAULTS.distillLoRA,
        distillLoRAStrength: 1.0,
        modelVersion: "2.3",
        pipelineMode: "official",
        qualityTier: "distilled",
        // Generation params
        prompt,
        negativePrompt,
        width,
        height,
        numFrames,
        frameRate,
        seed: genSeed,
        randomSeed: false,
        enableAudio: true,
        // A2V mode
        a2vMode: true,
        a2vAudioFile: normalizedAudioFile,
        // Source image (I2V guide)
        sourceImage: sourceImageFile,
        // Talking-head LoRA
        userLoras: [
          { name: TALKING_HEAD_LORA, strengthModel: loraStrength, strengthClip: 0, enabled: true },
        ],
        // Direct sampling (bypass NormalizingSampler)
        directSampling,
      };

      const workflow = buildLTX2OfficialWorkflow(ltxConfig, genSeed);
      setStage("Queuing to ComfyUI...");

      // Connect SSE for progress
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
            const totalSteps = 8; // distilled tier
            const globalStep = cumulativeStepsRef.current + chunkVal;
            setProgress(globalStep);
            setProgressMax(totalSteps);
            setStage(`Sampling step ${globalStep}/${totalSteps}`);
          } else if (msg.type === "executing" && msg.data) {
            if (msg.data.node === null) {
              fetchResult();
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
        () => {},
        () => {},
        (dataUrl: string) => setLivePreviewUrl(dataUrl)
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
      for (let i = 0; i < 30; i++) {
        try {
          const history = await getHistory(pid);
          if (history?.outputs) {
            const vhsOutput = history.outputs["17"];
            if (vhsOutput?.gifs?.[0]) {
              const gif = vhsOutput.gifs[0];
              const url = getImageUrl(gif.filename, gif.subfolder || "", gif.type || "output");
              setOutputUrl(url);
              setStage("Complete!");
              setIsRunning(false);
              esRef.current?.close();
              return;
            }
          }
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
      setStage("Complete (output may be in ComfyUI)");
      setIsRunning(false);
      esRef.current?.close();
    }
  }, [sourceImageFile, audioFile, prompt, negativePrompt, width, height, numFrames, frameRate, seed, randomSeed, loraStrength, directSampling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  const duration = (numFrames / frameRate).toFixed(1);
  const canGenerate = !!sourceImageFile && !!audioFile && !!prompt.trim() && comfyConnected !== false;

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Mic2 className="w-5 h-5 text-fuchsia-400" />
          <h2 className="text-sm font-semibold text-fuchsia-300">Lip-Sync Music Video Studio</h2>
        </div>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Generate lip-synced videos from a created character image + audio using LTX 2.3 with the talking-head LoRA.
          Upload a character image and audio file, describe the scene, and generate.
        </p>

        {/* Source Image */}
        <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-3 space-y-2">
          <Label className="text-[11px] text-fuchsia-400 font-medium flex items-center gap-1.5">
            <ImageIcon className="w-3.5 h-3.5" /> Source Image
          </Label>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageUpload}
            className="hidden"
          />
          {sourceImagePreview ? (
            <div className="relative group">
              <img
                src={sourceImagePreview}
                alt="Source"
                className="w-full max-h-48 object-contain rounded border border-fuchsia-500/20"
              />
              <button
                type="button"
                onClick={() => { setSourceImagePreview(null); setSourceImageFile(""); }}
                className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              className="w-full h-24 border-2 border-dashed border-fuchsia-500/30 rounded-lg flex flex-col items-center justify-center gap-1 hover:border-fuchsia-500/50 transition-colors"
              disabled={isRunning}
            >
              <Upload className="w-5 h-5 text-fuchsia-400/60" />
              <span className="text-[10px] text-muted-foreground">Click to upload a created character image</span>
            </button>
          )}
        </div>

        {/* Audio File */}
        <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-3 space-y-2">
          <Label className="text-[11px] text-fuchsia-400 font-medium flex items-center gap-1.5">
            <Music className="w-3.5 h-3.5" /> Audio File
          </Label>
          <p className="text-[8px] text-muted-foreground/60">
            Upload speech, singing, or music. Audio will be auto-trimmed/padded to match video duration ({duration}s).
          </p>
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*"
            onChange={handleAudioUpload}
            className="hidden"
          />
          {audioPreview ? (
            <div className="space-y-1">
              <audio src={audioPreview} controls className="w-full h-8" />
              <button
                type="button"
                onClick={() => { setAudioPreview(null); setAudioFile(""); }}
                className="text-[9px] text-fuchsia-400/70 hover:text-fuchsia-300"
              >
                Remove audio
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => audioInputRef.current?.click()}
              className="w-full h-16 border-2 border-dashed border-fuchsia-500/30 rounded-lg flex flex-col items-center justify-center gap-1 hover:border-fuchsia-500/50 transition-colors"
              disabled={isRunning}
            >
              <Volume2 className="w-4 h-4 text-fuchsia-400/60" />
              <span className="text-[10px] text-muted-foreground">Click to upload audio (WAV, MP3, etc.)</span>
            </button>
          )}
        </div>

        {/* Video Prompt */}
        <div className="space-y-1.5">
          <Label className="text-[11px] text-fuchsia-400/80 font-medium">Video Prompt</Label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the scene..."
            className="min-h-[60px] text-[11px] border-fuchsia-500/20 focus:ring-fuchsia-500/50"
            disabled={isRunning}
          />
          <div className="flex flex-wrap gap-1">
            {PROMPT_STARTERS.map((p, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPrompt(p)}
                className="text-[8px] px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-300/70 hover:bg-fuchsia-500/20 transition-colors"
                disabled={isRunning}
              >
                {p.slice(0, 40)}...
              </button>
            ))}
          </div>
        </div>

        {/* Resolution & Duration */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-[10px] text-fuchsia-400/80">Resolution</Label>
            <div className="flex flex-wrap gap-1">
              {RESOLUTION_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => { setWidth(p.w); setHeight(p.h); }}
                  className={`text-[9px] px-2 py-1 rounded border transition-colors ${
                    width === p.w && height === p.h
                      ? "border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-200"
                      : "border-border/50 text-muted-foreground hover:border-fuchsia-500/30"
                  }`}
                  disabled={isRunning}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] text-fuchsia-400/80">Duration</Label>
            <div className="flex flex-wrap gap-1">
              {DURATION_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setNumFrames(p.frames)}
                  className={`text-[9px] px-2 py-1 rounded border transition-colors ${
                    numFrames === p.frames
                      ? "border-fuchsia-500/50 bg-fuchsia-500/15 text-fuchsia-200"
                      : "border-border/50 text-muted-foreground hover:border-fuchsia-500/30"
                  }`}
                  disabled={isRunning}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* LoRA Strength + Seed */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-[10px] text-fuchsia-400/80">LoRA Strength: {loraStrength.toFixed(2)}</Label>
            <Slider
              min={0}
              max={1.5}
              step={0.01}
              value={[loraStrength]}
              onValueChange={([v]) => setLoraStrength(v)}
              disabled={isRunning}
            />
            <p className="text-[8px] text-muted-foreground/50">talking-head LoRA (1.0 = author recommended)</p>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-fuchsia-400/80">Seed</Label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                value={randomSeed ? -1 : seed}
                onChange={(e) => { setSeed(Number(e.target.value)); setRandomSeed(false); }}
                className="flex-1 h-7 rounded border border-fuchsia-500/20 bg-background px-2 text-[11px] font-mono"
                disabled={isRunning || randomSeed}
              />
              <label className="flex items-center gap-1 text-[9px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={randomSeed}
                  onChange={(e) => setRandomSeed(e.target.checked)}
                  className="h-3 w-3"
                  disabled={isRunning}
                />
                Rand
              </label>
            </div>
          </div>
        </div>

        {/* Direct Sampling Toggle */}
        <div className="flex items-center justify-between px-1">
          <Label className="text-[10px] text-muted-foreground cursor-pointer" htmlFor="lipsync-directSampling">
            Direct Sampling (skip normalization)
          </Label>
          <input
            id="lipsync-directSampling"
            type="checkbox"
            checked={directSampling}
            onChange={(e) => setDirectSampling(e.target.checked)}
            disabled={isRunning}
            className="h-3.5 w-3.5 rounded accent-fuchsia-500"
          />
        </div>

        {/* Advanced Settings */}
        <div className="rounded-lg border border-fuchsia-500/10 bg-fuchsia-500/5 p-2">
          <button
            type="button"
            className="flex items-center gap-2 w-full text-left"
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            {advancedOpen ? <ChevronDown className="w-3 h-3 text-fuchsia-400" /> : <ChevronRight className="w-3 h-3 text-fuchsia-400" />}
            <Settings2 className="w-3 h-3 text-fuchsia-400" />
            <span className="text-[10px] text-fuchsia-400/80">Advanced</span>
          </button>
          {advancedOpen && (
            <div className="space-y-2 pt-2">
              <div className="space-y-1">
                <Label className="text-[9px] text-muted-foreground/70">Negative Prompt</Label>
                <Textarea
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  className="min-h-[40px] text-[10px] border-fuchsia-500/10"
                  disabled={isRunning}
                />
              </div>
            </div>
          )}
        </div>

        {/* Generate Button */}
        <Button
          className="w-full bg-fuchsia-600 hover:bg-fuchsia-500 text-white"
          onClick={handleGenerate}
          disabled={!canGenerate || isRunning}
        >
          {isRunning ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {stage}
            </>
          ) : (
            <>
              <Play className="w-4 h-4 mr-2" />
              Generate Lip-Sync Video
            </>
          )}
        </Button>

        {/* Progress */}
        {isRunning && progressMax > 0 && (
          <div className="space-y-1">
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-fuchsia-500 transition-all duration-300"
                style={{ width: `${Math.min(100, (progress / progressMax) * 100)}%` }}
              />
            </div>
            <p className="text-[9px] text-muted-foreground text-center">{stage}</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Live Preview */}
        {isRunning && livePreviewUrl && !outputUrl && (
          <div className="rounded-lg border border-fuchsia-500/30 overflow-hidden">
            <img
              src={livePreviewUrl}
              alt="Live preview"
              className="w-full"
              style={{ maxHeight: "40vh", objectFit: "contain" }}
            />
          </div>
        )}

        {/* Output Video */}
        {outputUrl && (
          <div className="space-y-2">
            <Label className="text-[11px] text-fuchsia-400 font-medium">Output</Label>
            <div className="rounded-lg border border-fuchsia-500/30 overflow-hidden bg-black">
              <VideoSlot
                id="lipsync-output"
                src={outputUrl}
                className="w-full"
                style={{ maxHeight: "50vh", width: "100%" }}
                autoOpen={autoplay}
                loop
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[10px] px-2"
                onClick={handleGenerate}
              >
                <RefreshCw className="w-3 h-3 mr-1" /> Regenerate
              </Button>
            </div>
          </div>
        )}

        {/* Info panel */}
        <div className="rounded-lg border border-fuchsia-500/10 bg-fuchsia-500/5 p-2 space-y-1">
          <p className="text-[9px] text-muted-foreground/60">
            <strong className="text-fuchsia-400/70">Model:</strong> LTX 2.3 (Official Pipeline, Distilled 8-step)
          </p>
          <p className="text-[9px] text-muted-foreground/60">
            <strong className="text-fuchsia-400/70">LoRA:</strong> {TALKING_HEAD_LORA} @ {loraStrength.toFixed(2)}
          </p>
          <p className="text-[9px] text-muted-foreground/60">
            <strong className="text-fuchsia-400/70">Output:</strong> {width}×{height} @ {frameRate}fps · {duration}s · A2V mode
          </p>
          <p className="text-[9px] text-muted-foreground/60">
            <strong className="text-fuchsia-400/70">Prompt tip:</strong> End prompts with: The character is talking, and they say: &quot;[transcript]&quot;
          </p>
          <p className="text-[9px] text-muted-foreground/60">
            <strong className="text-fuchsia-400/70">Note:</strong> Simple/dark backgrounds produce best lip-sync. Sweep 3-5 seeds per generation.
          </p>
          <p className="text-[9px] text-muted-foreground/60">
            <strong className="text-fuchsia-400/70">Audio model:</strong> Future enhancement: currently uses uploaded audio only
          </p>
        </div>
      </div>
    </ScrollArea>
  );
}
