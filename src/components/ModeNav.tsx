"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ImageIcon,
  Film,
  Volume2,
  Wrench,
  Zap,
  Sparkles,
  Mic,
  Clapperboard,
  Wand2,
  Layers,
  Scissors,
  RefreshCw,
  Music,
  Video,
  Heart,
  Mic2,
  Package,
  ShieldCheck,
} from "lucide-react";
import type { GenerationMode } from "@/lib/types";

// ── Category definitions ──

type Category = "image" | "video" | "audio" | "utility";

interface ModeEntry {
  value: GenerationMode;
  label: string;
  icon?: React.ReactNode;
}

interface CategoryDef {
  id: Category;
  label: string;
  icon: React.ReactNode;
  color: string;        // active accent (tailwind arbitrary)
  modes: ModeEntry[];
}

const CATEGORIES: CategoryDef[] = [
  {
    id: "image",
    label: "Image",
    icon: <ImageIcon className="w-3.5 h-3.5" />,
    color: "sky",
    modes: [
      { value: "image", label: "Still Image" },
      { value: "zimage", label: "Z-Image", icon: <Zap className="w-3 h-3" /> },
      { value: "compose", label: "Re-Imagine", icon: <Wand2 className="w-3 h-3" /> },
    ],
  },
  {
    id: "video",
    label: "Video",
    icon: <Film className="w-3.5 h-3.5" />,
    color: "violet",
    modes: [
      { value: "ltx2", label: "LTX-2", icon: <Film className="w-3 h-3" /> },
      { value: "ltx25", label: "LTX-2.5", icon: <Film className="w-3 h-3" /> },
      { value: "director", label: "Director", icon: <Clapperboard className="w-3 h-3" /> },
      { value: "moviemaker", label: "VS - Movie Maker", icon: <Clapperboard className="w-3 h-3" /> },
      { value: "wan", label: "Wan 2.1" },
      { value: "wan_remix", label: "WAN Story", icon: <Sparkles className="w-3 h-3" /> },
      { value: "video", label: "AnimateDiff" },
      { value: "edit", label: "Edit Video", icon: <Scissors className="w-3 h-3" /> },
      { value: "lipsync", label: "Lip-Sync", icon: <Mic2 className="w-3 h-3" /> },
    ],
  },
  {
    id: "audio",
    label: "Audio",
    icon: <Volume2 className="w-3.5 h-3.5" />,
    color: "emerald",
    modes: [
      { value: "wan_s2v", label: "WAN S2V", icon: <Video className="w-3 h-3" /> },
      { value: "acestep", label: "AceStep", icon: <Music className="w-3 h-3" /> },
      { value: "heartmula", label: "HeartMuLa", icon: <Heart className="w-3 h-3" /> },
      { value: "dramabox", label: "DramaBox", icon: <Mic className="w-3 h-3" /> },
    ],
  },
  {
    id: "utility",
    label: "Utility",
    icon: <Wrench className="w-3.5 h-3.5" />,
    color: "amber",
    modes: [
      { value: "lora", label: "LoRA Factory", icon: <Sparkles className="w-3 h-3" /> },
      { value: "restore", label: "Restore", icon: <RefreshCw className="w-3 h-3" /> },
      { value: "components", label: "Components", icon: <Package className="w-3 h-3" /> },
      { value: "metaguard", label: "Meta-Guard", icon: <ShieldCheck className="w-3 h-3" /> },
    ],
  },
];

// Reverse lookup: mode → category
const MODE_TO_CATEGORY: Record<GenerationMode, Category> = {} as Record<GenerationMode, Category>;
for (const cat of CATEGORIES) {
  for (const m of cat.modes) {
    MODE_TO_CATEGORY[m.value] = cat.id;
  }
}

// ── Component ──

interface ModeNavProps {
  mode: GenerationMode;
  onModeChange: (mode: GenerationMode) => void;
}

export default function ModeNav({ mode, onModeChange }: ModeNavProps) {
  const [activeCategory, setActiveCategory] = useState<Category>(
    MODE_TO_CATEGORY[mode] ?? "video"
  );

  // Sync category when mode changes externally (e.g. config load)
  useEffect(() => {
    const cat = MODE_TO_CATEGORY[mode];
    if (cat && cat !== activeCategory) {
      setActiveCategory(cat);
    }
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCategoryClick = useCallback(
    (cat: Category) => {
      setActiveCategory(cat);
      // Auto-select first mode in category if current mode isn't in this category
      const catDef = CATEGORIES.find((c) => c.id === cat)!;
      const currentInCat = catDef.modes.some((m) => m.value === mode);
      if (!currentInCat) {
        onModeChange(catDef.modes[0].value);
      }
    },
    [mode, onModeChange]
  );

  const activeCatDef = CATEGORIES.find((c) => c.id === activeCategory)!;

  // Color classes per category
  const catColors: Record<Category, { activeBg: string; activeText: string; hoverBg: string; border: string; modeBg: string; modeText: string; modeHover: string }> = {
    image: {
      activeBg: "bg-sky-500/20",
      activeText: "text-sky-300",
      hoverBg: "hover:bg-sky-500/10",
      border: "border-sky-500/30",
      modeBg: "bg-sky-500/15",
      modeText: "text-sky-200",
      modeHover: "hover:bg-sky-500/10",
    },
    video: {
      activeBg: "bg-violet-500/20",
      activeText: "text-violet-300",
      hoverBg: "hover:bg-violet-500/10",
      border: "border-violet-500/30",
      modeBg: "bg-violet-500/15",
      modeText: "text-violet-200",
      modeHover: "hover:bg-violet-500/10",
    },
    audio: {
      activeBg: "bg-emerald-500/20",
      activeText: "text-emerald-300",
      hoverBg: "hover:bg-emerald-500/10",
      border: "border-emerald-500/30",
      modeBg: "bg-emerald-500/15",
      modeText: "text-emerald-200",
      modeHover: "hover:bg-emerald-500/10",
    },
    utility: {
      activeBg: "bg-amber-500/20",
      activeText: "text-amber-300",
      hoverBg: "hover:bg-amber-500/10",
      border: "border-amber-500/30",
      modeBg: "bg-amber-500/15",
      modeText: "text-amber-200",
      modeHover: "hover:bg-amber-500/10",
    },
  };

  const colors = catColors[activeCategory];

  return (
    <div className="space-y-1.5">
      {/* Tier 1: Category bar */}
      <div className="flex gap-1 p-1 rounded-lg bg-muted/50 border border-border/50">
        {CATEGORIES.map((cat) => {
          const isActive = cat.id === activeCategory;
          const c = catColors[cat.id];
          return (
            <button
              key={cat.id}
              onClick={() => handleCategoryClick(cat.id)}
              className={`
                flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5
                rounded-md text-[11px] font-medium transition-all duration-150
                ${isActive
                  ? `${c.activeBg} ${c.activeText} shadow-sm`
                  : `text-muted-foreground/70 hover:text-muted-foreground ${c.hoverBg}`
                }
              `}
            >
              {cat.icon}
              {cat.label}
              <span className="text-[9px] opacity-50 ml-0.5">{cat.modes.length}</span>
            </button>
          );
        })}
      </div>

      {/* Tier 2: Mode bar */}
      <div className={`flex gap-1 p-1 rounded-lg bg-muted/30 border ${colors.border} transition-colors duration-200`}>
        {activeCatDef.modes.map((m) => {
          const isActive = m.value === mode;
          return (
            <button
              key={m.value}
              onClick={() => onModeChange(m.value)}
              className={`
                flex-1 flex items-center justify-center gap-1 px-2 py-1.5
                rounded-md text-[11px] font-medium transition-all duration-150
                ${isActive
                  ? `${colors.modeBg} ${colors.modeText} shadow-sm`
                  : `text-muted-foreground/60 hover:text-muted-foreground ${colors.modeHover}`
                }
              `}
            >
              {m.icon}
              {m.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { MODE_TO_CATEGORY, CATEGORIES };
export type { Category };
