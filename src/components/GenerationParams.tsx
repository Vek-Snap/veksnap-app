"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Settings2, Shuffle, Monitor, Copy, RotateCcw } from "lucide-react";
import { SAMPLERS, SCHEDULERS, RESOLUTION_PRESETS, WAN_RESOLUTION_PRESETS, WAN_FRAME_PRESETS, REGION_SIZE_PRESETS, HIRES_UPSCALE_METHODS, HIRES_SCALE_PRESETS, ENHANCE_UPSCALER_MODELS, GenerationMode, ComposeOutputType, DEFAULT_PARAMS } from "@/lib/types";

interface Props {
  width: number;
  height: number;
  frames: number;
  fps: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  randomSeed: boolean;
  denoise: number;
  clipSkip: number;
  hiresEnabled: boolean;
  hiresScale: number;
  hiresSteps: number;
  hiresDenoise: number;
  hiresUpscaleMethod: string;
  enhanceEnabled: boolean;
  enhanceUpscalerModel: string;
  enhanceDenoise: number;
  enhanceSteps: number;
  adetailerEnabled: boolean;
  adetailerDenoise: number;
  adetailerCfg: number;
  adetailerSteps: number;
  batchSize: number;
  hasSourceImage?: boolean;
  mode?: GenerationMode;
  composeOutputType?: ComposeOutputType;
  lastSeed?: number | null;
  onChange: (key: string, value: number | string | boolean) => void;
}

export default function GenerationParams({
  width,
  height,
  frames,
  fps,
  steps,
  cfg,
  sampler,
  scheduler,
  seed,
  randomSeed,
  denoise,
  clipSkip,
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
  batchSize,
  hasSourceImage,
  mode = "video",
  composeOutputType = "image",
  lastSeed,
  onChange,
}: Props) {
  const isImageOnly = mode === "image" || mode === "zimage" || (mode === "compose" && composeOutputType === "image");
  const resPresets = mode === "wan" ? WAN_RESOLUTION_PRESETS : mode === "compose" ? REGION_SIZE_PRESETS : RESOLUTION_PRESETS;
  const currentPreset = resPresets.find(
    (p) => p.width === width && p.height === height
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Settings2 className="w-4 h-4" /> Generation Settings
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Resolution */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Monitor className="w-3 h-3" /> Resolution
          </Label>
          <Select
            value={currentPreset?.label ?? "custom"}
            onValueChange={(v) => {
              const preset = resPresets.find((p) => p.label === v);
              if (preset) {
                onChange("width", preset.width);
                onChange("height", preset.height);
              }
            }}
          >
            <SelectTrigger className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {resPresets.map((p) => (
                <SelectItem key={p.label} value={p.label} className="text-xs">
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px] text-muted-foreground">W</Label>
              <Input
                type="number"
                value={width}
                onChange={(e) => onChange("width", parseInt(e.target.value) || 512)}
                className="text-xs h-8"
                min={256}
                max={1024}
                step={64}
              />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">H</Label>
              <Input
                type="number"
                value={height}
                onChange={(e) => onChange("height", parseInt(e.target.value) || 512)}
                className="text-xs h-8"
                min={256}
                max={1024}
                step={64}
              />
            </div>
          </div>
        </div>

        {/* Frames & FPS (hidden for image-only modes) */}
        {!isImageOnly && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">{mode === "wan" ? "Length" : "Frames"}</Label>
              <span className="text-xs font-mono text-muted-foreground">{frames}{mode === "wan" ? "f" : ""}</span>
            </div>
            {mode === "wan" ? (
              <Select value={String(frames)} onValueChange={(v) => onChange("frames", parseInt(v))}>
                <SelectTrigger className="w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WAN_FRAME_PRESETS.map((f) => (
                    <SelectItem key={f} value={String(f)} className="text-xs">
                      {f} frames (~{(f / 16).toFixed(1)}s @16fps)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Slider
                value={[frames]}
                onValueChange={([v]) => onChange("frames", v)}
                min={4}
                max={32}
                step={1}
              />
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">FPS</Label>
              <span className="text-xs font-mono text-muted-foreground">{fps}</span>
            </div>
            <Slider
              value={[fps]}
              onValueChange={([v]) => onChange("fps", v)}
              min={4}
              max={30}
              step={1}
            />
          </div>
        </div>
        )}

        {/* Batch Size (still image modes only) */}
        {(mode === "image" || mode === "compose" || mode === "zimage") && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Batch Size</Label>
              <span className="text-xs font-mono text-muted-foreground">{batchSize}</span>
            </div>
            <Slider
              value={[batchSize]}
              onValueChange={([v]) => onChange("batchSize", v)}
              min={1}
              max={16}
              step={1}
            />
          </div>
        )}

        {/* Steps */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Steps</Label>
            <span className="text-xs font-mono text-muted-foreground">{steps}</span>
          </div>
          <Slider
            value={[steps]}
            onValueChange={([v]) => onChange("steps", v)}
            min={1}
            max={50}
            step={1}
          />
        </div>

        {/* CFG Scale */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">CFG Scale</Label>
            <span className="text-xs font-mono text-muted-foreground">{cfg.toFixed(1)}</span>
          </div>
          <Slider
            value={[cfg]}
            onValueChange={([v]) => onChange("cfg", v)}
            min={1}
            max={20}
            step={0.5}
          />
        </div>

        {/* Denoise */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Denoise</Label>
            <span className="text-xs font-mono text-muted-foreground">{denoise.toFixed(2)}</span>
          </div>
          <Slider
            value={[denoise]}
            onValueChange={([v]) => onChange("denoise", v)}
            min={0}
            max={1}
            step={0.05}
          />
          {hasSourceImage && denoise > 0.8 && (
            <p className="text-[10px] text-yellow-500">
              {mode === "compose" ? "Tip: For inpaint, use 0.4–0.7 to preserve region content. Lower = less change." : "Tip: For I2V, use 0.5–0.75 to preserve source image content. Lower = closer to original."}
            </p>
          )}
        </div>

        {/* CLIP Skip */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">CLIP Skip</Label>
            <span className="text-xs font-mono text-muted-foreground">{clipSkip}</span>
          </div>
          <Slider
            value={[clipSkip]}
            onValueChange={([v]) => onChange("clipSkip", v)}
            min={1}
            max={12}
            step={1}
          />
        </div>

        {/* Sampler & Scheduler */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Sampler</Label>
            <Select value={sampler} onValueChange={(v) => onChange("sampler", v)}>
              <SelectTrigger className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SAMPLERS.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Scheduler</Label>
            <Select value={scheduler} onValueChange={(v) => onChange("scheduler", v)}>
              <SelectTrigger className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULERS.map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Seed */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Seed</Label>
            <div className="flex items-center gap-2">
              <Label className="text-[10px] text-muted-foreground">Random</Label>
              <Switch
                checked={randomSeed}
                onCheckedChange={(v) => onChange("randomSeed", v)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Input
              type="number"
              value={seed}
              onChange={(e) => onChange("seed", parseInt(e.target.value) || 0)}
              className="text-xs h-8 font-mono"
              disabled={randomSeed}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => onChange("seed", Math.floor(Math.random() * 2 ** 32))}
              disabled={randomSeed}
            >
              <Shuffle className="w-3 h-3" />
            </Button>
          </div>
          {lastSeed != null && (
            <div className="flex items-center gap-2 mt-1.5 px-1 py-1 rounded bg-muted/30 border border-border">
              <span className="text-[10px] text-muted-foreground">Last used:</span>
              <span className="text-[10px] font-mono text-foreground flex-1 truncate">{lastSeed}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0"
                onClick={() => {
                  onChange("seed", lastSeed);
                  onChange("randomSeed", false);
                }}
                title="Reuse this seed"
              >
                <Copy className="w-3 h-3" />
              </Button>
            </div>
          )}
        </div>

        {/* ── HiRes Fix (still image modes only) ── */}
        {(mode === "image" || mode === "compose") && (
          <div className="space-y-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-amber-400 font-medium">HiRes Fix</Label>
              <div className="flex items-center gap-1">
                {hiresEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      onChange("hiresScale", DEFAULT_PARAMS.hiresScale);
                      onChange("hiresDenoise", DEFAULT_PARAMS.hiresDenoise);
                      onChange("hiresSteps", DEFAULT_PARAMS.hiresSteps);
                      onChange("hiresUpscaleMethod", DEFAULT_PARAMS.hiresUpscaleMethod);
                    }}
                    className="p-0.5 rounded hover:bg-amber-500/20 text-amber-400/60 hover:text-amber-400 transition-colors"
                    title="Reset HiRes Fix to defaults"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
                <Switch
                  checked={hiresEnabled}
                  onCheckedChange={(v) => onChange("hiresEnabled", v)}
                  className="scale-75"
                />
              </div>
            </div>
            {hiresEnabled && (
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">Upscale</Label>
                  <div className="flex gap-1">
                    {HIRES_SCALE_PRESETS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => onChange("hiresScale", p.value)}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors ${
                          hiresScale === p.value
                            ? "bg-amber-500/20 text-amber-400"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-[9px] text-muted-foreground">
                  Output: {Math.round(width * hiresScale)}×{Math.round(height * hiresScale)}
                </p>
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">Denoise</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{hiresDenoise.toFixed(2)}</span>
                </div>
                <Slider
                  value={[hiresDenoise]}
                  onValueChange={([v]) => onChange("hiresDenoise", v)}
                  min={0.1}
                  max={0.8}
                  step={0.05}
                />
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">Steps</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{hiresSteps}</span>
                </div>
                <Slider
                  value={[hiresSteps]}
                  onValueChange={([v]) => onChange("hiresSteps", v)}
                  min={5}
                  max={50}
                  step={1}
                />
                <div className="space-y-1">
                  <Label className="text-[10px] text-muted-foreground">Method</Label>
                  <Select value={hiresUpscaleMethod} onValueChange={(v) => onChange("hiresUpscaleMethod", v)}>
                    <SelectTrigger className="w-full text-[10px] h-7">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HIRES_UPSCALE_METHODS.map((m) => (
                        <SelectItem key={m.value} value={m.value} className="text-[10px]">{m.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Enhance Details (still image modes only) ── */}
        {(mode === "image" || mode === "compose") && (
          <div className="space-y-2 rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-indigo-400 font-medium">Enhance Details</Label>
              <div className="flex items-center gap-1">
                {enhanceEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      onChange("enhanceUpscalerModel", DEFAULT_PARAMS.enhanceUpscalerModel);
                      onChange("enhanceDenoise", DEFAULT_PARAMS.enhanceDenoise);
                      onChange("enhanceSteps", DEFAULT_PARAMS.enhanceSteps);
                    }}
                    className="p-0.5 rounded hover:bg-indigo-500/20 text-indigo-400/60 hover:text-indigo-400 transition-colors"
                    title="Reset Enhance Details to defaults"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
                <Switch
                  checked={enhanceEnabled}
                  onCheckedChange={(v) => onChange("enhanceEnabled", v)}
                  className="scale-75"
                />
              </div>
            </div>
            {enhanceEnabled && (
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">Upscaler Model</Label>
                </div>
                <Select value={enhanceUpscalerModel} onValueChange={(v) => onChange("enhanceUpscalerModel", v)}>
                  <SelectTrigger className="h-7 text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENHANCE_UPSCALER_MODELS.map((m) => (
                      <SelectItem key={m.value} value={m.value} className="text-[10px]">{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">Denoise</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{enhanceDenoise.toFixed(2)}</span>
                </div>
                <Slider
                  value={[enhanceDenoise]}
                  onValueChange={([v]) => onChange("enhanceDenoise", v)}
                  min={0.1}
                  max={0.7}
                  step={0.01}
                />
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">Steps</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{enhanceSteps}</span>
                </div>
                <Slider
                  value={[enhanceSteps]}
                  onValueChange={([v]) => onChange("enhanceSteps", v)}
                  min={5}
                  max={40}
                  step={1}
                />
                <p className="text-[9px] text-muted-foreground">
                  Vek-Snap style: ESRGAN upscale → img2img refinement. Uses HiRes scale factor ({hiresScale}x).
                  Place model in ComfyUI/models/upscale_models/.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── ADetailer / FaceDetailer (still image modes only) ── */}
        {(mode === "image" || mode === "compose") && (
          <div className="space-y-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-emerald-400 font-medium">ADetailer (Face Fix)</Label>
              <div className="flex items-center gap-1">
                {adetailerEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      onChange("adetailerDenoise", DEFAULT_PARAMS.adetailerDenoise);
                      onChange("adetailerCfg", DEFAULT_PARAMS.adetailerCfg);
                      onChange("adetailerSteps", DEFAULT_PARAMS.adetailerSteps);
                    }}
                    className="p-0.5 rounded hover:bg-emerald-500/20 text-emerald-400/60 hover:text-emerald-400 transition-colors"
                    title="Reset ADetailer to defaults"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
                <Switch
                  checked={adetailerEnabled}
                  onCheckedChange={(v) => onChange("adetailerEnabled", v)}
                  className="scale-75"
                />
              </div>
            </div>
            {adetailerEnabled && (
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">Denoise</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{adetailerDenoise.toFixed(2)}</span>
                </div>
                <Slider
                  value={[adetailerDenoise]}
                  onValueChange={([v]) => onChange("adetailerDenoise", v)}
                  min={0.1}
                  max={0.8}
                  step={0.05}
                />
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">CFG</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{adetailerCfg.toFixed(1)}</span>
                </div>
                <Slider
                  value={[adetailerCfg]}
                  onValueChange={([v]) => onChange("adetailerCfg", v)}
                  min={1}
                  max={20}
                  step={0.5}
                />
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">Steps</Label>
                  <span className="text-[10px] font-mono text-muted-foreground">{adetailerSteps}</span>
                </div>
                <Slider
                  value={[adetailerSteps]}
                  onValueChange={([v]) => onChange("adetailerSteps", v)}
                  min={5}
                  max={50}
                  step={1}
                />
                <p className="text-[9px] text-muted-foreground">
                  Requires ComfyUI-Impact-Pack. Auto-detects and refines faces.
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
