"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAutoplay } from "@/lib/use-autoplay";
import {
  Play,
  Square,
  Upload,
  X,
  Film,
  Settings2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Download,
  RefreshCw,
  Sparkles,
  Volume2,
  VolumeX,
  Plus,
  Trash2,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  LTX2Config,
  LTX25_DEFAULTS,
  ComfyUIProgress,
  LoraEntry,
} from "@/lib/types";
import { buildLTX25Workflow } from "@/lib/workflow-builder";
import LoraSelect from "@/components/LoraSelect";
import DecimalInput from "@/components/DecimalInput";
import { useRegisterComfyWorkflow } from "@/components/ComfyOpenProvider";
import SendToQueueButton from "@/components/SendToQueueButton";
import {
  queuePrompt,
  getHistory,
  interruptGeneration,
  connectComfyStream,
  uploadImage,
  getImageUrl,
} from "@/lib/comfyui-api";
import { inputSmall, selectBase, labelMuted, hintText, progressTrack, advancedToggle, toggleInactive } from "@/lib/theme-classes";

interface LTX25StudioProps {
  config: LTX2Config;
  onConfigChange: (config: LTX2Config) => void;
}

// Resolution presets (all multiples of 32).
const RES_PRESETS: { label: string; w: number; h: number; note?: string }[] = [
  { label: "512² (test)", w: 512, h: 512, note: "fastest" },
  { label: "720p ▭", w: 1280, h: 704 },
  { label: "720p ▯", w: 704, h: 1280 },
  { label: "Square", w: 960, h: 960 },
  { label: "1080p ▭", w: 1920, h: 1088, note: "heavy" },
];

// One-click showcase presets. Each loads a crafted prompt + matching settings so
// the user only has to press Generate. They demonstrate LTX-2.5's defining trait:
// SYNCHRONIZED audio+video in a single pass (foley, ambience, music, dialogue).
// Prompts follow the LTX-2 structure (flowing paragraph, present tense, explicit
// AUDIO: clause, dialogue in quotes). Frames are LTX-valid 8n+1 (121 ≈ 5s @ 24fps).
const SHOWCASE_PRESETS: {
  label: string;
  blurb: string;
  prompt: string;
  width: number;
  height: number;
  numFrames: number;
  frameRate: number;
}[] = [
  {
    label: "Neon Rain",
    blurb: "Cinematic noir: synced footsteps + rain foley/ambience",
    prompt:
      "A cinematic low-angle tracking shot glides through a rain-soaked neon alleyway at night; wet pavement mirrors magenta and cyan signs, steam curls from a street grate, and a lone figure in a glistening trench coat walks steadily toward camera with shallow depth of field and fine film grain. The camera slowly dollies backward to keep pace. AUDIO: footsteps splashing in puddles in sync with each step, steady rainfall pattering on metal, a low distant city hum, and a faraway police siren fading past, no music.",
    width: 1280,
    height: 704,
    numFrames: 121,
    frameRate: 24,
  },
  {
    label: "Ocean Cliff",
    blurb: "Epic nature: crashing waves + wind + swelling score",
    prompt:
      "A sweeping aerial establishing shot soars over towering ocean cliffs at golden hour as powerful turquoise waves crash against black rock and explode into white spray; seabirds wheel through drifting sea mist and wind-bent grass ripples along the ridgeline. The camera cranes upward to reveal a vast glowing horizon. AUDIO: thunderous waves crashing in rhythm with the swell, gusting wind, distant seabird calls, and a slow, swelling orchestral score.",
    width: 1280,
    height: 704,
    numFrames: 121,
    frameRate: 24,
  },
  {
    label: "Spoken Line",
    blurb: "Dialogue showcase: lip-synced speech + harbor ambience",
    prompt:
      "A warm medium close-up of a grey-bearded fisherman in a weathered wool peacoat on a misty harbor dock at dawn; soft overcast light with a warm break of sun near the horizon, gentle handheld sway, shallow focus. He looks into the lens, exhales, and says in a calm, gravelly voice: \"The tide always turns, you just have to wait for it.\" AUDIO: his clear spoken dialogue synced to his lips, water lapping against the hull, rope creaking, and a distant foghorn.",
    width: 1280,
    height: 704,
    numFrames: 121,
    frameRate: 24,
  },
  {
    label: "Stage Lights",
    blurb: "Vertical performance: music + roaring crowd",
    prompt:
      "A dynamic vertical concert shot pushes through swirling haze and lens flares as a singer steps to the microphone under sweeping blue and amber stage lights; a sea of phone-lights sparkles in the dark background and confetti drifts through the beams. The camera arcs around the performer. AUDIO: an energetic electronic-pop track with a driving beat and building synths, a roaring crowd, and rhythmic clapping.",
    width: 704,
    height: 1280,
    numFrames: 121,
    frameRate: 24,
  },
];

// Snap an arbitrary frame count to LTX's required 8n+1, min 25 (~1 s).
function snapFrames(raw: number): number {
  const n = Math.max(3, Math.round((raw - 1) / 8));
  return n * 8 + 1;
}

// mm:ss (or h:mm:ss) formatter for the live ETA panel.
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

// Live ETA countdown: same panel used by Continuum and LTX-2.3, themed violet
// to match this studio. Averages recent step intervals for a smoothed estimate.
function LTX25ETACountdown({ stepTimestamps, progress, progressMax }: {
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
  const recent = stepTimestamps.slice(-11);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i++) intervals.push(recent[i] - recent[i - 1]);
  const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const lastStepMs = intervals[intervals.length - 1];
  const stepsRemaining = progressMax - progress;
  const etaSeconds = (stepsRemaining * avgMs) / 1000;
  const sinceLastStep = (now - stepTimestamps[stepTimestamps.length - 1]) / 1000;
  const liveEta = Math.max(0, etaSeconds - sinceLastStep);
  const elapsed = (now - stepTimestamps[0]) / 1000;
  return (
    <div className="rounded-lg border border-violet-500/20 bg-gradient-to-r from-violet-500/5 to-fuchsia-500/5 p-2 mt-1">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[9px] text-violet-400/70 flex items-center gap-1">
          <Timer className="w-3 h-3" /> ETA
        </span>
        <span className="text-[9px] text-muted-foreground font-mono">
          {(avgMs / 1000).toFixed(0)}s/step · last {(lastStepMs / 1000).toFixed(0)}s
        </span>
      </div>
      <div className="flex items-baseline justify-center gap-1">
        <span className="text-xl font-mono font-bold text-violet-400 tabular-nums tracking-tight">
          {formatEtaTime(liveEta)}
        </span>
        <span className="text-[9px] text-violet-400/50">remaining</span>
      </div>
      <div className="flex justify-between mt-1 text-[8px] text-muted-foreground font-mono">
        <span>Elapsed: {formatEtaTime(elapsed)}</span>
        <span>{stepsRemaining} steps left</span>
      </div>
    </div>
  );
}

export default function LTX25Studio({ config, onConfigChange }: LTX25StudioProps) {
  const configRef = useRef(config);
  configRef.current = config;

  useRegisterComfyWorkflow(() => ({
    workflow: buildLTX25Workflow(config, config.seed < 0 ? 0 : config.seed) as Record<string, unknown>,
    name: "LTX-2.5",
  }));

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputVideoUrl, setOutputVideoUrl] = useState<string | null>(null);
  const [outputFilename, setOutputFilename] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [stage, setStage] = useState("");
  const [lastSeed, setLastSeed] = useState<number | null>(null);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imagePreviewLast, setImagePreviewLast] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [autoplay] = useAutoplay();
  const [stepTimestamps, setStepTimestamps] = useState<number[]>([]);
  const [rawFrameInput, setRawFrameInput] = useState(String(config.numFrames));
  const [rawSecInput, setRawSecInput] = useState(((config.numFrames - 1) / config.frameRate).toFixed(1));

  const imageInputRef = useRef<HTMLInputElement>(null);
  const imageInputLastRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const promptIdRef = useRef<string | null>(null);
  const clientIdRef = useRef(`ltx25-${Date.now()}`);

  const update = useCallback(
    <K extends keyof LTX2Config>(key: K, value: LTX2Config[K]) => {
      const next = { ...configRef.current, [key]: value };
      configRef.current = next;
      onConfigChange(next);
    },
    [onConfigChange]
  );

  const isI2V = !!config.sourceImage;
  const isFLF2V = !!config.sourceImage && !!config.sourceImageLast; // both endpoints → first-last-frame

  useEffect(() => {
    if (config.sourceImage && !imagePreview && !config.sourceImage.startsWith("blob:") && !config.sourceImage.startsWith("data:")) {
      setImagePreview(getImageUrl(config.sourceImage, "", "input"));
    }
  }, [config.sourceImage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore end-frame preview from the persisted ComfyUI input/ path after a tab switch.
  useEffect(() => {
    if (config.sourceImageLast && !imagePreviewLast && !config.sourceImageLast.startsWith("blob:") && !config.sourceImageLast.startsWith("data:")) {
      setImagePreviewLast(getImageUrl(config.sourceImageLast, "", "input"));
    }
  }, [config.sourceImageLast]); // eslint-disable-line react-hooks/exhaustive-deps

  // Available LoRA files for the searchable selector (shares the /api/lora-scan catalog for badges).
  useEffect(() => {
    fetch(`/api/lora-files?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: string[]) => setAvailableLoras(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  // Keep the frames + seconds fields in sync when numFrames/frameRate change
  // (external load, preset, or the sibling field). Duration = (frames-1)/fps.
  useEffect(() => {
    setRawFrameInput(String(config.numFrames));
    setRawSecInput(((config.numFrames - 1) / config.frameRate).toFixed(1));
  }, [config.numFrames, config.frameRate]);

  const handleImageUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImagePreview(URL.createObjectURL(file));
      setUploadPct(0);
      const uploaded = await uploadImage(file, (pct) => setUploadPct(pct));
      update("sourceImage", uploaded);
    } catch (err) {
      setError(`Image upload failed: ${err}`);
    } finally {
      setUploadPct(null);
    }
    e.target.value = "";
  }, [update]);

  const clearImage = useCallback(() => {
    setImagePreview(null);
    update("sourceImage", "");
  }, [update]);

  const handleImageUploadLast = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImagePreviewLast(URL.createObjectURL(file));
      setUploadPct(0);
      const uploaded = await uploadImage(file, (pct) => setUploadPct(pct));
      update("sourceImageLast", uploaded);
    } catch (err) {
      setError(`End-frame upload failed: ${err}`);
    } finally {
      setUploadPct(null);
    }
    e.target.value = "";
  }, [update]);

  const clearImageLast = useCallback(() => {
    setImagePreviewLast(null);
    update("sourceImageLast", "");
  }, [update]);

  const addLora = useCallback(() => {
    const next = [...(configRef.current.userLoras || []), { enabled: true, name: "", strengthModel: 1, strengthClip: 1 } as LoraEntry];
    update("userLoras", next);
  }, [update]);
  const updateLora = useCallback((i: number, patch: Partial<LoraEntry>) => {
    const next = (configRef.current.userLoras || []).map((l, idx) => (idx === i ? { ...l, ...patch } : l));
    update("userLoras", next);
  }, [update]);
  const removeLora = useCallback((i: number) => {
    const next = (configRef.current.userLoras || []).filter((_, idx) => idx !== i);
    update("userLoras", next);
  }, [update]);

  // One-click showcase: load a crafted prompt + matching resolution/frames/fps and
  // force audio on so the user only has to press Generate for a full A/V demo.
  const applyShowcase = useCallback((p: (typeof SHOWCASE_PRESETS)[number]) => {
    onConfigChange({
      ...configRef.current,
      prompt: p.prompt,
      width: p.width,
      height: p.height,
      numFrames: p.numFrames,
      frameRate: p.frameRate,
      enableAudio: true,
      ltx25AutoDuration: false,
      sourceImage: "",
      sourceImageLast: "",
    });
    setImagePreview(null);
    setImagePreviewLast(null);
  }, [onConfigChange]);

  const handleGenerate = useCallback(async () => {
    if (!config.prompt.trim()) {
      setError("Please enter a prompt.");
      return;
    }
    setIsGenerating(true);
    setError(null);
    setOutputVideoUrl(null);
    setOutputFilename(null);
    setProgress(0);
    setProgressMax(0);
    setStepTimestamps([]);
    setStage("Building workflow...");

    const seed = config.randomSeed || config.seed < 0
      ? Math.floor(Math.random() * 2 ** 32)
      : config.seed;
    setLastSeed(seed);

    try {
      const clientId = clientIdRef.current;
      esRef.current?.close();
      esRef.current = connectComfyStream(
        clientId,
        (msg: ComfyUIProgress) => {
          if (msg.type === "progress" && msg.data) {
            setProgress(msg.data.value ?? 0);
            setProgressMax(msg.data.max ?? 0);
            setStepTimestamps((prev) => {
              const next = [...prev, Date.now()];
              return next.length > 100 ? next.slice(-100) : next;
            });
          }
        },
        () => {}
      );

      const workflow = buildLTX25Workflow(config, seed);
      setStage("Queuing...");
      const response = await queuePrompt(workflow, clientId);
      promptIdRef.current = response.prompt_id;
      setStage("Generating (loading 22B model may take a minute)...");

      for (let i = 0; i < 1200; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const hist = await getHistory(response.prompt_id);
        if (!hist) continue;
        if (hist.status?.status_str === "error") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const messages = (hist.status as any)?.messages;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nodeErr = messages?.find((m: any) => m[0] === "execution_error");
          throw new Error(nodeErr ? JSON.stringify(nodeErr[1]) : "Execution failed");
        }
        const outputs = hist.outputs || {};
        for (const nodeOut of Object.values(outputs)) {
          const o = nodeOut as Record<string, unknown[]>;
          const media = (o.gifs || o.images) as Array<{ filename: string; subfolder?: string }> | undefined;
          if (media && media.length > 0) {
            const v = media[0];
            setOutputFilename(v.filename);
            setOutputVideoUrl(
              `/api/comfyui/view?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder || "")}&type=output`
            );
            setStage("Done!");
            if (autoplay && videoRef.current) setTimeout(() => videoRef.current?.play().catch(() => {}), 200);
            setIsGenerating(false);
            return;
          }
        }
      }
      throw new Error("Generation timed out (20 minutes).");
    } catch (err) {
      setError(String(err));
      setStage("");
    } finally {
      setIsGenerating(false);
      esRef.current?.close();
      esRef.current = null;
    }
  }, [config, autoplay]);

  const handleStop = useCallback(async () => {
    try { await interruptGeneration(); } catch { /* ignore */ }
    setIsGenerating(false);
    setStage("Cancelled");
  }, []);

  const handleDownload = useCallback(() => {
    if (!outputVideoUrl) return;
    const a = document.createElement("a");
    a.href = outputVideoUrl;
    a.download = outputFilename || `ltx25_${Date.now()}.mp4`;
    a.click();
  }, [outputVideoUrl, outputFilename]);

  const pct = progressMax > 0 ? Math.round((progress / progressMax) * 100) : 0;

  return (
    <div className="flex flex-col h-full p-3 space-y-3 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-medium text-violet-400">LTX-2.5</span>
          <span className="text-[9px] text-muted-foreground/60">Lightricks • Distilled Audio+Video • {isI2V ? "Image→Video" : "Text→Video"}</span>
        </div>
        <button
          onClick={() => onConfigChange({ ...LTX25_DEFAULTS })}
          className="text-[9px] text-muted-foreground hover:text-violet-400 flex items-center gap-0.5"
        >
          <RefreshCw className="w-3 h-3" /> Reset
        </button>
      </div>

      <div className="space-y-1.5">
        <Label className={labelMuted}>Prompt</Label>
        <textarea
          className={`${inputSmall} min-h-[90px] resize-y`}
          value={config.prompt}
          onChange={(e) => update("prompt", e.target.value)}
          placeholder="A cinematic shot of a fox trotting through a snowy forest at dawn, soft ambient wind and crunching snow…"
          disabled={isGenerating}
        />
        <p className={hintText}>Include sound cues (dialogue, ambience, music): LTX-2.5 generates synchronized audio.</p>
        {/* One-click showcase presets: load a crafted prompt + settings; press Generate for a full audio+video demo. */}
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="text-[9px] text-violet-400/70 flex items-center gap-1"><Sparkles className="w-3 h-3" /> Showcase:</span>
          {SHOWCASE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyShowcase(p)}
              disabled={isGenerating}
              title={p.blurb}
              className="text-[9px] px-2 py-0.5 rounded-full border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 hover:border-violet-500/50 transition-colors disabled:opacity-40"
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-[8px] text-muted-foreground/40">Two clicks to a demo: pick a showcase, then Generate. Each loads a crafted audio+video prompt and matching resolution/length.</p>
      </div>

      <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-violet-400 font-medium flex items-center gap-1">
            <Upload className="w-3 h-3" /> Start Image (optional, enables Image→Video)
          </span>
          {imagePreview && (
            <button onClick={clearImage} className="text-muted-foreground hover:text-violet-400" disabled={isGenerating}>
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        {imagePreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imagePreview} alt="start frame" className="w-full max-h-48 object-contain rounded" />
        ) : (
          <button
            onClick={() => imageInputRef.current?.click()}
            className="w-full border border-dashed border-violet-500/30 rounded py-3 flex flex-col items-center gap-1 text-muted-foreground hover:text-violet-400 hover:border-violet-500/50 transition-colors"
            disabled={isGenerating}
          >
            <Upload className="w-4 h-4" />
            <span className="text-[9px]">Upload a start image (leave empty for pure Text→Video)</span>
          </button>
        )}
        {uploadPct !== null && <p className={hintText}>Uploading… {uploadPct}%</p>}
        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
      </div>

      {/* End Image (FLF2V): only meaningful once a start image is set */}
      {imagePreview && (
        <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-fuchsia-400 font-medium flex items-center gap-1">
              <Upload className="w-3 h-3" /> End Image (optional, enables First→Last-Frame)
            </span>
            {imagePreviewLast && (
              <button onClick={clearImageLast} className="text-muted-foreground hover:text-fuchsia-400" disabled={isGenerating}>
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          {imagePreviewLast ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={imagePreviewLast} alt="end frame" className="w-full max-h-48 object-contain rounded" />
          ) : (
            <button
              onClick={() => imageInputLastRef.current?.click()}
              className="w-full border border-dashed border-fuchsia-500/30 rounded py-3 flex flex-col items-center gap-1 text-muted-foreground hover:text-fuchsia-400 hover:border-fuchsia-500/50 transition-colors"
              disabled={isGenerating}
            >
              <Upload className="w-4 h-4" />
              <span className="text-[9px]">Upload an end frame to morph start → end (FLF2V)</span>
            </button>
          )}
          {isFLF2V && (
            <p className={hintText}>First→Last-Frame active: single-stage render anchoring the first and last frames (no 2× upscale). Both frames are held at strength 0.7.</p>
          )}
          <input ref={imageInputLastRef} type="file" accept="image/*" className="hidden" onChange={handleImageUploadLast} />
        </div>
      )}

      <div className="space-y-1.5">
        <Label className={labelMuted}>Resolution</Label>
        <div className="flex flex-wrap gap-1.5">
          {RES_PRESETS.map((r) => {
            const active = config.width === r.w && config.height === r.h;
            return (
              <button
                key={r.label}
                onClick={() => { update("width", r.w); update("height", r.h); }}
                className={`flex items-center gap-1 text-[9px] px-2.5 py-1 rounded-md border transition-all duration-150 disabled:opacity-40 ${
                  active
                    ? "border-violet-500/60 bg-violet-500/20 text-violet-200"
                    : "border-violet-500/30 bg-violet-500/5 text-violet-300 hover:bg-violet-500/15"
                }`}
                disabled={isGenerating}
              >
                {r.label}
                {r.note && <span className="text-[8px] opacity-60">({r.note})</span>}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-0.5">
            <Label className="text-[9px] text-muted-foreground/70">Width: {config.width}</Label>
            <input type="number" step={32} min={256} className={inputSmall} value={config.width} onChange={(e) => update("width", parseInt(e.target.value) || 512)} disabled={isGenerating} />
          </div>
          <div className="space-y-0.5">
            <Label className="text-[9px] text-muted-foreground/70">Height: {config.height}</Label>
            <input type="number" step={32} min={256} className={inputSmall} value={config.height} onChange={(e) => update("height", parseInt(e.target.value) || 512)} disabled={isGenerating} />
          </div>
        </div>
        <p className={hintText}>Snapped to multiples of 32. Stage-1 renders at half-res, then a 2× latent upscale to target.</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[9px] text-muted-foreground/70">
              {config.ltx25AutoDuration ? "Duration: Auto (model-predicted)" : "Duration"}
            </Label>
            <span className="flex items-center gap-1">
              <span className="text-[8px] text-muted-foreground/50">Auto</span>
              <Switch checked={!!config.ltx25AutoDuration} onCheckedChange={(v) => update("ltx25AutoDuration", v)} disabled={isGenerating} />
            </span>
          </div>
          {/* Seconds + Frames entry fields that stay in sync (like LTX-2.3): editing
              one recomputes the other. Frames snap to LTX's required 8n+1. */}
          <div className={`flex gap-2 ${config.ltx25AutoDuration ? "opacity-40 pointer-events-none" : ""}`}>
            <div className="flex-1">
              <input
                type="text"
                inputMode="decimal"
                value={rawSecInput}
                onChange={(e) => setRawSecInput(e.target.value)}
                onBlur={() => {
                  const secs = parseFloat(rawSecInput);
                  if (!isNaN(secs) && secs > 0) update("numFrames", snapFrames(Math.round(secs * configRef.current.frameRate)));
                  else setRawSecInput(((config.numFrames - 1) / config.frameRate).toFixed(1));
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className={inputSmall}
                disabled={isGenerating || !!config.ltx25AutoDuration}
                title="Duration in seconds (auto-snaps to a valid frame count on blur)"
              />
              <span className="text-[8px] text-muted-foreground/50">seconds</span>
            </div>
            <div className="flex-1">
              <input
                type="text"
                inputMode="numeric"
                value={rawFrameInput}
                onChange={(e) => setRawFrameInput(e.target.value)}
                onBlur={() => {
                  const raw = parseInt(rawFrameInput);
                  if (!isNaN(raw) && raw > 0) update("numFrames", snapFrames(raw));
                  else setRawFrameInput(String(config.numFrames));
                }}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className={inputSmall}
                disabled={isGenerating || !!config.ltx25AutoDuration}
                title="Exact frame count (snaps to 8n+1: 25, 33, 41…)"
              />
              <span className="text-[8px] text-muted-foreground/50">frames (8n+1) · {config.numFrames}f @ {config.frameRate}fps</span>
            </div>
          </div>
        </div>
        <div className="space-y-0.5">
          <Label className={labelMuted}>Frame Rate</Label>
          <select className={selectBase} value={config.frameRate} onChange={(e) => update("frameRate", parseInt(e.target.value))} disabled={isGenerating}>
            <option value={24}>24 fps</option>
            <option value={25}>25 fps</option>
            <option value={30}>30 fps</option>
          </select>
        </div>
      </div>

      {config.ltx25AutoDuration && (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-0.5">
              <Label className="text-[9px] text-muted-foreground/70">Auto min (s)</Label>
              <input type="number" min={0.5} max={120} step={0.5} className={inputSmall} value={config.ltx25AutoDurationMin ?? 1} onChange={(e) => update("ltx25AutoDurationMin", parseFloat(e.target.value) || 1)} disabled={isGenerating} />
            </div>
            <div className="space-y-0.5">
              <Label className="text-[9px] text-muted-foreground/70">Auto max (s)</Label>
              <input type="number" min={0.5} max={120} step={0.5} className={inputSmall} value={config.ltx25AutoDurationMax ?? 20} onChange={(e) => update("ltx25AutoDurationMax", parseFloat(e.target.value) || 20)} disabled={isGenerating} />
            </div>
          </div>
          <p className={hintText}>The model predicts clip length from your prompt (bounded by min/max), overriding the manual duration. Requires the duration-head model in <code>model_patches/</code>.</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        {config.enableAudio ? <Volume2 className="w-3.5 h-3.5 text-violet-400" /> : <VolumeX className="w-3.5 h-3.5 text-muted-foreground" />}
        <Label className="text-[9px] text-muted-foreground/70 whitespace-nowrap">Generate Audio</Label>
        <Switch checked={config.enableAudio} onCheckedChange={(v) => update("enableAudio", v)} disabled={isGenerating} />
        <span className="text-[8px] text-muted-foreground/50">Joint audio+video (native to LTX-2.5)</span>
      </div>

      <button
        onClick={() => setAdvancedExpanded(!advancedExpanded)}
        className={advancedExpanded ? advancedToggle : `${advancedToggle} ${toggleInactive}`}
      >
        {advancedExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Settings2 className="w-3 h-3" /> Advanced
      </button>

      {advancedExpanded && (
        <div className="space-y-3 pl-2 border-l border-violet-500/20">
          <div className="space-y-0.5">
            <Label className={labelMuted}>Negative Prompt</Label>
            <textarea className={`${inputSmall} min-h-[44px] resize-y`} value={config.negativePrompt} onChange={(e) => update("negativePrompt", e.target.value)} disabled={isGenerating} />
          </div>

          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            <Label className="text-[9px] text-muted-foreground/70 whitespace-nowrap">Prompt Enhancer</Label>
            <Switch checked={!!config.promptEnhance} onCheckedChange={(v) => update("promptEnhance", v)} disabled={isGenerating} />
            <span className="text-[8px] text-muted-foreground/50">Uses the Gemma4-e2b encoder (extra VRAM)</span>
          </div>

          <div className="flex items-center gap-2">
            <Label className="text-[9px] text-muted-foreground/70 whitespace-nowrap">Random Seed</Label>
            <Switch checked={config.randomSeed} onCheckedChange={(v) => update("randomSeed", v)} disabled={isGenerating} />
            {!config.randomSeed && (
              <input type="number" className={`${inputSmall} w-28`} value={config.seed} onChange={(e) => update("seed", parseInt(e.target.value) || 0)} disabled={isGenerating} />
            )}
          </div>
          <div className="space-y-2">
            <Label className={labelMuted}>Sampler &amp; Steps</Label>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-0.5">
                <Label className="text-[9px] text-muted-foreground/70">Video Steps (stage 1)</Label>
                <input type="number" min={1} max={30} className={inputSmall} value={config.ltx25BaseSteps ?? 8} onChange={(e) => update("ltx25BaseSteps", Math.max(1, parseInt(e.target.value) || 8))} disabled={isGenerating} />
              </div>
              <div className="space-y-0.5">
                <Label className="text-[9px] text-muted-foreground/70">Refine Steps (stage 2)</Label>
                <input type="number" min={1} max={20} className={inputSmall} value={config.ltx25RefineSteps ?? 3} onChange={(e) => update("ltx25RefineSteps", Math.max(1, parseInt(e.target.value) || 3))} disabled={isGenerating} />
              </div>
            </div>
            <div className="space-y-0.5">
              <Label className="text-[9px] text-muted-foreground/70">Sampler</Label>
              <select className={selectBase} value={config.ltx25Sampler || "euler_ancestral"} onChange={(e) => update("ltx25Sampler", e.target.value)} disabled={isGenerating}>
                {["euler_ancestral", "euler", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "ddim", "lcm"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <p className={hintText}>LTX-2.5 samples audio + video jointly per stage: steps apply to both. Defaults (8 / 3) use the proven distilled schedule; other values generate a linear schedule (experimental).</p>
          </div>

          <div className="space-y-2">
            <Label className={labelMuted}>Guidance (Dual CFG)</Label>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-0.5">
                <Label className="text-[9px] text-muted-foreground/70">Video CFG: {(config.ltx25VideoCfg ?? 1).toFixed(1)}</Label>
                <Slider min={1} max={10} step={0.5} value={[config.ltx25VideoCfg ?? 1]} onValueChange={([v]) => update("ltx25VideoCfg", v)} disabled={isGenerating} />
              </div>
              <div className="space-y-0.5">
                <Label className="text-[9px] text-muted-foreground/70">Audio CFG: {(config.ltx25AudioCfg ?? 1).toFixed(1)}</Label>
                <Slider min={1} max={10} step={0.5} value={[config.ltx25AudioCfg ?? 1]} onValueChange={([v]) => update("ltx25AudioCfg", v)} disabled={isGenerating} />
              </div>
            </div>
            <p className={hintText}>Distilled models expect CFG = 1. Raise only if the checkpoint supports guidance; higher values usually degrade distilled output.</p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className={labelMuted}>LoRAs (model-only)</Label>
              <button onClick={addLora} className="text-[9px] text-violet-400 hover:text-violet-300 flex items-center gap-0.5" disabled={isGenerating}>
                <Plus className="w-3 h-3" /> Add
              </button>
            </div>
            {(config.userLoras || []).length === 0 && (
              <p className={hintText}>None. LTX-2.5 is pre-distilled (no distill LoRA needed). LTX-2.3 LoRAs may not match the 2.5 transformer; mismatched keys are logged and skipped by ComfyUI.</p>
            )}
            {(config.userLoras || []).map((lora, i) => (
              <div key={i} className={`rounded-md border p-2 space-y-1.5 ${lora.enabled ? "border-violet-500/20 bg-violet-500/5" : "border-border/30 bg-muted/20 opacity-60"}`}>
                <div className="flex items-center gap-2">
                  <Switch checked={lora.enabled} onCheckedChange={(v) => updateLora(i, { enabled: v })} className="scale-75" disabled={isGenerating} />
                  <LoraSelect
                    value={lora.name}
                    options={availableLoras}
                    onChange={(name) => updateLora(i, { name })}
                    compatMode="ltx25"
                    disabled={isGenerating}
                    placeholder="Select LoRA…"
                  />
                  <button onClick={() => removeLora(i)} className="text-destructive/50 hover:text-destructive p-0.5" disabled={isGenerating}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                {lora.enabled && lora.name && (
                  <div className="flex items-center gap-2 pl-1">
                    <Label className="text-[10px] text-muted-foreground w-14 flex-shrink-0">Strength</Label>
                    <Slider min={-2} max={2} step={0.05} value={[lora.strengthModel]} onValueChange={([v]) => updateLora(i, { strengthModel: v })} className="flex-1" disabled={isGenerating} />
                    <DecimalInput
                      value={lora.strengthModel}
                      onChange={(v) => updateLora(i, { strengthModel: v })}
                      min={-2}
                      max={2}
                      decimals={2}
                      disabled={isGenerating}
                      title="model strength"
                      className="w-14 h-6 rounded border border-input bg-background px-1 text-center text-[10px] font-mono"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label className={labelMuted}>Model Files</Label>
            {([
              ["diffusionModel", "Diffusion (diffusion_models/)"],
              ["textEncoder", "Text Encoder (text_encoders/)"],
              ["videoVae", "Video VAE (vae/)"],
              ["audioVae", "Audio VAE (vae/)"],
              ["spatialUpscaler", "Latent Upscaler (latent_upscale_models/)"],
            ] as [keyof LTX2Config, string][]).map(([k, lbl]) => (
              <div key={k as string} className="space-y-0.5">
                <Label className="text-[8px] text-muted-foreground/60">{lbl}</Label>
                <input
                  className={inputSmall}
                  value={(config[k] as string) || ""}
                  onChange={(e) => update(k, e.target.value as LTX2Config[typeof k])}
                  disabled={isGenerating}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {isGenerating && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[9px] text-muted-foreground">
            <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> {stage}</span>
            {progressMax > 0 && <span>{pct}%</span>}
          </div>
          {progressMax > 0 && (
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div className={`h-full ${progressTrack} transition-all duration-300`} style={{ width: `${pct}%` }} />
            </div>
          )}
          {stepTimestamps.length >= 2 && progressMax > 0 && (
            <LTX25ETACountdown stepTimestamps={stepTimestamps} progress={progress} progressMax={progressMax} />
          )}
        </div>
      )}

      {error && (
        <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 break-words whitespace-pre-wrap">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        {isGenerating ? (
          <Button onClick={handleStop} variant="destructive" size="sm" className="flex-1">
            <Square className="w-3 h-3 mr-1" /> Stop
          </Button>
        ) : (
          <Button onClick={handleGenerate} size="sm" className="flex-1 bg-violet-600 hover:bg-violet-500 text-white" disabled={!config.prompt.trim()}>
            <Play className="w-3 h-3 mr-1" /> Generate
          </Button>
        )}
      </div>
      {!isGenerating && (
        <SendToQueueButton
          className="w-full"
          disabled={!config.prompt.trim()}
          getJob={() => ({
            workflow: buildLTX25Workflow(config, config.randomSeed || config.seed < 0 ? Math.floor(Math.random() * 2 ** 32) : config.seed) as Record<string, unknown>,
            name: "LTX-2.5",
            outputKind: "video",
          })}
        />
      )}

      {outputVideoUrl && (
        <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-violet-400 font-medium">Output{lastSeed !== null && <span className="text-muted-foreground/50 ml-1">seed {lastSeed}</span>}</span>
            <button onClick={handleDownload} className="text-muted-foreground hover:text-violet-400">
              <Download className="w-3 h-3" />
            </button>
          </div>
          <video ref={videoRef} src={outputVideoUrl} controls loop className="w-full rounded" />
        </div>
      )}
    </div>
  );
}
