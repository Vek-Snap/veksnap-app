"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Heart,
  Play,
  Square,
  Settings2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  HeartMuLaConfig,
  HEARTMULA_DEFAULTS,
  HEARTMULA_SECTION_MARKERS,
} from "@/lib/types";
import { inputSmall, inputBase, selectBase, labelMuted, hintText, presetBtn, progressTrack, infoFooter, advancedToggle } from "@/lib/theme-classes";
import { buildHeartMuLaWorkflow } from "@/lib/workflow-builder";
import { useRegisterComfyWorkflow } from "@/components/ComfyOpenProvider";
import SendToQueueButton from "@/components/SendToQueueButton";
import {
  queuePrompt,
  getHistory,
  interruptGeneration,
  connectComfyStream,
} from "@/lib/comfyui-api";

interface HeartMuLaStudioProps {
  config: HeartMuLaConfig;
  onConfigChange: (config: HeartMuLaConfig) => void;
}

const TAG_PRESETS = [
  "pop, female vocal, energetic",
  "rock, male vocal, electric guitar, drums, powerful",
  "electronic, synth, upbeat, dance, fast",
  "jazz, piano, saxophone, smooth, medium",
  "classical, strings, orchestra, calm",
  "hip-hop, male vocal, trap beat, aggressive",
  "r&b, female vocal, romantic, slow",
  "folk, acoustic guitar, male vocal, melancholic",
  "metal, male vocal, heavy drums, aggressive, fast",
  "indie, dreamy, reverb, medium",
];

export default function HeartMuLaStudio({ config, onConfigChange }: HeartMuLaStudioProps) {
  // Register this page's workflow with the global "Open in ComfyUI" button.
  useRegisterComfyWorkflow(() => ({
    workflow: buildHeartMuLaWorkflow({
      ...config,
      seed: config.seed >= 0 ? config.seed : -1,
    }) as Record<string, unknown>,
    name: "HeartMuLa Music",
  }));
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [outputAudioUrl, setOutputAudioUrl] = useState<string | null>(null);
  const [lastOutputFilename, setLastOutputFilename] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [batchOutputs, setBatchOutputs] = useState<string[]>([]);

  const clientIdRef = useRef(`veksnap-heartmula-${Date.now()}`);
  const esRef = useRef<EventSource | null>(null);
  const promptIdRef = useRef<string | null>(null);
  const lyricsRef = useRef<HTMLTextAreaElement>(null);

  const set = useCallback(
    <K extends keyof HeartMuLaConfig>(key: K, val: HeartMuLaConfig[K]) => {
      onConfigChange({ ...config, [key]: val });
    },
    [config, onConfigChange]
  );

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
    };
  }, []);

  const progressPct = progressMax > 0 ? (progress / progressMax) * 100 : 0;

  // Insert section marker at cursor
  const insertMarker = useCallback(
    (marker: string) => {
      const ta = lyricsRef.current;
      if (!ta) {
        set("lyrics", config.lyrics + (config.lyrics && !config.lyrics.endsWith("\n") ? "\n" : "") + marker + "\n");
        return;
      }
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const text = config.lyrics;
      const before = text.slice(0, start);
      const after = text.slice(end);
      const insert = marker + "\n";
      set("lyrics", before + insert + after);
      setTimeout(() => {
        ta.selectionStart = ta.selectionEnd = start + insert.length;
        ta.focus();
      }, 0);
    },
    [config.lyrics, set]
  );

  // Generate handler
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setOutputAudioUrl(null);
    setLastOutputFilename(null);
    setBatchOutputs([]);
    setProgress(0);
    setProgressMax(0);
    setStage("Queuing...");

    const batchCount = config.batchCount || 1;
    const urls: string[] = [];

    try {
      for (let b = 0; b < batchCount; b++) {
        if (batchCount > 1) setStage(`Variation ${b + 1}/${batchCount}`);

        const workflow = buildHeartMuLaWorkflow({
          ...config,
          seed: config.randomSeed ? -1 : config.seed + b,
        });

        const clientId = clientIdRef.current;
        esRef.current?.close();
        esRef.current = connectComfyStream(
          clientId,
          (msg) => {
            if (msg.type === "progress" && msg.data) {
              setProgress(msg.data.value ?? 0);
              setProgressMax(msg.data.max ?? 0);
              setStage(
                batchCount > 1
                  ? `Variation ${b + 1}/${batchCount}: Frame ${msg.data.value}/${msg.data.max}`
                  : `Generating: Frame ${msg.data.value}/${msg.data.max}`
              );
            }
            if (msg.type === "executing" && msg.data?.node === null) {
              setStage(batchCount > 1 ? `Variation ${b + 1} done` : "Decoding...");
            }
          },
          () => {},
          () => {}
        );

        const result = await queuePrompt(workflow, clientId);
        const promptId = result.prompt_id;
        promptIdRef.current = promptId;

        // Poll history for output
        let outputFile = "";
        for (let i = 0; i < 600; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const hist = await getHistory(promptId);
          if (hist?.outputs) {
            // SaveAudioMP3 is node "6"
            const saveOut = hist.outputs["6"];
            if (saveOut?.audio?.[0]) {
              const audio = saveOut.audio[0] as { filename: string; subfolder?: string };
              outputFile = audio.filename;
              break;
            }
          }
        }

        esRef.current?.close();

        if (!outputFile) throw new Error("Generation timed out or produced no output");

        const url = `/api/comfyui/view?filename=${encodeURIComponent(outputFile)}&subfolder=audio&type=output`;
        urls.push(url);
        setOutputAudioUrl(url);
        setLastOutputFilename(outputFile);
      }

      setBatchOutputs(urls);
      setStage("Complete!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
      setStage("Failed");
    } finally {
      setGenerating(false);
    }
  }, [config]);

  const handleCancel = useCallback(async () => {
    try {
      await interruptGeneration();
      esRef.current?.close();
    } catch {}
    setGenerating(false);
    setStage("Cancelled");
  }, []);

  return (
    <div className="p-3 space-y-3 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Heart className="w-4 h-4 text-rose-400" />
          <h2 className="text-sm font-semibold text-rose-300">HeartMuLa Studio</h2>
          <span className="text-[10px] text-rose-400/60 bg-rose-500/10 px-1.5 py-0.5 rounded">
            3B • 48kHz • 4min
          </span>
        </div>
      </div>

      {/* Style Tags */}
      <div className="space-y-1.5">
        <Label className="text-[10px] text-rose-400/80" title="Comma-separated descriptors that define the music style. Order matters: put the most important tags first.">Style Tags</Label>
        <p className="text-[8px] text-muted-foreground/70 -mt-0.5">Genre, vocal type (male/female), instruments, mood (energetic/melancholic), tempo (slow/medium/fast). More specific = better results.</p>
        <input
          type="text"
          value={config.tags}
          onChange={(e) => set("tags", e.target.value)}
          className="w-full bg-muted border border-rose-500/20 rounded px-2 py-1.5 text-xs text-foreground focus:border-rose-500/50 focus:outline-none placeholder:text-muted-foreground/30"
          placeholder="genre, vocal type, instruments, mood, tempo..."
        />
        <div className="flex flex-wrap gap-1">
          {TAG_PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => set("tags", preset)}
              className={`text-[8px] px-1.5 py-0.5 rounded transition-colors ${
                config.tags === preset
                  ? "bg-rose-500/30 text-rose-200 border border-rose-500/50"
                  : "bg-muted/60 text-muted-foreground hover:text-foreground border border-border/60"
              }`}
            >
              {preset.split(",").slice(0, 2).join(",")}
            </button>
          ))}
        </div>
      </div>

      {/* Lyrics */}
      <div className="space-y-1.5">
        <Label className="text-[10px] text-rose-400/80" title="Song lyrics with section markers for structure. Leave empty for instrumental music.">Lyrics</Label>
        <p className="text-[8px] text-muted-foreground/70 -mt-0.5">Use section markers to structure the song. Leave empty for instrumental. Supports EN, ZH, JA, KO, ES.</p>
        <div className="flex flex-wrap gap-1 mb-1">
          {HEARTMULA_SECTION_MARKERS.map((marker) => (
            <button
              key={marker}
              onClick={() => insertMarker(marker)}
              className="text-[8px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400/70 hover:bg-rose-500/20 transition-colors"
            >
              {marker}
            </button>
          ))}
        </div>
        <textarea
          ref={lyricsRef}
          value={config.lyrics}
          onChange={(e) => set("lyrics", e.target.value)}
          rows={8}
          className="w-full bg-muted border border-rose-500/20 rounded px-2 py-1.5 text-xs text-foreground resize-none focus:border-rose-500/50 focus:outline-none placeholder:text-muted-foreground/30 font-mono leading-relaxed"
          placeholder={"[Verse]\nWalking down the empty street\nThinking about you and me\n\n[Chorus]\nWe belong together\nNow and forever"}
        />
      </div>

      {/* Duration + Temperature + TopK row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className={labelMuted} title="Length of generated audio. Shorter durations (30-60s) tend to be more coherent. Max 240s (4 min).">Duration (s)</Label>
          <Slider
            value={[config.maxDuration]}
            onValueChange={([v]) => set("maxDuration", v)}
            min={10}
            max={240}
            step={10}
          />
          <div className="text-[9px] text-rose-400/60 text-center">{config.maxDuration}s</div>
        </div>
        <div className="space-y-1">
          <Label className={labelMuted} title="Controls randomness/creativity. Low (0.5-0.8) = safe & repetitive. Medium (0.85-1.0) = balanced. High (1.0+) = creative but risky.">Temperature</Label>
          <Slider
            value={[config.temperature]}
            onValueChange={([v]) => set("temperature", v)}
            min={0.1}
            max={2.0}
            step={0.05}
          />
          <div className="text-[9px] text-rose-400/60 text-center">{config.temperature.toFixed(2)}</div>
        </div>
        <div className="space-y-1">
          <Label className={labelMuted} title="Limits token choices to top K candidates. Low (50-100) = focused/repetitive. Medium (150-250) = balanced. High (300+) = diverse but less coherent.">Top-K</Label>
          <Slider
            value={[config.topK]}
            onValueChange={([v]) => set("topK", v)}
            min={1}
            max={500}
            step={10}
          />
          <div className="text-[9px] text-rose-400/60 text-center">{config.topK}</div>
        </div>
      </div>

      {/* CFG Scale */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className={labelMuted} title="Classifier-Free Guidance: how strictly the model follows your tags/lyrics. 1.0 = no guidance. 3-5 = balanced. 7+ = strict but may reduce quality.">CFG Scale</Label>
          <span className="text-[9px] text-rose-400/60">{config.cfgScale.toFixed(1)}</span>
        </div>
        <Slider
          value={[config.cfgScale]}
          onValueChange={([v]) => set("cfgScale", v)}
          min={1.0}
          max={10.0}
          step={0.1}
        />
      </div>

      {/* Seed */}
      <div className="flex items-center gap-2">
        <Switch
          checked={config.randomSeed}
          onCheckedChange={(v) => set("randomSeed", v)}
        />
        <Label className={labelMuted} title="Fixed seed = reproducible output. Useful for A/B testing different tags with the same melody structure.">Random Seed</Label>
        {!config.randomSeed && (
          <input
            type="number"
            value={config.seed}
            onChange={(e) => set("seed", Number(e.target.value))}
            className={`flex-1 ${inputSmall}`}
          />
        )}
      </div>

      {/* Batch */}
      <div className="flex items-center justify-between">
        <Label className={labelMuted} title="Generate multiple outputs with different seeds. Great for finding the best take: compare and pick your favorite.">Variations</Label>
        <div className="flex items-center gap-0.5">
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              onClick={() => set("batchCount", n)}
              className={`w-6 h-6 rounded text-[10px] font-medium transition-colors ${
                config.batchCount === n
                  ? "bg-rose-500/30 text-rose-300 border border-rose-500/50"
                  : "text-muted-foreground hover:text-foreground border border-border"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* Advanced Settings */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className={advancedToggle}
      >
        {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Settings2 className="w-3 h-3" />
        Advanced Settings
      </button>

      {showAdvanced && (
        <div className="space-y-2 pl-2 border-l border-rose-500/20">
          <div className="space-y-1">
            <Label className={labelMuted} title="Controls GPU memory usage. Auto detects your GPU. Use Low/Ultra if you have less than 16GB VRAM.">Memory Mode</Label>
            <select
              value={config.memoryMode}
              onChange={(e) => set("memoryMode", e.target.value as HeartMuLaConfig["memoryMode"])}
              className={selectBase}
            >
              <option value="auto">Auto (recommended)</option>
              <option value="normal">Normal (fast, ~12GB VRAM)</option>
              <option value="low">Low (slower, ~8GB VRAM)</option>
              <option value="ultra">Ultra (slowest, ~5GB VRAM)</option>
            </select>
          </div>

          <div className="space-y-1">
            <Label className={labelMuted} title="Floating point precision. FP16 recommended for most GPUs. BF16 for newer cards (RTX 40/50 series). FP32 uses 2x VRAM.">Precision</Label>
            <select
              value={config.precision}
              onChange={(e) => set("precision", e.target.value as HeartMuLaConfig["precision"])}
              className={selectBase}
            >
              <option value="auto">Auto</option>
              <option value="fp16">FP16 (recommended)</option>
              <option value="bf16">BF16 (RTX 40/50 series)</option>
              <option value="fp32">FP32 (debug only, 2x VRAM)</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={config.use4bit}
              onCheckedChange={(v) => set("use4bit", v)}
            />
            <Label className={labelMuted} title="Quantize the 3B model to 4-bit. Saves ~6GB VRAM with slight quality reduction. Good for GPUs with 8-10GB VRAM.">4-bit Quantization (~6GB VRAM)</Label>
          </div>
        </div>
      )}

      {/* Progress Bar */}
      {generating && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-rose-400">{stage}</span>
            <span className="text-muted-foreground/70">{progress}/{progressMax}</span>
          </div>
          <div className={progressTrack}>
            <div
              className="h-full bg-gradient-to-r from-rose-500 to-pink-500 transition-all duration-300"
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
          <Label className="text-[10px] text-rose-400/80">{batchOutputs.length} Variations</Label>
          {batchOutputs.map((url, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[9px] text-muted-foreground w-3">{i + 1}</span>
              <audio controls src={url} className="flex-1 h-8" />
              <a href={url} download className="text-rose-400/60 hover:text-rose-300">
                <Download className="w-3 h-3" />
              </a>
            </div>
          ))}
        </div>
      ) : outputAudioUrl ? (
        <div className="space-y-1">
          <Label className="text-[10px] text-rose-400/80">Generated Audio</Label>
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
            className="flex-1 h-9 bg-rose-600 hover:bg-rose-700 text-white"
          >
            <Play className="w-3.5 h-3.5 mr-1.5" />
            Generate Music
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-9 text-xs text-muted-foreground"
          onClick={() => onConfigChange({ ...HEARTMULA_DEFAULTS })}
        >
          <RefreshCw className="w-3 h-3 mr-1" />
          Reset
        </Button>
      </div>
      {!generating && (
        <SendToQueueButton className="w-full mt-2" getJob={() => ({ workflow: buildHeartMuLaWorkflow({ ...config, seed: config.seed >= 0 ? config.seed : -1 }) as Record<string, unknown>, name: "HeartMuLa Music", outputKind: "audio" })} />
      )}

      {/* Model Info */}
      <div className={infoFooter}>
        <p>Model: HeartMuLa-RL-oss-3B (LLaMA-3B backbone)</p>
        <p>Codec: HeartCodec-oss (48kHz, 8 codebooks)</p>
        <p>Max Duration: 240s (4 minutes)</p>
        <p>Languages: EN, ZH, JA, KO, ES</p>
        <p className="text-muted-foreground/50">VRAM: ~12GB FP16 / ~6GB 4-bit</p>
      </div>
    </div>
  );
}
