"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Save, Upload as UploadIcon, Download, RotateCcw, Power,
  FolderOpen, Eye, EyeOff, FileCode2, Globe, ShieldOff,
  Wifi, WifiOff, Minus, Square, X, Copy,
  Sun, Moon, Monitor, Check, Info, FileDown, ScanEye, ExternalLink, Trash2,
  LayoutDashboard, RefreshCw,
} from "lucide-react";
import { useComfyOpen } from "@/components/ComfyOpenProvider";
import { switchLayout } from "@/lib/layout-switch";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
// checkConnection import removed: MenuBar now receives comfyConnected as prop from ServiceManager
import { useTheme } from "next-themes";
import PanelDarknessSlider from "@/components/PanelDarknessSlider";
import ConfirmDialog from "@/components/ConfirmDialog";
import TempCleanupDialog from "@/components/TempCleanupDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { RecentFile } from "@/hooks/useRecentFiles";

// ── Props: identical to Header so it's a drop-in replacement ──
interface Props {
  onSaveSettings?: () => void | Promise<boolean>;
  onLoadSettings?: () => void;
  onFreshStart?: () => void;
  onLoadComfyFile?: () => void;
  onOpenOutputFolder?: () => void;
  showPreview?: boolean;
  onShowPreviewChange?: (v: boolean) => void;
  embedMetadata?: boolean;
  onEmbedMetadataChange?: (v: boolean) => void;
  recentFiles?: RecentFile[];
  onLoadRecentFile?: (json: string) => void;
  onClearRecentFiles?: () => void;
  recentFilesEnabled?: boolean;
  onRecentFilesEnabledChange?: (v: boolean) => void;
  comfyConnected?: boolean;
}

// Render status banner moved to center panel in page.tsx (CenterPanelRenderStatus)

// ── Menu trigger button style ──
function MenuTrigger({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenuTrigger asChild>
      <button className="px-3 py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent rounded-sm transition-colors outline-none select-none">
        {children}
      </button>
    </DropdownMenuTrigger>
  );
}

// ── Window controls (minimize / maximize / close) ──
function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;

  useEffect(() => {
    if (!api) return;
    api.isMaximized().then(setIsMaximized);
    api.onMaximizedChange(setIsMaximized);
  }, [api]);

  if (!api) return null; // Not running in Electron, hide controls

  const btnBase = "inline-flex items-center justify-center w-[46px] h-[32px] transition-colors";
  return (
    <div className="flex items-center h-full">
      <button
        className={`${btnBase} hover:bg-muted text-muted-foreground hover:text-foreground`}
        onClick={() => api.minimize()}
        title="Minimize"
      >
        <Minus className="w-4 h-4" />
      </button>
      <button
        className={`${btnBase} hover:bg-muted text-muted-foreground hover:text-foreground`}
        onClick={() => api.maximize()}
        title={isMaximized ? "Restore" : "Maximize"}
      >
        {isMaximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
      </button>
      <button
        className={`${btnBase} hover:bg-red-600 text-muted-foreground hover:text-white`}
        onClick={() => api.close()}
        title="Close"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ── Main MenuBar component ──
export default function MenuBar({
  onSaveSettings,
  onLoadSettings,
  onFreshStart,
  onLoadComfyFile,
  onOpenOutputFolder,
  showPreview,
  onShowPreviewChange,
  embedMetadata,
  onEmbedMetadataChange,
  recentFiles,
  onLoadRecentFile,
  onClearRecentFiles,
  recentFilesEnabled,
  onRecentFilesEnabledChange,
  comfyConnected,
}: Props) {
  // ComfyUI connected status is now driven by ServiceManager prop, no independent poll
  const connected = comfyConnected ?? false;

  // Global "Open in ComfyUI": enabled only when the active page registered a
  // ComfyUI-compatible workflow AND ComfyUI is connected.
  const comfyOpen = useComfyOpen();
  const canOpenInComfy = connected && !!comfyOpen?.hasWorkflow;
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);
  const [allowOnline, setAllowOnline] = useState(false);
  const [toggling, setToggling] = useState(false);

  // ── Live Preview setting ──
  const [previewMethod, setPreviewMethod] = useState<string>("none");
  const [previewRestartOpen, setPreviewRestartOpen] = useState(false);
  const [pendingPreviewMethod, setPendingPreviewMethod] = useState<string>("none");

  // Load settings on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s) => {
        setAllowOnline(!!s.allowOnline);
        if (s.comfyPreviewMethod) setPreviewMethod(s.comfyPreviewMethod);
      })
      .catch(() => {});
  }, []);

  // ── Online mode toggle confirmation ──
  const [onlineConfirmOpen, setOnlineConfirmOpen] = useState(false);

  const toggleOnline = useCallback(async () => {
    const next = !allowOnline;
    if (next) {
      setOnlineConfirmOpen(true);
      return;
    }
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

  const confirmOnline = useCallback(async () => {
    setToggling(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", key: "allowOnline", value: true }),
      });
      setAllowOnline(true);
    } catch { /* ignore */ }
    setToggling(false);
  }, []);

  // ── Live Preview toggle (requires ComfyUI restart) ──
  const togglePreviewMethod = useCallback(() => {
    const next = previewMethod === "none" ? "latent2rgb" : "none";
    setPendingPreviewMethod(next);
    setPreviewRestartOpen(true);
  }, [previewMethod]);

  const confirmPreviewChange = useCallback(async () => {
    setPreviewRestartOpen(false);
    // Save the new setting
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", key: "comfyPreviewMethod", value: pendingPreviewMethod }),
      });
      setPreviewMethod(pendingPreviewMethod);
      // Restart ComfyUI to apply
      await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart", services: ["comfyui"] }),
      });
    } catch { /* ignore */ }
  }, [pendingPreviewMethod]);

  // ── Close confirmation (Electron IPC) ──
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [closeHasUnsaved, setCloseHasUnsaved] = useState(false);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api) return;
    api.onConfirmClose((hasUnsaved) => {
      setCloseHasUnsaved(hasUnsaved);
      setCloseConfirmOpen(true);
    });
  }, []);

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

  // ── Minimize to tray ──
  const [minimizeToTray, setMinimizeToTray] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("veksnap-minimize-to-tray") === "true"; } catch { return false; }
  });
  // Sync initial state to main process on mount
  useEffect(() => {
    if (minimizeToTray) window.electronAPI?.setMinimizeToTray(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Spellcheck toggle ──
  const [spellcheckEnabled, setSpellcheckEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("veksnap-spellcheck") === "true"; } catch { return false; }
  });
  // Sync initial state to main process on mount
  useEffect(() => {
    if (spellcheckEnabled) window.electronAPI?.setSpellcheck(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── About dialog + app update check (Phase 1 update system) ──
  const [aboutOpen, setAboutOpen] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<{
    status: "idle" | "checking" | "current" | "available" | "offline" | "error";
    latestVersion?: string | null;
    summary?: string | null;
    downloadUrl?: string | null;
    notesUrl?: string | null;
    message?: string | null;
  }>({ status: "idle" });

  // When About opens, load the REAL version from the local server (localhost
  // only: this makes no internet request).
  useEffect(() => {
    if (!aboutOpen) return;
    setUpdateState({ status: "idle" });
    fetch("/api/app-update")
      .then((r) => r.json())
      .then((d) => { if (d?.currentVersion) setAppVersion(d.currentVersion); })
      .catch(() => {});
  }, [aboutOpen]);

  // The ONLY user action that reaches the internet, and only if Network Access
  // is enabled (enforced server-side). Sends no user content.
  const checkForUpdates = useCallback(async () => {
    setUpdateState({ status: "checking" });
    try {
      const r = await fetch("/api/app-update?check=1");
      const d = await r.json();
      if (d?.currentVersion) setAppVersion(d.currentVersion);
      if (r.status === 403 && d?.offline) {
        setUpdateState({ status: "offline", message: d.error });
      } else if (!r.ok) {
        setUpdateState({ status: "error", message: d?.error || "Update check failed." });
      } else if (d?.updateAvailable) {
        setUpdateState({
          status: "available",
          latestVersion: d.latestVersion,
          summary: d.summary,
          downloadUrl: d.downloadUrl,
          notesUrl: d.notesUrl,
        });
      } else {
        setUpdateState({ status: "current" });
      }
    } catch (e) {
      setUpdateState({ status: "error", message: (e as Error).message });
    }
  }, []);

  // ── Clear Temporary Files dialog ──
  const [tempCleanupOpen, setTempCleanupOpen] = useState(false);
  const inElectron = typeof window !== "undefined" && !!window.electronAPI;

  // ── Export diagnostic logs ──
  const handleExportLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/export-logs", { method: "POST" });
      if (!res.ok) throw new Error("Failed to export logs");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `veksnap_logs_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: open the log directory in the OS file manager
      fetch("/api/open-logs", { method: "POST" }).catch(() => {});
    }
  }, []);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+S: Save
      if (e.ctrlKey && !e.shiftKey && e.key === "s") {
        e.preventDefault();
        onSaveSettings?.();
      }
      // Ctrl+O: Load
      if (e.ctrlKey && !e.shiftKey && e.key === "o") {
        e.preventDefault();
        onLoadSettings?.();
      }
      // Ctrl+Shift+I: Import ComfyUI
      if (e.ctrlKey && e.shiftKey && e.key === "I") {
        e.preventDefault();
        onLoadComfyFile?.();
      }
      // Ctrl+Shift+P: Toggle Preview
      if (e.ctrlKey && e.shiftKey && e.key === "P") {
        e.preventDefault();
        onShowPreviewChange?.(!showPreview);
      }
      // Ctrl+Shift+E: Toggle Metadata
      if (e.ctrlKey && e.shiftKey && e.key === "E") {
        e.preventDefault();
        onEmbedMetadataChange?.(!embedMetadata);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSaveSettings, onLoadSettings, onLoadComfyFile, onShowPreviewChange, showPreview, onEmbedMetadataChange, embedMetadata]);

  return (
    <header
      className="flex items-center border-b border-border bg-card select-none"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* ── Left: App icon + Title + Menus ── */}
      <div className="flex items-center" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        <div className="flex items-center gap-2 pl-3 pr-2 py-1.5">
          <img
            src={mounted && resolvedTheme === "dark" ? "/icon-dark.png" : "/icon-light.png"}
            alt="Vek-Snap"
            className="w-4 h-4 object-contain"
            draggable={false}
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <span className="text-[11px] font-semibold text-muted-foreground/70 tracking-wide">Vek-Snap</span>
        </div>

        {/* ── Menu dropdowns ── */}
        <nav className="flex items-center gap-0.5 px-1 py-1.5">
          {/* ─── File ─── */}
          <DropdownMenu>
            <MenuTrigger>File</MenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              {onSaveSettings && (
                <DropdownMenuItem onClick={onSaveSettings}>
                  <Save className="w-4 h-4" />
                  Save Settings
                  <DropdownMenuShortcut>Ctrl+S</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              {onLoadSettings && (
                <DropdownMenuItem onClick={onLoadSettings}>
                  <UploadIcon className="w-4 h-4" />
                  Load Settings
                  <DropdownMenuShortcut>Ctrl+O</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              {onLoadComfyFile && (
                <DropdownMenuItem onClick={onLoadComfyFile}>
                  <Download className="w-4 h-4" />
                  Import ComfyUI File
                  <DropdownMenuShortcut>Ctrl+Shift+I</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
              {onRecentFilesEnabledChange && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <FolderOpen className="w-4 h-4" />
                      Recent Files
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-[240px]">
                      <DropdownMenuCheckboxItem
                        checked={recentFilesEnabled}
                        onCheckedChange={(v) => onRecentFilesEnabledChange(!!v)}
                      >
                        Track Recent Files
                      </DropdownMenuCheckboxItem>
                      {recentFiles && recentFiles.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          {recentFiles.map((f) => (
                            <DropdownMenuItem key={f.timestamp} onClick={() => onLoadRecentFile?.(f.path)}>
                              <FileCode2 className="w-4 h-4 shrink-0" />
                              <span className="truncate">{f.name}</span>
                              <span className="ml-auto text-[9px] text-muted-foreground/50 whitespace-nowrap">
                                {new Date(f.timestamp).toLocaleDateString()}
                              </span>
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={onClearRecentFiles} className="text-muted-foreground">
                            Clear Recent
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}
              <DropdownMenuSeparator />
              {onFreshStart && (
                <DropdownMenuItem onClick={onFreshStart} className="text-orange-400 focus:text-orange-400">
                  <RotateCcw className="w-4 h-4" />
                  Fresh Start
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={executeShutdown}
                variant="destructive"
                disabled={shutdownActive}
              >
                <Power className="w-4 h-4" />
                Shutdown
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* ─── View ─── */}
          <DropdownMenu>
            <MenuTrigger>View</MenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              {/* Switch to the modern Studio v2 shell (the default UI). This is
                  the counterpart to v2's "Classic UI" button, so users can get
                  back after switching here. */}
              <DropdownMenuItem onClick={() => switchLayout("/studio-v2")}>
                <LayoutDashboard className="w-4 h-4" />
                Modern Layout
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {onShowPreviewChange && (
                <DropdownMenuCheckboxItem
                  checked={showPreview}
                  onCheckedChange={(v) => onShowPreviewChange(!!v)}
                >
                  {showPreview ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  Live Preview
                  <DropdownMenuShortcut>Ctrl+Shift+P</DropdownMenuShortcut>
                </DropdownMenuCheckboxItem>
              )}
              {onOpenOutputFolder && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onOpenOutputFolder}>
                    <FolderOpen className="w-4 h-4" />
                    Open Output Folder
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* ─── Settings ─── */}
          <DropdownMenu>
            <MenuTrigger>Settings</MenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px]">
              {onEmbedMetadataChange && (
                <DropdownMenuCheckboxItem
                  checked={embedMetadata}
                  onCheckedChange={(v) => onEmbedMetadataChange(!!v)}
                >
                  <FileCode2 className="w-4 h-4" />
                  Embed Workflow Metadata
                  <DropdownMenuShortcut>Ctrl+Shift+E</DropdownMenuShortcut>
                </DropdownMenuCheckboxItem>
              )}
              <DropdownMenuCheckboxItem
                checked={previewMethod !== "none"}
                onCheckedChange={() => togglePreviewMethod()}
              >
                <ScanEye className="w-4 h-4" />
                Denoise Step Preview
                <span className={`ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                  previewMethod !== "none"
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "bg-zinc-500/15 text-zinc-400"
                }`}>
                  {previewMethod !== "none" ? previewMethod.toUpperCase() : "OFF"}
                </span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={minimizeToTray}
                onCheckedChange={(v) => {
                  setMinimizeToTray(!!v);
                  window.electronAPI?.setMinimizeToTray(!!v);
                  try { localStorage.setItem("veksnap-minimize-to-tray", String(!!v)); } catch {}
                }}
              >
                <Minus className="w-4 h-4" />
                Minimize to Tray
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={spellcheckEnabled}
                onCheckedChange={(v) => {
                  setSpellcheckEnabled(!!v);
                  window.electronAPI?.setSpellcheck(!!v);
                  try { localStorage.setItem("veksnap-spellcheck", String(!!v)); } catch {}
                }}
              >
                <Check className="w-4 h-4" />
                <span>Spellcheck <span className="text-[9px] text-muted-foreground ml-1">offline · Windows dict</span></span>
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={toggleOnline} disabled={toggling}>
                {allowOnline ? (
                  <Globe className="w-4 h-4 text-amber-400" />
                ) : (
                  <ShieldOff className="w-4 h-4 text-emerald-400" />
                )}
                {allowOnline ? "Network Access" : "Network Access"}
                <span className={`ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                  allowOnline
                    ? "bg-amber-500/15 text-amber-400"
                    : "bg-emerald-500/15 text-emerald-400"
                }`}>
                  {allowOnline ? "ONLINE" : "OFFLINE MODE SET"}
                </span>
              </DropdownMenuItem>
              {inElectron && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setTempCleanupOpen(true)}>
                    <Trash2 className="w-4 h-4" />
                    Clear Temporary Files…
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setTheme("light")}>
                <Sun className="w-4 h-4" />
                Light
                {mounted && theme === "light" && <Check className="w-3 h-3 ml-auto text-emerald-400" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("dark")}>
                <Moon className="w-4 h-4" />
                Dark
                {mounted && theme === "dark" && <Check className="w-3 h-3 ml-auto text-emerald-400" />}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme("system")}>
                <Monitor className="w-4 h-4" />
                System
                {mounted && theme === "system" && <Check className="w-3 h-3 ml-auto text-emerald-400" />}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <div onPointerDown={(e) => e.stopPropagation()}>
                <PanelDarknessSlider />
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* ─── Help ─── */}
          <DropdownMenu>
            <MenuTrigger>Help</MenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              <DropdownMenuItem onClick={() => setAboutOpen(true)}>
                <Info className="w-4 h-4" />
                About Vek-Snap
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleExportLogs}>
                <FileDown className="w-4 h-4" />
                Export Diagnostic Logs
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </nav>
      </div>

      {/* Spacer to push right section to the right (banner moved to center panel) */}
      <div className="flex-1" />

      {/* ── Right: Status + Window controls ── */}
      <div className="flex items-center ml-auto" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
        {/* Global "Open in ComfyUI", appears on every ComfyUI-driven page */}
        {comfyOpen?.hasWorkflow && (
          <button
            onClick={() => { void comfyOpen.openInComfyUI(); }}
            disabled={!canOpenInComfy || comfyOpen.status === "opening"}
            title={
              !connected
                ? "ComfyUI is offline: start it to open your workflow"
                : "Open the current workflow directly in ComfyUI"
            }
            className="inline-flex items-center gap-1.5 mr-3 px-2.5 py-1 rounded-md text-[11px] font-medium border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {comfyOpen.status === "opening" ? "Opening…" : "Open in ComfyUI"}
          </button>
        )}
        <Badge variant={connected ? "default" : "destructive"} className="gap-1.5 text-[10px] mr-3">
          {connected ? (
            <><Wifi className="w-3 h-3" /> ComfyUI</>
          ) : (
            <><WifiOff className="w-3 h-3" /> ComfyUI Offline</>
          )}
        </Badge>

        {/* Window controls (min / max / close) */}
        <WindowControls />
      </div>

      {/* ── Shutdown overlay ── */}
      {shutdownActive && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center">
          <div className="bg-card border border-red-500/40 rounded-xl p-8 max-w-md w-full mx-4 text-center space-y-4 shadow-2xl">
            <Power className="w-12 h-12 text-red-400 mx-auto" />
            <h2 className="text-xl font-semibold text-red-400">Shutting Down</h2>
            <p className="text-sm text-muted-foreground">{shutdownStatus || "Shutting down..."}</p>
            <p className="text-xs text-muted-foreground/60">
              Vek-Snap is shutting down. This window will close momentarily.
            </p>
          </div>
        </div>
      )}

      {/* ── Close confirmation dialog ──
          With unsaved changes: Save & Quit / Don't Save / Cancel.
          Otherwise: a simple Quit / Cancel. */}
      <ConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={setCloseConfirmOpen}
        title={closeHasUnsaved ? "Save changes before closing?" : "Close Vek-Snap?"}
        description={
          closeHasUnsaved
            ? "You have unsaved changes. Save them before quitting? All running services (ComfyUI, etc.) will be stopped."
            : "All running services (ComfyUI, etc.) will be stopped."
        }
        confirmLabel={closeHasUnsaved ? "Save & Quit" : "Quit"}
        cancelLabel="Cancel"
        variant={closeHasUnsaved ? "default" : "destructive"}
        tertiaryLabel={closeHasUnsaved ? "Don't Save" : undefined}
        onTertiary={closeHasUnsaved ? () => window.electronAPI?.confirmClose() : undefined}
        onConfirm={async () => {
          if (closeHasUnsaved) {
            // Wait for the save to ACTUALLY complete (native Save dialog + write)
            // before starting the terminate cycle, never a timer, or the app can
            // quit mid-dialog and lose the file. If the user cancels the Save
            // dialog, stay open (don't quit).
            const saved = await onSaveSettings?.();
            if (saved === false) return;
            window.electronAPI?.confirmClose();
          } else {
            window.electronAPI?.confirmClose();
          }
        }}
      />

      {/* ── Online mode confirmation dialog ── */}
      <ConfirmDialog
        open={onlineConfirmOpen}
        onOpenChange={setOnlineConfirmOpen}
        title="Enable Online Mode?"
        description="This allows components to download models and updates from the internet (HuggingFace, GitHub). Disable when you want a fully air-gapped system."
        confirmLabel="Enable"
        cancelLabel="Cancel"
        onConfirm={confirmOnline}
      />

      {/* ── Preview method restart dialog ── */}
      <ConfirmDialog
        open={previewRestartOpen}
        onOpenChange={setPreviewRestartOpen}
        title={pendingPreviewMethod !== "none" ? "Enable Denoise Previews?" : "Disable Denoise Previews?"}
        description={
          pendingPreviewMethod !== "none"
            ? "This shows live image previews during each denoising step. ComfyUI must be restarted to apply this change. Restart now?"
            : "This disables live denoising previews (saves minor VRAM). ComfyUI must be restarted to apply this change. Restart now?"
        }
        confirmLabel="Restart ComfyUI"
        cancelLabel="Cancel"
        onConfirm={confirmPreviewChange}
      />

      {/* ── Open-in-ComfyUI error dialog ── */}
      <ConfirmDialog
        open={!!comfyOpen?.error}
        onOpenChange={(o) => { if (!o) comfyOpen?.clearError(); }}
        title="Couldn't open in ComfyUI"
        description={comfyOpen?.error || ""}
        confirmLabel="OK"
        cancelLabel="Close"
        onConfirm={() => comfyOpen?.clearError()}
        onCancel={() => comfyOpen?.clearError()}
      />

      {/* ── Clear Temporary Files dialog ── */}
      <TempCleanupDialog open={tempCleanupOpen} onOpenChange={setTempCleanupOpen} />

      {/* ── About dialog ── */}
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader className="items-center text-center">
            <img
              src={mounted && resolvedTheme === "dark" ? "/icon-dark.png" : "/icon-light.png"}
              alt="Vek-Snap"
              className="w-16 h-16 object-contain mx-auto mb-2"
              draggable={false}
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <DialogTitle className="text-xl">Vek-Snap</DialogTitle>
            <DialogDescription className="space-y-1">
              <span className="block">AI Creative Studio</span>
              <span className="block text-[11px] text-muted-foreground/60">
                {appVersion ? `Version ${appVersion}` : "Version …"}
              </span>
            </DialogDescription>
          </DialogHeader>

          {/* ── Update check (user-initiated, offline-gated, no user content) ── */}
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-center text-xs space-y-2">
            {updateState.status === "idle" && (
              <p className="text-muted-foreground/70">
                Check online for a newer version. This is the only time Vek-Snap
                contacts the internet, and only if Network Access is on.
              </p>
            )}
            {updateState.status === "checking" && (
              <p className="text-muted-foreground flex items-center justify-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Checking for updates…
              </p>
            )}
            {updateState.status === "current" && (
              <p className="text-emerald-400 flex items-center justify-center gap-1.5">
                <Check className="w-3.5 h-3.5" /> You&apos;re on the latest version.
              </p>
            )}
            {updateState.status === "offline" && (
              <p className="text-amber-400">{updateState.message}</p>
            )}
            {updateState.status === "error" && (
              <p className="text-red-400">{updateState.message}</p>
            )}
            {updateState.status === "available" && (
              <div className="space-y-1.5">
                <p className="text-cyan-300 font-medium">
                  Version {updateState.latestVersion} is available.
                </p>
                {updateState.summary && (
                  <p className="text-muted-foreground/70">{updateState.summary}</p>
                )}
                {updateState.downloadUrl && (
                  <a
                    href={updateState.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-cyan-400 hover:underline"
                  >
                    <Download className="w-3.5 h-3.5" /> Download the installer
                  </a>
                )}
                {updateState.notesUrl && (
                  <a
                    href={updateState.notesUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-muted-foreground/60 hover:underline"
                  >
                    Release notes
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="text-center text-xs text-muted-foreground/50 space-y-1 pt-1">
            <p>Built with Next.js, Electron, and ComfyUI</p>
            <p>&copy; {new Date().getFullYear()} Vek-Snap. All rights reserved.</p>
          </div>
          <DialogFooter className="justify-center pt-2 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={checkForUpdates}
              disabled={updateState.status === "checking"}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${updateState.status === "checking" ? "animate-spin" : ""}`} />
              Check for updates
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAboutOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
