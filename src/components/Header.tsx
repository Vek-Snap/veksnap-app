"use client";

import { useEffect, useState, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Wifi, WifiOff, RotateCcw, Globe, ShieldOff, Sparkles, Shuffle, Power, Save, Upload as UploadIcon, Download, RefreshCw, FolderOpen, Eye, EyeOff, Loader2, CheckCircle2, FileCode2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
// checkConnection import removed: Header now receives comfyConnected as prop from ServiceManager
import { useRenderStatus } from "@/lib/render-status-context";

interface Props {
  onSaveSettings?: () => void;
  onLoadSettings?: () => void;
  onFreshStart?: () => void;
  onLoadComfyFile?: () => void;
  onOpenOutputFolder?: () => void;
  showPreview?: boolean;
  onShowPreviewChange?: (v: boolean) => void;
  embedMetadata?: boolean;
  onEmbedMetadataChange?: (v: boolean) => void;
  comfyConnected?: boolean;
}

function formatEtaTime(seconds: number): string {
  if (seconds < 0 || !isFinite(seconds)) return "--:--";
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}:${m.toString().padStart(2, "0")}:${(Math.floor(seconds) % 60).toString().padStart(2, "0")}`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function HeaderRenderStatus() {
  const { status } = useRenderStatus();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!status?.active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status?.active]);

  if (!status?.active) return null;

  const { stage, progress, progressMax, stepTimestamps, mode, completed, wallClockStart } = status;
  const pct = progressMax > 0 ? Math.min(100, Math.round((progress / progressMax) * 100)) : 0;

  // ETA calculation (only during active render, not after completion)
  let etaStr = "";
  let elapsedStr = "";
  if (!completed) {
    // Wall-clock elapsed (immune to ffmpeg frame spam)
    if (wallClockStart) {
      elapsedStr = formatEtaTime((now - wallClockStart) / 1000);
    }
    // Step-based ETA (only from sampling timestamps)
    if (stepTimestamps.length >= 2 && progressMax > 0) {
      const recent = stepTimestamps.slice(-11);
      const intervals: number[] = [];
      for (let i = 1; i < recent.length; i++) intervals.push(recent[i] - recent[i - 1]);
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const stepsRemaining = Math.max(0, progressMax - progress);
      const etaSeconds = (stepsRemaining * avgMs) / 1000;
      const sinceLastStep = (now - stepTimestamps[stepTimestamps.length - 1]) / 1000;
      const liveEta = Math.max(0, etaSeconds - sinceLastStep);
      etaStr = formatEtaTime(liveEta);
    }
  }

  // Color scheme: orange (in-progress) → green (completed)
  const stripeColor = completed ? "#22c55e" : "#f97316";
  const bgColor = completed ? "bg-emerald-500/90" : "bg-orange-500/90";

  return (
    <div className="absolute left-1/2 -translate-x-1/2 w-full max-w-[600px] min-w-[200px] px-4 pointer-events-none z-10">
      <div className="relative rounded-md overflow-hidden pointer-events-auto">
        {/* Top stripe border: animated during render, static on complete */}
        <div
          className="h-[6px] w-full"
          style={{
            backgroundImage: `repeating-linear-gradient(-45deg, ${stripeColor}, ${stripeColor} 8px, #000 8px, #000 16px)`,
            backgroundSize: "22.6px 22.6px",
            animation: completed ? "none" : "hazard-scroll 0.8s linear infinite",
          }}
        />
        {/* Main content area */}
        <div className={`${bgColor} px-3 py-1.5 flex items-center gap-3 transition-colors duration-500`}>
          {completed ? (
            <CheckCircle2 className="w-4 h-4 text-black shrink-0" />
          ) : (
            <Loader2 className="w-4 h-4 text-black animate-spin shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span className="text-[10px] font-bold text-black truncate">
                {mode}: {stage}
              </span>
              {etaStr && !completed && (
                <span className="text-[10px] font-mono font-bold text-black/80 shrink-0">
                  ETA {etaStr}
                </span>
              )}
            </div>
            {progressMax > 0 && !completed && (
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-black/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-black/70 rounded-full transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[9px] font-mono font-bold text-black/70 shrink-0 tabular-nums">
                  {progress}/{progressMax}
                </span>
              </div>
            )}
            {elapsedStr && !completed && (
              <div className="text-[8px] text-black/60 font-mono mt-0.5">
                Elapsed: {elapsedStr}
              </div>
            )}
          </div>
        </div>
        {/* Bottom stripe border: animated during render, static on complete */}
        <div
          className="h-[6px] w-full"
          style={{
            backgroundImage: `repeating-linear-gradient(-45deg, ${stripeColor}, ${stripeColor} 8px, #000 8px, #000 16px)`,
            backgroundSize: "22.6px 22.6px",
            animation: completed ? "none" : "hazard-scroll 0.8s linear infinite",
          }}
        />
      </div>
      <style jsx>{`
        @keyframes hazard-scroll {
          from { background-position: 0 0; }
          to { background-position: 22.6px 0; }
        }
      `}</style>
    </div>
  );
}

export default function Header({ onSaveSettings, onLoadSettings, onFreshStart, onLoadComfyFile, onOpenOutputFolder, showPreview, onShowPreviewChange, embedMetadata, onEmbedMetadataChange, comfyConnected }: Props = {}) {
  const [allowOnline, setAllowOnline] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [bannerSrc, setBannerSrc] = useState<string | null>(null);

  // ComfyUI connected status is now driven by ServiceManager prop, no independent poll
  const connected = comfyConnected ?? false;

  // Load allowOnline from server settings on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => setAllowOnline(!!s.allowOnline))
      .catch(() => {});
  }, []);

  const pickBanner = useCallback(() => {
    fetch("/api/banner")
      .then((r) => r.json())
      .then((d) => { if (d.banner) setBannerSrc(d.banner); })
      .catch(() => {});
  }, []);

  // Load a random banner image from public/banners/ on mount
  useEffect(() => { pickBanner(); }, [pickBanner]);

  const toggleOnline = useCallback(async () => {
    const next = !allowOnline;
    if (next && !confirm(
      "Enable online mode? This allows components to download models and updates from the internet (HuggingFace, GitHub). Disable when you want a fully air-gapped system."
    )) return;
    setToggling(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", key: "allowOnline", value: next }),
      });
      setAllowOnline(next);
    } catch { /* ignore */ }
    setToggling(false);
  }, [allowOnline]);

  // ── Shutdown (immediate) ──
  const [shutdownActive, setShutdownActive] = useState(false);
  const [shutdownStatus, setShutdownStatus] = useState<string | null>(null);

  const executeShutdown = useCallback(() => {
    setShutdownActive(true);
    setShutdownStatus("Shutting down...");
    fetch("/api/shutdown-all", { method: "POST" })
      .then((r) => r.json())
      .then((data) => setShutdownStatus(data.message || "Shutdown initiated"))
      .catch(() => setShutdownStatus("Shutdown signal sent: server is stopping"));
  }, []);

  return (
    <header className="relative flex items-center justify-between border-b border-border px-6 py-3 bg-card overflow-visible">
      <div className="flex items-center gap-3">
        <div className="shrink-0">
          <h1 className="text-lg font-semibold tracking-tight">Vek-Snap</h1>
          <p className="text-xs text-muted-foreground">AI Creative Studio</p>
        </div>
        {bannerSrc ? (
          <img
            src={bannerSrc}
            alt="Vek-Snap"
            className="h-14 max-h-16 w-auto max-w-[40vw] object-contain rounded-lg"
            draggable={false}
          />
        ) : (
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="w-5 h-5" />
          </div>
        )}
        <button
          onClick={pickBanner}
          title="Shuffle banner"
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Shuffle className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Render Status Banner (visible only when actively rendering) ── */}
      <HeaderRenderStatus />

      <div className="flex items-center gap-3">
        {/* Session & Settings quick actions, 2×2 compact grid */}
        {(onSaveSettings || onLoadSettings || onFreshStart || onLoadComfyFile || onOpenOutputFolder || onShowPreviewChange) && (
          <div className="grid grid-cols-4 gap-1 rounded-lg border border-border/50 bg-muted/10 p-1">
            {/* Row 1: Save, ComfyUI, New, Meta */}
            {onSaveSettings && (
              <Button variant="ghost" size="sm" className="h-6 px-2 gap-1 text-[9px] text-muted-foreground hover:text-foreground rounded-md border border-transparent hover:border-border/40" onClick={onSaveSettings} title="Save all settings to JSON">
                <Save className="w-3 h-3" /> Save
              </Button>
            )}
            {onLoadComfyFile && (
              <Button variant="ghost" size="sm" className="h-6 px-2 gap-1 text-[9px] text-emerald-400/70 hover:text-emerald-400 rounded-md border border-transparent hover:border-emerald-500/30" onClick={onLoadComfyFile} title="Load settings from ComfyUI output file">
                <Download className="w-3 h-3" /> ComfyUI
              </Button>
            )}
            {onFreshStart && (
              <Button variant="ghost" size="sm" className="h-6 px-2 gap-1 text-[9px] text-orange-400/70 hover:text-orange-400 rounded-md border border-transparent hover:border-orange-500/30" onClick={onFreshStart} title="Reset all settings and uploads to factory defaults">
                <RotateCcw className="w-3 h-3" /> Fresh Start
              </Button>
            )}
            {onEmbedMetadataChange && (
              <button
                onClick={() => onEmbedMetadataChange(!embedMetadata)}
                title={embedMetadata ? "Workflow metadata embedded in output videos: click to disable" : "Workflow metadata NOT embedded: click to enable (needed for Load from ComfyUI file)"}
                className={`flex items-center gap-1 h-6 px-2 rounded-md text-[9px] font-medium transition-colors border ${
                  embedMetadata
                    ? "text-violet-400/80 hover:text-violet-400 hover:bg-violet-500/10 border-violet-500/30"
                    : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/20 border-transparent hover:border-border/40"
                }`}
              >
                <FileCode2 className="w-3 h-3" />
                Meta
              </button>
            )}
            {/* Row 2: Load, Output, Preview */}
            {onLoadSettings && (
              <Button variant="ghost" size="sm" className="h-6 px-2 gap-1 text-[9px] text-muted-foreground hover:text-foreground rounded-md border border-transparent hover:border-border/40" onClick={onLoadSettings} title="Load settings from JSON">
                <UploadIcon className="w-3 h-3" /> Load
              </Button>
            )}
            {onOpenOutputFolder && (
              <Button variant="ghost" size="sm" className="h-6 px-2 gap-1 text-[9px] text-muted-foreground hover:text-foreground rounded-md border border-transparent hover:border-border/40" onClick={onOpenOutputFolder} title="Open output folder in Explorer">
                <FolderOpen className="w-3 h-3" /> Output
              </Button>
            )}
            {onShowPreviewChange && (
              <button
                onClick={() => onShowPreviewChange(!showPreview)}
                title={showPreview ? "Live preview enabled: click to disable" : "Live preview disabled: click to enable"}
                className={`flex items-center gap-1 h-6 px-2 rounded-md text-[9px] font-medium transition-colors border ${
                  showPreview
                    ? "text-cyan-400/80 hover:text-cyan-400 hover:bg-cyan-500/10 border-cyan-500/30"
                    : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/20 border-transparent hover:border-border/40"
                }`}
              >
                {showPreview ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                Preview
              </button>
            )}
          </div>
        )}

        <Separator orientation="vertical" className="h-6" />

        {/* Online / Offline master toggle */}
        <button
          onClick={toggleOnline}
          disabled={toggling}
          title={allowOnline
            ? "Online Mode: components can download models & updates. Click to go offline."
            : "Offline Mode: all internet access blocked. Click to allow downloads."}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium border transition-colors cursor-pointer ${
            allowOnline
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
              : "border-border/60 bg-muted/10 text-muted-foreground hover:bg-muted/20"
          }`}
        >
          {allowOnline ? (
            <><Globe className="w-3 h-3" /> Online</>
          ) : (
            <><ShieldOff className="w-3 h-3" /> Offline</>
          )}
        </button>

        <Badge variant={connected ? "default" : "destructive"} className="gap-1.5">
          {connected ? (
            <><Wifi className="w-3 h-3" /> ComfyUI Connected</>
          ) : (
            <><WifiOff className="w-3 h-3" /> ComfyUI Offline</>
          )}
        </Badge>
        {/* Shutdown button */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 text-red-400/60 hover:text-red-400 hover:bg-red-500/10"
          onClick={executeShutdown}
          title="Shutdown Vek-Snap (stops all services and processes)"
          disabled={shutdownActive}
        >
          <Power className="w-4 h-4" />
        </Button>
      </div>

      {/* Shutdown overlay */}
      {shutdownActive && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center">
          <div className="bg-card border border-red-500/40 rounded-xl p-8 max-w-md w-full mx-4 text-center space-y-4 shadow-2xl">
            <Power className="w-12 h-12 text-red-400 mx-auto" />
            <h2 className="text-xl font-semibold text-red-400">Shutting Down</h2>
            <p className="text-sm text-muted-foreground">{shutdownStatus || "Shutting down..."}</p>
            <p className="text-xs text-muted-foreground/60">
              You can close this window now.
            </p>
          </div>
        </div>
      )}
    </header>
  );
}
