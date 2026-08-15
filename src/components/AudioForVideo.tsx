"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";
import {
  Upload,
  Play,
  Square,
  Download,
  Film,
  Volume2,
  Loader2,
  CheckCircle2,
  XCircle,
  X,
  Settings2,
  ChevronDown,
  ChevronRight,
  Info,
  AudioLines,
  Mic,
  Wand2,
  Eye,
  Plus,
  Trash2,
  RotateCcw,
} from "lucide-react";
import { VideoSlot } from "@/components/media/MediaPlayer";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  LTX2Config,
  LTX2_DEFAULTS,
  LTX2_RESOLUTION_PRESETS,
  ComfyUIProgress,
  DirectorConfig,
  FOLEY_PROMPT_PRESETS,
  FOLEY_SAMPLERS,
  GenerationParams,
  DEFAULT_PARAMS,
  getLTX2ModelDefaults,
  LoraEntry,
} from "@/lib/types";
import { buildLTX2Workflow, buildLTX2OfficialWorkflow, buildFoleyAudioWorkflow } from "@/lib/workflow-builder";
import AudioTrimmer from "@/components/AudioTrimmer";
import LoraSelect from "@/components/LoraSelect";
import {
  queuePrompt,
  getHistory,
  getImageUrl,
  connectComfyStream,
  checkConnection,
  uploadAudio,
} from "@/lib/comfyui-api";
import { ensureVramForStage } from "@/lib/vram-guard";

type AudioEngine = "ltx2" | "foley";
type V2APhase = "idle" | "analyzing" | "generating" | "extracting" | "merging" | "previewing" | "complete" | "error";

interface VideoMeta {
  fps: number;
  frameCount: number;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  firstFrameFile: string;
  videoPath: string;
}

interface AudioSegment {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  frameFile: string | null;      // ComfyUI input/ filename for first frame
  prompt: string;                // per-segment audio prompt (editable)
  status: "idle" | "describing" | "generating" | "done" | "error";
}

interface AudioForVideoProps {
  directorConfig: DirectorConfig;
}

export default function AudioForVideo({ directorConfig }: AudioForVideoProps) {
  // Video state
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);

  // Engine & settings
  const [engine, setEngine] = useState<AudioEngine>("ltx2");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("silence, noise, static, hum");

  // LTX-2 settings (inherit from Director config)
  const [ltx2AudioNorm, setLtx2AudioNorm] = useState(directorConfig.audioNormFactors || LTX2_DEFAULTS.audioNormFactors);
  const [ltx2VideoNorm, setLtx2VideoNorm] = useState(directorConfig.videoNormFactors || LTX2_DEFAULTS.videoNormFactors);

  // Segment-based workflow (LTX-2)
  const [segments, setSegments] = useState<AudioSegment[]>([]);
  const [describingAll, setDescribingAll] = useState(false);

  // Foley settings
  const [foleySteps, setFoleySteps] = useState(75);
  const [foleyCfg, setFoleyCfg] = useState(5.5);
  const [foleySampler, setFoleySampler] = useState("euler");

  // Merge settings
  const [mergeMode, setMergeMode] = useState<"replace" | "mix">("replace");
  const [mixVolume, setMixVolume] = useState(0.8);

  // Audio overlap / voice reference
  const [overlapDuration, setOverlapDuration] = useState(0); // 0 = disabled
  const [voiceRefFile, setVoiceRefFile] = useState<File | null>(null);
  const [voiceRefFilename, setVoiceRefFilename] = useState<string | null>(null);
  const [voiceRefObjectUrl, setVoiceRefObjectUrl] = useState<string | null>(null);
  const [voiceRefTrimStart, setVoiceRefTrimStart] = useState(0);
  const [voiceRefTrimEnd, setVoiceRefTrimEnd] = useState(0);

  // V2A Fast Mode: encode source video into video latent (frozen), generate audio only
  const [v2aFastMode, setV2aFastMode] = useState(false);

  // Pipeline state
  const [phase, setPhase] = useState<V2APhase>("idle");
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [stageLabel, setStageLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resultBlobUrl, setResultBlobUrl] = useState<string | null>(null);
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null);

  // Audio preview state (post-generation, pre-merge)
  const [rawAudioBlobUrl, setRawAudioBlobUrl] = useState<string | null>(null);
  const [rawAudioPath, setRawAudioPath] = useState<string | null>(null);
  const [denoisedAudioBlobUrl, setDenoisedAudioBlobUrl] = useState<string | null>(null);
  const [denoisedAudioPath, setDenoisedAudioPath] = useState<string | null>(null);
  const [denoising, setDenoising] = useState(false);
  const [donorUrlsRef, setDonorUrlsRef] = useState<string[]>([]);

  // Denoise filter parameters (configurable)
  const [dnHighpass, setDnHighpass] = useState(80);
  const [dnNoiseReduction, setDnNoiseReduction] = useState(30);
  const [dnNoiseFloor, setDnNoiseFloor] = useState(-30);
  const [dnTrackNoise, setDnTrackNoise] = useState(1);
  const [dnLowpass, setDnLowpass] = useState(14000);

  // LoRA state (local override: allows picking LoRAs without switching tabs)
  const [userLoras, setUserLoras] = useState<LoraEntry[]>(directorConfig.userLoras || []);
  const [availableLoras, setAvailableLoras] = useState<string[]>([]);
  const [lorasExpanded, setLorasExpanded] = useState(false);

  // UI state
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [comfyConnected, setComfyConnected] = useState<boolean | null>(null);
  const [audioAnalyzing, setAudioAnalyzing] = useState(false);
  const [audioAnalysis, setAudioAnalysis] = useState<{ summary: string; directives: string[] } | null>(null);

  // Refs
  const esRef = useRef<EventSource | null>(null);
  const promptIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const clientIdRef = useRef<string>(
    `v2a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  );

  useEffect(() => {
    checkConnection().then(setComfyConnected);
    fetch(`/api/lora-files?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: string[]) => setAvailableLoras(list))
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      esRef.current?.close();
      if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
      if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
      if (voiceRefObjectUrl) URL.revokeObjectURL(voiceRefObjectUrl);
      if (rawAudioBlobUrl) URL.revokeObjectURL(rawAudioBlobUrl);
      if (denoisedAudioBlobUrl) URL.revokeObjectURL(denoisedAudioBlobUrl);
    };
  }, []);

  // ── Video Upload ──
  const handleVideoUpload = useCallback(async (file: File) => {
    // Clean up previous
    if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
    setResultBlobUrl(null);
    setError(null);
    setPhase("analyzing");
    setStageLabel("Analyzing video...");

    const previewUrl = URL.createObjectURL(file);
    setVideoFile(file);
    setVideoPreviewUrl(previewUrl);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const resp = await fetch("/api/director/analyze-video", {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Analysis failed" }));
        throw new Error(err.error);
      }

      const meta: VideoMeta = await resp.json();
      setVideoMeta(meta);

      // Calculate LTX-2 chunks and create editable segments
      const genFps = 24;
      const maxFramesPerChunk = 257;
      const maxChunkDuration = maxFramesPerChunk / genFps;
      const numChunks = Math.max(1, Math.ceil(meta.duration / maxChunkDuration));

      const newSegments: AudioSegment[] = [];
      for (let i = 0; i < numChunks; i++) {
        const startTime = i * maxChunkDuration;
        const endTime = Math.min((i + 1) * maxChunkDuration, meta.duration);
        newSegments.push({
          index: i,
          startTime,
          endTime,
          duration: endTime - startTime,
          frameFile: i === 0 ? meta.firstFrameFile : null,
          prompt: "",
          status: "idle",
        });
      }

      // Extract first frame for each segment beyond the first
      if (numChunks > 1) {
        setStageLabel("Extracting segment frames...");
        for (let i = 1; i < newSegments.length; i++) {
          try {
            const frameResp = await fetch("/api/director/extract-frame-at", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ videoPath: meta.videoPath, timestamp: newSegments[i].startTime }),
            });
            if (frameResp.ok) {
              const data = await frameResp.json();
              newSegments[i].frameFile = data.frameFile;
            }
          } catch { /* frame extraction non-fatal */ }
        }
      }

      setSegments(newSegments);
      setPhase("idle");
      setStageLabel("");
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Video analysis failed");
      setVideoMeta(null);
      setSegments([]);
    }
  }, [videoPreviewUrl, resultBlobUrl]);

  // ── Voice Reference Upload ──
  const handleVoiceRefUpload = useCallback(async (file: File) => {
    try {
      const uploadedName = await uploadAudio(file);
      setVoiceRefFile(file);
      setVoiceRefFilename(uploadedName);
      // Create object URL for waveform/playback
      if (voiceRefObjectUrl) URL.revokeObjectURL(voiceRefObjectUrl);
      setVoiceRefObjectUrl(URL.createObjectURL(file));
      setVoiceRefTrimStart(0);
      setVoiceRefTrimEnd(0); // AudioTrimmer will auto-set on decode
    } catch (err) {
      setError(err instanceof Error ? err.message : "Voice ref upload failed");
    }
  }, [voiceRefObjectUrl]);

  const clearVoiceRef = useCallback(() => {
    if (voiceRefObjectUrl) URL.revokeObjectURL(voiceRefObjectUrl);
    setVoiceRefFile(null);
    setVoiceRefFilename(null);
    setVoiceRefObjectUrl(null);
    setVoiceRefTrimStart(0);
    setVoiceRefTrimEnd(0);
  }, [voiceRefObjectUrl]);

  const clearVideo = useCallback(() => {
    if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
    if (rawAudioBlobUrl) URL.revokeObjectURL(rawAudioBlobUrl);
    if (denoisedAudioBlobUrl) URL.revokeObjectURL(denoisedAudioBlobUrl);
    setVideoFile(null);
    setVideoPreviewUrl(null);
    setVideoMeta(null);
    setSegments([]);
    setResultBlobUrl(null);
    setRawAudioBlobUrl(null);
    setRawAudioPath(null);
    setDenoisedAudioBlobUrl(null);
    setDenoisedAudioPath(null);
    setDonorUrlsRef([]);
    setPhase("idle");
    setError(null);
  }, [videoPreviewUrl, resultBlobUrl, rawAudioBlobUrl, denoisedAudioBlobUrl]);

  // ── Batch Auto-Describe All Segments (single model load) ──
  const handleAutoDescribeAll = useCallback(async () => {
    if (!videoMeta || segments.length === 0 || describingAll) return;

    setDescribingAll(true);
    setError(null);

    // Mark all segments as "describing"
    setSegments(prev => prev.map(s => ({ ...s, status: "describing" })));

    try {
      // Build batch items: use each segment's first frame
      const items = segments.map(seg => ({
        imagePath: seg.frameFile || videoMeta.firstFrameFile,
        prompt:
          "Describe the sounds and audio that would naturally be heard in this scene. " +
          "Focus on: environment sounds (wind, water, traffic, nature), " +
          "visible sound sources (speakers, instruments, machines, animals, people talking or singing), " +
          "the acoustic space (indoor/outdoor, echo, reverb), " +
          "and the overall audio mood. " +
          "Write 2-3 concise sentences as a plain audio description. Do not describe visuals.",
      }));

      const resp = await fetch("/api/vision-describe-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, maxTokens: 120 }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Batch describe failed" }));
        throw new Error(err.error);
      }

      const data = await resp.json();
      const results: { description?: string; error?: string }[] = data.results || [];

      // Fill segment prompts with descriptions
      setSegments(prev => prev.map((seg, i) => {
        const result = results[i];
        if (result?.description) {
          // Combine with existing user prompt if present
          const existing = seg.prompt.trim();
          const newPrompt = existing
            ? `${existing} ${result.description}`
            : result.description;
          return { ...seg, prompt: newPrompt, status: "idle" };
        }
        return { ...seg, status: result?.error ? "error" : "idle" };
      }));

    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto-describe failed");
      setSegments(prev => prev.map(s => ({ ...s, status: "idle" })));
    } finally {
      setDescribingAll(false);
    }
  }, [videoMeta, segments, describingAll]);

  // ── LTX-2 V2A Pipeline (chunked for long videos) ──

  // Helper: fetch the output URL from a completed LTX-2 workflow
  const fetchLTX2Result = async (): Promise<string | null> => {
    const pid = promptIdRef.current;
    if (!pid) return null;

    for (let i = 0; i < 60; i++) {
      try {
        const history = await getHistory(pid);
        if (history?.outputs) {
          const vhsOutput = history.outputs["17"];
          if (vhsOutput?.gifs?.[0]) {
            const gif = vhsOutput.gifs[0];
            const url = getImageUrl(gif.filename, gif.subfolder || "", gif.type || "output");
            esRef.current?.close();
            return url;
          }
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    esRef.current?.close();
    return null;
  };

  // Helper: generate one LTX-2 audio-video chunk and return donor video URL
  const generateOneChunk = async (
    config: LTX2Config,
    chunkIdx: number,
    totalChunks: number,
  ): Promise<string | null> => {
    const workflow = config.pipelineMode === "official"
      ? buildLTX2OfficialWorkflow(config, config.seed)
      : buildLTX2Workflow(config, config.seed);
    const clientId = clientIdRef.current;
    esRef.current?.close();

    const prefix = totalChunks > 1 ? `Chunk ${chunkIdx + 1}/${totalChunks}: ` : "";
    setStageLabel(`LTX-2: ${prefix}Queuing workflow...`);

    return new Promise<string | null>((resolve) => {
      esRef.current = connectComfyStream(
        clientId,
        (msg: ComfyUIProgress) => {
          if (msg.type === "progress" && msg.data) {
            setProgress(msg.data.value ?? 0);
            setProgressMax(msg.data.max ?? 0);
            setStageLabel(`LTX-2: ${prefix}Sampling step ${msg.data.value}/${msg.data.max}`);
          } else if (msg.type === "executing" && msg.data) {
            if (msg.data.node === null) {
              fetchLTX2Result().then(resolve);
            } else {
              const nodeNames: Record<string, string> = {
                "88": "Loading text encoder...",
                "91": "Loading diffusion model...",
                "107": "Loading video VAE...",
                "87": "Loading audio VAE...",
                "6": "Encoding prompt...",
                "123": "Sampling (audio+video)...",
                "129": "Decoding video (tiled)...",
                "16": "Decoding audio...",
                "17": "Encoding MP4...",
              };
              const name = nodeNames[msg.data.node as string];
              if (name) setStageLabel(`LTX-2: ${prefix}${name}`);
            }
          } else if (msg.type === "execution_error") {
            const errMsg = (msg.data as Record<string, unknown>)?.exception_message as string || "ComfyUI error";
            setError(errMsg);
            setPhase("error");
            resolve(null);
          }
        },
        () => {},
        () => {},
        (dataUrl: string) => {
          setLivePreviewUrl(dataUrl);
        }
      );

      queuePrompt(workflow, clientId)
        .then((result) => {
          promptIdRef.current = result.prompt_id;
          setStageLabel(`LTX-2: ${prefix}Waiting for ComfyUI...`);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Queue failed");
          setPhase("error");
          resolve(null);
        });
    });
  };

  // Main LTX-2 pipeline: splits long videos into ~10s chunks
  const runLTX2Pipeline = useCallback(async (): Promise<string[]> => {
    if (!videoMeta) return [];

    setPhase("generating");
    setProgress(0);
    setProgressMax(0);
    setLivePreviewUrl(null);

    // Always generate at 24fps: LTX-2 was trained at this rate.
    // Using the source video's native fps (30, 60, etc.) produces out-of-distribution
    // conditioning that causes slow/misaligned audio and machine-noise artifacts.
    const genFps = 24;
    const maxFramesPerChunk = 257; // 8*32+1, ~10.7s at 24fps
    const maxChunkDuration = maxFramesPerChunk / genFps;
    const numChunks = Math.max(1, Math.ceil(videoMeta.duration / maxChunkDuration));

    // Find closest supported resolution
    const aspect = videoMeta.width / videoMeta.height;
    let bestRes = { width: 768, height: 512 };
    let bestDiff = Infinity;
    for (const preset of LTX2_RESOLUTION_PRESETS) {
      const presetAspect = preset.width / preset.height;
      const diff = Math.abs(aspect - presetAspect);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestRes = preset;
      }
    }

    // Model version from Director config
    const version = directorConfig.modelVersion || "2.0";
    const vDefaults = getLTX2ModelDefaults(version);

    if (numChunks > 1) {
      setStageLabel(`Video is ${videoMeta.duration.toFixed(1)}s, splitting into ${numChunks} chunks`);
    }

    const donorUrls: string[] = [];

    for (let i = 0; i < numChunks; i++) {
      if (cancelledRef.current) return donorUrls;

      const seg = segments[i];
      const chunkStart = seg ? seg.startTime : i * maxChunkDuration;
      const chunkEnd = seg ? seg.endTime : Math.min((i + 1) * maxChunkDuration, videoMeta.duration);
      const chunkFrameCount = Math.round((chunkEnd - chunkStart) * genFps);
      let numFrames = Math.max(9, Math.round((chunkFrameCount - 1) / 8) * 8 + 1);
      if (numFrames > maxFramesPerChunk) numFrames = maxFramesPerChunk;

      // Update segment status
      setSegments(prev => prev.map((s, idx) => idx === i ? { ...s, status: "generating" } : s));

      const chunkDuration = chunkEnd - chunkStart;
      const chunkLabel = numChunks > 1 ? ` for chunk ${i + 1}/${numChunks}` : "";

      // ── V2A Fast Mode vs Standard: video conditioning ──
      let frameFile = seg?.frameFile || "";
      let chunkVideoPath: string | undefined;
      let guideFrames: { image: string; frameIdx: number; strength: number }[] = [];

      if (v2aFastMode) {
        // V2A Fast Mode: trim the source video for this chunk at target resolution/fps.
        // VHS_LoadVideoPath loads it, LTXVImgToVideoInplace encodes into frozen video latent.
        // No guide frame extraction needed, the entire video IS the conditioning.
        setStageLabel(`Preparing V2A chunk video${chunkLabel}...`);
        const prepResp = await fetch("/api/director/prepare-v2a-chunk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoPath: videoMeta.videoPath,
            startTime: chunkStart,
            endTime: chunkEnd,
            width: bestRes.width,
            height: bestRes.height,
            fps: genFps,
            numFrames,
          }),
        });
        if (!prepResp.ok) throw new Error(`Failed to prepare V2A chunk${chunkLabel}`);
        const prepData = await prepResp.json();
        chunkVideoPath = prepData.chunkVideoPath;
      } else {
        // Standard mode: extract multiple guide frames from source video (~1/sec, max 8).
        // Multi-guide constrains the generated video to follow the original, improving audio match.
        const numGuides = Math.min(8, Math.max(1, Math.round(chunkDuration)));
        setStageLabel(`Extracting ${numGuides} guide frame${numGuides > 1 ? "s" : ""}${chunkLabel}...`);

        for (let g = 0; g < numGuides; g++) {
          if (cancelledRef.current) return donorUrls;

          const guideTimestamp = Math.min(
            chunkStart + (numGuides > 1 ? (g / (numGuides - 1)) * chunkDuration : 0),
            videoMeta.duration - 0.05  // clamp to avoid seeking past video end
          );
          const guideFrameIdx = numGuides > 1
            ? Math.round((g / (numGuides - 1)) * (numFrames - 1))
            : 0;
          const strength = (g === 0 || g === numGuides - 1) ? 1.0 : 0.85;

          let gFrameFile: string;
          if (g === 0 && seg?.frameFile) {
            gFrameFile = seg.frameFile;
          } else {
            const resp = await fetch("/api/director/extract-frame-at", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ videoPath: videoMeta.videoPath, timestamp: guideTimestamp }),
            });
            if (!resp.ok) throw new Error(`Failed to extract guide frame ${g + 1}${chunkLabel}`);
            const data = await resp.json();
            gFrameFile = data.frameFile;
          }

          guideFrames.push({ image: gFrameFile, frameIdx: guideFrameIdx, strength });
        }

        frameFile = guideFrames[0].image;
      }

      // Use segment prompt if available, otherwise fall back to base prompt
      const segPrompt = seg?.prompt?.trim();
      const chunkPrompt = segPrompt || prompt || "ambient sound effects matching the video scene";

      // Determine overlap audio for this chunk
      let chunkOverlapFile: string | undefined;
      let chunkOverlapDur: number | undefined;

      if (voiceRefFilename) {
        // Voice reference: use for ALL chunks (consistent voice)
        // Pre-trim to the selected region so LoadAudio gets only the relevant audio
        const trimLen = voiceRefTrimEnd > voiceRefTrimStart
          ? voiceRefTrimEnd - voiceRefTrimStart
          : 0;
        if (trimLen > 0.5) {
          try {
            const trimResp = await fetch("/api/director/trim-audio", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                audioFile: voiceRefFilename,
                trimStart: voiceRefTrimStart,
                trimEnd: voiceRefTrimEnd,
              }),
            });
            if (trimResp.ok) {
              const trimData = await trimResp.json();
              chunkOverlapFile = trimData.audioFile;
              chunkOverlapDur = trimData.duration;
            } else {
              // Fallback: use full file with 3s overlap
              chunkOverlapFile = voiceRefFilename;
              chunkOverlapDur = 3;
            }
          } catch {
            chunkOverlapFile = voiceRefFilename;
            chunkOverlapDur = 3;
          }
        } else {
          // No meaningful trim: use full file with 3s overlap
          chunkOverlapFile = voiceRefFilename;
          chunkOverlapDur = 3;
        }
      } else if (overlapDuration > 0 && i > 0 && donorUrls.length > 0) {
        // Tail overlap: extract last N seconds from previous chunk's donor video
        const prevLabel = numChunks > 1 ? ` from chunk ${i}/${numChunks}` : "";
        setStageLabel(`Extracting audio tail${prevLabel} for continuity...`);
        try {
          // Resolve donor path from ComfyUI URL
          const prevUrl = donorUrls[donorUrls.length - 1];
          const parsed = new URL(prevUrl, "http://localhost");
          const filename = parsed.searchParams.get("filename");
          const subfolder = parsed.searchParams.get("subfolder") || "";
          const type = parsed.searchParams.get("type") || "output";
          // Build path relative to ComfyUI
          const donorRelPath = filename
            ? `../ComfyUI/${type}/${subfolder ? subfolder + "/" : ""}${filename}`
            : prevUrl;

          const tailResp = await fetch("/api/director/extract-audio-tail", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourcePath: donorRelPath,
              duration: overlapDuration,
            }),
          });
          if (tailResp.ok) {
            const tailData = await tailResp.json();
            chunkOverlapFile = tailData.audioFile;
            chunkOverlapDur = tailData.actualDuration;
          }
        } catch { /* proceed without overlap if extraction fails */ }
      }

      const config: LTX2Config = {
        ...LTX2_DEFAULTS,
        ...vDefaults,
        prompt: chunkPrompt,
        sourceImage: v2aFastMode ? "" : frameFile,
        enableAudio: true,
        width: bestRes.width,
        height: bestRes.height,
        numFrames,
        frameRate: genFps,
        seed: Math.floor(Math.random() * 2 ** 32),
        randomSeed: false,
        // Use Director config models (already version-correct after toggle)
        diffusionModel: directorConfig.diffusionModel || vDefaults.diffusionModel || LTX2_DEFAULTS.diffusionModel,
        textEncoder: directorConfig.textEncoder || vDefaults.textEncoder || LTX2_DEFAULTS.textEncoder,
        connectorModel: directorConfig.connectorModel || vDefaults.connectorModel || LTX2_DEFAULTS.connectorModel,
        videoVae: directorConfig.videoVae || vDefaults.videoVae || LTX2_DEFAULTS.videoVae,
        audioVae: directorConfig.audioVae || vDefaults.audioVae || LTX2_DEFAULTS.audioVae,
        distillLoRA: directorConfig.distillLoRA || vDefaults.distillLoRA || LTX2_DEFAULTS.distillLoRA,
        distillLoRAStrength: directorConfig.distillLoRAStrength,
        userLoras: userLoras.filter(l => l.enabled && l.name),
        videoNormFactors: ltx2VideoNorm,
        audioNormFactors: ltx2AudioNorm,
        // Cross-attention scales from Director (critical for audio quality)
        videoScale: directorConfig.videoScale,
        audioScale: directorConfig.audioScale,
        audioToVideoScale: directorConfig.audioToVideoScale,
        videoToAudioScale: directorConfig.videoToAudioScale,
        // VAE tiling & feedforward from Director
        vaeTileSize: directorConfig.vaeTileSize,
        vaeOverlap: directorConfig.vaeOverlap,
        vaeTemporalSize: directorConfig.vaeTemporalSize,
        vaeTemporalOverlap: directorConfig.vaeTemporalOverlap,
        ffChunks: directorConfig.ffChunks,
        ffDimThreshold: directorConfig.ffDimThreshold,
        imgCompression: directorConfig.imgCompression,
        modelBasePath: directorConfig.modelBasePath || "",
        modelVersion: version,
        pipelineMode: directorConfig.pipelineMode || "alternative",
        qualityTier: directorConfig.qualityTier || "distilled",
        negativePrompt: directorConfig.negativePrompt || "",
        stylePreset: directorConfig.stylePreset || "none",
        // Audio overlap conditioning
        overlapAudioFile: chunkOverlapFile,
        overlapDuration: chunkOverlapDur,
        // Multi-guide frames: constrain generated video to match original source (standard mode only)
        guideFrames: v2aFastMode ? undefined : guideFrames,
        // V2A Fast Mode: encode source video into frozen video latent, audio-only generation
        v2aFastMode: v2aFastMode || undefined,
        sourceVideoPath: chunkVideoPath,
      };

      const url = await generateOneChunk(config, i, numChunks);
      if (!url) {
        setSegments(prev => prev.map((s, idx) => idx === i ? { ...s, status: "error" } : s));
        if (!cancelledRef.current) throw new Error(`Chunk ${i + 1} generation failed`);
        return donorUrls;
      }
      setSegments(prev => prev.map((s, idx) => idx === i ? { ...s, status: "done" } : s));
      donorUrls.push(url);
    }

    return donorUrls;
  }, [videoMeta, prompt, directorConfig, ltx2AudioNorm, ltx2VideoNorm, overlapDuration, voiceRefFilename, voiceRefTrimStart, voiceRefTrimEnd, segments, userLoras, v2aFastMode]);

  // ── Foley V2A Pipeline ──
  const runFoleyPipeline = useCallback(async () => {
    if (!videoMeta) return;

    setPhase("generating");
    setProgress(0);
    setProgressMax(0);

    // Step 1: Stage frames
    setStageLabel("Foley: Staging video frames...");

    // We need to convert the video path to something foley-stage accepts
    // Since our video is already saved at videoMeta.videoPath, we pass it directly
    const stageRes = await fetch("/api/director/foley-stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoUrl: videoMeta.videoPath }),
    });

    if (!stageRes.ok) {
      const err = await stageRes.json().catch(() => ({}));
      throw new Error(err.error || "Failed to stage frames");
    }

    const stageData = await stageRes.json();

    // Step 2: Make room for the Foley model. Measured + strategy-aware (see lib/vram-guard.ts):
    // never an unconditional flush; it keeps the video model resident when it fits / streaming is
    // cheaper, and reports its decision through the stage label.
    await ensureVramForStage("foley", (msg) => setStageLabel(msg));

    // Step 3: Build and queue Foley workflow
    const foleyParams: GenerationParams = {
      ...DEFAULT_PARAMS,
      fps: stageData.fps || Math.round(videoMeta.fps),
      frames: stageData.frameCount || videoMeta.frameCount,
      foleyPrompt: prompt || "ambient sound effects",
      foleyNegativePrompt: negativePrompt,
      foleySteps,
      foleyCfg,
      foleySampler,
      seed: Math.floor(Math.random() * 2 ** 32),
      randomSeed: true,
    };

    const foleyWorkflow = buildFoleyAudioWorkflow(foleyParams, stageData.directory);

    const clientId = clientIdRef.current;
    esRef.current?.close();

    return new Promise<{ audioFilename: string; audioSubfolder: string } | null>((resolve) => {
      esRef.current = connectComfyStream(
        clientId,
        (msg: ComfyUIProgress) => {
          if (msg.type === "progress" && msg.data) {
            setProgress(msg.data.value ?? 0);
            setProgressMax(msg.data.max ?? 0);
            setStageLabel(`Foley: Step ${msg.data.value}/${msg.data.max}`);
          } else if (msg.type === "executing" && msg.data) {
            if (msg.data.node === null) {
              // Done: fetch audio result
              fetchFoleyResult().then(resolve);
            }
          } else if (msg.type === "execution_error") {
            const errMsg = (msg.data as Record<string, unknown>)?.exception_message as string || "ComfyUI error";
            setError(errMsg);
            setPhase("error");
            resolve(null);
          }
        },
        () => {},
        () => {}
      );

      setStageLabel("Foley: Generating audio...");
      queuePrompt(foleyWorkflow, clientId)
        .then((result) => {
          promptIdRef.current = result.prompt_id;
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Queue failed");
          setPhase("error");
          resolve(null);
        });
    });
  }, [videoMeta, prompt, negativePrompt, foleySteps, foleyCfg, foleySampler]);

  const fetchFoleyResult = async (): Promise<{ audioFilename: string; audioSubfolder: string } | null> => {
    const pid = promptIdRef.current;
    if (!pid) return null;

    for (let i = 0; i < 120; i++) {
      try {
        const history = await getHistory(pid);
        if (history?.status?.completed) {
          if (history.outputs) {
            for (const nodeOutput of Object.values(history.outputs)) {
              const no = nodeOutput as Record<string, unknown>;
              const audioArr = no.audio as Array<{ filename: string; subfolder: string }> | undefined;
              if (audioArr && audioArr.length > 0) {
                esRef.current?.close();
                return { audioFilename: audioArr[0].filename, audioSubfolder: audioArr[0].subfolder };
              }
            }
          }
          esRef.current?.close();
          return null;
        }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
    esRef.current?.close();
    return null;
  };

  // ── Main Generate Handler ──
  const handleGenerate = useCallback(async () => {
    if (!videoMeta) return;

    cancelledRef.current = false;
    setError(null);
    if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
    setResultBlobUrl(null);

    try {
      if (engine === "ltx2") {
        // LTX-2 pipeline: generate joint A+V in chunks, then extract audio for preview
        const donorVideoUrls = await runLTX2Pipeline();
        if (!donorVideoUrls.length || cancelledRef.current) {
          if (!cancelledRef.current) {
            setPhase("error");
            setError("LTX-2 generation failed: no output");
          }
          return;
        }

        // Extract audio only (no merge yet), user will preview before merging
        setPhase("extracting");
        setStageLabel(
          donorVideoUrls.length > 1
            ? `Extracting & concatenating audio from ${donorVideoUrls.length} chunks...`
            : "Extracting audio from generated output..."
        );

        // Clean up any previous audio previews
        if (rawAudioBlobUrl) URL.revokeObjectURL(rawAudioBlobUrl);
        if (denoisedAudioBlobUrl) URL.revokeObjectURL(denoisedAudioBlobUrl);
        setDenoisedAudioBlobUrl(null);
        setDenoisedAudioPath(null);

        const extractRes = await fetch("/api/director/audio-transfer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            originalVideoPath: videoMeta.videoPath,
            donorVideoUrls,
            audioOnly: true,
          }),
        });

        if (!extractRes.ok) {
          const err = await extractRes.json().catch(() => ({ error: "Audio extraction failed" }));
          throw new Error(err.error);
        }

        const audioPath = extractRes.headers.get("X-Audio-Path") || "";
        const audioBlob = await extractRes.blob();
        const audioBlobUrl = URL.createObjectURL(audioBlob);

        setRawAudioBlobUrl(audioBlobUrl);
        setRawAudioPath(audioPath);
        setDonorUrlsRef(donorVideoUrls);
        setPhase("previewing");
        setStageLabel("Audio extracted: preview and choose before merging.");

      } else {
        // Foley pipeline: stage frames, generate audio, merge
        const foleyResult = await runFoleyPipeline();
        if (!foleyResult || cancelledRef.current) {
          if (!cancelledRef.current) {
            setPhase("error");
            setError("Foley generation failed: no audio output");
          }
          return;
        }

        // Merge foley audio with original video
        setPhase("merging");
        setStageLabel("Merging Foley audio with original video...");

        const mergeRes = await fetch("/api/foley-merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoSource: { type: "upload", path: videoMeta.videoPath },
            audioFilename: foleyResult.audioFilename,
            audioSubfolder: foleyResult.audioSubfolder,
          }),
        });

        if (!mergeRes.ok) {
          const err = await mergeRes.json().catch(() => ({ error: "Merge failed" }));
          throw new Error(err.error);
        }

        const blob = await mergeRes.blob();
        const blobUrl = URL.createObjectURL(blob);
        setResultBlobUrl(blobUrl);
        setPhase("complete");
        setStageLabel("Foley audio generation complete!");
      }
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Pipeline failed");
    }
  }, [videoMeta, engine, runLTX2Pipeline, runFoleyPipeline, mergeMode, mixVolume, resultBlobUrl, rawAudioBlobUrl, denoisedAudioBlobUrl]);

  // ── Denoise: apply spectral noise reduction to the extracted raw audio ──
  const handleDenoise = useCallback(async () => {
    if (!rawAudioPath || denoising) return;
    setDenoising(true);
    setError(null);

    try {
      const res = await fetch("/api/director/denoise-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioPath: rawAudioPath,
          highpass: dnHighpass,
          noiseReduction: dnNoiseReduction,
          noiseFloor: dnNoiseFloor,
          trackNoise: dnTrackNoise,
          lowpass: dnLowpass,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Denoise failed" }));
        throw new Error(err.error);
      }

      const denoisedPath = res.headers.get("X-Audio-Path") || "";
      const blob = await res.blob();
      if (denoisedAudioBlobUrl) URL.revokeObjectURL(denoisedAudioBlobUrl);
      setDenoisedAudioBlobUrl(URL.createObjectURL(blob));
      setDenoisedAudioPath(denoisedPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Denoise failed");
    } finally {
      setDenoising(false);
    }
  }, [rawAudioPath, denoising, denoisedAudioBlobUrl, dnHighpass, dnNoiseReduction, dnNoiseFloor, dnTrackNoise, dnLowpass]);

  // ── Merge chosen audio with original video ──
  const handleMergeAudio = useCallback(async (variant: "raw" | "denoised") => {
    if (!videoMeta) return;
    const audioPath = variant === "denoised" ? denoisedAudioPath : rawAudioPath;
    if (!audioPath) return;

    setPhase("merging");
    setStageLabel(`Merging ${variant === "denoised" ? "denoised" : "raw"} audio with original video...`);
    setError(null);

    try {
      const mergeRes = await fetch("/api/director/audio-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalVideoPath: videoMeta.videoPath,
          audioPath,
          mode: mergeMode,
          mixVolume,
        }),
      });

      if (!mergeRes.ok) {
        const err = await mergeRes.json().catch(() => ({ error: "Merge failed" }));
        throw new Error(err.error);
      }

      const blob = await mergeRes.blob();
      if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
      setResultBlobUrl(URL.createObjectURL(blob));
      setPhase("complete");
      setStageLabel("Audio generation complete!");
    } catch (err) {
      setPhase("previewing"); // Return to preview on error
      setError(err instanceof Error ? err.message : "Merge failed");
    }
  }, [videoMeta, rawAudioPath, denoisedAudioPath, mergeMode, mixVolume, resultBlobUrl]);

  const handleCancel = useCallback(() => {
    cancelledRef.current = true;
    esRef.current?.close();
    setPhase("idle");
    setStageLabel("Cancelled");
    import("@/lib/comfyui-api").then(({ interruptGeneration }) => interruptGeneration()).catch(() => {});
  }, []);

  const handleDownload = useCallback(() => {
    if (!resultBlobUrl) return;
    const a = document.createElement("a");
    a.href = resultBlobUrl;
    a.download = `VekSnap_V2A_${engine}_${Date.now()}.mp4`;
    a.click();
  }, [resultBlobUrl, engine]);

  const isRunning = phase !== "idle" && phase !== "complete" && phase !== "error" && phase !== "previewing";
  const canGenerate = videoMeta && !isRunning && comfyConnected;
  const progressPct = progressMax > 0 ? Math.round((progress / progressMax) * 100) : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-violet-500/30 bg-violet-500/5">
        <div className="flex items-center gap-2">
          <AudioLines className="w-5 h-5 text-violet-400" />
          <h2 className="text-sm font-semibold text-violet-400">Audio for Video</h2>
          <span className="text-[9px] text-violet-400/60 bg-violet-500/10 px-1.5 py-0.5 rounded">
            V2A · Generate Audio from Existing Video
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

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Info banner */}
        <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-violet-400 mt-0.5 shrink-0" />
            <p className="text-[10px] text-violet-300/80 leading-relaxed">
              Upload a video and generate matching audio using AI. <strong>LTX-2</strong> generates
              joint audio-video from the first frame (best for ambient + dialogue). <strong>Foley</strong> uses
              HunyuanVideo-Foley to create sound effects synced to motion.
            </p>
          </div>
        </div>

        {/* Video Upload */}
        <div className="space-y-2">
          <Label className="text-[11px] text-violet-400 font-medium">Source Video</Label>

          {!videoFile ? (
            <label
              className="flex flex-col items-center justify-center w-full h-32 rounded-lg border-2 border-dashed border-violet-500/30 bg-violet-500/5 cursor-pointer hover:border-violet-500/50 hover:bg-violet-500/10 transition-colors"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const f = e.dataTransfer.files?.[0];
                if (f && f.type.startsWith("video/")) handleVideoUpload(f);
              }}
            >
              <Upload className="w-6 h-6 text-violet-400/60 mb-2" />
              <span className="text-[10px] text-violet-400/60">
                Drop video file or click to browse
              </span>
              <span className="text-[9px] text-muted-foreground mt-1">
                MP4, MOV, AVI, WebM
              </span>
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleVideoUpload(f);
                }}
              />
            </label>
          ) : (
            <div className="space-y-2">
              <div className="relative rounded-lg overflow-hidden border border-border/30 bg-black">
                {videoPreviewUrl && (
                  <VideoSlot
                    id="afv-source"
                    src={videoPreviewUrl}
                    className="w-full"
                    style={{ maxHeight: "12rem", width: "100%" }}
                    muted
                  />
                )}
                <button
                  onClick={clearVideo}
                  disabled={isRunning}
                  className="absolute top-2 right-2 p-1 rounded-full bg-black/60 text-white/80 hover:text-white hover:bg-black/80 disabled:opacity-30"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>

              {videoMeta && (
                <div className="flex flex-wrap gap-2 text-[9px]">
                  <span className="bg-violet-500/10 text-violet-400 px-1.5 py-0.5 rounded">
                    {videoMeta.width}×{videoMeta.height}
                  </span>
                  <span className="bg-violet-500/10 text-violet-400 px-1.5 py-0.5 rounded">
                    {videoMeta.fps} fps
                  </span>
                  <span className="bg-violet-500/10 text-violet-400 px-1.5 py-0.5 rounded">
                    {videoMeta.duration}s
                  </span>
                  <span className="bg-violet-500/10 text-violet-400 px-1.5 py-0.5 rounded">
                    {videoMeta.frameCount} frames
                  </span>
                  <span className={`px-1.5 py-0.5 rounded ${videoMeta.hasAudio ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}>
                    {videoMeta.hasAudio ? "Has Audio" : "No Audio"}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Audio Engine Selector */}
        <div className="space-y-2">
          <Label className="text-[11px] text-violet-400 font-medium">Audio Engine</Label>
          <div className="flex gap-2">
            <button
              onClick={() => setEngine("ltx2")}
              disabled={isRunning}
              className={`flex-1 py-2 px-3 rounded-lg text-[10px] font-medium border transition-colors ${
                engine === "ltx2"
                  ? "border-violet-500 bg-violet-500/20 text-violet-300"
                  : "border-border/30 bg-muted/10 text-muted-foreground hover:border-violet-500/30"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <Film className="w-3.5 h-3.5" />
                LTX-2 Joint Audio
              </div>
              <div className="text-[8px] mt-1 opacity-60">
                Best for ambient + dialogue
              </div>
            </button>
            <button
              onClick={() => setEngine("foley")}
              disabled={isRunning}
              className={`flex-1 py-2 px-3 rounded-lg text-[10px] font-medium border transition-colors ${
                engine === "foley"
                  ? "border-violet-500 bg-violet-500/20 text-violet-300"
                  : "border-border/30 bg-muted/10 text-muted-foreground hover:border-violet-500/30"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <Volume2 className="w-3.5 h-3.5" />
                Foley (HunyuanVideo)
              </div>
              <div className="text-[8px] mt-1 opacity-60">
                Best for SFX synced to motion
              </div>
            </button>
          </div>
        </div>

        {/* V2A Fast Mode Toggle (LTX-2 only) */}
        {engine === "ltx2" && (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] text-emerald-400 font-medium flex items-center gap-1.5">
                <Film className="w-3.5 h-3.5" /> V2A Fast Mode
              </Label>
              <Switch
                checked={v2aFastMode}
                onCheckedChange={setV2aFastMode}
                disabled={isRunning}
              />
            </div>
            <p className="text-[9px] text-muted-foreground leading-relaxed">
              {v2aFastMode
                ? "Fast: Encodes the source video into a frozen latent and generates audio only. Skips video rendering: much faster, preserves original video quality."
                : "Standard: Generates video + audio jointly using guide frames from the source video. Higher quality audio sync but slower."}
            </p>
          </div>
        )}

        {/* LTX-2 Segment Cards */}
        {engine === "ltx2" && videoMeta && segments.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] text-violet-400 font-medium">
                Audio Segments ({segments.length})
              </Label>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[9px] px-2 text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/30"
                onClick={handleAutoDescribeAll}
                disabled={isRunning || describingAll}
                title="Load Qwen2.5-VL once and auto-describe audio for all segments"
              >
                {describingAll ? (
                  <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Describing...</>
                ) : (
                  <><Eye className="w-3 h-3 mr-1" /> Auto-Describe All</>
                )}
              </Button>
            </div>
            <p className="text-[8px] text-muted-foreground/60">
              Each segment gets its own audio prompt. Use &quot;Auto-Describe All&quot; to analyze frames with Qwen2.5-VL
              (loads model once for all segments), or type prompts manually.
            </p>

            <div className="space-y-2">
              {segments.map((seg, idx) => (
                <div
                  key={idx}
                  className={`rounded-lg border p-2.5 space-y-1.5 transition-colors ${
                    seg.status === "generating"
                      ? "border-violet-500/50 bg-violet-500/10"
                      : seg.status === "describing"
                      ? "border-emerald-500/50 bg-emerald-500/10"
                      : seg.status === "done"
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : seg.status === "error"
                      ? "border-red-500/30 bg-red-500/5"
                      : "border-border/30 bg-muted/5"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {/* Frame thumbnail */}
                    {seg.frameFile && (
                      <div className="w-16 h-10 rounded overflow-hidden border border-border/20 shrink-0 bg-black">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`${COMFYUI_HTTP}/view?filename=${encodeURIComponent(seg.frameFile)}&subfolder=&type=input`}
                          alt={`Segment ${idx + 1}`}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] font-medium text-violet-300">
                          Segment {idx + 1}
                          <span className="text-muted-foreground/60 ml-1">
                            {seg.startTime.toFixed(1)}s – {seg.endTime.toFixed(1)}s
                            ({seg.duration.toFixed(1)}s)
                          </span>
                        </span>
                        {seg.status === "generating" && (
                          <Loader2 className="w-3 h-3 text-violet-400 animate-spin" />
                        )}
                        {seg.status === "describing" && (
                          <Loader2 className="w-3 h-3 text-emerald-400 animate-spin" />
                        )}
                        {seg.status === "done" && (
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                        )}
                      </div>
                      <textarea
                        value={seg.prompt}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSegments(prev => prev.map((s, i) =>
                            i === idx ? { ...s, prompt: val } : s
                          ));
                        }}
                        disabled={isRunning || describingAll}
                        placeholder="Describe audio for this segment..."
                        className="w-full h-12 bg-muted/20 border border-border/20 rounded px-2 py-1 text-[10px] resize-none focus:border-violet-500/50 focus:outline-none placeholder:text-muted-foreground/30"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Base prompt (fallback for empty segments) */}
            <div className="space-y-1">
              <Label className="text-[9px] text-muted-foreground">
                Fallback Prompt <span className="text-muted-foreground/40">(used for segments without a prompt)</span>
              </Label>
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={isRunning}
                placeholder="ambient sounds, natural environment audio"
                className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1.5 text-[10px] focus:border-violet-500/50 focus:outline-none placeholder:text-muted-foreground/30"
              />
            </div>
          </div>
        )}

        {/* Foley / pre-upload prompt */}
        {(engine === "foley" || !videoMeta || segments.length === 0) && (
          <div className="space-y-2">
            <Label className="text-[11px] text-violet-400 font-medium">Audio Prompt</Label>
            {audioAnalysis && (
              <p className="text-[8px] text-emerald-400/50 leading-relaxed">
                {audioAnalysis.summary}
              </p>
            )}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isRunning}
              placeholder={engine === "ltx2"
                ? "Describe the audio: dialogue, ambient sounds, music..."
                : "Describe sound effects: footsteps, wind, birds, water..."
              }
              className="w-full h-20 bg-muted/20 border border-border/30 rounded-lg px-3 py-2 text-[11px] resize-none focus:border-violet-500/50 focus:outline-none placeholder:text-muted-foreground/40"
            />

            {/* Quick prompt presets */}
            {engine === "foley" && (
              <div className="flex flex-wrap gap-1">
                {FOLEY_PROMPT_PRESETS.slice(0, 6).map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setPrompt(p.prompt)}
                    disabled={isRunning}
                    className="text-[8px] px-1.5 py-0.5 rounded bg-muted/20 text-muted-foreground hover:bg-violet-500/10 hover:text-violet-400 transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Merge Mode */}
        {videoMeta?.hasAudio && (
          <div className="space-y-2">
            <Label className="text-[11px] text-violet-400 font-medium">Audio Merge Mode</Label>
            <div className="flex gap-2">
              <button
                onClick={() => setMergeMode("replace")}
                disabled={isRunning}
                className={`flex-1 py-1.5 rounded-lg text-[10px] border transition-colors ${
                  mergeMode === "replace"
                    ? "border-violet-500 bg-violet-500/20 text-violet-300"
                    : "border-border/30 bg-muted/10 text-muted-foreground"
                }`}
              >
                Replace Audio
              </button>
              <button
                onClick={() => setMergeMode("mix")}
                disabled={isRunning}
                className={`flex-1 py-1.5 rounded-lg text-[10px] border transition-colors ${
                  mergeMode === "mix"
                    ? "border-violet-500 bg-violet-500/20 text-violet-300"
                    : "border-border/30 bg-muted/10 text-muted-foreground"
                }`}
              >
                Mix with Original
              </button>
            </div>
            {mergeMode === "mix" && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-muted-foreground">AI Audio Volume</span>
                  <span className="text-[9px] text-violet-400">{Math.round(mixVolume * 100)}%</span>
                </div>
                <Slider
                  value={[mixVolume]}
                  onValueChange={([v]) => setMixVolume(v)}
                  min={0.1}
                  max={1.0}
                  step={0.05}
                  disabled={isRunning}
                />
              </div>
            )}
          </div>
        )}

        {/* Audio Continuity (LTX-2 only, shown when video > ~10s or always for voice ref) */}
        {engine === "ltx2" && (
          <div className="space-y-2">
            <Label className="text-[11px] text-violet-400 font-medium">Audio Continuity</Label>
            <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 space-y-3">
              {/* Overlap Duration Slider */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] text-muted-foreground">Overlap Duration</span>
                  <span className="text-[9px] text-violet-400">
                    {overlapDuration === 0 ? "Off" : `${overlapDuration.toFixed(1)}s`}
                  </span>
                </div>
                <Slider
                  value={[overlapDuration]}
                  onValueChange={([v]) => setOverlapDuration(v)}
                  min={0}
                  max={5}
                  step={0.5}
                  disabled={isRunning}
                />
                <p className="text-[8px] text-muted-foreground/60">
                  Audio from the end of each chunk conditions the next chunk for voice/sound continuity.
                  Higher = stronger continuity, more chunks needed. 0 = independent chunks.
                </p>
              </div>

              {/* Voice Reference Upload */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[11px] text-violet-400 font-medium flex items-center gap-1">
                    <Mic className="w-3 h-3" /> Voice Reference (optional)
                  </Label>
                  {voiceRefFile && (
                    <button
                      onClick={clearVoiceRef}
                      disabled={isRunning}
                      className="text-[8px] text-red-400 hover:text-red-300"
                    >
                      <X className="w-3 h-3 inline mr-0.5" />Remove
                    </button>
                  )}
                </div>
                <div className="rounded border border-violet-500/20 bg-background/50 p-2 min-h-[60px] flex flex-col items-center justify-center gap-2">
                  {voiceRefFile && voiceRefObjectUrl ? (
                    <div className="w-full space-y-1.5">
                      <div className="flex items-center gap-2">
                        <Mic className="w-3 h-3 text-violet-400 shrink-0" />
                        <span className="text-[9px] text-violet-300 truncate flex-1">{voiceRefFile.name}</span>
                      </div>
                      <AudioTrimmer
                        audioUrl={voiceRefObjectUrl}
                        maxDuration={10}
                        trimStart={voiceRefTrimStart}
                        trimEnd={voiceRefTrimEnd}
                        onTrimChange={(start, end) => {
                          setVoiceRefTrimStart(start);
                          setVoiceRefTrimEnd(end);
                        }}
                        disabled={isRunning}
                        contextLabel="Reference"
                        hideConfirm
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 text-[8px] px-1.5 text-emerald-400 hover:bg-emerald-500/10 self-start"
                        onClick={async () => {
                          if (!voiceRefFile || audioAnalyzing) return;
                          setAudioAnalyzing(true);
                          try {
                            const formData = new FormData();
                            formData.append("file", voiceRefFile);
                            const res = await fetch("/api/audio-analysis", { method: "POST", body: formData });
                            const data = await res.json();
                            if (data.error) throw new Error(data.error);
                            setAudioAnalysis({ summary: data.summary || "", directives: data.directives || [] });
                            if (data.directives?.length) {
                              const directive = data.directives.join(" ");
                              setPrompt((prev) => prev.trim()
                                ? `${prev.trim()}\n\n[Audio context: ${directive}]`
                                : `[Audio context: ${directive}]`
                              );
                            }
                          } catch (err) {
                            setError(err instanceof Error ? err.message : "Audio analysis failed");
                          } finally {
                            setAudioAnalyzing(false);
                          }
                        }}
                        disabled={isRunning || audioAnalyzing}
                        title="Analyze voice reference and enrich fallback prompt with audio-reactive directives"
                      >
                        {audioAnalyzing ? (
                          <><Loader2 className="w-2.5 h-2.5 mr-0.5 animate-spin" /> Analyzing...</>
                        ) : (
                          <><Wand2 className="w-2.5 h-2.5 mr-0.5" /> Analyze Audio</>
                        )}
                      </Button>
                      {audioAnalysis && (
                        <p className="text-[8px] text-emerald-400/50 leading-relaxed">
                          {audioAnalysis.summary}
                        </p>
                      )}
                    </div>
                  ) : (
                    <label
                      className="flex flex-col items-center gap-1.5 w-full py-3 cursor-pointer hover:bg-violet-500/5 transition-colors rounded"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const f = e.dataTransfer.files?.[0];
                        if (f && f.type.startsWith("audio/")) handleVoiceRefUpload(f);
                      }}
                    >
                      <Mic className="w-5 h-5 text-violet-400/40" />
                      <span className="text-[9px] text-violet-400/60">Upload voice sample (WAV/MP3)</span>
                      <span className="text-[8px] text-muted-foreground/40">2–10 seconds recommended</span>
                      <input
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        disabled={isRunning}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleVoiceRefUpload(f);
                        }}
                      />
                    </label>
                  )}
                </div>
                <p className="text-[8px] text-muted-foreground/60">
                  When set, this voice sample conditions ALL chunks for consistent character voice.
                  Use the trim handles to select a <strong>2–10 second</strong> segment of clear speech
                  with no music, background noise, or silence. The model works best with natural,
                  conversational speech at a steady volume.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* LoRA Picker (LTX-2 only) */}
        {engine === "ltx2" && (
          <div className="border border-purple-500/20 rounded-lg overflow-hidden">
            <button
              onClick={() => setLorasExpanded(!lorasExpanded)}
              className="flex items-center gap-2 w-full px-3 py-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {lorasExpanded ? <ChevronDown className="w-3 h-3 text-purple-400" /> : <ChevronRight className="w-3 h-3 text-purple-400" />}
              <span className="text-[10px] text-purple-400 font-medium">LoRAs</span>
              {userLoras.filter(l => l.enabled && l.name).length > 0 && (
                <span className="text-[9px] text-purple-300">
                  ({userLoras.filter(l => l.enabled && l.name).length} active)
                </span>
              )}
            </button>

            {lorasExpanded && (
              <div className="px-3 pb-3 space-y-2 border-t border-purple-500/10">
                {userLoras.map((lora, i) => (
                  <div key={i} className="rounded border border-purple-500/10 bg-background p-2 space-y-1.5 mt-2">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={lora.enabled}
                        onCheckedChange={(v) => {
                          const updated = [...userLoras];
                          updated[i] = { ...updated[i], enabled: v };
                          setUserLoras(updated);
                        }}
                        className="scale-[0.6]"
                        disabled={isRunning}
                      />
                      <LoraSelect
                        value={lora.name}
                        options={availableLoras}
                        onChange={(name) => {
                          const updated = [...userLoras];
                          updated[i] = { ...updated[i], name };
                          setUserLoras(updated);
                        }}
                        disabled={isRunning}
                        compatMode="ltx2"
                      />
                      <button
                        type="button"
                        onClick={() => setUserLoras(prev => prev.filter((_, idx) => idx !== i))}
                        className="p-0.5 text-destructive/40 hover:text-destructive"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[8px] text-muted-foreground w-10">Strength</span>
                      <Slider
                        min={0} max={2} step={0.05}
                        value={[lora.strengthModel]}
                        onValueChange={([v]) => {
                          const updated = [...userLoras];
                          updated[i] = { ...updated[i], strengthModel: v };
                          setUserLoras(updated);
                        }}
                        className="flex-1"
                        disabled={isRunning}
                      />
                      <span className="text-[9px] text-purple-400 w-8 text-right">{lora.strengthModel.toFixed(2)}</span>
                    </div>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full h-7 text-[10px] border-purple-500/30 text-purple-400 hover:bg-purple-500/10 mt-2"
                  onClick={() => {
                    const usedNames = new Set(userLoras.map(l => l.name));
                    const firstUnused = availableLoras.find(n => !usedNames.has(n));
                    setUserLoras(prev => [...prev, { enabled: true, name: firstUnused || "", strengthModel: 1.0, strengthClip: 1.0 }]);
                  }}
                  disabled={isRunning || availableLoras.length === 0}
                >
                  <Plus className="w-3 h-3 mr-1" /> Add LoRA
                </Button>
                <p className="text-[8px] text-muted-foreground/60">
                  LTX-2 LoRAs contain joint audio+video weights, they directly affect generated audio character and quality.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Advanced Settings */}
        <div className="border border-border/20 rounded-lg overflow-hidden">
          <button
            onClick={() => setAdvancedExpanded(!advancedExpanded)}
            className="flex items-center gap-2 w-full px-3 py-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {advancedExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Settings2 className="w-3 h-3" />
            Advanced Settings
          </button>

          {advancedExpanded && (
            <div className="px-3 pb-3 space-y-3 border-t border-border/20">
              {engine === "ltx2" ? (
                <>
                  <div className="space-y-1 mt-2">
                    <Label className="text-[9px] text-muted-foreground">Audio Norm Factors</Label>
                    <input
                      type="text"
                      value={ltx2AudioNorm}
                      onChange={(e) => setLtx2AudioNorm(e.target.value)}
                      disabled={isRunning}
                      className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-[10px] font-mono"
                    />
                    <p className="text-[8px] text-muted-foreground/60">
                      Per-step scaling. Alternative recipe: &quot;1,1,0.25,1,1,0.25,1,1&quot; reduces noise at steps 3,6
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[9px] text-muted-foreground">Video Norm Factors</Label>
                    <input
                      type="text"
                      value={ltx2VideoNorm}
                      onChange={(e) => setLtx2VideoNorm(e.target.value)}
                      disabled={isRunning}
                      className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-[10px] font-mono"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1 mt-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-muted-foreground">Steps</Label>
                      <span className="text-[9px] text-violet-400">{foleySteps}</span>
                    </div>
                    <Slider
                      value={[foleySteps]}
                      onValueChange={([v]) => setFoleySteps(v)}
                      min={25}
                      max={150}
                      step={5}
                      disabled={isRunning}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-muted-foreground">CFG Scale</Label>
                      <span className="text-[9px] text-violet-400">{foleyCfg}</span>
                    </div>
                    <Slider
                      value={[foleyCfg]}
                      onValueChange={([v]) => setFoleyCfg(v)}
                      min={1}
                      max={15}
                      step={0.5}
                      disabled={isRunning}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[9px] text-muted-foreground">Sampler</Label>
                    <select
                      value={foleySampler}
                      onChange={(e) => setFoleySampler(e.target.value)}
                      disabled={isRunning}
                      className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-[10px]"
                    >
                      {FOLEY_SAMPLERS.map((s) => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[9px] text-muted-foreground">Negative Prompt</Label>
                    <input
                      type="text"
                      value={negativePrompt}
                      onChange={(e) => setNegativePrompt(e.target.value)}
                      disabled={isRunning}
                      className="w-full bg-muted/20 border border-border/30 rounded px-2 py-1 text-[10px]"
                    />
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Progress */}
        {isRunning && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-violet-400 animate-spin" />
              <span className="text-[10px] text-violet-300">{stageLabel}</span>
            </div>
            {progressMax > 0 && (
              <div className="space-y-1">
                <div className="h-1.5 bg-muted/30 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-500 rounded-full transition-all duration-300"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="flex justify-between text-[8px] text-muted-foreground">
                  <span>{progress}/{progressMax}</span>
                  <span>{progressPct}%</span>
                </div>
              </div>
            )}
            {/* Live Preview during LTX-2 generation */}
            {livePreviewUrl && (
              <div className="rounded border border-cyan-500/20 bg-cyan-500/5 p-2 space-y-1">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  <span className="text-[9px] text-cyan-400 font-medium">Live Preview</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={livePreviewUrl}
                  alt="Live preview"
                  className="w-full rounded border border-cyan-500/20 object-contain"
                  style={{ maxHeight: "25vh" }}
                />
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {phase === "error" && error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 flex items-start gap-2">
            <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <p className="text-[10px] text-red-300">{error}</p>
          </div>
        )}

        {/* Audio Preview (post-generation, pre-merge) */}
        {phase === "previewing" && rawAudioBlobUrl && (
          <div className="space-y-3">
            <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-violet-400" />
              <span className="text-[10px] text-violet-300 flex-1">{stageLabel}</span>
            </div>

            {/* Raw Audio */}
            <div className="rounded-lg border border-border/30 bg-muted/5 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-foreground">Raw Audio</span>
                <Button
                  size="sm"
                  onClick={() => handleMergeAudio("raw")}
                  className="h-6 text-[9px] px-3 bg-violet-600 hover:bg-violet-700 text-white"
                >
                  <CheckCircle2 className="w-3 h-3 mr-1" /> Use Raw
                </Button>
              </div>
              <audio src={rawAudioBlobUrl} controls className="w-full h-8" />
            </div>

            {/* Denoise Section: parameters + button + result */}
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-amber-400">Denoise Filter</span>
                <button
                  type="button"
                  onClick={() => {
                    setDnHighpass(80);
                    setDnNoiseReduction(30);
                    setDnNoiseFloor(-30);
                    setDnTrackNoise(1);
                    setDnLowpass(14000);
                  }}
                  className="text-[8px] text-muted-foreground hover:text-amber-400 flex items-center gap-0.5"
                >
                  <RotateCcw className="w-2.5 h-2.5" /> Reset defaults
                </button>
              </div>

              {/* Highpass */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[9px] text-muted-foreground/70">Highpass</Label>
                  <span className="text-[9px] font-mono text-amber-400">{dnHighpass} Hz</span>
                </div>
                <Slider min={20} max={200} step={5} value={[dnHighpass]} onValueChange={([v]) => setDnHighpass(v)} className="flex-1" />
              </div>

              {/* Noise Reduction */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[9px] text-muted-foreground/70">Noise Reduction (nr)</Label>
                  <span className="text-[9px] font-mono text-amber-400">{dnNoiseReduction} dB</span>
                </div>
                <Slider min={5} max={80} step={1} value={[dnNoiseReduction]} onValueChange={([v]) => setDnNoiseReduction(v)} className="flex-1" />
              </div>

              {/* Noise Floor */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[9px] text-muted-foreground/70">Noise Floor (nf)</Label>
                  <span className="text-[9px] font-mono text-amber-400">{dnNoiseFloor} dB</span>
                </div>
                <Slider min={-80} max={0} step={1} value={[dnNoiseFloor]} onValueChange={([v]) => setDnNoiseFloor(v)} className="flex-1" />
              </div>

              {/* Track Noise */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[9px] text-muted-foreground/70">Track Noise (tn)</Label>
                  <span className="text-[9px] font-mono text-amber-400">{dnTrackNoise}</span>
                </div>
                <Slider min={0} max={1} step={1} value={[dnTrackNoise]} onValueChange={([v]) => setDnTrackNoise(v)} className="flex-1" />
              </div>

              {/* Lowpass */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[9px] text-muted-foreground/70">Lowpass</Label>
                  <span className="text-[9px] font-mono text-amber-400">{dnLowpass} Hz</span>
                </div>
                <Slider min={4000} max={20000} step={500} value={[dnLowpass]} onValueChange={([v]) => setDnLowpass(v)} className="flex-1" />
              </div>

              {/* Denoise / Re-denoise Button */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleDenoise}
                disabled={denoising}
                className="w-full h-7 text-[10px] border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
              >
                {denoising ? (
                  <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Applying denoise filter...</>
                ) : denoisedAudioBlobUrl ? (
                  <><RotateCcw className="w-3 h-3 mr-1" /> Re-denoise with new settings</>
                ) : (
                  <><Wand2 className="w-3 h-3 mr-1" /> Denoise &amp; Compare</>
                )}
              </Button>

              {/* Denoised Audio Result */}
              {denoisedAudioBlobUrl && (
                <div className="space-y-2 pt-1 border-t border-amber-500/10">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium text-amber-300">Denoised Audio</span>
                    <Button
                      size="sm"
                      onClick={() => handleMergeAudio("denoised")}
                      className="h-6 text-[9px] px-3 bg-amber-600 hover:bg-amber-700 text-white"
                    >
                      <CheckCircle2 className="w-3 h-3 mr-1" /> Use Denoised
                    </Button>
                  </div>
                  <audio src={denoisedAudioBlobUrl} controls className="w-full h-8" />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Result */}
        {phase === "complete" && resultBlobUrl && (
          <div className="space-y-2">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span className="text-[10px] text-emerald-300 flex-1">{stageLabel}</span>
            </div>

            <div className="rounded-lg overflow-hidden border border-border/30 bg-black">
              <VideoSlot
                id="afv-result"
                src={resultBlobUrl}
                className="w-full"
                style={{ maxHeight: "12rem", width: "100%" }}
              />
            </div>

            <Button
              onClick={handleDownload}
              className="w-full h-8 text-[11px] bg-violet-600 hover:bg-violet-700 text-white"
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Download Result
            </Button>
          </div>
        )}

        {/* Generate / Cancel */}
        <div className="pt-2">
          {isRunning ? (
            <Button
              onClick={handleCancel}
              variant="destructive"
              className="w-full h-9 text-[11px]"
            >
              <Square className="w-3.5 h-3.5 mr-1.5" />
              Cancel
            </Button>
          ) : (
            <Button
              onClick={handleGenerate}
              disabled={!canGenerate}
              className="w-full h-9 text-[11px] bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40"
            >
              <Play className="w-3.5 h-3.5 mr-1.5" />
              Generate Audio for Video
              {!videoMeta && " (upload video first)"}
            </Button>
          )}

          {!comfyConnected && (
            <p className="text-[9px] text-amber-400 mt-1 text-center">
              ComfyUI is not connected. Start services first.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
