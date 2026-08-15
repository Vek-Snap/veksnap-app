"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAutoplay } from "@/lib/use-autoplay";
import {
  Play,
  Square,
  Music,
  Settings2,
  RefreshCw,
  Download,
  Loader2,
  FolderOpen,
  Upload,
  X,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Disc3,
  Repeat,
  Palette,
  Link2,
  Video,
  ImageIcon,
  Wand2,
  Waves,
  Zap,
  Film,
} from "lucide-react";
import { VideoSlot } from "@/components/media/MediaPlayer";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  AceStepConfig,
  ACESTEP_DEFAULTS,
  ACESTEP_MODELS,
  ACESTEP_LANGUAGES,
  ACESTEP_KEY_SCALES,
  KEY_VIBES,
  AceStepModelVariant,
  AceStepMode,
  ComfyUIProgress,
  LoraEntry,
  LTX2Config,
  LTX2_DEFAULTS,
  LTX23_MODEL_DEFAULTS,
  LTX2_OFFICIAL_NEGATIVE,
  LTX2QualityTier,
} from "@/lib/types";
import LoraSelect from "@/components/LoraSelect";
import { inputSmall, inputBase, selectBase, labelMuted, hintText, presetBtn, progressTrack, infoFooter, uploadBtn, advancedToggle, toggleInactive } from "@/lib/theme-classes";
import { buildAceStepWorkflow, buildLTX2OfficialWorkflow } from "@/lib/workflow-builder";
import { useRegisterComfyWorkflow } from "@/components/ComfyOpenProvider";
import SendToQueueButton from "@/components/SendToQueueButton";
import {
  queuePrompt,
  getHistory,
  interruptGeneration,
  connectComfyStream,
  uploadAudio,
  uploadImage,
  getImageUrl,
} from "@/lib/comfyui-api";

interface AceStepStudioProps {
  config: AceStepConfig;
  onConfigChange: (config: AceStepConfig) => void;
}

const GENRE_PRESETS = [
  "pop, upbeat, energetic",
  "rock, electric guitar, drums, powerful",
  "hip hop, trap, bass, 808",
  "electronic, synth, edm, dance",
  "jazz, piano, smooth, saxophone",
  "classical, orchestral, strings, cinematic",
  "r&b, soul, smooth, groovy",
  "metal, heavy, distorted guitar, double bass",
  "ambient, atmospheric, ethereal, pad",
  "country, acoustic guitar, banjo, folk",
  "lo-fi, chill, relaxed, vinyl",
  "reggae, island, dub, offbeat",
];

export default function AceStepStudio({ config, onConfigChange }: AceStepStudioProps) {
  // Register this page's workflow with the global "Open in ComfyUI" button.
  useRegisterComfyWorkflow(() => ({
    workflow: buildAceStepWorkflow(config) as Record<string, unknown>,
    name: "ACE-Step Music",
  }));
  const [autoplay] = useAutoplay();
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [outputAudioUrl, setOutputAudioUrl] = useState<string | null>(null);
  const [lastOutputFilename, setLastOutputFilename] = useState<string | null>(null);
  const [sourceAudioPreview, setSourceAudioPreview] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [batchOutputs, setBatchOutputs] = useState<string[]>([]);
  const [showAudioReactive, setShowAudioReactive] = useState(false);
  const [reactiveStage, setReactiveStage] = useState("");
  const [reactiveRunning, setReactiveRunning] = useState(false);
  const [reactiveOutputUrl, setReactiveOutputUrl] = useState<string | null>(null);
  const [reactiveSourcePreview, setReactiveSourcePreview] = useState<string | null>(null);
  const reactiveImageRef = useRef<HTMLInputElement>(null);

  // Music Video (A2V) state
  const [showMusicVideo, setShowMusicVideo] = useState(false);
  const [mvRunning, setMvRunning] = useState(false);
  const [mvStage, setMvStage] = useState("");
  const [mvOutputUrl, setMvOutputUrl] = useState<string | null>(null);
  const [mvSourcePreview, setMvSourcePreview] = useState<string | null>(null);
  const [mvLivePreview, setMvLivePreview] = useState<string | null>(null);
  const mvImageRef = useRef<HTMLInputElement>(null);

  const clientIdRef = useRef(`veksnap-ace-${Date.now()}`);
  const esRef = useRef<EventSource | null>(null);
  const promptIdRef = useRef<string | null>(null);
  const lyricsRef = useRef<HTMLTextAreaElement>(null);

  const set = useCallback(
    <K extends keyof AceStepConfig>(key: K, val: AceStepConfig[K]) => {
      onConfigChange({ ...config, [key]: val });
    },
    [config, onConfigChange]
  );

  // Fetch available LoRAs on mount
  useEffect(() => {
    fetch(`/api/lora-files?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((files: string[]) => setAvailableLoras(files))
      .catch(() => {});
  }, []);

  // Reconstruct the source-audio preview from the persisted ComfyUI input/ path after a
  // tab switch unmounted/remounted this studio. Path-based only (no base64). Skip the
  // "[output]" annotated form used by Extend-from-last-output (served from output/, not input/).
  useEffect(() => {
    if (config.sourceAudioFile && !sourceAudioPreview && !config.sourceAudioFile.includes("[output]")) {
      setSourceAudioPreview(getImageUrl(config.sourceAudioFile, "", "input"));
    }
  }, [config.sourceAudioFile]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setOutputAudioUrl(null);
    setBatchOutputs([]);
    setProgress(0);
    setProgressMax(config.steps);

    const batchTotal = Math.max(1, Math.min(4, config.batchCount));

    try {
      const clientId = clientIdRef.current;
      esRef.current?.close();
      esRef.current = connectComfyStream(
        clientId,
        (msg: ComfyUIProgress) => {
          if (msg.type === "progress" && msg.data) {
            setProgress(msg.data.value ?? 0);
            setProgressMax(msg.data.max ?? config.steps);
            setStage(`Sampling step ${msg.data.value}/${msg.data.max}`);
          }
          if (msg.type === "executing" && msg.data?.node === null) {
            setStage("Finalizing...");
          }
        },
        () => {},
        () => setError("Lost connection to ComfyUI")
      );

      const collectedOutputs: string[] = [];

      for (let batchIdx = 0; batchIdx < batchTotal; batchIdx++) {
        const batchLabel = batchTotal > 1 ? ` (${batchIdx + 1}/${batchTotal})` : "";
        setStage(`Building workflow${batchLabel}...`);

        // Override seed for each batch variation (keep user seed for batch 0 if not random)
        const batchConfig = { ...config };
        if (batchIdx > 0 || config.randomSeed) {
          batchConfig.seed = Math.floor(Math.random() * 2 ** 32);
          batchConfig.randomSeed = false; // already randomized
        }

        const workflow = buildAceStepWorkflow(batchConfig);
        setStage(`Queuing${batchLabel}...`);

        const response = await queuePrompt(workflow, clientId);
        promptIdRef.current = response.prompt_id;
        setStage(`Generating${batchLabel}...`);

        // Poll for completion
        let completed = false;
        for (let i = 0; i < 600; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const hist = await getHistory(response.prompt_id);
          if (hist) {
            const outputs = hist.outputs || {};
            let newOutputFile = "";
            for (const nodeOut of Object.values(outputs)) {
              const audios = (nodeOut as Record<string, unknown[]>)?.audio;
              if (audios && audios.length > 0) {
                const audio = audios[0] as { filename: string; subfolder?: string };
                newOutputFile = audio.filename;
                const subfolder = audio.subfolder || "";
                const url = `/api/comfyui/view?filename=${encodeURIComponent(audio.filename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`;
                setOutputAudioUrl(url);
              }
            }

            // Extend mode: auto-concat source + new output
            if (config.aceMode === "extend" && config.sourceAudioFile && newOutputFile) {
              setStage(`Concatenating${batchLabel}...`);
              try {
                const concatRes = await fetch("/api/audio-concat", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ file1: config.sourceAudioFile, file2: newOutputFile }),
                });
                if (concatRes.ok) {
                  const { filename, subfolder } = await concatRes.json();
                  const concatUrl = `/api/comfyui/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`;
                  setOutputAudioUrl(concatUrl);
                  setLastOutputFilename(filename);
                  collectedOutputs.push(concatUrl);
                } else {
                  setLastOutputFilename(newOutputFile);
                  collectedOutputs.push(`/api/comfyui/view?filename=${encodeURIComponent(newOutputFile)}&subfolder=audio&type=output`);
                }
              } catch {
                setLastOutputFilename(newOutputFile);
                collectedOutputs.push(`/api/comfyui/view?filename=${encodeURIComponent(newOutputFile)}&subfolder=audio&type=output`);
              }
            } else {
              setLastOutputFilename(newOutputFile);
              if (newOutputFile) {
                collectedOutputs.push(`/api/comfyui/view?filename=${encodeURIComponent(newOutputFile)}&subfolder=audio&type=output`);
              }
            }

            completed = true;
            break;
          }
        }

        if (!completed) {
          setError(`Batch ${batchIdx + 1} timed out`);
          break;
        }
      }

      setBatchOutputs(collectedOutputs);
      setStage("Done!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
      esRef.current?.close();
    }
  }, [config]);

  const handleCancel = useCallback(async () => {
    try {
      await interruptGeneration();
    } catch { /* ignore */ }
    setGenerating(false);
    setStage("Cancelled");
    esRef.current?.close();
  }, []);

  const handleReferenceUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const name = await uploadAudio(file);
        set("referenceAudioFile", name);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      }
    },
    [set]
  );

  const handleSourceAudioUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const previewUrl = URL.createObjectURL(file);
        setSourceAudioPreview(previewUrl);
        const name = await uploadAudio(file);
        set("sourceAudioFile", name);
      } catch (err) {
        setSourceAudioPreview(null);
        setError(err instanceof Error ? err.message : "Source audio upload failed");
      }
    },
    [set]
  );

  const clearSourceAudio = useCallback(() => {
    if (sourceAudioPreview) URL.revokeObjectURL(sourceAudioPreview);
    setSourceAudioPreview(null);
    set("sourceAudioFile", "");
  }, [sourceAudioPreview, set]);

  // "Extend from last output": sets the last generated audio as the source for style reference
  // ComfyUI LoadAudio supports [output] annotation to read from output/ instead of input/
  const extendFromLastOutput = useCallback(() => {
    if (!lastOutputFilename) return;
    const annotated = `audio/${lastOutputFilename} [output]`;
    onConfigChange({ ...config, sourceAudioFile: annotated, aceMode: "extend" });
    setSourceAudioPreview(outputAudioUrl);
  }, [lastOutputFilename, outputAudioUrl, config, onConfigChange]);

  // Insert structure tag at cursor position in lyrics textarea
  const insertLyricsTag = useCallback(
    (tag: string) => {
      const ta = lyricsRef.current;
      const lyrics = config.lyrics;
      if (ta) {
        const start = ta.selectionStart ?? lyrics.length;
        const prefix = start > 0 && lyrics[start - 1] !== "\n" ? "\n" : "";
        const newLyrics = lyrics.slice(0, start) + prefix + tag + "\n" + lyrics.slice(start);
        set("lyrics", newLyrics);
        // Restore cursor after the inserted tag
        requestAnimationFrame(() => {
          const pos = start + prefix.length + tag.length + 1;
          ta.setSelectionRange(pos, pos);
          ta.focus();
        });
      } else {
        set("lyrics", lyrics + (lyrics && !lyrics.endsWith("\n") ? "\n" : "") + tag + "\n");
      }
    },
    [config.lyrics, set]
  );

  // LoRA helpers
  const addLora = useCallback(() => {
    onConfigChange({
      ...config,
      userLoras: [...config.userLoras, { enabled: true, name: "", strengthModel: 1.0, strengthClip: 1.0 }],
    });
  }, [config, onConfigChange]);

  const updateLora = useCallback(
    (index: number, patch: Partial<LoraEntry>) => {
      const updated = config.userLoras.map((l, i) => (i === index ? { ...l, ...patch } : l));
      onConfigChange({ ...config, userLoras: updated });
    },
    [config, onConfigChange]
  );

  const removeLora = useCallback(
    (index: number) => {
      onConfigChange({ ...config, userLoras: config.userLoras.filter((_, i) => i !== index) });
    },
    [config, onConfigChange]
  );

  const handleModelVariant = useCallback(
    (variant: AceStepModelVariant) => {
      const diffusionModel = ACESTEP_MODELS[variant];
      // Recommended defaults: user can override freely
      // Official ComfyUI blueprint uses shift=3.0, cfg_scale=2.0, steps=8 (turbo)
      const steps = variant === "turbo" ? 8 : variant === "sft" ? 50 : 100;
      const samplerShift = 3.0;
      const cfgScale = 2.0;
      onConfigChange({ ...config, modelVariant: variant, diffusionModel, steps, samplerShift, cfgScale });
    },
    [config, onConfigChange]
  );

  // Audio Reactive: upload source image
  const handleReactiveImageUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const preview = URL.createObjectURL(file);
        setReactiveSourcePreview(preview);
        const name = await uploadImage(file);
        set("audioReactiveSourceImage", name);
      } catch (err) {
        setReactiveSourcePreview(null);
        setError(err instanceof Error ? err.message : "Image upload failed");
      }
    },
    [set]
  );

  // Audio Reactive: full pipeline
  const runAudioReactivePipeline = useCallback(async () => {
    if (!outputAudioUrl || !lastOutputFilename) {
      setError("Generate music first before creating reactive video");
      return;
    }
    setReactiveRunning(true);
    setReactiveOutputUrl(null);
    setError(null);

    try {
      // Step 1: Analyze the generated audio
      setReactiveStage("Analyzing audio features...");
      const analyzeRes = await fetch("/api/audio-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioPath: `audio/${lastOutputFilename}`, fps: 24 }),
      });
      if (!analyzeRes.ok) {
        const err = await analyzeRes.json().catch(() => ({}));
        throw new Error(err.error || "Audio analysis failed");
      }
      const analysisData = await analyzeRes.json();

      // Step 2: Generate base video via LTX 2.3 (queue ComfyUI workflow)
      setReactiveStage("Generating base video via LTX 2.3...");
      const { buildLTX2OfficialWorkflow } = await import("@/lib/workflow-builder");
      const { LTX2_DEFAULTS } = await import("@/lib/types");

      const seed = Math.floor(Math.random() * 2 ** 32);
      const videoConfig = {
        ...LTX2_DEFAULTS,
        prompt: config.audioReactiveVideoPrompt || "abstract fractal patterns, flowing energy waves",
        negativePrompt: "text, watermark, blurry, static, still image",
        width: 512,
        height: 512,
        numFrames: Math.min(257, Math.max(49, Math.round(analysisData.duration * 24))),
        frameRate: 24,
        qualityTier: "distilled" as const,
        sourceImage: config.audioReactiveSourceImage || "",
        pipelineMode: "official" as const,
      };
      const ltxWorkflow = buildLTX2OfficialWorkflow(videoConfig, seed);
      const clientId = clientIdRef.current;

      // Connect SSE for progress
      esRef.current?.close();
      esRef.current = connectComfyStream(
        clientId,
        (msg) => {
          if (msg.type === "progress" && msg.data) {
            setProgress(msg.data.value ?? 0);
            setProgressMax(msg.data.max ?? 0);
            setReactiveStage(`LTX 2.3: Step ${msg.data.value}/${msg.data.max}`);
          }
        },
        () => {},
        () => {}
      );

      const queueRes = await queuePrompt(ltxWorkflow, clientId);
      const promptId = queueRes.prompt_id;

      // Poll for LTX completion
      let videoFile = "";
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const hist = await getHistory(promptId);
        // Check for execution error
        if (hist?.status?.status_str === "error") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const messages = (hist as any).status?.messages as unknown[][] | undefined;
          const errMsg = messages
            ?.filter((m) => m[0] === "execution_error")
            ?.map((m) => {
              const d = m[1] as Record<string, unknown>;
              return `Node ${d.node_id} (${d.node_type}): ${d.exception_message}`;
            })
            ?.join("; ");
          throw new Error(`ComfyUI execution error: ${errMsg || "Unknown error, check ComfyUI logs"}`);
        }
        if (hist?.outputs) {
          const vhsOut = hist.outputs["17"];
          if (vhsOut?.gifs?.[0]) {
            const gif = vhsOut.gifs[0] as { filename: string; subfolder?: string };
            videoFile = gif.subfolder ? `${gif.subfolder}/${gif.filename}` : gif.filename;
            break;
          }
        }
      }
      esRef.current?.close();

      if (!videoFile) {
        throw new Error("LTX video generation timed out or produced no output");
      }

      // Step 3: Apply audio-reactive effects via FFmpeg
      setReactiveStage("Applying audio-reactive effects...");
      const reactiveRes = await fetch("/api/audio-reactive-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoPath: videoFile,
          audioPath: `audio/${lastOutputFilename}`,
          analysisData,
          effects: {
            zoomIntensity: config.audioReactiveZoom,
            colorCycleSpeed: config.audioReactiveColorCycle,
            blurOnset: config.audioReactiveBlur,
            warpIntensity: config.audioReactiveWarp,
            brightnessReactive: config.audioReactiveBrightness,
          },
          fps: 24,
        }),
      });

      if (!reactiveRes.ok) {
        const err = await reactiveRes.json().catch(() => ({}));
        throw new Error(err.error || "Audio-reactive processing failed");
      }

      const { outputUrl } = await reactiveRes.json();
      setReactiveOutputUrl(outputUrl);
      setReactiveStage("Complete!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Audio reactive pipeline failed");
      setReactiveStage("Failed");
    } finally {
      setReactiveRunning(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputAudioUrl, lastOutputFilename, config]);

  // Music Video: upload source image
  const handleMvImageUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const preview = URL.createObjectURL(file);
        setMvSourcePreview(preview);
        const name = await uploadImage(file);
        set("musicVideoSourceImage", name);
      } catch (err) {
        setMvSourcePreview(null);
        setError(err instanceof Error ? err.message : "Image upload failed");
      }
    },
    [set]
  );

  // Music Video: A2V pipeline - takes finished AceStep audio → LTX 2.3 A2V
  const runMusicVideoPipeline = useCallback(async () => {
    if (!outputAudioUrl || !lastOutputFilename) {
      setError("Generate music first before creating a music video");
      return;
    }
    setMvRunning(true);
    setMvOutputUrl(null);
    setMvLivePreview(null);
    setError(null);

    try {
      // Step 1: Upload the generated audio to ComfyUI input/
      setMvStage("Uploading audio to ComfyUI...");
      const audioBlob = await fetch(outputAudioUrl).then((r) => r.blob());
      const audioFile = new File([audioBlob], `mv_audio_${Date.now()}.wav`, { type: "audio/wav" });
      const a2vAudioFile = await uploadAudio(audioFile);

      // Step 2: Build LTX 2.3 Official A2V workflow
      setMvStage("Building A2V workflow...");
      const seed = config.randomSeed ? Math.floor(Math.random() * 2 ** 32) : config.seed;

      const videoConfig: LTX2Config = {
        ...LTX2_DEFAULTS,
        // Use 2.3 model files
        diffusionModel: LTX23_MODEL_DEFAULTS.diffusionModel,
        textEncoder: LTX23_MODEL_DEFAULTS.textEncoder,
        connectorModel: LTX23_MODEL_DEFAULTS.connectorModel,
        videoVae: LTX23_MODEL_DEFAULTS.videoVae,
        audioVae: LTX23_MODEL_DEFAULTS.audioVae,
        distillLoRA: LTX23_MODEL_DEFAULTS.distillLoRA,
        // Music Video settings
        prompt: config.musicVideoPrompt,
        negativePrompt: config.musicVideoNegativePrompt || LTX2_OFFICIAL_NEGATIVE,
        width: config.musicVideoWidth,
        height: config.musicVideoHeight,
        numFrames: config.musicVideoNumFrames,
        frameRate: config.musicVideoFrameRate,
        sourceImage: config.musicVideoSourceImage,
        enableAudio: true,
        pipelineMode: "official",
        qualityTier: config.musicVideoQualityTier,
        modelVersion: "2.3",
        userLoras: config.musicVideoLoras,
        // A2V mode: freeze audio latent, generate video conditioned on it
        a2vMode: true,
        a2vAudioFile,
      };

      const workflow = buildLTX2OfficialWorkflow(videoConfig, seed);
      const clientId = clientIdRef.current;

      // Step 3: Connect SSE for progress + live preview
      esRef.current?.close();
      esRef.current = connectComfyStream(
        clientId,
        (msg) => {
          if (msg.type === "progress" && msg.data) {
            setProgress(msg.data.value ?? 0);
            setProgressMax(msg.data.max ?? 0);
            setMvStage(`A2V: Step ${msg.data.value}/${msg.data.max}`);
          }
        },
        () => {},
        () => {},
        (dataUrl) => setMvLivePreview(dataUrl)
      );

      const queueRes = await queuePrompt(workflow, clientId);
      const promptId = queueRes.prompt_id;

      // Step 4: Poll for completion
      let videoFile = "";
      for (let attempt = 0; attempt < 300; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        const hist = await getHistory(promptId);
        // Check for execution error
        if (hist?.status?.status_str === "error") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const messages = (hist as any).status?.messages as unknown[][] | undefined;
          const errMsg = messages
            ?.filter((m) => m[0] === "execution_error")
            ?.map((m) => {
              const d = m[1] as Record<string, unknown>;
              return `Node ${d.node_id} (${d.node_type}): ${d.exception_message}`;
            })
            ?.join("; ");
          throw new Error(`ComfyUI error: ${errMsg || "Unknown: check ComfyUI logs"}`);
        }
        if (hist?.outputs) {
          const vhsOut = hist.outputs["17"];
          if (vhsOut?.gifs?.[0]) {
            const gif = vhsOut.gifs[0] as { filename: string; subfolder?: string };
            videoFile = gif.subfolder ? `${gif.subfolder}/${gif.filename}` : gif.filename;
            break;
          }
        }
      }
      esRef.current?.close();

      if (!videoFile) throw new Error("Music video generation timed out");

      setMvOutputUrl(`/api/comfyui/view?filename=${encodeURIComponent(videoFile)}`);
      setMvLivePreview(null);
      setMvStage("Complete!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Music video pipeline failed");
      setMvStage("Failed");
    } finally {
      setMvRunning(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputAudioUrl, lastOutputFilename, config]);

  const progressPct = progressMax > 0 ? (progress / progressMax) * 100 : 0;

  return (
    <div className="p-3 space-y-3 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Music className="w-4 h-4 text-purple-400" />
          <h2 className="text-sm font-semibold text-purple-300">AceStep Music Studio</h2>
          <span className="text-[10px] text-purple-400/60 bg-purple-500/10 px-1.5 py-0.5 rounded">
            XL 4B {config.modelVariant === "turbo" ? "Turbo" : config.modelVariant === "sft" ? "SFT" : "Base"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {outputAudioUrl && (
            <a href={outputAudioUrl} download className="text-purple-400 hover:text-purple-300">
              <Download className="w-4 h-4" />
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => {
              try {
                const workflow = buildAceStepWorkflow(config);
                navigator.clipboard.writeText(JSON.stringify({ prompt: workflow }, null, 2));
              } catch { /* ignore */ }
            }}
          >
            Export
          </Button>
        </div>
      </div>

      {/* Model Variant Selector */}
      <div className="flex items-center gap-1">
        {(["turbo", "sft", "base"] as AceStepModelVariant[]).map((v) => (
          <button
            key={v}
            onClick={() => handleModelVariant(v)}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              config.modelVariant === v
                ? "bg-purple-500/30 text-purple-300 border border-purple-500/50"
                : "text-muted-foreground hover:text-foreground border border-border"
            }`}
          >
            {v === "turbo" ? "Turbo (fast)" : v === "sft" ? "SFT (best quality)" : "Base (balanced)"}
          </button>
        ))}
      </div>

      {/* Mode Tabs */}
      <div className="flex items-center gap-1">
        {([
          { mode: "generate" as AceStepMode, label: "Generate", icon: <Music className="w-3 h-3 mr-1" />, desc: "Create from scratch" },
          { mode: "extend" as AceStepMode, label: "Extend", icon: <Link2 className="w-3 h-3 mr-1" />, desc: "Continue a song" },
          { mode: "remix" as AceStepMode, label: "Remix", icon: <Repeat className="w-3 h-3 mr-1" />, desc: "Restyle audio" },
          { mode: "cover" as AceStepMode, label: "Cover", icon: <Palette className="w-3 h-3 mr-1" />, desc: "New genre, same vibe" },
        ]).map(({ mode, label, icon }) => (
          <button
            key={mode}
            onClick={() => set("aceMode", mode)}
            className={`flex items-center px-2 py-1 rounded text-[10px] font-medium transition-colors ${
              config.aceMode === mode
                ? "bg-purple-500/30 text-purple-300 border border-purple-500/50"
                : "text-muted-foreground hover:text-foreground border border-border"
            }`}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      {/* Mode description */}
      <p className="text-[9px] text-muted-foreground/70">
        {config.aceMode === "generate" && "Create music from scratch using tags and optional lyrics."}
        {config.aceMode === "extend" && "Continue from an existing audio: style is preserved, new section is generated and auto-concatenated."}
        {config.aceMode === "remix" && "Re-style existing audio. Lower denoise keeps more of the original; higher denoise changes more."}
        {config.aceMode === "cover" && "Generate a new version in a different genre. Upload the original, change the tags, and the timbre carries over."}
      </p>

      {/* Source Audio (for extend/remix/cover modes) */}
      {config.aceMode !== "generate" && (
        <div className="space-y-1.5 p-2 rounded border border-purple-500/20 bg-purple-500/5">
          <Label className="text-[10px] text-purple-400/80">
            {config.aceMode === "extend" ? "Continue From" : "Source Audio"}
          </Label>
          {config.sourceAudioFile ? (
            <div className="space-y-1.5">
              {sourceAudioPreview && (
                <audio controls src={sourceAudioPreview} className="w-full h-8" />
              )}
              <div className="flex items-center gap-1 text-[10px] text-purple-300">
                <Disc3 className="w-3 h-3" />
                <span className="truncate flex-1">{config.sourceAudioFile}</span>
                <button onClick={clearSourceAudio} className="hover:text-red-400">
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-purple-400 cursor-pointer bg-muted/60 border border-border rounded px-2 py-1">
                <Upload className="w-3 h-3" />
                Upload Audio
                <input type="file" accept="audio/*" className="hidden" onChange={handleSourceAudioUpload} />
              </label>
              {lastOutputFilename && config.aceMode === "extend" && (
                <button
                  onClick={extendFromLastOutput}
                  className="flex items-center gap-1 text-[10px] text-purple-400 hover:text-purple-300 bg-purple-500/10 border border-purple-500/30 rounded px-2 py-1"
                >
                  <Link2 className="w-3 h-3" />
                  Use Last Output
                </button>
              )}
            </div>
          )}

          {/* Remix/Cover denoise slider */}
          {(config.aceMode === "remix" || config.aceMode === "cover") && (
            <div className="space-y-1 pt-1">
              <div className="flex items-center justify-between">
                <Label className={labelMuted}>
                  {config.aceMode === "remix" ? "Remix Strength" : "Style Transfer"}
                </Label>
                <span className="text-[10px] text-muted-foreground/70">{config.remixDenoise.toFixed(2)}</span>
              </div>
              <Slider
                min={0.1}
                max={1.0}
                step={0.05}
                value={[config.remixDenoise]}
                onValueChange={([v]) => set("remixDenoise", v)}
                className="py-1"
              />
              <p className="text-[8px] text-muted-foreground/70">
                Low = subtle changes, preserves original &nbsp;|&nbsp; High = dramatic transformation
              </p>
            </div>
          )}
        </div>
      )}

      {/* Tags / Genre */}
      <div className="space-y-1">
        <Label className="text-[11px] text-purple-400/80">Genre Tags</Label>
        <input
          className="w-full bg-muted border border-border rounded px-2 py-1.5 text-xs text-foreground placeholder-muted-foreground/50"
          placeholder="pop, upbeat, energetic, female vocal..."
          value={config.tags}
          onChange={(e) => set("tags", e.target.value)}
        />
        <div className="flex flex-wrap gap-1 mt-1">
          {GENRE_PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => set("tags", preset)}
              className="text-[9px] text-muted-foreground hover:text-purple-400 bg-muted/60 hover:bg-purple-500/10 px-1.5 py-0.5 rounded transition-colors"
            >
              {preset.split(",")[0]}
            </button>
          ))}
        </div>
      </div>

      {/* Lyrics */}
      <div className="space-y-1">
        <Label className="text-[11px] text-purple-400/80">Lyrics (optional)</Label>
        <textarea
          ref={lyricsRef}
          className="w-full bg-muted border border-border rounded px-2 py-1.5 text-xs text-foreground placeholder-muted-foreground/50 min-h-[80px] resize-y"
          placeholder="Enter song lyrics here... Leave empty for instrumental.&#10;Use structure tags: [verse], [chorus], [bridge], [outro]..."
          value={config.lyrics}
          onChange={(e) => set("lyrics", e.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {["[intro]", "[verse]", "[chorus]", "[bridge]", "[outro]", "[instrumental]", "[hook]", "[pre-chorus]", "[rap]", "[ad-lib]"].map((tag) => (
            <button
              key={tag}
              onClick={() => insertLyricsTag(tag)}
              className="text-[9px] text-muted-foreground hover:text-purple-400 bg-muted/60 hover:bg-purple-500/10 px-1.5 py-0.5 rounded transition-colors"
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      {/* Music Parameters Grid */}
      <div className="grid grid-cols-2 gap-2">
        {/* Duration */}
        <div className="space-y-1">
          <Label className={labelMuted}>Duration (sec)</Label>
          <input
            type="number"
            min={1}
            max={600}
            value={config.duration}
            onChange={(e) => set("duration", Number(e.target.value))}
            className={inputSmall}
          />
        </div>

        {/* BPM */}
        <div className="space-y-1">
          <Label className={labelMuted}>BPM</Label>
          <input
            type="number"
            min={10}
            max={300}
            value={config.bpm}
            onChange={(e) => set("bpm", Number(e.target.value))}
            className={inputSmall}
          />
        </div>

        {/* Time Signature */}
        <div className="space-y-1">
          <Label className={labelMuted}>Time Signature</Label>
          <select
            value={config.timeSignature}
            onChange={(e) => set("timeSignature", e.target.value as "2" | "3" | "4" | "6")}
            className={inputSmall}
          >
            <option value="2">2/4</option>
            <option value="3">3/4 (Waltz)</option>
            <option value="4">4/4 (Standard)</option>
            <option value="6">6/8</option>
          </select>
        </div>

        {/* Key / Scale */}
        <div className="space-y-1">
          <Label className={labelMuted}>Key</Label>
          <select
            value={config.keyScale}
            onChange={(e) => set("keyScale", e.target.value)}
            className={inputSmall}
          >
            {ACESTEP_KEY_SCALES.map((ks) => {
              const vibe = KEY_VIBES[ks];
              return (
                <option key={ks} value={ks}>
                  {ks}{vibe ? `: ${vibe.feel} (${vibe.uses})` : ""}
                </option>
              );
            })}
          </select>
        </div>

        {/* Language */}
        <div className="space-y-1">
          <Label className={labelMuted}>Language</Label>
          <select
            value={config.language}
            onChange={(e) => set("language", e.target.value)}
            className={inputSmall}
          >
            {ACESTEP_LANGUAGES.map((l) => (
              <option key={l} value={l}>{l.toUpperCase()}</option>
            ))}
          </select>
        </div>

        {/* Steps */}
        <div className="space-y-1">
          <Label className={labelMuted}>Steps</Label>
          <input
            type="number"
            min={1}
            max={200}
            value={config.steps}
            onChange={(e) => set("steps", Math.min(200, Math.max(1, Number(e.target.value))))}
            className={inputSmall}
          />
          <p className="text-[8px] text-muted-foreground/70">
            {config.modelVariant === "turbo" ? "Turbo: 4-8 recommended" : config.modelVariant === "sft" ? "SFT: 30-50 recommended" : "Base: 50-100 recommended"}
          </p>
        </div>
      </div>

      {/* Vocal Strength (Volume) Slider */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className={labelMuted}>Vocal Strength (Volume)</Label>
          <span className="text-[10px] text-muted-foreground/70">{config.lyricsStrength.toFixed(1)}</span>
        </div>
        <Slider
          min={0}
          max={10}
          step={0.1}
          value={[config.lyricsStrength]}
          onValueChange={([v]) => set("lyricsStrength", v)}
          className="py-1"
        />
        <p className="text-[8px] text-muted-foreground/70">Higher = louder vocals relative to instrumentals. Default 1.0. Try 2–4 if vocals are buried.</p>
      </div>

      {/* LoRAs */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-purple-400/80">LoRAs</Label>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 text-[10px] px-1.5 text-purple-400 hover:bg-purple-500/10"
            onClick={addLora}
            disabled={generating}
          >
            <Plus className="w-3 h-3 mr-0.5" /> Add
          </Button>
        </div>
        {config.userLoras.length > 0 && (
          <p className="text-[9px] text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1">
            ⚠️ All current models are XL (4B). Most community LoRAs are trained for the 2B model and are <strong>incompatible</strong>.
            They will silently fail and corrupt output. Only use LoRAs specifically trained for AceStep XL.
          </p>
        )}
        {config.userLoras.length === 0 && (
          <p className="text-[9px] text-muted-foreground/70">No LoRAs. Add music style LoRAs to customize sound.</p>
        )}
        {config.userLoras.map((lora, index) => (
          <div
            key={index}
            className={`rounded border p-2 space-y-1.5 ${
              lora.enabled
                ? "border-purple-500/20 bg-purple-500/5"
                : "border-border/60 bg-muted/20 opacity-60"
            }`}
          >
            <div className="flex items-center gap-2">
              <Switch
                checked={lora.enabled}
                onCheckedChange={(v) => updateLora(index, { enabled: v })}
                className="scale-75"
                disabled={generating}
              />
              <LoraSelect
                value={lora.name}
                options={availableLoras}
                onChange={(name) => updateLora(index, { name })}
                compatMode="acestep"
                disabled={generating}
              />
              <button
                type="button"
                onClick={() => removeLora(index)}
                className="text-destructive/50 hover:text-destructive p-0.5"
                disabled={generating}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            {lora.enabled && lora.name && (
              <div className="flex items-center gap-2 pl-1">
                <Label className="text-[10px] text-muted-foreground w-14 flex-shrink-0">
                  Strength
                </Label>
                <Slider
                  min={-2}
                  max={2}
                  step={0.05}
                  value={[lora.strengthModel]}
                  onValueChange={([v]) => updateLora(index, { strengthModel: v })}
                  className="flex-1"
                  disabled={generating}
                />
                <span className="text-[10px] text-muted-foreground font-mono w-8 text-right">
                  {lora.strengthModel.toFixed(2)}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Reference Audio */}
      <div className="space-y-1">
        <Label className={labelMuted}>Reference Audio (timbre transfer)</Label>
        <div className="flex items-center gap-2">
          {config.referenceAudioFile ? (
            <div className="flex items-center gap-1 bg-purple-500/10 border border-purple-500/30 rounded px-2 py-1 text-[10px] text-purple-300">
              <Music className="w-3 h-3" />
              {config.referenceAudioFile}
              <button onClick={() => set("referenceAudioFile", "")} className="ml-1 hover:text-red-400">
                <X className="w-3 h-3" />
              </button>
            </div>
          ) : (
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-purple-400 cursor-pointer bg-muted/60 border border-border rounded px-2 py-1">
              <Upload className="w-3 h-3" />
              Upload WAV/MP3
              <input type="file" accept="audio/*" className="hidden" onChange={handleReferenceUpload} />
            </label>
          )}
        </div>
      </div>

      {/* Seed + Batch */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch
            checked={config.randomSeed}
            onCheckedChange={(v) => set("randomSeed", v)}
          />
          <Label className={labelMuted}>Random Seed</Label>
          {!config.randomSeed && (
            <input
              type="number"
              value={config.seed}
              onChange={(e) => set("seed", Number(e.target.value))}
              className="w-24 bg-muted border border-border rounded px-2 py-0.5 text-xs text-foreground"
            />
          )}
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <Label className={labelMuted}>Variations</Label>
          <div className="flex items-center gap-0.5">
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                onClick={() => set("batchCount", n)}
                className={`w-6 h-6 rounded text-[10px] font-medium transition-colors ${
                  config.batchCount === n
                    ? "bg-purple-500/30 text-purple-300 border border-purple-500/50"
                    : "text-muted-foreground hover:text-foreground border border-border"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Advanced Settings */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
      >
        {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Settings2 className="w-3 h-3" />
        Advanced Settings
      </button>

      {showAdvanced && (
        <div className="space-y-2 pl-2 border-l border-purple-500/20">
          <div className="flex items-center gap-2">
            <Switch
              checked={config.generateAudioCodes}
              onCheckedChange={(v) => set("generateAudioCodes", v)}
            />
            <Label className={labelMuted}>Generate Audio Codes (LLM planning, slower but better quality)</Label>
          </div>

          <p className="text-[8px] text-muted-foreground/70 leading-relaxed">
            <strong>CFG</strong>: How closely to follow your tags (higher = more literal, lower = more creative).
            <strong>Shift</strong>: Noise schedule bias (leave at default unless experimenting).
            <strong>Temp</strong>: Randomness of LM token choices (higher = wilder, lower = safer).
            <strong>Top P</strong>: Nucleus sampling cutoff (0.95 = diverse, 0.7 = focused).
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className={labelMuted}>CFG Scale</Label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.1}
                value={config.cfgScale}
                onChange={(e) => set("cfgScale", Number(e.target.value))}
                className={inputSmall}
              />
            </div>
            <div className="space-y-1">
              <Label className={labelMuted}>Sampler Shift</Label>
              <input
                type="number"
                min={0}
                max={10}
                step={0.01}
                value={config.samplerShift}
                onChange={(e) => set("samplerShift", Number(e.target.value))}
                className={inputSmall}
              />
            </div>
            <div className="space-y-1">
              <Label className={labelMuted}>Temperature</Label>
              <input
                type="number"
                min={0}
                max={2}
                step={0.01}
                value={config.temperature}
                onChange={(e) => set("temperature", Number(e.target.value))}
                className={inputSmall}
              />
            </div>
            <div className="space-y-1">
              <Label className={labelMuted}>Top P</Label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={config.topP}
                onChange={(e) => set("topP", Number(e.target.value))}
                className={inputSmall}
              />
            </div>
            <div className="space-y-1">
              <Label className={labelMuted}>Top K</Label>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={config.topK}
                onChange={(e) => set("topK", Number(e.target.value))}
                className={inputSmall}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Audio Reactive Video ── */}
      <div className="rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/5">
        <button
          onClick={() => setShowAudioReactive(!showAudioReactive)}
          className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-fuchsia-500/10 transition-colors"
        >
          {showAudioReactive ? <ChevronDown className="w-3 h-3 text-fuchsia-400" /> : <ChevronRight className="w-3 h-3 text-fuchsia-400" />}
          <Zap className="w-3.5 h-3.5 text-fuchsia-400" />
          <span className="text-[11px] font-medium text-fuchsia-300">Audio Reactive Video</span>
          {config.audioReactiveEnabled && (
            <span className="text-[8px] bg-fuchsia-500/30 text-fuchsia-300 px-1.5 py-0.5 rounded ml-auto">ON</span>
          )}
        </button>

        {showAudioReactive && (
          <div className="px-3 pb-3 space-y-2.5 border-t border-fuchsia-500/20">
            {/* Enable toggle */}
            <div className="flex items-center justify-between pt-2">
              <Label className="text-[10px] text-fuchsia-400/80">Enable after music generation</Label>
              <Switch
                checked={config.audioReactiveEnabled}
                onCheckedChange={(v) => set("audioReactiveEnabled", v)}
              />
            </div>

            {config.audioReactiveEnabled && (
              <>
                <p className="text-[9px] text-muted-foreground/60 leading-relaxed">
                  Generates a base video with LTX 2.3, analyzes your music, then applies
                  per-frame visual effects (zoom, color, blur, warp) synchronized to audio features.
                </p>

                {/* Source Image (optional I2V) */}
                <div className="space-y-1">
                  <Label className="text-[10px] text-fuchsia-400/70 flex items-center gap-1">
                    <ImageIcon className="w-3 h-3" /> Source Image (optional I2V)
                  </Label>
                  <input
                    ref={reactiveImageRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleReactiveImageUpload}
                  />
                  {reactiveSourcePreview ? (
                    <div className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={reactiveSourcePreview} alt="Source" className="w-full h-20 object-cover rounded border border-fuchsia-500/20" />
                      <button
                        onClick={() => { setReactiveSourcePreview(null); set("audioReactiveSourceImage", ""); }}
                        className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white/80 hover:text-white"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => reactiveImageRef.current?.click()}
                      className="w-full h-14 rounded border border-dashed border-fuchsia-500/30 text-[9px] text-fuchsia-400/60 hover:bg-fuchsia-500/5 flex items-center justify-center gap-1"
                    >
                      <Upload className="w-3 h-3" /> Upload image or leave empty for T2V
                    </button>
                  )}
                </div>

                {/* Video Prompt */}
                <div className="space-y-1">
                  <Label className="text-[10px] text-fuchsia-400/70 flex items-center gap-1">
                    <Video className="w-3 h-3" /> Video Prompt
                  </Label>
                  <textarea
                    value={config.audioReactiveVideoPrompt}
                    onChange={(e) => set("audioReactiveVideoPrompt", e.target.value)}
                    rows={2}
                    className="w-full bg-muted border border-fuchsia-500/20 rounded px-2 py-1 text-[10px] text-foreground resize-none focus:border-fuchsia-500/50 focus:outline-none placeholder:text-muted-foreground/30"
                    placeholder="Describe the base video visuals..."
                  />
                  <div className="flex flex-wrap gap-1">
                    {["abstract fractal patterns, cosmic energy", "underwater bioluminescence, flowing creatures", "neon city lights, rain reflections", "fire and smoke, ember particles"].map((p) => (
                      <button
                        key={p}
                        onClick={() => set("audioReactiveVideoPrompt", p)}
                        className="text-[8px] px-1.5 py-0.5 rounded bg-fuchsia-500/10 text-fuchsia-400/70 hover:bg-fuchsia-500/20 transition-colors"
                      >
                        {p.split(",")[0]}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Effect Sliders */}
                <div className="space-y-2">
                  <Label className="text-[10px] text-fuchsia-400/70 flex items-center gap-1">
                    <Waves className="w-3 h-3" /> Effect Intensities
                  </Label>
                  {([
                    ["audioReactiveZoom", "Beat Zoom", "Zoom on beats/amplitude peaks"],
                    ["audioReactiveColorCycle", "Color Cycle", "Hue rotation from spectral centroid"],
                    ["audioReactiveBlur", "Onset Blur", "Radial blur on onset peaks"],
                    ["audioReactiveWarp", "Warp", "Barrel distortion on amplitude"],
                    ["audioReactiveBrightness", "Brightness", "Brightness modulation on amplitude"],
                  ] as const).map(([key, label, tooltip]) => (
                    <div key={key} className="space-y-0.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-[9px] text-muted-foreground" title={tooltip}>{label}</Label>
                        <span className="text-[9px] text-fuchsia-400/60">{(config[key] as number).toFixed(2)}</span>
                      </div>
                      <Slider
                        value={[config[key] as number]}
                        onValueChange={([v]) => set(key, v)}
                        min={0} max={1} step={0.05}
                        disabled={reactiveRunning}
                      />
                    </div>
                  ))}
                </div>

                {/* Generate Reactive Video Button */}
                <Button
                  size="sm"
                  className="w-full h-8 bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-[10px]"
                  onClick={runAudioReactivePipeline}
                  disabled={!outputAudioUrl || generating || reactiveRunning}
                >
                  {reactiveRunning ? (
                    <>
                      <Wand2 className="w-3 h-3 mr-1 animate-spin" />
                      {reactiveStage}
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-3 h-3 mr-1" />
                      {outputAudioUrl ? "Generate Reactive Video" : "Generate music first"}
                    </>
                  )}
                </Button>

                {/* Reactive Video Output */}
                {reactiveOutputUrl && (
                  <div className="space-y-1.5">
                    <Label className="text-[10px] text-fuchsia-400/80">Audio Reactive Output</Label>
                    <VideoSlot
                      id="acestep-reactive-output"
                      src={reactiveOutputUrl}
                      className="w-full rounded border border-fuchsia-500/20"
                      style={{ width: "100%" }}
                      autoOpen={autoplay}
                      loop
                    />
                    <button
                      onClick={() => {
                        const a = document.createElement("a");
                        a.href = reactiveOutputUrl;
                        a.download = `reactive_${Date.now()}.mp4`;
                        a.click();
                      }}
                      className="flex items-center justify-center gap-1 w-full h-6 rounded border border-fuchsia-500/30 text-[9px] text-fuchsia-400 hover:bg-fuchsia-500/10 transition-colors"
                    >
                      <Download className="w-3 h-3" /> Download Video
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Music Video (LTX 2.3 A2V) ── */}
      <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5">
        <button
          onClick={() => setShowMusicVideo(!showMusicVideo)}
          className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-cyan-500/10 transition-colors"
        >
          {showMusicVideo ? <ChevronDown className="w-3 h-3 text-cyan-400" /> : <ChevronRight className="w-3 h-3 text-cyan-400" />}
          <Film className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-[11px] font-medium text-cyan-300">Music Video (A2V)</span>
          <span className="text-[9px] text-cyan-500/60 ml-auto">LTX 2.3 Audio-to-Video</span>
        </button>

        {showMusicVideo && (
          <div className="px-3 pb-3 space-y-2 border-t border-cyan-500/20">
            <p className="text-[9px] text-cyan-600 pt-2">
              Generates video conditioned on your music. The model &quot;hears&quot; the audio and generates matching visuals.
              Generate music first, then click Generate Music Video.
            </p>

            {/* Video Prompt */}
            <div className="space-y-1">
              <Label className="text-[10px] text-cyan-500">Video Prompt</Label>
              <textarea
                value={config.musicVideoPrompt}
                onChange={(e) => set("musicVideoPrompt", e.target.value)}
                rows={2}
                placeholder="Describe the music video visuals..."
                className="w-full bg-muted border border-cyan-500/20 rounded px-2 py-1.5 text-xs text-foreground resize-none placeholder:text-muted-foreground/70"
              />
              <div className="flex flex-wrap gap-1">
                {["singer on stage, concert lights", "band performing, crowd, cinematic", "abstract visuals, flowing colors, psychedelic", "anime music video, stylized, vibrant"].map((p) => (
                  <button
                    key={p}
                    onClick={() => set("musicVideoPrompt", p)}
                    className="text-[8px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400/70 hover:text-cyan-300 hover:bg-cyan-500/20 transition-colors truncate max-w-[150px]"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Negative Prompt */}
            <div className="space-y-1">
              <Label className={labelMuted}>Negative Prompt</Label>
              <input
                type="text"
                value={config.musicVideoNegativePrompt}
                onChange={(e) => set("musicVideoNegativePrompt", e.target.value)}
                className="w-full bg-muted border border-border rounded px-2 py-1 text-[10px] text-muted-foreground"
              />
            </div>

            {/* Resolution + Frames */}
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className={labelMuted}>Width</Label>
                <input
                  type="number"
                  value={config.musicVideoWidth}
                  onChange={(e) => {
                    const v = Math.max(64, Math.min(2048, Math.round((Number(e.target.value) || 512) / 32) * 32));
                    set("musicVideoWidth", v);
                  }}
                  min={64} max={2048} step={32}
                  className="w-full bg-muted border border-border rounded px-1.5 py-1 text-xs text-foreground text-center font-mono focus:outline-none focus:border-cyan-500/50"
                />
              </div>
              <div className="space-y-1">
                <Label className={labelMuted}>Height</Label>
                <input
                  type="number"
                  value={config.musicVideoHeight}
                  onChange={(e) => {
                    const v = Math.max(64, Math.min(2048, Math.round((Number(e.target.value) || 512) / 32) * 32));
                    set("musicVideoHeight", v);
                  }}
                  min={64} max={2048} step={32}
                  className="w-full bg-muted border border-border rounded px-1.5 py-1 text-xs text-foreground text-center font-mono focus:outline-none focus:border-cyan-500/50"
                />
              </div>
              <div className="space-y-1">
                <Label className={labelMuted}>Frames</Label>
                <input
                  type="number"
                  value={config.musicVideoNumFrames}
                  onChange={(e) => set("musicVideoNumFrames", Math.max(9, Math.min(257, Number(e.target.value) || 49)))}
                  min={9} max={257} step={1}
                  className="w-full bg-muted border border-border rounded px-1.5 py-1 text-xs text-foreground text-center font-mono focus:outline-none focus:border-cyan-500/50"
                />
              </div>
            </div>
            <div className="flex justify-between text-[8px] text-muted-foreground/70">
              <span>mult. of 32</span>
              <span>~{(config.musicVideoNumFrames / config.musicVideoFrameRate).toFixed(1)}s @ {config.musicVideoFrameRate}fps</span>
            </div>
            {/* Quick resolution presets */}
            <div className="flex flex-wrap gap-1">
              {[
                { label: "512×512", w: 512, h: 512 },
                { label: "768×512", w: 768, h: 512 },
                { label: "512×768", w: 512, h: 768 },
                { label: "1024×576", w: 1024, h: 576 },
                { label: "576×1024", w: 576, h: 1024 },
                { label: "1280×704", w: 1280, h: 704 },
              ].map((p) => (
                <button
                  key={p.label}
                  onClick={() => { set("musicVideoWidth", p.w); set("musicVideoHeight", p.h); }}
                  className={`text-[8px] px-1.5 py-0.5 rounded border transition-colors ${
                    config.musicVideoWidth === p.w && config.musicVideoHeight === p.h
                      ? "border-cyan-500/50 bg-cyan-500/20 text-cyan-300"
                      : "border-border/60 text-muted-foreground hover:text-cyan-400 hover:border-cyan-500/30"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Quality Tier */}
            <div className="flex items-center gap-2">
              <Label className={labelMuted}>Quality</Label>
              <div className="flex gap-1">
                {(["distilled", "full"] as LTX2QualityTier[]).map((tier) => (
                  <button
                    key={tier}
                    onClick={() => set("musicVideoQualityTier", tier)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                      config.musicVideoQualityTier === tier
                        ? "bg-cyan-500/30 text-cyan-300 border border-cyan-500/50"
                        : "text-muted-foreground hover:text-foreground border border-border"
                    }`}
                  >
                    {tier === "distilled" ? "Fast (8 steps)" : "Full (15 steps)"}
                  </button>
                ))}
              </div>
            </div>

            {/* Source Image (I2V) */}
            <div className="space-y-1">
              <Label className={labelMuted}>Source Image (optional I2V)</Label>
              <div className="flex items-center gap-2">
                {config.musicVideoSourceImage ? (
                  <div className="flex items-center gap-2">
                    {mvSourcePreview && (
                      <img src={mvSourcePreview} alt="I2V" className="w-12 h-12 rounded border border-cyan-500/30 object-cover" />
                    )}
                    <div className="flex items-center gap-1 text-[10px] text-cyan-400">
                      <ImageIcon className="w-3 h-3" />
                      {config.musicVideoSourceImage}
                      <button
                        onClick={() => { set("musicVideoSourceImage", ""); setMvSourcePreview(null); }}
                        className="ml-1 hover:text-red-400"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <label className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-cyan-400 cursor-pointer bg-muted/60 border border-border rounded px-2 py-1">
                    <Upload className="w-3 h-3" />
                    Upload Image
                    <input ref={mvImageRef} type="file" accept="image/*" className="hidden" onChange={handleMvImageUpload} />
                  </label>
                )}
              </div>
            </div>

            {/* Video LoRAs */}
            <div className="space-y-1">
              <Label className={labelMuted}>Video LoRAs</Label>
              {config.musicVideoLoras.map((lora, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <span className="text-[9px] text-cyan-400 truncate flex-1">{lora.name}</span>
                  <input
                    type="range"
                    min={0} max={2} step={0.05}
                    value={lora.strengthModel}
                    onChange={(e) => {
                      const updated = [...config.musicVideoLoras];
                      updated[idx] = { ...lora, strengthModel: Number(e.target.value), strengthClip: Number(e.target.value) };
                      set("musicVideoLoras", updated);
                    }}
                    className="w-16 h-1 accent-cyan-500"
                  />
                  <span className="text-[9px] text-muted-foreground w-7 text-right">{lora.strengthModel.toFixed(2)}</span>
                  <button onClick={() => set("musicVideoLoras", config.musicVideoLoras.filter((_, i) => i !== idx))} className="text-muted-foreground/70 hover:text-red-400">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <LoraSelect
                value=""
                options={availableLoras}
                onChange={(name: string) => set("musicVideoLoras", [...config.musicVideoLoras, { enabled: true, name, strengthModel: 1.0, strengthClip: 1.0 }])}
                placeholder="Add video LoRA..."
              />
            </div>

            {/* Music Video Progress */}
            {mvRunning && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-cyan-400">{mvStage}</span>
                  <span className="text-muted-foreground/70">{progress}/{progressMax}</span>
                </div>
                <div className={progressTrack}>
                  <div
                    className="h-full bg-gradient-to-r from-cyan-500 to-teal-500 transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Live Preview */}
            {mvLivePreview && (
              <div className="space-y-1">
                <Label className="text-[10px] text-cyan-400/80">Live Preview</Label>
                <img
                  src={mvLivePreview}
                  alt="Live preview"
                  className="w-full rounded border border-cyan-500/20"
                  style={{ maxHeight: "35vh", objectFit: "contain" }}
                />
              </div>
            )}

            {/* Generate Button */}
            <Button
              onClick={runMusicVideoPipeline}
              disabled={mvRunning || !outputAudioUrl}
              size="sm"
              className="w-full h-8 bg-cyan-600 hover:bg-cyan-700 text-white text-xs disabled:opacity-40"
            >
              {mvRunning ? (
                <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Generating A2V...</>
              ) : (
                <><Film className="w-3 h-3 mr-1" /> Generate Music Video</>
              )}
            </Button>

            {/* Music Video Output */}
            {mvOutputUrl && (
              <div className="space-y-1.5">
                <Label className="text-[10px] text-cyan-400/80">Music Video Output</Label>
                <VideoSlot
                  id="acestep-mv-output"
                  src={mvOutputUrl}
                  className="w-full rounded border border-cyan-500/20"
                  style={{ width: "100%" }}
                  autoOpen={autoplay}
                  loop
                />
                <button
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = mvOutputUrl;
                    a.download = `music_video_${Date.now()}.mp4`;
                    a.click();
                  }}
                  className="flex items-center justify-center gap-1 w-full h-6 rounded border border-cyan-500/30 text-[9px] text-cyan-400 hover:bg-cyan-500/10 transition-colors"
                >
                  <Download className="w-3 h-3" /> Download Music Video
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Progress Bar */}
      {generating && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-purple-400">{stage}</span>
            <span className="text-muted-foreground/70">{progress}/{progressMax}</span>
          </div>
          <div className={progressTrack}>
            <div
              className="h-full bg-gradient-to-r from-purple-500 to-fuchsia-500 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1">
          {error}
        </div>
      )}

      {/* Audio Output */}
      {batchOutputs.length > 1 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-[10px] text-purple-400/80">{batchOutputs.length} Variations</Label>
            {lastOutputFilename && !generating && (
              <button
                onClick={extendFromLastOutput}
                className="flex items-center gap-1 text-[9px] text-purple-400 hover:text-purple-300 transition-colors"
              >
                <Link2 className="w-3 h-3" />
                Extend Last
              </button>
            )}
          </div>
          {batchOutputs.map((url, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[9px] text-muted-foreground w-3">{i + 1}</span>
              <audio controls src={url} className="flex-1 h-8" />
              <a href={url} download className="text-purple-400/60 hover:text-purple-300">
                <Download className="w-3 h-3" />
              </a>
            </div>
          ))}
        </div>
      ) : outputAudioUrl ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[10px] text-purple-400/80">Generated Audio</Label>
            <div className="flex items-center gap-2">
              {lastOutputFilename && !generating && (
                <button
                  onClick={extendFromLastOutput}
                  className="flex items-center gap-1 text-[9px] text-purple-400 hover:text-purple-300 transition-colors"
                >
                  <Link2 className="w-3 h-3" />
                  Extend From This
                </button>
              )}
              <a href={outputAudioUrl} download className="text-purple-400 hover:text-purple-300">
                <Download className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
          <audio controls src={outputAudioUrl} className="w-full h-8" />
        </div>
      ) : null}

      {/* Generate / Cancel Buttons */}
      <div className="flex items-center gap-2 pt-1">
        {generating ? (
          <Button
            onClick={handleCancel}
            variant="destructive"
            size="sm"
            className="flex-1 h-9"
          >
            <Square className="w-3.5 h-3.5 mr-1.5" />
            Cancel
          </Button>
        ) : (
          <Button
            onClick={handleGenerate}
            size="sm"
            className="flex-1 h-9 bg-purple-600 hover:bg-purple-700 text-white"
          >
            <Play className="w-3.5 h-3.5 mr-1.5" />
            {config.aceMode === "generate" ? "Generate Music" : config.aceMode === "extend" ? "Extend Song" : config.aceMode === "remix" ? "Remix Audio" : "Create Cover"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-9 text-xs text-muted-foreground"
          onClick={() => onConfigChange({ ...ACESTEP_DEFAULTS })}
        >
          <RefreshCw className="w-3 h-3 mr-1" />
          Reset
        </Button>
      </div>
      {!generating && (
        <SendToQueueButton className="w-full mt-2" getJob={() => ({ workflow: buildAceStepWorkflow(config) as Record<string, unknown>, name: "ACE-Step Music", outputKind: "audio" })} />
      )}

      {/* Model Info */}
      <div className={infoFooter}>
        <p>Model: {config.diffusionModel}</p>
        <p>Text Encoders: {config.textEncoderSmall} + {config.textEncoderLarge}</p>
        <p>VAE: {config.vae}</p>
        <p className="text-muted-foreground/50">VRAM: ~9 GB weights + ~3 GB working = ~12 GB minimum</p>
      </div>
    </div>
  );
}
