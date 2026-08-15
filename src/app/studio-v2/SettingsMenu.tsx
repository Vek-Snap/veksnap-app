"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Studio V2: app menu (File / Appearance / System / Help).
//
// A v2-native, professional industry standard-styled dropdown that calls the SAME underlying functions
// the classic MenuBar uses (theme via next-themes, network/preview via
// /api/settings, temp cleanup via TempCleanupDialog, logs via /api/export-logs,
// output folder via /api/open-output). Save/Load/Fresh-Start are passed in from
// the page because they operate on the v2 per-studio config state.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from "react";
import { useTheme } from "next-themes";
import {
  Settings2,
  Save,
  Upload as UploadIcon,
  RotateCcw,
  Sun,
  Moon,
  Monitor,
  Check,
  Globe,
  ShieldOff,
  FolderOpen,
  Trash2,
  FileDown,
  Info,
  SlidersHorizontal,
  PlayCircle,
  SpellCheck,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import ConfirmDialog from "@/components/ConfirmDialog";
import AboutDialog from "@/components/AboutDialog";
import TempCleanupDialog from "@/components/TempCleanupDialog";
import SystemPanelsDialog from "./SystemPanelsDialog";
import { ALLOW_ONLINE_EVENT } from "@/hooks/useAllowOnline";
import { OutputMetadataMenuSection } from "@/components/OutputMetadataControls";
import { useAutoplay } from "@/lib/use-autoplay";
import { useSpellcheck } from "@/lib/use-spellcheck";
import { useUiScale, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP, UI_SCALE_DEFAULT } from "@/lib/use-ui-scale";
import PanelDarknessSlider from "@/components/PanelDarknessSlider";

interface SettingsMenuProps {
  onSave: () => void;
  onLoad: () => void;
  onFreshStart: () => void;
  // Page-scoped reset label: "Clear Timeline" on the Timeline page, "Reset Studios" elsewhere.
  freshStartLabel?: string;
}

const NO_DRAG: React.CSSProperties = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

export default function SettingsMenu({ onSave, onLoad, onFreshStart, freshStartLabel = "Reset Studios" }: SettingsMenuProps) {
  const { theme, setTheme } = useTheme();
  const inElectron = typeof window !== "undefined" && !!window.electronAPI;
  const [autoplay, setAutoplay] = useAutoplay();
  const [spellcheck, setSpellcheck] = useSpellcheck();
  const [uiScale, setUiScale] = useUiScale();
  const scalePct = Math.round(uiScale * 100);

  const [allowOnline, setAllowOnline] = useState(false);
  const [networkBusy, setNetworkBusy] = useState(false);
  const [onlineConfirmOpen, setOnlineConfirmOpen] = useState(false);
  const [tempOpen, setTempOpen] = useState(false);
  const [panelsOpen, setPanelsOpen] = useState(false);

  const [aboutOpen, setAboutOpen] = useState(false);

  // Mirror the classic MenuBar: read the persisted network-access flag.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setAllowOnline(!!s.allowOnline))
      .catch(() => {});
  }, []);

  const setOnline = useCallback(async (value: boolean) => {
    setNetworkBusy(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", key: "allowOnline", value }),
      });
      setAllowOnline(value);
      // Notify any mounted gated features (e.g. the Library CivitAI fetch button)
      // to re-read the setting immediately, no app restart required.
      window.dispatchEvent(new Event(ALLOW_ONLINE_EVENT));
    } catch { /* ignore */ }
    setNetworkBusy(false);
  }, []);

  const toggleOnline = useCallback(() => {
    if (!allowOnline) { setOnlineConfirmOpen(true); return; } // enabling is sensitive → confirm
    void setOnline(false);
  }, [allowOnline, setOnline]);

  const openOutputFolder = useCallback(() => {
    fetch("/api/open-output", { method: "POST" }).catch(() => {});
  }, []);

  const exportLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/export-logs", { method: "POST" });
      if (!res.ok) throw new Error("export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `veksnap_logs_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      fetch("/api/open-logs", { method: "POST" }).catch(() => {});
    }
  }, []);

  const themeItem = (value: string, label: string, Icon: typeof Sun) => (
    <DropdownMenuItem onClick={() => setTheme(value)}>
      <Icon className="w-4 h-4" />
      {label}
      {theme === value && <Check className="w-3 h-3 ml-auto text-emerald-400" />}
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            style={NO_DRAG}
            title="Quick Settings: save / load, appearance, network, logs"
            aria-label="Open Quick Settings menu"
            className="inline-flex items-center gap-1.5 h-8 pl-2 pr-2.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors data-[state=open]:bg-foreground/10 data-[state=open]:text-foreground"
          >
            <Settings2 className="w-4 h-4 shrink-0" />
            <span className="hidden md:inline text-[11px] font-medium whitespace-nowrap">Quick Settings</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[230px]" style={NO_DRAG}>
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            File
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={onSave}>
            <Save className="w-4 h-4" />
            Save Settings
            <DropdownMenuShortcut>Ctrl+S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onLoad}>
            <UploadIcon className="w-4 h-4" />
            Load Settings
            <DropdownMenuShortcut>Ctrl+O</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onFreshStart} className="text-orange-400 focus:text-orange-400">
            <RotateCcw className="w-4 h-4" />
            {freshStartLabel}
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            Appearance
          </DropdownMenuLabel>
          {themeItem("light", "Light", Sun)}
          {themeItem("dark", "Dark", Moon)}
          {themeItem("system", "System", Monitor)}

          {/* Accessibility: program-wide display size (CSS zoom). Rendered as a
              plain row (not a menu item) so the +/- buttons don't close the menu
              while the user dials it in. */}
          <div
            className="flex items-center gap-2 px-2 py-1.5 text-sm"
            style={NO_DRAG}
            onClick={(e) => e.stopPropagation()}
          >
            <ZoomIn className="w-4 h-4 shrink-0" />
            <span className="flex-1">Display Size</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Decrease display size"
                title="Smaller"
                disabled={uiScale <= UI_SCALE_MIN}
                onClick={() => setUiScale(uiScale - UI_SCALE_STEP)}
                className="inline-flex items-center justify-center w-6 h-6 rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title="Reset to 100%"
                onClick={() => setUiScale(UI_SCALE_DEFAULT)}
                className="w-11 text-center text-[11px] font-semibold tabular-nums text-foreground hover:text-violet-300 transition-colors"
              >
                {scalePct}%
              </button>
              <button
                type="button"
                aria-label="Increase display size"
                title="Larger"
                disabled={uiScale >= UI_SCALE_MAX}
                onClick={() => setUiScale(uiScale + UI_SCALE_STEP)}
                className="inline-flex items-center justify-center w-6 h-6 rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Panel darkness/dim: same control the classic MenuBar exposes. It
              writes global CSS vars on <html>, so it already affects this modern
              shell; surfacing the slider here lets v2 users dial it in too.
              Wrapped so dragging the slider doesn't close the menu. */}
          <div onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
            <PanelDarknessSlider />
          </div>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            General
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => setAutoplay(!autoplay)}>
            <PlayCircle className="w-4 h-4" />
            Auto-Play Video Renders
            {autoplay && <Check className="w-3 h-3 ml-auto text-emerald-400" />}
          </DropdownMenuItem>
          {/* Spellcheck: native offline Windows dictionary; default OFF for
              privacy-minded users. Session-wide once on (covers all prompt fields). */}
          <DropdownMenuItem onClick={() => setSpellcheck(!spellcheck)}>
            <SpellCheck className="w-4 h-4" />
            <span>Spellcheck in Prompts <span className="text-[9px] text-muted-foreground ml-1">offline · Windows dict</span></span>
            {spellcheck && <Check className="w-3 h-3 ml-auto text-emerald-400" />}
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            System
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={toggleOnline} disabled={networkBusy}>
            {allowOnline ? <Globe className="w-4 h-4 text-amber-400" /> : <ShieldOff className="w-4 h-4 text-emerald-400" />}
            Network Access
            <span className={`ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
              allowOnline ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/15 text-emerald-400"
            }`}>
              {allowOnline ? "ONLINE" : "OFFLINE"}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={openOutputFolder}>
            <FolderOpen className="w-4 h-4" />
            Open Output Folder
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setPanelsOpen(true)}>
            <SlidersHorizontal className="w-4 h-4" />
            System Panels…
          </DropdownMenuItem>
          {inElectron && (
            <DropdownMenuItem onClick={() => setTempOpen(true)}>
              <Trash2 className="w-4 h-4" />
              Clear Temporary Files…
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
            Output Metadata
          </DropdownMenuLabel>
          <OutputMetadataMenuSection />

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={exportLogs}>
            <FileDown className="w-4 h-4" />
            Export Diagnostic Logs
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAboutOpen(true)}>
            <Info className="w-4 h-4" />
            About Vek-Snap™
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={onlineConfirmOpen}
        onOpenChange={setOnlineConfirmOpen}
        title="Enable Online Mode?"
        description="This allows components to download models and updates from the internet (HuggingFace, GitHub). Disable when you want a fully air-gapped system."
        confirmLabel="Enable"
        cancelLabel="Cancel"
        onConfirm={() => { void setOnline(true); }}
      />

      <TempCleanupDialog open={tempOpen} onOpenChange={setTempOpen} />

      <SystemPanelsDialog open={panelsOpen} onOpenChange={setPanelsOpen} />

      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </>
  );
}
