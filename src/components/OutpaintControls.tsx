"use client";

import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { OutpaintConfig, OutpaintDirection } from "@/lib/types";
import { calculatePadding } from "@/lib/outpaint-utils";
import { ArrowLeft, ArrowRight, ArrowUp, ArrowDown } from "lucide-react";

interface Props {
  config: OutpaintConfig;
  onChange: (config: OutpaintConfig) => void;
  sourceWidth: number;
  sourceHeight: number;
}

const DIRECTIONS: { key: OutpaintDirection; label: string; Icon: typeof ArrowLeft }[] = [
  { key: "left", label: "Left", Icon: ArrowLeft },
  { key: "right", label: "Right", Icon: ArrowRight },
  { key: "top", label: "Top", Icon: ArrowUp },
  { key: "bottom", label: "Bottom", Icon: ArrowDown },
];

export default function OutpaintControls({ config, onChange, sourceWidth, sourceHeight }: Props) {
  const activeCount = Object.values(config.directions).filter(Boolean).length;

  const toggleDir = (dir: OutpaintDirection) => {
    onChange({
      ...config,
      directions: { ...config.directions, [dir]: !config.directions[dir] },
    });
  };

  const setPct = (dir: OutpaintDirection, pct: number) => {
    onChange({
      ...config,
      percentages: { ...config.percentages, [dir]: pct },
    });
  };

  // Calculate expanded dimensions
  const pad = sourceWidth > 0 ? calculatePadding(sourceWidth, sourceHeight, config) : null;

  return (
    <div className="space-y-3">
      {/* Direction toggles */}
      <div>
        <Label className="text-xs text-muted-foreground mb-1.5 block">Outpaint Direction</Label>
        <div className="flex gap-1.5">
          {DIRECTIONS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => toggleDir(key)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md border text-xs font-medium transition-all ${
                config.directions[key]
                  ? "bg-violet-600 border-violet-500 text-white shadow-sm shadow-violet-500/20"
                  : "bg-muted/30 border-border/50 text-muted-foreground hover:bg-muted/50 hover:border-border"
              }`}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Per-direction percentage sliders (only show active directions) */}
      {activeCount > 0 && (
        <div className="space-y-2.5 pt-1">
          {DIRECTIONS.filter(({ key }) => config.directions[key]).map(({ key, label }) => {
            const pct = config.percentages[key];
            const isHorizontal = key === "left" || key === "right";
            const baseDim = isHorizontal ? sourceWidth : sourceHeight;
            const pixelExpansion = sourceWidth > 0 ? Math.ceil(baseDim * (pct / 100) / 8) * 8 : 0;

            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground">{label} Expansion</Label>
                  <span className="text-[10px] font-mono text-violet-400">
                    {pct}%{" "}
                    <span className="text-muted-foreground">
                      ({pixelExpansion}px)
                    </span>
                  </span>
                </div>
                <Slider
                  value={[pct]}
                  onValueChange={([v]) => setPct(key, v)}
                  min={5}
                  max={100}
                  step={5}
                  className="h-4"
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Dimension readout */}
      {activeCount > 0 && pad && sourceWidth > 0 && (
        <div className="rounded-md border border-violet-500/20 bg-violet-500/5 px-3 py-2">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground">Original</span>
            <span className="font-mono text-muted-foreground">{sourceWidth} × {sourceHeight}</span>
          </div>
          <div className="flex items-center justify-between text-[10px] mt-0.5">
            <span className="text-violet-400 font-medium">Expanded</span>
            <span className="font-mono text-violet-400 font-medium">
              {pad.totalWidth} × {pad.totalHeight}
            </span>
          </div>
          <div className="flex items-center justify-between text-[9px] mt-0.5">
            <span className="text-muted-foreground/60">Ratio</span>
            <span className="font-mono text-muted-foreground/60">
              {((pad.totalWidth * pad.totalHeight) / (sourceWidth * sourceHeight)).toFixed(2)}× area
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
