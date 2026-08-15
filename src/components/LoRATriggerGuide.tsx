"use client";

import { useMemo } from "react";
import { Info } from "lucide-react";
import { getLoRATriggerInfo, LoRATriggerInfo } from "@/lib/types";

interface LoRATriggerGuideProps {
  /** List of currently selected LoRA filenames */
  selectedLoras: string[];
  /** Callback to append text to the prompt */
  onInsertToPrompt: (text: string) => void;
}

/**
 * Displays trigger word guidance for selected LoRAs.
 * Shows trigger badges (click to insert), tips, and preset buttons (1-5)
 * that dynamically change based on selected LoRAs.
 */
export default function LoRATriggerGuide({
  selectedLoras,
  onInsertToPrompt,
}: LoRATriggerGuideProps) {
  // Collect trigger info for all selected LoRAs (deduplicated)
  const loraInfos = useMemo(() => {
    const seen = new Set<string>();
    const result: { name: string; info: LoRATriggerInfo }[] = [];
    for (const lora of selectedLoras) {
      if (!lora || seen.has(lora)) continue;
      seen.add(lora);
      const info = getLoRATriggerInfo(lora);
      if (info) result.push({ name: lora, info });
    }
    return result;
  }, [selectedLoras]);

  // Merge all presets from all matched LoRAs, capped at 5
  const mergedPresets = useMemo(() => {
    const all: { label: string; text: string; source: string }[] = [];
    for (const { name, info } of loraInfos) {
      if (info.presets) {
        for (const p of info.presets) {
          all.push({ ...p, source: name });
        }
      }
    }
    // If multiple LoRAs, re-number the merged presets
    if (loraInfos.length > 1) {
      return all.slice(0, 5).map((p, i) => ({
        ...p,
        label: `${i + 1}: ${p.label.replace(/^\d+:\s*/, "")}`,
      }));
    }
    return all.slice(0, 5);
  }, [loraInfos]);

  if (loraInfos.length === 0) return null;

  return (
    <div className="space-y-1.5 mt-1.5">
      {loraInfos.map(({ name, info }) => (
        <div
          key={name}
          className="rounded border border-violet-500/20 bg-violet-500/5 px-2.5 py-1.5 space-y-1"
        >
          {/* Header */}
          <div className="flex items-center gap-1">
            <Info className="w-3 h-3 text-violet-400 shrink-0" />
            <span className="text-[9px] text-violet-400 font-medium truncate max-w-[260px]">
              {name.replace(/\.(safetensors|gguf|ckpt|pt)$/i, "")}
            </span>
          </div>

          {/* Trigger word badges */}
          {info.triggers.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {info.triggers.map((t) => (
                <button
                  key={t}
                  className="text-[9px] font-mono bg-violet-500/15 text-violet-300 px-1.5 py-0.5 rounded hover:bg-violet-500/30 transition-colors cursor-pointer border border-violet-500/20"
                  onClick={() => onInsertToPrompt(t)}
                  title={`Click to insert "${t}" into prompt`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          {/* Tips (scrollable if many) */}
          {info.tips && info.tips.length > 0 && (
            <div className="max-h-[40px] overflow-y-auto">
              {info.tips.map((tip, i) => (
                <p key={i} className="text-[8px] text-muted-foreground/70 leading-tight">
                  {tip}
                </p>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Preset buttons: merged from all active LoRAs */}
      {mergedPresets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {mergedPresets.map((p) => (
            <button
              key={p.label}
              className="text-[9px] bg-background border border-violet-500/25 text-violet-300/80 px-2 py-0.5 rounded hover:bg-violet-500/15 hover:text-violet-300 transition-colors"
              onClick={() => onInsertToPrompt(p.text)}
              title={p.text}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
