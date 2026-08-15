"use client";

// ─────────────────────────────────────────────────────────────────────────────
// SystemSettingsStudio: the Modern-UI "System Settings" surface.
//
// A categorised, tabbed settings page (styled after the classic workflow tab
// panel) reached from the pinned "System Settings" rail entry. Houses system
// TOOLS that don't belong under a creative "Utility" group:
//   • Model Paths: where ComfyUI looks for models (shared ModelPathsPanel)
//   • Components: model / custom-node manager (moved out of Utilities)
//   • Cache & Temp: scratch-space cleanup (also on the Quick Settings menu)
//
// Deliberately additive: each tab reuses an existing, proven component, so this
// is a container + navigation, not a rewrite of the underlying tools.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { HardDrive, Package, Trash2, FileCog, PlayCircle, type LucideIcon } from "lucide-react";
import ComponentManager from "@/components/ComponentManager";
import ModelPathsPanel from "@/components/ModelPathsPanel";
import TempCleanupDialog from "@/components/TempCleanupDialog";
import { OutputMetadataPanel } from "@/components/OutputMetadataControls";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAutoplay } from "@/lib/use-autoplay";

type TabId = "general" | "paths" | "components" | "cache" | "output";

const TABS: { id: TabId; label: string; Icon: LucideIcon }[] = [
  { id: "general", label: "General", Icon: PlayCircle },
  { id: "paths", label: "Model Paths", Icon: HardDrive },
  { id: "components", label: "Components", Icon: Package },
  { id: "cache", label: "Cache & Temp", Icon: Trash2 },
  { id: "output", label: "Output Metadata", Icon: FileCog },
];

function GeneralTab() {
  const [autoplay, setAutoplay] = useAutoplay();
  return (
    <div className="space-y-4 max-w-xl">
      <div className="flex items-start gap-3">
        <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/15 text-violet-300 border border-violet-500/40 shrink-0">
          <PlayCircle className="w-4 h-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold leading-tight">General</h3>
          <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
            App-wide preferences for how Vek-Snap behaves.
          </p>
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-[12px] font-medium">Auto-Play Video Renders</span>
          <span className="block text-[10px] text-muted-foreground">Automatically start playback when a finished video render appears.</span>
        </span>
        <Switch checked={autoplay} onCheckedChange={setAutoplay} />
      </label>
    </div>
  );
}

function OutputTab() {
  return (
    <div className="space-y-4 max-w-xl">
      <div className="flex items-start gap-3">
        <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-sky-500/15 text-sky-300 border border-sky-500/40 shrink-0">
          <FileCog className="w-4 h-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold leading-tight">Output metadata embedding</h3>
          <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
            Choose what Vek-Snap writes INTO the image, video, and audio files it produces.
            Everything here is OFF by default: your outputs stay clean unless you opt in.
          </p>
        </div>
      </div>
      <OutputMetadataPanel />
    </div>
  );
}

function CacheTab() {
  const inElectron = typeof window !== "undefined" && !!window.electronAPI;
  const [tempOpen, setTempOpen] = useState(false);
  const [clearOnExit, setClearOnExit] = useState(false);

  useEffect(() => {
    if (!inElectron) return;
    window.electronAPI?.getClearTempOnExit().then((v) => setClearOnExit(!!v)).catch(() => {});
  }, [inElectron]);

  const toggleClearOnExit = useCallback((v: boolean) => {
    setClearOnExit(v);
    window.electronAPI?.setClearTempOnExit(v).catch(() => {});
  }, []);

  return (
    <div className="space-y-4 max-w-xl">
      <div className="flex items-start gap-3">
        <span className="flex items-center justify-center w-9 h-9 rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/40 shrink-0">
          <Trash2 className="w-4 h-4" />
        </span>
        <div>
          <h3 className="text-sm font-semibold leading-tight">Cache &amp; temporary files</h3>
          <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
            Vek-Snap stages uploads, previews, and intermediate renders in a scratch
            area. Clear it to reclaim disk space; your saved projects and outputs are
            never touched.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-9 px-3 gap-1.5" onClick={() => setTempOpen(true)} disabled={!inElectron}>
          <Trash2 className="w-3.5 h-3.5" /> Manage temporary files…
        </Button>
        {!inElectron && (
          <span className="text-[10px] text-muted-foreground/70">Available in the desktop app.</span>
        )}
      </div>

      {inElectron && (
        <label className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-[12px] font-medium">Clear temporary files on exit</span>
            <span className="block text-[10px] text-muted-foreground">Automatically empty the scratch area when Vek-Snap closes.</span>
          </span>
          <Switch checked={clearOnExit} onCheckedChange={toggleClearOnExit} />
        </label>
      )}

      <TempCleanupDialog open={tempOpen} onOpenChange={setTempOpen} />
    </div>
  );
}

export default function SystemSettingsStudio() {
  const [tab, setTab] = useState<TabId>("general");

  return (
    <div className="p-1">
      {/* Tab bar: mirrors the classic workflow tab panel styling. */}
      <div className="flex items-center gap-1 border-b border-border/60 mb-4">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`relative flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-medium transition-colors ${
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <t.Icon className="w-3.5 h-3.5" />
              {t.label}
              {active && <span className="absolute left-2 right-2 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400" />}
            </button>
          );
        })}
      </div>

      {/* Tab body */}
      <div className="px-1">
        {tab === "general" && <GeneralTab />}
        {tab === "paths" && <ModelPathsPanel className="max-w-xl" />}
        {tab === "components" && <ComponentManager />}
        {tab === "cache" && <CacheTab />}
        {tab === "output" && <OutputTab />}
      </div>
    </div>
  );
}
