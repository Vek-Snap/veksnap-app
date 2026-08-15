"use client";

import { useState, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Wand2, Check, Loader2, ImageIcon, RotateCcw } from "lucide-react";
import ModelSelector from "@/components/ModelSelector";
import LoraSelector from "@/components/LoraSelector";
import EmbeddingSelector from "@/components/EmbeddingSelector";
import {
  GenerationParams,
  DEFAULT_PARAMS,
  LoraEntry,
  EmbeddingEntry,
  SAMPLERS,
  SCHEDULERS,
  RESOLUTION_PRESETS,
  HIRES_UPSCALE_METHODS,
  HIRES_SCALE_PRESETS,
  ENHANCE_UPSCALER_MODELS,
} from "@/lib/types";
import { buildWorkflow } from "@/lib/workflow-builder";
import {
  queuePrompt,
  getHistory,
  uploadImage,
  getImageUrl,
} from "@/lib/comfyui-api";

interface Props {
  open: boolean;
  onClose: () => void;
  onAccept: (filename: string) => void;
  initialPrompt: string;
  segmentIndex: number;
  slot: "start" | "end";
  mainWidth: number;
  mainHeight: number;
  clientId: string;
}

export default function KeyframeGeneratorModal({
  open,
  onClose,
  onAccept,
  initialPrompt,
  segmentIndex,
  slot,
  mainWidth,
  mainHeight,
  clientId,
}: Props) {
  // ── Persistent generation params (survive modal close/reopen) ──
  const [checkpoint, setCheckpoint] = useState("");
  const [loras, setLoras] = useState<LoraEntry[]>([]);
  const [embeddings, setEmbeddings] = useState<EmbeddingEntry[]>([]);
  const [positivePrompt, setPositivePrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_PARAMS.negativePrompt);
  const [width, setWidth] = useState(mainWidth || 512);
  const [height, setHeight] = useState(mainHeight || 512);
  const [steps, setSteps] = useState(25);
  const [cfg, setCfg] = useState(7.0);
  const [denoise, setDenoise] = useState(1.0);
  const [clipSkip, setClipSkip] = useState(2);
  const [sampler, setSampler] = useState("dpmpp_2m");
  const [scheduler, setScheduler] = useState("karras");
  const [hiresEnabled, setHiresEnabled] = useState(false);
  const [hiresScale, setHiresScale] = useState(2.0);
  const [hiresSteps, setHiresSteps] = useState(20);
  const [hiresDenoise, setHiresDenoise] = useState(0.45);
  const [hiresUpscaleMethod, setHiresUpscaleMethod] = useState("bislerp");
  const [enhanceEnabled, setEnhanceEnabled] = useState(false);
  const [enhanceUpscalerModel, setEnhanceUpscalerModel] = useState("RealESRGAN_x4plus.pth");
  const [enhanceDenoise, setEnhanceDenoise] = useState(0.35);
  const [enhanceSteps, setEnhanceSteps] = useState(15);
  const [adetailerEnabled, setAdetailerEnabled] = useState(false);
  const [adetailerDenoise, setAdetailerDenoise] = useState(0.4);
  const [adetailerCfg, setAdetailerCfg] = useState(7.0);
  const [adetailerSteps, setAdetailerSteps] = useState(20);

  // ── Generation state ──
  const [generating, setGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFilename, setPreviewFilename] = useState<string | null>(null);
  const [previewSubfolder, setPreviewSubfolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const promptInitialized = useRef(false);

  // Sync initial prompt when modal opens with new content
  if (open && initialPrompt && !promptInitialized.current) {
    setPositivePrompt(initialPrompt);
    promptInitialized.current = true;
  }
  if (!open && promptInitialized.current) {
    promptInitialized.current = false;
  }

  // ── Build params and generate ──
  const handleGenerate = useCallback(async () => {
    if (!checkpoint) {
      setError("Select a checkpoint model first");
      return;
    }
    setGenerating(true);
    setError(null);
    setPreviewUrl(null);
    setPreviewFilename(null);
    try {
      const genParams: GenerationParams = {
        ...DEFAULT_PARAMS,
        checkpoint,
        positivePrompt,
        negativePrompt,
        width,
        height,
        steps,
        cfg,
        denoise,
        clipSkip,
        sampler,
        scheduler,
        seed: -1,
        randomSeed: true,
        loras,
        embeddings,
        hiresEnabled,
        hiresScale,
        hiresSteps,
        hiresDenoise,
        hiresUpscaleMethod,
        enhanceEnabled,
        enhanceUpscalerModel,
        enhanceDenoise,
        enhanceSteps,
        adetailerEnabled,
        adetailerDenoise,
        adetailerCfg,
        adetailerSteps,
      };

      const workflow = buildWorkflow(genParams, "image");
      const response = await queuePrompt(workflow, clientId);

      // Poll for completion (max 3 min for HiRes + ADetailer)
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const history = await getHistory(response.prompt_id);
        if (history?.status?.completed) {
          const outputs = history.outputs;
          for (const nodeId of Object.keys(outputs || {})) {
            const nodeOut = outputs![nodeId];
            if (nodeOut.images && nodeOut.images.length > 0) {
              const img = nodeOut.images[0];
              setPreviewUrl(getImageUrl(img.filename, img.subfolder, img.type));
              setPreviewFilename(img.filename);
              setPreviewSubfolder(img.subfolder || "");
              setGenerating(false);
              return;
            }
          }
          throw new Error("No image output found");
        }
      }
      throw new Error("Generation timed out (3 min)");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [
    checkpoint, positivePrompt, negativePrompt, width, height, steps, cfg,
    denoise, clipSkip, sampler, scheduler, loras, embeddings, hiresEnabled,
    hiresScale, hiresSteps, hiresDenoise, hiresUpscaleMethod, enhanceEnabled,
    enhanceUpscalerModel, enhanceDenoise, enhanceSteps, adetailerEnabled,
    adetailerDenoise, adetailerCfg, adetailerSteps, clientId,
  ]);

  // ── Accept: upload output image as input, return filename ──
  const handleAccept = useCallback(async () => {
    if (!previewUrl || !previewFilename) return;
    setGenerating(true);
    try {
      const res = await fetch(previewUrl);
      const blob = await res.blob();
      const file = new File([blob], `keyframe_s${segmentIndex}_${slot}.png`, { type: "image/png" });
      const name = await uploadImage(file);
      onAccept(name);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload keyframe");
    } finally {
      setGenerating(false);
    }
  }, [previewUrl, previewFilename, segmentIndex, slot, onAccept, onClose]);

  const currentRes = RESOLUTION_PRESETS.find((p) => p.width === width && p.height === height);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[95vw] max-w-6xl h-[90vh] p-0 gap-0 overflow-hidden flex flex-col">
        <DialogHeader className="px-4 pt-4 pb-2 border-b">
          <DialogTitle className="text-sm flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-emerald-400" />
            Generate Keyframe: Shot {segmentIndex + 1} ({slot})
          </DialogTitle>
          <DialogDescription className="text-[10px]">
            Configure a still-image generation with checkpoint, LoRAs, embeddings, and quality settings.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* ── Left Column: Model / LoRA / Embedding Selection ── */}
          <ScrollArea className="w-[380px] min-w-[380px] border-r h-full">
            <div className="p-3 space-y-3">
              <ModelSelector
                checkpoint={checkpoint}
                motionModule=""
                mode="image"
                hideMotionModule={true}
                onCheckpointChange={setCheckpoint}
                onMotionModuleChange={() => {}}
              />
              <LoraSelector loras={loras} onChange={setLoras} mode="image" />
              <EmbeddingSelector embeddings={embeddings} onChange={setEmbeddings} />
            </div>
          </ScrollArea>

          {/* ── Right Column: Prompts / Params / Preview ── */}
          <ScrollArea className="flex-1 h-full">
            <div className="p-3 space-y-3">
              {/* Prompts */}
              <div className="space-y-1.5">
                <Label className="text-[10px] text-muted-foreground font-medium">Positive Prompt</Label>
                <textarea
                  value={positivePrompt}
                  onChange={(e) => setPositivePrompt(e.target.value)}
                  rows={3}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                  placeholder="masterpiece, best quality, cinematic, ..."
                />
                <Label className="text-[10px] text-muted-foreground font-medium">Negative Prompt</Label>
                <textarea
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  rows={2}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                  placeholder="low quality, blurry, ..."
                />
              </div>

              {/* Resolution */}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground font-medium">Resolution</Label>
                <div className="flex flex-wrap gap-1">
                  {RESOLUTION_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => { setWidth(p.width); setHeight(p.height); }}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors ${
                        width === p.width && height === p.height
                          ? "bg-primary/20 text-primary"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Core Generation Params: compact 2-column grid */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                {/* Steps */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-muted-foreground">Steps</Label>
                    <span className="text-[10px] font-mono text-muted-foreground">{steps}</span>
                  </div>
                  <Slider value={[steps]} onValueChange={([v]) => setSteps(v)} min={1} max={50} step={1} />
                </div>
                {/* CFG */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-muted-foreground">CFG</Label>
                    <span className="text-[10px] font-mono text-muted-foreground">{cfg.toFixed(1)}</span>
                  </div>
                  <Slider value={[cfg]} onValueChange={([v]) => setCfg(v)} min={1} max={20} step={0.5} />
                </div>
                {/* Denoise */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-muted-foreground">Denoise</Label>
                    <span className="text-[10px] font-mono text-muted-foreground">{denoise.toFixed(2)}</span>
                  </div>
                  <Slider value={[denoise]} onValueChange={([v]) => setDenoise(v)} min={0.01} max={1} step={0.01} />
                </div>
                {/* CLIP Skip */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] text-muted-foreground">CLIP Skip</Label>
                    <span className="text-[10px] font-mono text-muted-foreground">{clipSkip}</span>
                  </div>
                  <Slider value={[clipSkip]} onValueChange={([v]) => setClipSkip(v)} min={1} max={12} step={1} />
                </div>
                {/* Sampler */}
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Sampler</Label>
                  <Select value={sampler} onValueChange={setSampler}>
                    <SelectTrigger className="w-full text-[10px] h-7">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SAMPLERS.map((s) => (
                        <SelectItem key={s} value={s} className="text-[10px]">{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* Scheduler */}
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Scheduler</Label>
                  <Select value={scheduler} onValueChange={setScheduler}>
                    <SelectTrigger className="w-full text-[10px] h-7">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCHEDULERS.map((s) => (
                        <SelectItem key={s} value={s} className="text-[10px]">{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* HiRes Fix */}
              <div className="space-y-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-[10px] text-amber-400 font-medium">HiRes Fix</Label>
                    {hiresEnabled && (
                      <button
                        type="button"
                        onClick={() => { setHiresScale(2.0); setHiresSteps(20); setHiresDenoise(0.45); setHiresUpscaleMethod("bislerp"); }}
                        className="text-amber-400/40 hover:text-amber-400 transition-colors"
                        title="Reset HiRes Fix to defaults"
                      >
                        <RotateCcw className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <Switch checked={hiresEnabled} onCheckedChange={setHiresEnabled} className="scale-75" />
                </div>
                {hiresEnabled && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-[9px] text-muted-foreground">Scale</Label>
                      <div className="flex gap-1">
                        {HIRES_SCALE_PRESETS.map((p) => (
                          <button
                            key={p.value}
                            type="button"
                            onClick={() => setHiresScale(p.value)}
                            className={`px-1 py-0.5 rounded text-[8px] font-mono transition-colors ${
                              hiresScale === p.value ? "bg-amber-500/20 text-amber-400" : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <p className="text-[8px] text-muted-foreground">
                      Output: {Math.round(width * hiresScale)}×{Math.round(height * hiresScale)}
                    </p>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                      <div className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[9px] text-muted-foreground">Denoise</Label>
                          <span className="text-[9px] font-mono text-muted-foreground">{hiresDenoise.toFixed(2)}</span>
                        </div>
                        <Slider value={[hiresDenoise]} onValueChange={([v]) => setHiresDenoise(v)} min={0.1} max={0.8} step={0.05} />
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[9px] text-muted-foreground">Steps</Label>
                          <span className="text-[9px] font-mono text-muted-foreground">{hiresSteps}</span>
                        </div>
                        <Slider value={[hiresSteps]} onValueChange={([v]) => setHiresSteps(v)} min={5} max={50} step={1} />
                      </div>
                    </div>
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground">Method</Label>
                      <Select value={hiresUpscaleMethod} onValueChange={setHiresUpscaleMethod}>
                        <SelectTrigger className="w-full text-[9px] h-6"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {HIRES_UPSCALE_METHODS.map((m) => (
                            <SelectItem key={m.value} value={m.value} className="text-[9px]">{m.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </div>

              {/* Enhance Details */}
              <div className="space-y-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-2.5 py-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-[10px] text-indigo-400 font-medium">Enhance Details</Label>
                    {enhanceEnabled && (
                      <button
                        type="button"
                        onClick={() => { setEnhanceUpscalerModel("RealESRGAN_x4plus.pth"); setEnhanceDenoise(0.35); setEnhanceSteps(15); }}
                        className="text-indigo-400/40 hover:text-indigo-400 transition-colors"
                        title="Reset Enhance Details to defaults"
                      >
                        <RotateCcw className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <Switch checked={enhanceEnabled} onCheckedChange={setEnhanceEnabled} className="scale-75" />
                </div>
                {enhanceEnabled && (
                  <div className="space-y-1">
                    <div className="space-y-0.5">
                      <Label className="text-[9px] text-muted-foreground">Upscaler Model</Label>
                      <Select value={enhanceUpscalerModel} onValueChange={setEnhanceUpscalerModel}>
                        <SelectTrigger className="w-full text-[9px] h-6"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ENHANCE_UPSCALER_MODELS.map((m) => (
                            <SelectItem key={m.value} value={m.value} className="text-[9px]">{m.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                      <div className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[9px] text-muted-foreground">Denoise</Label>
                          <span className="text-[9px] font-mono text-muted-foreground">{enhanceDenoise.toFixed(2)}</span>
                        </div>
                        <Slider value={[enhanceDenoise]} onValueChange={([v]) => setEnhanceDenoise(v)} min={0.1} max={0.7} step={0.01} />
                      </div>
                      <div className="space-y-0.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-[9px] text-muted-foreground">Steps</Label>
                          <span className="text-[9px] font-mono text-muted-foreground">{enhanceSteps}</span>
                        </div>
                        <Slider value={[enhanceSteps]} onValueChange={([v]) => setEnhanceSteps(v)} min={5} max={40} step={1} />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* ADetailer */}
              <div className="space-y-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-[10px] text-emerald-400 font-medium">ADetailer (Face Fix)</Label>
                    {adetailerEnabled && (
                      <button
                        type="button"
                        onClick={() => { setAdetailerDenoise(0.4); setAdetailerCfg(7.0); setAdetailerSteps(20); }}
                        className="text-emerald-400/40 hover:text-emerald-400 transition-colors"
                        title="Reset ADetailer to defaults"
                      >
                        <RotateCcw className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <Switch checked={adetailerEnabled} onCheckedChange={setAdetailerEnabled} className="scale-75" />
                </div>
                {adetailerEnabled && (
                  <div className="grid grid-cols-3 gap-x-2 gap-y-1">
                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-[9px] text-muted-foreground">Denoise</Label>
                        <span className="text-[9px] font-mono text-muted-foreground">{adetailerDenoise.toFixed(2)}</span>
                      </div>
                      <Slider value={[adetailerDenoise]} onValueChange={([v]) => setAdetailerDenoise(v)} min={0.1} max={0.8} step={0.05} />
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-[9px] text-muted-foreground">CFG</Label>
                        <span className="text-[9px] font-mono text-muted-foreground">{adetailerCfg.toFixed(1)}</span>
                      </div>
                      <Slider value={[adetailerCfg]} onValueChange={([v]) => setAdetailerCfg(v)} min={1} max={20} step={0.5} />
                    </div>
                    <div className="space-y-0.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-[9px] text-muted-foreground">Steps</Label>
                        <span className="text-[9px] font-mono text-muted-foreground">{adetailerSteps}</span>
                      </div>
                      <Slider value={[adetailerSteps]} onValueChange={([v]) => setAdetailerSteps(v)} min={5} max={50} step={1} />
                    </div>
                  </div>
                )}
              </div>

              {/* ── Preview Area ── */}
              <div className="rounded-lg border border-border bg-black/20 min-h-[200px] flex items-center justify-center relative overflow-hidden">
                {generating ? (
                  <div className="text-center space-y-2">
                    <Loader2 className="w-8 h-8 text-emerald-400 animate-spin mx-auto" />
                    <p className="text-xs text-muted-foreground">Generating keyframe...</p>
                    {hiresEnabled && <p className="text-[9px] text-amber-400/60">HiRes Fix enabled: this may take longer</p>}
                  </div>
                ) : previewUrl ? (
                  <img
                    src={previewUrl}
                    alt="Generated keyframe"
                    className="max-w-full max-h-[300px] object-contain"
                  />
                ) : (
                  <div className="text-center space-y-1">
                    <ImageIcon className="w-8 h-8 text-muted-foreground/30 mx-auto" />
                    <p className="text-[10px] text-muted-foreground/50">
                      Configure settings and click Generate
                    </p>
                  </div>
                )}
              </div>

              {error && (
                <p className="text-[10px] text-red-400 bg-red-500/10 rounded px-2 py-1">{error}</p>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* ── Footer: Action Buttons ── */}
        <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/20">
          <Button variant="outline" size="sm" onClick={onClose} disabled={generating}>
            Cancel
          </Button>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleGenerate}
              disabled={generating || !checkpoint}
              className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
            >
              {generating ? (
                <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Generating...</>
              ) : (
                <><Wand2 className="w-3 h-3 mr-1.5" /> Generate</>
              )}
            </Button>
            {previewUrl && !generating && (
              <Button
                size="sm"
                onClick={handleAccept}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                <Check className="w-3 h-3 mr-1.5" /> Use as Keyframe
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
