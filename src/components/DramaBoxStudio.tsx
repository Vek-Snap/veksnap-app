"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useAutoplay } from "@/lib/use-autoplay";
import {
  Play,
  Square,
  Upload,
  X,
  Mic,
  Settings2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Download,
  Sparkles,
  RefreshCw,
  Plus,
  Trash2,
  Send,
  Scissors,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  DramaBoxConfig,
  DRAMABOX_DEFAULTS,
  DRAMABOX_PROMPT_EXAMPLES,
  DRAMABOX_DEFAULT_NEGATIVE,
  DramaBoxGenerationMode,
  DramaBoxModelPolicy,
  ComfyUIProgress,
  LoraEntry,
} from "@/lib/types";
import { buildDramaBoxWorkflow } from "@/lib/workflow-builder";
import { useRegisterComfyWorkflow } from "@/components/ComfyOpenProvider";
import SendToQueueButton from "@/components/SendToQueueButton";
import {
  queuePrompt,
  getHistory,
  interruptGeneration,
  connectComfyStream,
  uploadAudio,
  getImageUrl,
} from "@/lib/comfyui-api";
import { inputSmall, selectBase, labelMuted, hintText, presetBtn, progressTrack, advancedToggle, toggleInactive } from "@/lib/theme-classes";
import AudioTrimmer from "@/components/AudioTrimmer";

interface DramaBoxStudioProps {
  config: DramaBoxConfig;
  onConfigChange: (config: DramaBoxConfig) => void;
  onSendToS2V?: (audioFile: string) => void;
}

export default function DramaBoxStudio({
  config,
  onConfigChange,
  onSendToS2V,
}: DramaBoxStudioProps) {
  const configRef = useRef(config);
  configRef.current = config;

  // Register this page's workflow with the global "Open in ComfyUI" button.
  useRegisterComfyWorkflow(() => ({
    workflow: buildDramaBoxWorkflow(config) as Record<string, unknown>,
    name: "DramaBox TTS",
  }));

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputAudioUrl, setOutputAudioUrl] = useState<string | null>(null);
  const [outputFilename, setOutputFilename] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressMax, setProgressMax] = useState(0);
  const [stage, setStage] = useState("");
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [voiceRefPreview, setVoiceRefPreview] = useState<string | null>(null);
  const [voiceRefDuration, setVoiceRefDuration] = useState<number | null>(null);
  const [refTrimEnabled, setRefTrimEnabled] = useState(false);
  const [refTrimStart, setRefTrimStart] = useState(0);
  const [refTrimEnd, setRefTrimEnd] = useState(0);
  const [sendingToS2V, setSendingToS2V] = useState(false);
  const [autoplay] = useAutoplay();

  const voiceRefInputRef = useRef<HTMLInputElement>(null);
  const audioPlayerRef = useRef<HTMLAudioElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const promptIdRef = useRef<string | null>(null);
  const clientIdRef = useRef(`dramabox-${Date.now()}`);

  const update = useCallback(
    <K extends keyof DramaBoxConfig>(key: K, value: DramaBoxConfig[K]) => {
      const newConfig = { ...configRef.current, [key]: value };
      configRef.current = newConfig;
      onConfigChange(newConfig);
    },
    [onConfigChange]
  );

  // ── Voice reference upload ──
  const handleVoiceRefUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const previewUrl = URL.createObjectURL(file);
      setVoiceRefPreview(previewUrl);
      // Get duration
      const audio = new Audio(previewUrl);
      audio.addEventListener("loadedmetadata", () => {
        setVoiceRefDuration(audio.duration);
      });
      // Upload to ComfyUI
      const uploaded = await uploadAudio(file);
      update("voiceRefFile", uploaded);
    } catch (err) {
      setError(`Failed to upload voice reference: ${err}`);
    }
    e.target.value = "";
  }, [update]);

  // Reconstruct the voice-reference preview from the persisted ComfyUI input/ path after a
  // tab switch unmounted/remounted this studio. Path-based only, no base64 retained.
  useEffect(() => {
    if (config.voiceRefFile && !voiceRefPreview) {
      setVoiceRefPreview(getImageUrl(config.voiceRefFile, "", "input"));
    }
  }, [config.voiceRefFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearVoiceRef = useCallback(() => {
    setVoiceRefPreview(null);
    setVoiceRefDuration(null);
    setRefTrimEnabled(false);
    setRefTrimStart(0);
    setRefTrimEnd(0);
    update("voiceRefFile", "");
  }, [update]);

  // ── LoRA management ──
  const addLora = useCallback(() => {
    update("userLoras", [...config.userLoras, { name: "", strengthModel: 1.0, strengthClip: 1.0, enabled: true }]);
  }, [config.userLoras, update]);

  const removeLora = useCallback((idx: number) => {
    update("userLoras", config.userLoras.filter((_, i) => i !== idx));
  }, [config.userLoras, update]);

  const updateLora = useCallback((idx: number, field: keyof LoraEntry, value: unknown) => {
    const loras = [...config.userLoras];
    loras[idx] = { ...loras[idx], [field]: value };
    update("userLoras", loras);
  }, [config.userLoras, update]);

  // ── Generate ──
  const handleGenerate = useCallback(async () => {
    if (!config.prompt.trim()) {
      setError("Please enter a prompt.");
      return;
    }
    setIsGenerating(true);
    setError(null);
    setOutputAudioUrl(null);
    setOutputFilename(null);
    setProgress(0);
    setProgressMax(0);
    setStage("Building workflow...");

    try {
      const clientId = clientIdRef.current;

      // Connect SSE for progress
      esRef.current?.close();
      esRef.current = connectComfyStream(
        clientId,
        (msg: ComfyUIProgress) => {
          if (msg.type === "progress" && msg.data) {
            setProgress(msg.data.value ?? 0);
            setProgressMax(msg.data.max ?? 0);
          }
        },
        () => {}
      );

      const workflow = buildDramaBoxWorkflow(config);
      setStage("Queuing...");

      const response = await queuePrompt(workflow, clientId);
      promptIdRef.current = response.prompt_id;
      setStage("Generating speech...");

      // Poll for completion
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const hist = await getHistory(response.prompt_id);
        if (hist) {
          // Check for error
          if (hist.status?.status_str === "error") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const messages = (hist.status as any)?.messages;
            const nodeErrors = messages?.find(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (m: any) => m[0] === "execution_error"
            );
            throw new Error(nodeErrors ? JSON.stringify(nodeErrors[1]) : "Execution failed");
          }
          const outputs = hist.outputs || {};
          for (const nodeOut of Object.values(outputs)) {
            const audios = (nodeOut as Record<string, unknown[]>)?.audio;
            if (audios && audios.length > 0) {
              const audio = audios[0] as { filename: string; subfolder?: string };
              setOutputFilename(audio.filename);
              const subfolder = audio.subfolder || "";
              const url = `/api/comfyui/view?filename=${encodeURIComponent(audio.filename)}&subfolder=${encodeURIComponent(subfolder)}&type=output`;
              setOutputAudioUrl(url);
              setStage("Done!");
              if (autoplay && audioPlayerRef.current) {
                setTimeout(() => audioPlayerRef.current?.play(), 200);
              }
              setIsGenerating(false);
              return;
            }
          }
        }
      }
      throw new Error("Generation timed out (5 minutes)");
    } catch (err) {
      setError(String(err));
      setStage("");
    } finally {
      setIsGenerating(false);
      esRef.current?.close();
      esRef.current = null;
    }
  }, [config, autoplay]);

  // ── Stop generation ──
  const handleStop = useCallback(async () => {
    try {
      await interruptGeneration();
    } catch { /* ignore */ }
    setIsGenerating(false);
    setStage("Cancelled");
  }, []);

  // ── Send to WAN S2V ──
  const handleSendToS2V = useCallback(async () => {
    if (!outputFilename || !onSendToS2V) return;
    setSendingToS2V(true);
    try {
      onSendToS2V(outputFilename);
    } finally {
      setSendingToS2V(false);
    }
  }, [outputFilename, onSendToS2V]);

  // ── Download ──
  const handleDownload = useCallback(() => {
    if (!outputAudioUrl) return;
    const a = document.createElement("a");
    a.href = outputAudioUrl;
    a.download = outputFilename || `dramabox_${Date.now()}.flac`;
    a.click();
  }, [outputAudioUrl, outputFilename]);

  const pct = progressMax > 0 ? Math.round((progress / progressMax) * 100) : 0;

  return (
    <div className="flex flex-col h-full p-3 space-y-3 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mic className="w-4 h-4 text-rose-400" />
          <span className="text-sm font-medium text-rose-400">DramaBox TTS</span>
          <span className="text-[9px] text-muted-foreground/60">Resemble AI • Expressive Voice</span>
        </div>
        <button
          onClick={() => onConfigChange({ ...DRAMABOX_DEFAULTS })}
          className="text-[9px] text-muted-foreground hover:text-rose-400 flex items-center gap-0.5"
        >
          <RefreshCw className="w-3 h-3" /> Reset
        </button>
      </div>

      {/* Prompt */}
      <div className="space-y-1.5">
        <Label className={labelMuted}>Prompt</Label>
        <textarea
          className={`${inputSmall} min-h-[100px] resize-y`}
          value={config.prompt}
          onChange={(e) => update("prompt", e.target.value)}
          placeholder={'A woman speaks warmly, "Hello, how are you today?" She laughs, "Hahaha!"'}
          disabled={isGenerating}
        />
        <div className="flex flex-wrap gap-1.5">
          {DRAMABOX_PROMPT_EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              onClick={() => update("prompt", ex.prompt)}
              className="flex items-center gap-1 text-[9px] px-2.5 py-1 rounded-md border border-rose-500/30 bg-rose-500/5 text-rose-300 hover:bg-rose-500/20 hover:border-rose-500/50 hover:text-rose-200 active:bg-rose-500/30 transition-all duration-150 cursor-pointer disabled:opacity-40"
              disabled={isGenerating}
            >
              <Sparkles className="w-3 h-3" />
              {ex.label}
            </button>
          ))}
        </div>
        <p className={hintText}>
          Inside &quot;quotes&quot; = spoken literally. Outside quotes = stage directions (emotions, actions).
        </p>
      </div>

      {/* Voice Reference */}
      <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-2.5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-rose-400 font-medium flex items-center gap-1">
            <Mic className="w-3 h-3" /> Voice Reference (Optional)
          </span>
          {voiceRefPreview && (
            <button onClick={clearVoiceRef} className="text-muted-foreground hover:text-rose-400" disabled={isGenerating}>
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        {voiceRefPreview ? (
          <div className="space-y-1.5">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio src={voiceRefPreview} controls className="w-full h-7" />
            {voiceRefDuration && (
              <p className={hintText}>Duration: {voiceRefDuration.toFixed(1)}s • Using first {config.refDuration}s</p>
            )}
            <div className="space-y-0.5">
              <Label className="text-[9px] text-muted-foreground/70">Ref Duration: {config.refDuration.toFixed(1)}s</Label>
              <Slider
                min={1} max={30} step={0.5}
                value={[config.refDuration]}
                onValueChange={([v]) => update("refDuration", v)}
                disabled={isGenerating}
              />
            </div>

            {/* Trim toggle */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setRefTrimEnabled(!refTrimEnabled)}
                className={`flex items-center gap-1 text-[9px] px-2 py-0.5 rounded border transition-colors ${
                  refTrimEnabled
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                    : "border-border/60 bg-muted/10 text-muted-foreground hover:text-foreground"
                }`}
                disabled={isGenerating}
              >
                <Scissors className="w-3 h-3" />
                {refTrimEnabled ? "Trim Active" : "Trim Reference"}
              </button>
              {refTrimEnabled && refTrimEnd > refTrimStart && (
                <span className="text-[8px] text-amber-400/60">
                  Using {(refTrimEnd - refTrimStart).toFixed(1)}s of reference
                </span>
              )}
            </div>

            {refTrimEnabled && (
              <AudioTrimmer
                audioUrl={voiceRefPreview}
                maxDuration={30}
                trimStart={refTrimStart}
                trimEnd={refTrimEnd}
                onTrimChange={(s, e) => { setRefTrimStart(s); setRefTrimEnd(e); }}
                hideConfirm
                contextLabel="Max"
              />
            )}
          </div>
        ) : (
          <button
            onClick={() => voiceRefInputRef.current?.click()}
            className="w-full border border-dashed border-rose-500/30 rounded py-3 flex flex-col items-center gap-1 text-muted-foreground hover:text-rose-400 hover:border-rose-500/50 transition-colors"
            disabled={isGenerating}
          >
            <Upload className="w-4 h-4" />
            <span className="text-[9px]">Upload voice reference: audio or video (5-15s recommended)</span>
          </button>
        )}
        <input
          ref={voiceRefInputRef}
          type="file"
          accept="audio/*,video/*"
          className="hidden"
          onChange={handleVoiceRefUpload}
        />
      </div>

      {/* Generation Controls */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <Label className="text-[9px] text-muted-foreground/70">CFG Scale: {config.cfgScale.toFixed(1)}</Label>
          <Slider min={1} max={10} step={0.1} value={[config.cfgScale]} onValueChange={([v]) => update("cfgScale", v)} disabled={isGenerating} />
        </div>
        <div className="space-y-0.5">
          <Label className="text-[9px] text-muted-foreground/70">STG Scale: {config.stgScale.toFixed(1)}</Label>
          <Slider min={0} max={5} step={0.1} value={[config.stgScale]} onValueChange={([v]) => update("stgScale", v)} disabled={isGenerating} />
        </div>
        <div className="space-y-0.5">
          <Label className="text-[9px] text-muted-foreground/70">Steps: {config.steps}</Label>
          <Slider min={10} max={80} step={1} value={[config.steps]} onValueChange={([v]) => update("steps", v)} disabled={isGenerating} />
        </div>
        <div className="space-y-0.5">
          <Label className="text-[9px] text-muted-foreground/70">Speed: {config.speed.toFixed(2)}x</Label>
          <Slider min={0.5} max={2.0} step={0.05} value={[config.speed]} onValueChange={([v]) => update("speed", v)} disabled={isGenerating} />
        </div>
      </div>

      {/* Duration */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <Label className="text-[9px] text-muted-foreground/70">Duration: {config.genDuration === 0 ? "Auto" : `${config.genDuration}s`}</Label>
          <Slider min={0} max={60} step={0.5} value={[config.genDuration]} onValueChange={([v]) => update("genDuration", v)} disabled={isGenerating} />
        </div>
        <div className="space-y-0.5">
          <Label className="text-[9px] text-muted-foreground/70">Multiplier: {config.durationMultiplier.toFixed(2)}x</Label>
          <Slider min={0.5} max={3.0} step={0.05} value={[config.durationMultiplier]} onValueChange={([v]) => update("durationMultiplier", v)} disabled={isGenerating} />
        </div>
      </div>

      {/* Seed */}
      <div className="flex items-center gap-2">
        <Label className="text-[9px] text-muted-foreground/70 whitespace-nowrap">Random Seed</Label>
        <Switch checked={config.randomSeed} onCheckedChange={(v) => update("randomSeed", v)} disabled={isGenerating} />
        {!config.randomSeed && (
          <input
            type="number"
            className={`${inputSmall} w-24`}
            value={config.seed}
            onChange={(e) => update("seed", parseInt(e.target.value) || 0)}
            disabled={isGenerating}
          />
        )}
      </div>

      {/* Advanced Settings */}
      <button
        onClick={() => setAdvancedExpanded(!advancedExpanded)}
        className={advancedExpanded ? advancedToggle : `${advancedToggle} ${toggleInactive}`}
      >
        {advancedExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Settings2 className="w-3 h-3" /> Advanced
      </button>

      {advancedExpanded && (
        <div className="space-y-3 pl-2 border-l border-rose-500/20">
          {/* Negative Prompt */}
          <div className="space-y-0.5">
            <Label className={labelMuted}>Negative Prompt</Label>
            <textarea
              className={`${inputSmall} min-h-[50px] resize-y`}
              value={config.negativePrompt}
              onChange={(e) => update("negativePrompt", e.target.value)}
              disabled={isGenerating}
            />
          </div>

          {/* ID Guidance & Rescale */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-0.5">
              <Label className="text-[9px] text-muted-foreground/70">ID Guidance: {config.idGuidanceScale.toFixed(1)}</Label>
              <Slider min={0} max={10} step={0.1} value={[config.idGuidanceScale]} onValueChange={([v]) => update("idGuidanceScale", v)} disabled={isGenerating} />
            </div>
            <div className="space-y-0.5">
              <Label className="text-[9px] text-muted-foreground/70">Rescale: {config.rescaleScale < 0 ? "Auto" : config.rescaleScale.toFixed(2)}</Label>
              <Slider min={-1} max={1} step={0.05} value={[config.rescaleScale]} onValueChange={([v]) => update("rescaleScale", v)} disabled={isGenerating} />
            </div>
          </div>

          {/* Generation Mode & Memory Policy */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-0.5">
              <Label className={labelMuted}>Generation Mode</Label>
              <select
                className={selectBase}
                value={config.generationMode}
                onChange={(e) => update("generationMode", e.target.value as DramaBoxGenerationMode)}
                disabled={isGenerating}
              >
                <option value="clip_loader">CLIP Loader (Best VRAM)</option>
                <option value="dramabox_wrapper">Wrapper (OG Behavior)</option>
              </select>
            </div>
            <div className="space-y-0.5">
              <Label className={labelMuted}>Memory Policy</Label>
              <select
                className={selectBase}
                value={config.modelPolicy}
                onChange={(e) => update("modelPolicy", e.target.value as DramaBoxModelPolicy)}
                disabled={isGenerating}
              >
                <option value="offload_to_cpu">Offload to CPU</option>
                <option value="offload">Full Offload</option>
                <option value="keep_loaded">Keep Loaded</option>
              </select>
            </div>
          </div>

          {/* Text Encoder */}
          <div className="space-y-0.5">
            <Label className={labelMuted}>Text Encoder (Gemma)</Label>
            <input
              className={inputSmall}
              value={config.textEncoder}
              onChange={(e) => update("textEncoder", e.target.value)}
              placeholder="gemma_3_12B_it_fp4_mixed.safetensors"
              disabled={isGenerating}
            />
          </div>

          {/* Voice LoRAs */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className={labelMuted}>Voice LoRAs</Label>
              <button onClick={addLora} className="text-rose-400 hover:text-rose-300" disabled={isGenerating}>
                <Plus className="w-3 h-3" />
              </button>
            </div>
            <p className="text-[8px] text-muted-foreground/60 leading-tight">
              These are DramaBox-specific voice LoRAs trained via Voice-Clone-Studio (not standard SD/video LoRAs).
              Place in <span className="text-rose-400/70">models/loras/</span>, trained on ~10 clips of 5-10s each.
              Optional: voice cloning also works with just a reference audio upload above.
            </p>
            {config.userLoras.map((lora, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  className={`${inputSmall} flex-1`}
                  value={lora.name}
                  onChange={(e) => updateLora(i, "name", e.target.value)}
                  placeholder="lora_filename.safetensors"
                  disabled={isGenerating}
                />
                <input
                  type="number"
                  className={`${inputSmall} w-14`}
                  value={lora.strengthModel}
                  onChange={(e) => updateLora(i, "strengthModel", parseFloat(e.target.value) || 1.0)}
                  step={0.1}
                  min={0}
                  max={2}
                  disabled={isGenerating}
                />
                <button onClick={() => removeLora(i)} className="text-muted-foreground hover:text-red-400">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Progress */}
      {isGenerating && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[9px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> {stage}
            </span>
            {progressMax > 0 && <span>{pct}%</span>}
          </div>
          {progressMax > 0 && (
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div className={`h-full ${progressTrack} transition-all duration-300`} style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 break-words">
          {error}
        </div>
      )}

      {/* Generate / Stop Buttons */}
      <div className="flex gap-2">
        {isGenerating ? (
          <Button onClick={handleStop} variant="destructive" size="sm" className="flex-1">
            <Square className="w-3 h-3 mr-1" /> Stop
          </Button>
        ) : (
          <Button
            onClick={handleGenerate}
            size="sm"
            className="flex-1 bg-rose-600 hover:bg-rose-500 text-white"
            disabled={!config.prompt.trim()}
          >
            <Play className="w-3 h-3 mr-1" /> Generate
          </Button>
        )}
      </div>
      {!isGenerating && (
        <SendToQueueButton className="w-full mt-2" disabled={!config.prompt.trim()} getJob={() => ({ workflow: buildDramaBoxWorkflow(config) as Record<string, unknown>, name: "DramaBox TTS", outputKind: "audio" })} />
      )}

      {/* Output */}
      {outputAudioUrl && (
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-rose-400 font-medium">Output</span>
            <div className="flex items-center gap-1.5">
              {onSendToS2V && outputFilename && (
                <button
                  onClick={handleSendToS2V}
                  className="text-[9px] text-muted-foreground hover:text-emerald-400 flex items-center gap-0.5"
                  disabled={sendingToS2V}
                >
                  {sendingToS2V ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} S2V
                </button>
              )}
              <button onClick={handleDownload} className="text-muted-foreground hover:text-rose-400">
                <Download className="w-3 h-3" />
              </button>
            </div>
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio ref={audioPlayerRef} src={outputAudioUrl} controls className="w-full h-8" />
        </div>
      )}
    </div>
  );
}
