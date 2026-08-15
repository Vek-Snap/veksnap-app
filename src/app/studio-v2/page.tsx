"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Studio V2: polished, professional-grade shell (parallel route, opt-in).
//
// This is an ALTERNATE presentation that lives alongside the classic UI at "/".
// It does NOT replace or modify the classic page, visit "/" for the original.
// It reuses the existing self-contained studio components (each manages its own
// state via config/onConfigChange), so there is ZERO extra backend/VRAM cost:
// the same ComfyUI process and APIs are shared. Only the chrome/layout differ.
//
// Image generation: a v2-native ImageStudio (Z-Image Turbo txt2img + img2img)
// is mounted below: it is self-contained (its own state, reusing the shared
// workflow-builder + comfyui-api) and does NOT touch the classic page. The
// remaining legacy image modes (compose/Re-Imagine, plain-SD, outpaint,
// smart-upscale, wan/edit) are still coupled to the classic page's giant shared
// state and are being migrated into ImageStudio in stages, use the classic UI
// ("Classic UI" rail button) for those until they land here.
//
// NOTE (G rebuild): VibeVoice is intentionally NOT registered here - that feature
// is not part of the G build. DramaBox is the shipped expressive-TTS engine and
// also powers the Timeline Editor's Audio Generation clips.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import Image from "next/image";
import { useTheme } from "next-themes";
import {
  Film,
  Clapperboard,
  Infinity as InfinityIcon,
  Mic,
  Mic2,
  Music,
  Video,
  Heart,
  Sparkles,
  RefreshCw,
  ShieldCheck,
  Cog,
  LibraryBig,
  Scissors,
  SlidersHorizontal,
  Image as ImageIcon,
  ExternalLink,
  PanelLeftClose,
  PanelLeft,
  PanelRightClose,
  PanelRight,
  Activity,
  ListChecks,
  Minus,
  Square,
  Copy,
  X,
  Sun,
  Moon,
  Columns2,
  ArrowLeftRight,
  ChevronRight,
  Layers,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { createPortal } from "react-dom";

import { useComfyOpen } from "@/components/ComfyOpenProvider";
import { checkConnection, wasRecentlyConnected, getImageUrl } from "@/lib/comfyui-api";
import { switchLayout } from "@/lib/layout-switch";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useToast } from "@/components/ToastProvider";
import ConfirmDialog from "@/components/ConfirmDialog";
import SettingsMenu from "./SettingsMenu";
import ComfyServiceControl from "./ComfyServiceControl";
import { usePersistedConfig, stripBlobUrls } from "@/hooks/usePersistedConfig";
import { WorkflowControlsSlotContext, type WorkflowControlsSlotValue } from "@/components/WorkflowControlsSlot";
import WorkflowConfigPanel from "./WorkflowConfigPanel";
import AIProcessingQueue from "./AIProcessingQueue";
import { useAIQueueRunner } from "./useAIQueueRunner";

import ImageStudio from "@/components/ImageStudio";
import SdxlStudio from "@/components/SdxlStudio";
import ReimagineStudio from "@/components/ReimagineStudio";
import LTX2Studio from "@/components/LTX2Studio";
import LTX25Studio from "@/components/LTX25Studio";
import DirectorStudio from "@/components/DirectorStudio";
import MovieMakerStudio from "@/components/MovieMakerStudio";
import LipSyncStudio from "@/components/LipSyncStudio";
import WanS2VStudio from "@/components/WanS2VStudio";
import AceStepStudio from "@/components/AceStepStudio";
import HeartMuLaStudio from "@/components/HeartMuLaStudio";
import DramaBoxStudio from "@/components/DramaBoxStudio";
import LoraFactory from "@/components/LoraFactory";
import VideoRestoration from "@/components/VideoRestoration";
import MetaGuardStudio from "@/components/MetaGuardStudio";
import TimelineEditorStudio from "@/components/TimelineEditorStudio";
import { timelineStore } from "@/lib/timeline/store";
import { saveJsonFile } from "@/lib/save-file";
import HardwareDock from "@/components/HardwareDock";
import SystemSettingsStudio from "./SystemSettingsStudio";
import LibraryStudio from "./LibraryStudio";

import {
  LTX2Config,
  LTX2_DEFAULTS,
  LTX25_DEFAULTS,
  DirectorConfig,
  DIRECTOR_DEFAULTS,
  WanS2VConfig,
  WAN_S2V_DEFAULTS,
  VideoRestorationConfig,
  VIDEO_RESTORATION_DEFAULTS,
  AceStepConfig,
  ACESTEP_DEFAULTS,
  HeartMuLaConfig,
  HEARTMULA_DEFAULTS,
  DramaBoxConfig,
  DRAMABOX_DEFAULTS,
  MovieMakerConfig,
  MOVIEMAKER_DEFAULTS,
} from "@/lib/types";

// ── Studio registry ──────────────────────────────────────────────────────────

type GroupId = "resource" | "editor" | "image" | "video" | "audio" | "utility";

interface StudioDef {
  key: string;
  label: string;
  blurb: string;
  Icon: LucideIcon;
  group: GroupId;
  // Optional: items sharing a cluster id within a group collapse into ONE slide-out
  // flyout (e.g. "image" = SDXL/Z-Image/Re-Imagine, "ltx" = LTX-2.5/2.3). See CLUSTERS.
  cluster?: string;
  render: () => React.ReactNode;
}

interface GroupDef {
  id: GroupId;
  label: string;
  // Tailwind accent tokens for the group (used on the active rail item + header).
  accent: string;      // text color for active
  accentBg: string;    // subtle bg for active
  accentBorder: string;
  accentBar: string;   // solid bg for the active-item indicator bar (static class)
  glow: string;        // gradient used in the header strip
}

const GROUPS: GroupDef[] = [
  { id: "resource", label: "Resource Hub", accent: "text-indigo-300", accentBg: "bg-indigo-500/15", accentBorder: "border-indigo-500/40", accentBar: "bg-indigo-400", glow: "from-indigo-500/30 via-violet-500/10 to-transparent" },
  { id: "editor", label: "Editor", accent: "text-rose-300", accentBg: "bg-rose-500/15", accentBorder: "border-rose-500/40", accentBar: "bg-rose-400", glow: "from-rose-500/30 via-pink-500/10 to-transparent" },
  { id: "image", label: "Image", accent: "text-sky-300", accentBg: "bg-sky-500/15", accentBorder: "border-sky-500/40", accentBar: "bg-sky-400", glow: "from-sky-500/30 via-cyan-500/10 to-transparent" },
  { id: "video", label: "Video", accent: "text-violet-300", accentBg: "bg-violet-500/15", accentBorder: "border-violet-500/40", accentBar: "bg-violet-400", glow: "from-violet-500/30 via-fuchsia-500/10 to-transparent" },
  { id: "audio", label: "Audio", accent: "text-emerald-300", accentBg: "bg-emerald-500/15", accentBorder: "border-emerald-500/40", accentBar: "bg-emerald-400", glow: "from-emerald-500/30 via-teal-500/10 to-transparent" },
  { id: "utility", label: "Utility", accent: "text-amber-300", accentBg: "bg-amber-500/15", accentBorder: "border-amber-500/40", accentBar: "bg-amber-400", glow: "from-amber-500/30 via-orange-500/10 to-transparent" },
];

// Flyout clusters: multiple studios in the same group that collapse into ONE
// slide-out rail entry (a hover submenu). Keyed by StudioDef.cluster. Only a
// SUBSET of a group need be clustered (e.g. LTX-2.5/2.3 in Video); the rest stay
// standalone rail buttons.
const CLUSTERS: Record<string, { label: string; blurb: string; Icon: LucideIcon }> = {
  image: { label: "Image", blurb: "Image models & inpaint", Icon: ImageIcon },
  ltx: { label: "LTX Video", blurb: "LTX-2.5 & LTX-2.3", Icon: Film },
};

// The pinned "System Settings" surface is not a studio/group, it's a system
// tool reached from a fixed rail entry. Sentinel key + neutral (slate) accent.
const SETTINGS_KEY = "system-settings";
const SETTINGS_GROUP = {
  label: "System",
  accent: "text-slate-300",
  accentBg: "bg-slate-500/15",
  accentBorder: "border-slate-500/40",
  accentBar: "bg-slate-400",
  glow: "from-slate-500/25 via-zinc-500/10 to-transparent",
};

// The Library (models & LoRAs) is the first entry under the Utility group. It
// renders as a card-less surface (see isSpecial) but is otherwise a normal studio.
const LIBRARY_KEY = "library";

// Electron's frameless window has no native title bar, so we render our own.
// `-webkit-app-region: drag` makes a region act as the OS title bar (move the
// window); interactive controls must opt out with `no-drag`.
const DRAG: React.CSSProperties = { WebkitAppRegion: "drag" } as React.CSSProperties;
const NO_DRAG: React.CSSProperties = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

// ── Angle-cut tab for the right dock (Workflow Controls | System) ──
// A parallelogram tab (clip-path) matching the app's pro aesthetic. Overlaps its
// left neighbor slightly so the tabs read as a connected, angled set.
function DockTab({
  active,
  first,
  onClick,
  Icon,
  label,
}: {
  active: boolean;
  first?: boolean;
  onClick: () => void;
  Icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      style={{ ...NO_DRAG, clipPath: "polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 0 100%)" }}
      className={`relative flex items-center gap-1.5 py-2 pl-4 pr-4 text-[11px] font-medium whitespace-nowrap transition-colors ${
        first ? "" : "-ml-3"
      } ${
        active
          ? "z-10 bg-violet-500/20 text-violet-100"
          : "z-0 bg-foreground/[0.04] text-muted-foreground hover:text-foreground hover:bg-foreground/[0.07]"
      }`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

// ── Window controls (minimize / maximize / close) ──
// Mirrors the classic UI's controls; talks to the same preload IPC. Renders
// nothing outside Electron (e.g. when previewed in a plain browser tab).
function WindowControls() {
  const [isMax, setIsMax] = useState(false);
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;

  useEffect(() => {
    if (!api) return;
    api.isMaximized().then(setIsMax);
    api.onMaximizedChange(setIsMax);
  }, [api]);

  if (!api) return null;

  const btn = "inline-flex items-center justify-center w-12 h-full text-muted-foreground transition-colors";
  return (
    <div className="flex items-center h-full -mr-5 self-stretch" style={NO_DRAG}>
      <button className={`${btn} hover:bg-foreground/10 hover:text-foreground`} onClick={() => api.minimize()} title="Minimize" aria-label="Minimize">
        <Minus className="w-4 h-4" />
      </button>
      <button className={`${btn} hover:bg-foreground/10 hover:text-foreground`} onClick={() => api.maximize()} title={isMax ? "Restore" : "Maximize"} aria-label={isMax ? "Restore" : "Maximize"}>
        {isMax ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
      </button>
      <button className={`${btn} hover:bg-red-600 hover:text-white`} onClick={() => api.close()} title="Close" aria-label="Close">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ── localStorage-backed UI state (SSR-safe via useSyncExternalStore) ──
// Server snapshot returns the fallback, so initial paint matches SSR (no
// hydration mismatch); the stored value is adopted right after hydration.
function usePersisted(key: string, fallback: string): [string, (v: string) => void] {
  const subscribe = useCallback((cb: () => void) => {
    if (typeof window === "undefined") return () => {};
    const onStorage = (e: StorageEvent) => { if (e.key === key) cb(); };
    const evt = `vs2-ls:${key}`;
    window.addEventListener("storage", onStorage);
    window.addEventListener(evt, cb);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(evt, cb);
    };
  }, [key]);
  const value = useSyncExternalStore(
    subscribe,
    () => { try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
    () => fallback,
  );
  const setValue = useCallback((v: string) => {
    try { window.localStorage.setItem(key, v); } catch { /* ignore */ }
    window.dispatchEvent(new Event(`vs2-ls:${key}`));
  }, [key]);
  return [value, setValue];
}

// ── Live ComfyUI connection (single poller, shared by header + footer) ──
function useComfyConnection(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Start optimistically green if ComfyUI was connected moments ago (e.g. we
    // just arrived here from a Classic/Modern switch), the poll below confirms
    // or corrects within ~1s, so a running server never flashes red on switch.
    if (wasRecentlyConnected()) setConnected(true);
    const poll = async () => {
      let ok = false;
      try { ok = await checkConnection(); } catch { ok = false; }
      if (cancelled) return;
      setConnected(ok);                       // async callback: safe in effect
      timer = setTimeout(poll, ok ? 30000 : 5000);
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, []);
  return connected;
}

function ComfyDot({ connected }: { connected: boolean }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full ${
        connected ? "bg-emerald-400 shadow-[0_0_6px] shadow-emerald-400/70" : "bg-rose-500"
      }`}
    />
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme !== "light"; // dark is the default
  // The icon reflects the CURRENT mode (sun = high luminosity / light, moon = low
  // luminosity / dark); the tooltip offers the OPPOSITE. Clicking toggles.
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={isDark ? 'Switch to "High Luminosity Mode"' : 'Switch to "Low Luminosity Mode"'}
      aria-label="Toggle theme"
      style={NO_DRAG}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors"
    >
      {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
    </button>
  );
}

// ── Open-in-ComfyUI button ──
// Enabled only when the active studio has registered a workflow (via
// useRegisterComfyWorkflow) AND ComfyUI is connected. The ComfyUI status +
// start/stop/restart controls live in ComfyServiceControl (to its left); the
// theme toggle is rendered separately in the header.
function OpenInComfyUIButton({ connected }: { connected: boolean }) {
  const comfyOpen = useComfyOpen();
  const canOpen = connected && !!comfyOpen?.hasWorkflow;
  if (!comfyOpen?.hasWorkflow) return null;
  return (
    <button
      type="button"
      onClick={() => { void comfyOpen.openInComfyUI(); }}
      disabled={!canOpen || comfyOpen.status === "opening"}
      title={connected ? "Stage this workflow and open it in ComfyUI" : "ComfyUI is offline: start it to open your workflow"}
      style={NO_DRAG}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <ExternalLink className="w-3.5 h-3.5" />
      {comfyOpen.status === "opening" ? "Opening…" : "Open in ComfyUI"}
    </button>
  );
}

// Reconstruct Director image/audio previews from persisted ComfyUI input
// filenames (blob previews are stripped on write), and reset any mid-flight
// segment status so a restored session never looks "stuck" mid-render.
function hydrateDirector(parsed: DirectorConfig): DirectorConfig {
  const inputUrl = (file?: string) => (file ? getImageUrl(file, "", "input") : "");
  return {
    ...parsed,
    storyboardImages: (parsed.storyboardImages ?? []).map((sb) => ({
      ...sb,
      preview: sb.image ? getImageUrl(sb.image, "", "input") : sb.preview ?? "",
    })),
    masterAudioPreview: parsed.masterAudioFile
      ? getImageUrl(parsed.masterAudioFile, "", "input")
      : parsed.masterAudioPreview,
    segments: (parsed.segments ?? []).map((s) => ({
      ...s,
      sourceImagePreview: inputUrl(s.sourceImage),
      endImagePreview: inputUrl(s.endImage),
      status: s.status === "complete" ? "complete" : "pending",
      error: null,
    })),
  };
}

// ── Flyout submenu for multi-studio groups (e.g. Image) ──────────────────────
// A single rail entry that, on hover, slides out a card of sub-options. The card
// is portaled to <body> with fixed positioning so it escapes the rail's vertical
// overflow (which would otherwise clip a left-full flyout).
function GroupFlyout({
  items,
  activeKey,
  onSelect,
  railOpen,
  group,
  TriggerIcon,
  triggerLabel,
  triggerBlurb,
}: {
  items: StudioDef[];
  activeKey: string;
  onSelect: (key: string) => void;
  railOpen: boolean;
  group: GroupDef;
  TriggerIcon: LucideIcon;
  triggerLabel: string;
  triggerBlurb: string;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const activeItem = items.find((i) => i.key === activeKey);
  const isActive = !!activeItem;

  const show = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    setOpen(true);
  }, []);
  const scheduleHide = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  }, []);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const select = useCallback((key: string) => { onSelect(key); setOpen(false); }, [onSelect]);

  return (
    <div
      ref={wrapRef}
      className="relative"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
    >
      <button
        type="button"
        onClick={() => select(activeItem?.key ?? items[0].key)}
        aria-current={isActive ? "page" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`group relative w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
          isActive
            ? `${group.accentBg} ${group.accent} border ${group.accentBorder}`
            : "text-muted-foreground hover:text-foreground hover:bg-foreground/5 border border-transparent"
        } ${railOpen ? "" : "justify-center"}`}
      >
        {isActive && <span className={`absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r ${group.accentBar}`} />}
        <TriggerIcon className="w-4 h-4 shrink-0 transition-transform duration-200 group-hover:scale-110" />
        {railOpen && (
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium leading-tight truncate">{triggerLabel}</span>
            <span className="block text-[9px] text-muted-foreground/70 leading-tight truncate">
              {activeItem ? activeItem.label : triggerBlurb}
            </span>
          </span>
        )}
        <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${railOpen ? "" : "hidden"} ${open ? "translate-x-0.5 opacity-100" : "opacity-50"}`} />
      </button>

      {open && rect && typeof document !== "undefined" && createPortal(
        <div
          onMouseEnter={show}
          onMouseLeave={scheduleHide}
          style={{ position: "fixed", top: rect.top, left: rect.right + 8, zIndex: 80 }}
          className="w-60 animate-in fade-in-0 slide-in-from-left-2 duration-150"
        >
          <div className={`rounded-xl border ${group.accentBorder} bg-[var(--sidebar)]/95 backdrop-blur shadow-2xl p-1.5 space-y-0.5`}>
            <div className={`px-2 py-1 text-[9px] font-semibold uppercase tracking-widest ${group.accent} opacity-70`}>
              {triggerLabel}
            </div>
            {items.map((sub) => {
              const subActive = sub.key === activeKey;
              return (
                <button
                  key={sub.key}
                  type="button"
                  onClick={() => select(sub.key)}
                  aria-current={subActive ? "page" : undefined}
                  className={`group/sub w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    subActive
                      ? `${group.accentBg} ${group.accent}`
                      : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                  }`}
                >
                  <sub.Icon className="w-4 h-4 shrink-0 transition-transform duration-200 group-hover/sub:scale-110" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium leading-tight truncate">{sub.label}</span>
                    <span className="block text-[9px] text-muted-foreground/70 leading-tight truncate">{sub.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default function StudioV2Page() {
  // Per-studio config state (mirrors the classic page, but scoped to this shell).
  const [ltx2Config, setLtx2Config] = useState<LTX2Config>({ ...LTX2_DEFAULTS });
  const [ltx25Config, setLtx25Config] = useState<LTX2Config>({ ...LTX25_DEFAULTS });
  const [directorConfig, setDirectorConfig] = useState<DirectorConfig>({ ...DIRECTOR_DEFAULTS });
  const [movieMakerConfig, setMovieMakerConfig] = useState<MovieMakerConfig>({ ...MOVIEMAKER_DEFAULTS });
  const [s2vConfig, setS2vConfig] = useState<WanS2VConfig>({ ...WAN_S2V_DEFAULTS });
  const [aceStepConfig, setAceStepConfig] = useState<AceStepConfig>({ ...ACESTEP_DEFAULTS });
  const [heartMuLaConfig, setHeartMuLaConfig] = useState<HeartMuLaConfig>({ ...HEARTMULA_DEFAULTS });
  const [dramaBoxConfig, setDramaBoxConfig] = useState<DramaBoxConfig>({ ...DRAMABOX_DEFAULTS });
  const [restoreConfig, setRestoreConfig] = useState<VideoRestorationConfig>({ ...VIDEO_RESTORATION_DEFAULTS });

  const STUDIOS: StudioDef[] = useMemo(() => [
    // Editor
    { key: "timeline", label: "Timeline Editor", blurb: "Multi-Track NLE · Assemble & Export", Icon: Scissors, group: "editor",
      render: () => <TimelineEditorStudio /> },
    // Image
    { key: "image-sdxl", label: "SDXL · SD1.5 · Pony", blurb: "Checkpoint Image Models · Text To Image", Icon: Layers, group: "image", cluster: "image",
      render: () => <SdxlStudio /> },
    { key: "image", label: "Z-Image Turbo", blurb: "Turbo Text → Image & Refine", Icon: ImageIcon, group: "image", cluster: "image",
      render: () => <ImageStudio /> },
    { key: "image-reimagine", label: "Re-Imagine", blurb: "Refine & Custom Inpaint Existing Images", Icon: Wand2, group: "image", cluster: "image",
      render: () => <ReimagineStudio /> },
    // Video
    { key: "ltx25", label: "LTX-2.5", blurb: "Distilled Two-Stage Audio+Video", Icon: Sparkles, group: "video", cluster: "ltx",
      render: () => <LTX25Studio config={ltx25Config} onConfigChange={setLtx25Config} /> },
    { key: "ltx2", label: "LTX-2.3", blurb: "Joint Audio-Video Generation", Icon: Film, group: "video", cluster: "ltx",
      render: () => <LTX2Studio config={ltx2Config} onConfigChange={setLtx2Config} /> },
    { key: "director", label: "Continuum (LTX)", blurb: "Long Video, and Music Video Creation", Icon: InfinityIcon, group: "video",
      render: () => <DirectorStudio config={directorConfig} onConfigChange={setDirectorConfig} /> },
    { key: "moviemaker", label: "Movie Maker", blurb: "Multi-Speaker Dialogue → Film", Icon: Clapperboard, group: "video",
      render: () => <MovieMakerStudio config={movieMakerConfig} onConfigChange={setMovieMakerConfig} /> },
    { key: "lipsync", label: "Lip-Sync", blurb: "Music-Video Lip-Sync Studio", Icon: Mic2, group: "video",
      render: () => <LipSyncStudio /> },
    // Audio
    { key: "wan_s2v", label: "WAN S2V", blurb: "Sound-To-Video With Lip-Sync", Icon: Video, group: "audio",
      render: () => <WanS2VStudio config={s2vConfig} onConfigChange={setS2vConfig} /> },
    { key: "acestep", label: "AceStep", blurb: "Music Generation", Icon: Music, group: "audio",
      render: () => <AceStepStudio config={aceStepConfig} onConfigChange={setAceStepConfig} /> },
    { key: "heartmula", label: "HeartMuLa", blurb: "Music Generation", Icon: Heart, group: "audio",
      render: () => <HeartMuLaStudio config={heartMuLaConfig} onConfigChange={setHeartMuLaConfig} /> },
    { key: "dramabox", label: "DramaBox", blurb: "Expressive TTS", Icon: Mic, group: "audio",
      render: () => <DramaBoxStudio config={dramaBoxConfig} onConfigChange={setDramaBoxConfig} /> },
    // Resource Hub
    { key: LIBRARY_KEY, label: "Library", blurb: "Your Models and LoRAs", Icon: LibraryBig, group: "resource",
      render: () => <LibraryStudio /> },
    // Utility
    { key: "lora", label: "LoRA Factory", blurb: "Train & Manage LoRAs", Icon: Sparkles, group: "utility",
      render: () => <LoraFactory /> },
    { key: "restore", label: "Restore", blurb: "SeedVR2 + Real-ESRGAN", Icon: RefreshCw, group: "utility",
      render: () => <VideoRestoration config={restoreConfig} onConfigChange={setRestoreConfig} /> },
    // NOTE: "Components" now lives in the pinned System Settings panel (a system
    // tool, not a creative utility), see SETTINGS_KEY / SystemSettingsStudio.
    { key: "metaguard", label: "Meta-Guard", blurb: "Privacy Metadata Toolkit", Icon: ShieldCheck, group: "utility",
      render: () => <MetaGuardStudio /> },
  ], [ltx2Config, ltx25Config, directorConfig, movieMakerConfig, s2vConfig, aceStepConfig, heartMuLaConfig, dramaBoxConfig, restoreConfig]);

  // Persist each studio config to localStorage (hydrate-once + debounced write;
  // blob: preview URLs are stripped on write). Director reconstructs its image/
  // audio previews from persisted ComfyUI filenames on hydrate.
  usePersistedConfig("vs2:cfg:ltx2", ltx2Config, setLtx2Config, { sanitize: stripBlobUrls });
  usePersistedConfig("vs2:cfg:ltx25", ltx25Config, setLtx25Config, { sanitize: stripBlobUrls });
  usePersistedConfig("vs2:cfg:director", directorConfig, setDirectorConfig, { sanitize: stripBlobUrls, hydrate: hydrateDirector });
  usePersistedConfig("vs2:cfg:moviemaker", movieMakerConfig, setMovieMakerConfig, { sanitize: stripBlobUrls });
  usePersistedConfig("vs2:cfg:s2v", s2vConfig, setS2vConfig, { sanitize: stripBlobUrls });
  usePersistedConfig("vs2:cfg:acestep", aceStepConfig, setAceStepConfig, { sanitize: stripBlobUrls });
  usePersistedConfig("vs2:cfg:heartmula", heartMuLaConfig, setHeartMuLaConfig, { sanitize: stripBlobUrls });
  usePersistedConfig("vs2:cfg:dramabox", dramaBoxConfig, setDramaBoxConfig, { sanitize: stripBlobUrls });
  usePersistedConfig("vs2:cfg:restore", restoreConfig, setRestoreConfig, { sanitize: stripBlobUrls });

  // Persisted UI state: last active studio + rail collapsed-state survive reloads.
  const [activeKey, setActiveKey] = usePersisted("vs2:active", "timeline");
  const [railRaw, setRailRaw] = usePersisted("vs2:rail", "1");
  const railOpen = railRaw !== "0";
  const toggleRail = useCallback(() => setRailRaw(railOpen ? "0" : "1"), [railOpen, setRailRaw]);

  // Right hardware dock (collapsible). Default closed so nothing polls until opened.
  const [dockRaw, setDockRaw] = usePersisted("vs2:hwdock", "0");
  const dockOpen = dockRaw !== "0";
  const toggleDock = useCallback(() => setDockRaw(dockOpen ? "0" : "1"), [dockOpen, setDockRaw]);

  // Right dock tabs: "workflow" (context-sensitive controls) | "system" (hardware).
  const [dockTab, setDockTab] = usePersisted("vs2:dockTab", "workflow");
  // Modern-layout mode: "compact" = single tabbed right dock (small screens);
  // "full" = separate Workflow Controls + System panels side-by-side (big screens).
  const [layout, setLayout] = usePersisted("vs2:layout", "compact");
  const layoutFull = layout === "full";
  // Program-wide dock side. "right" (default) keeps Workflow Controls + System on
  // the right; "left" mirrors them to just right of the nav rail (Workflow Controls
  // stays adjacent to the center canvas, System on the outer edge).
  const [dockSideRaw, setDockSideRaw] = usePersisted("vs2:dockSide", "right");
  const dockLeft = dockSideRaw === "left";
  const toggleDockSide = useCallback(() => setDockSideRaw(dockLeft ? "right" : "left"), [dockLeft, setDockSideRaw]);
  // Nav rail current width (px), used by the left-docked resize math.
  const navWidthPx = railOpen ? 240 : 60;
  // Portal target + occupancy for the "Workflow Controls" tab. A studio projects its
  // controls into `controlsSlotEl` via <WorkflowControls>; `hasControls` toggles the
  // empty state. `setHasControls` is a stable setter, so the consumer effect is loop-free.
  const [controlsSlotEl, setControlsSlotEl] = useState<HTMLElement | null>(null);
  const [hasControls, setHasControls] = useState(false);
  const workflowSlotValue = useMemo<WorkflowControlsSlotValue>(
    () => ({ slot: controlsSlotEl, setHasControls }),
    [controlsSlotEl],
  );

  // Workflows the Timeline Editor can call, each maps its studio tab to the
  // localStorage key it persists to, so the pinned Timeline Integration panel can
  // save/load that workflow's params. (See WorkflowConfigPanel.) DramaBox powers
  // the timeline's Audio Generation clips.
  const TIMELINE_WORKFLOWS: Record<string, { workflow: string; lsKey: string; label: string }> = {
    "image-sdxl": { workflow: "sdxl", lsKey: "vs2:img:sdxl", label: "SDXL \u00b7 SD1.5 \u00b7 Pony" },
    "image": { workflow: "zimage", lsKey: "vs2:img:zimage", label: "Z-Image Turbo" },
    "dramabox": { workflow: "dramabox", lsKey: "vs2:cfg:dramabox", label: "DramaBox" },
  };
  const activeWf = TIMELINE_WORKFLOWS[activeKey];
  // Drive the AI Processing Queue (runs even when its panel is collapsed).
  useAIQueueRunner();

  // Right dock is user-resizable (width persisted). Drag the handle on its left
  // edge; width is clamped to a sensible range. `resizing` disables the width
  // transition mid-drag so the panel tracks the cursor 1:1.
  // Continuum's right panel hosts the full Pipeline Settings + generate controls,
  // so enforce a higher MIN width when Continuum (key "director") is active.
  const DOCK_MAX = 640, DOCK_DEFAULT = 320;
  const dockMin = activeKey === "director" || activeKey === "image" || activeKey.startsWith("image-") ? 360 : 260;
  const [dockWRaw, setDockWRaw] = usePersisted("vs2:hwdockW", String(DOCK_DEFAULT));
  const dockW = Math.min(DOCK_MAX, Math.max(dockMin, parseInt(dockWRaw, 10) || DOCK_DEFAULT));
  // System / Resource-monitor panel (Full layout only), independently resizable.
  const SYS_MAX = 520, SYS_MIN = 240, SYS_DEFAULT = 300;
  const [sysWRaw, setSysWRaw] = usePersisted("vs2:sysW", String(SYS_DEFAULT));
  const sysW = Math.min(SYS_MAX, Math.max(SYS_MIN, parseInt(sysWRaw, 10) || SYS_DEFAULT));
  const [resizing, setResizing] = useState(false);

  // Generic left-edge drag resizer. `rightOffsetPx` = combined width of any
  // panel(s) sitting to the RIGHT of the one being dragged (the System panel in
  // Full layout), so the width tracks the cursor 1:1 regardless of position.
  const startEdgeResize = useCallback(
    (setRaw: (v: string) => void, min: number, max: number, offsetPx: number, fromLeft = false) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        setResizing(true);
        const onMove = (ev: MouseEvent) => {
          const w = fromLeft
            ? Math.min(max, Math.max(min, ev.clientX - offsetPx))
            : Math.min(max, Math.max(min, window.innerWidth - offsetPx - ev.clientX));
          setRaw(String(Math.round(w)));
        };
        const onUp = () => {
          setResizing(false);
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          document.body.style.userSelect = "";
          document.body.style.cursor = "";
        };
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      },
    [],
  );
  // Workflow/dock panel: offset by the System panel width when in Full layout.
  const startDockResize = useCallback(
    (e: React.MouseEvent) =>
      dockLeft
        ? startEdgeResize(setDockWRaw, dockMin, DOCK_MAX, navWidthPx + (layoutFull ? sysW : 0), true)(e)
        : startEdgeResize(setDockWRaw, dockMin, DOCK_MAX, layoutFull ? sysW : 0)(e),
    [startEdgeResize, setDockWRaw, dockMin, layoutFull, sysW, dockLeft, navWidthPx],
  );
  // System panel: outermost on whichever side the dock lives (nav-adjacent when left).
  const startSysResize = useCallback(
    (e: React.MouseEvent) =>
      dockLeft
        ? startEdgeResize(setSysWRaw, SYS_MIN, SYS_MAX, navWidthPx, true)(e)
        : startEdgeResize(setSysWRaw, SYS_MIN, SYS_MAX, 0)(e),
    [startEdgeResize, setSysWRaw, dockLeft, navWidthPx],
  );

  const connected = useComfyConnection();

  const active = STUDIOS.find((s) => s.key === activeKey) ?? STUDIOS[0];
  const activeGroup = GROUPS.find((g) => g.id === active.group)!;
  const isSystemSettings = activeKey === SETTINGS_KEY;
  const isLibrary = activeKey === LIBRARY_KEY;
  const isSpecial = isSystemSettings || isLibrary;
  const headerGroup = isSystemSettings ? SETTINGS_GROUP : activeGroup;
  const headerLabel = isSystemSettings ? "System Settings" : active.label;
  const headerBlurb = isSystemSettings
    ? "Model paths, components, cache & system tools"
    : active.blurb;
  const HeaderIcon = isSystemSettings ? Cog : active.Icon;

  const studiosByGroup = useCallback(
    (g: GroupId) => STUDIOS.filter((s) => s.group === g),
    [STUDIOS],
  );

  // Keyboard: Ctrl+B toggles the rail (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (!typing && e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleRail]);

  // ── Save / Load / Fresh Start (operate on v2's per-studio configs) ──
  // The settings file format is shared with the classic UI (version 7); v2 owns
  // a subset of keys, so a v2 file loads cleanly in classic and vice-versa.
  const { toast } = useToast();
  const [loadNonce, setLoadNonce] = useState(0); // bump to remount the active studio (rebuilds previews)
  const [freshOpen, setFreshOpen] = useState(false);

  // Unsaved-changes (dirty) tracking: snapshot configs; push the flag to the
  // Electron shell so its close intercept can prompt to save.
  const snapshot = useMemo(
    () => JSON.stringify({ ltx2Config, ltx25Config, directorConfig, movieMakerConfig, s2vConfig, aceStepConfig, heartMuLaConfig, dramaBoxConfig, restoreConfig }),
    [ltx2Config, ltx25Config, directorConfig, movieMakerConfig, s2vConfig, aceStepConfig, heartMuLaConfig, dramaBoxConfig, restoreConfig],
  );
  const baselineRef = useRef(snapshot);
  const snapshotRef = useRef(snapshot);
  const pendingCleanRef = useRef(false);
  const markClean = useCallback(() => {
    baselineRef.current = snapshotRef.current;
    window.electronAPI?.setUnsavedChanges(false);
  }, []);
  useEffect(() => {
    snapshotRef.current = snapshot;
    if (pendingCleanRef.current) { baselineRef.current = snapshot; pendingCleanRef.current = false; }
    window.electronAPI?.setUnsavedChanges(snapshot !== baselineRef.current);
  }, [snapshot]);

  const handleV2Save = useCallback(async (): Promise<boolean> => {
    const config = {
      ltx2Config, ltx25Config, directorConfig, movieMakerConfig, s2vConfig,
      aceStepConfig, heartMuLaConfig, dramaBoxConfig, restoreConfig,
      version: 7, _source: "studio-v2",
    };
    // saveJsonFile strips ephemeral blob:/data: URLs (deep) so the file stays
    // portable; ComfyUI input filenames survive so previews rebuild on load.
    // In Electron it resolves only after the file is written (or cancelled).
    const ok = await saveJsonFile(`veksnap_settings_${Date.now()}.json`, config);
    if (ok) {
      markClean();
      toast("Settings saved", "success");
    }
    return ok;
  }, [ltx2Config, ltx25Config, directorConfig, movieMakerConfig, s2vConfig, aceStepConfig, heartMuLaConfig, dramaBoxConfig, restoreConfig, markClean, toast]);

  const handleV2Load = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const c = JSON.parse(reader.result as string);
          if (c.ltx2Config) setLtx2Config((p) => ({ ...p, ...c.ltx2Config }));
          if (c.ltx25Config) setLtx25Config((p) => ({ ...p, ...c.ltx25Config }));
          if (c.directorConfig) setDirectorConfig((p) => hydrateDirector({ ...p, ...c.directorConfig }));
          if (c.movieMakerConfig) setMovieMakerConfig((p) => ({ ...p, ...c.movieMakerConfig }));
          if (c.s2vConfig) setS2vConfig((p) => ({ ...p, ...c.s2vConfig }));
          if (c.aceStepConfig) setAceStepConfig((p) => ({ ...p, ...c.aceStepConfig }));
          if (c.heartMuLaConfig) setHeartMuLaConfig((p) => ({ ...p, ...c.heartMuLaConfig }));
          if (c.dramaBoxConfig) setDramaBoxConfig((p) => ({ ...p, ...c.dramaBoxConfig }));
          if (c.restoreConfig) setRestoreConfig((p) => ({ ...p, ...c.restoreConfig }));
          setLoadNonce((n) => n + 1); // remount active studio → its preview-rebuild effect runs
          pendingCleanRef.current = true; // loaded state is the new clean baseline
          toast(`Loaded settings from ${file.name}`, "success");
        } catch {
          toast("Invalid settings file: expected a Vek-Snap .json", "error");
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, [toast]);

  const handleV2FreshStart = useCallback(() => setFreshOpen(true), []);
  const executeV2FreshStart = useCallback(() => {
    // Page-scoped reset: on the Timeline Editor page this clears ONLY the
    // timeline project (never the generation-studio configs). On any other page
    // it resets the generation studios and leaves the timeline untouched, so a
    // reset from LTX / Z-Image never wipes the user's assembled timeline.
    if (activeKey === "timeline") {
      timelineStore.newProject();
      setFreshOpen(false);
      toast("Timeline cleared", "info");
      return;
    }
    setLtx2Config({ ...LTX2_DEFAULTS });
    setLtx25Config({ ...LTX25_DEFAULTS });
    setDirectorConfig({ ...DIRECTOR_DEFAULTS });
    setMovieMakerConfig({ ...MOVIEMAKER_DEFAULTS });
    setS2vConfig({ ...WAN_S2V_DEFAULTS });
    setAceStepConfig({ ...ACESTEP_DEFAULTS });
    setHeartMuLaConfig({ ...HEARTMULA_DEFAULTS });
    setDramaBoxConfig({ ...DRAMABOX_DEFAULTS });
    setRestoreConfig({ ...VIDEO_RESTORATION_DEFAULTS });
    setLoadNonce((n) => n + 1);
    pendingCleanRef.current = true;
    setFreshOpen(false);
    toast("All studio settings reset to defaults", "info");
  }, [toast, activeKey]);

  // Keyboard: Ctrl+S save, Ctrl+O load (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing || !e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.key === "s" || e.key === "S") { e.preventDefault(); void handleV2Save(); }
      else if (e.key === "o" || e.key === "O") { e.preventDefault(); handleV2Load(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleV2Save, handleV2Load]);

  // Exit flow: confirm close (+ Save&Quit when dirty) and a shutdown overlay.
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeDirty, setCloseDirty] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.electronAPI : undefined;
    if (!api) return;
    api.onConfirmClose((hasUnsaved) => { setCloseDirty(hasUnsaved); setCloseOpen(true); });
  }, []);
  const doQuit = useCallback(() => {
    setCloseOpen(false);
    setShuttingDown(true);
    window.setTimeout(() => window.electronAPI?.confirmClose(), 150);
  }, []);
  const doSaveQuit = useCallback(async () => {
    // Wait for the save to ACTUALLY complete (native dialog + write) before we
    // begin the terminate cycle, otherwise the app can quit mid-Save dialog and
    // lose the file. If the user cancels the save, stay open (don't quit).
    const saved = await handleV2Save();
    if (!saved) return;
    setCloseOpen(false);
    setShuttingDown(true);
    window.electronAPI?.confirmClose();
  }, [handleV2Save]);

  return (
    <WorkflowControlsSlotContext.Provider value={workflowSlotValue}>
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)] selection:bg-violet-500/30">
      {/* ── Left rail ── */}
      <aside
        className={`relative flex flex-col border-r border-border/60 bg-[var(--sidebar)] backdrop-blur transition-[width] duration-200 ease-out ${
          railOpen ? "w-60" : "w-[60px]"
        }`}
      >
        {/* Brand (also a window-drag region) */}
        <div style={DRAG} className="flex items-center gap-2.5 px-3.5 h-14 border-b border-border/60 shrink-0">
          <Image src="/icon-dark.png" alt="Vek-Snap" width={26} height={26} className="rounded-md shrink-0" />
          {railOpen && (
            <div className="min-w-0">
              <div className="text-[13px] font-semibold tracking-tight leading-none bg-gradient-to-r from-violet-300 to-fuchsia-300 bg-clip-text text-transparent">
                VEK-SNAP
              </div>
              <div className="text-[9px] text-muted-foreground leading-tight mt-0.5">Modern Layout</div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 space-y-4">
          {GROUPS.map((group) => {
            const items = studiosByGroup(group.id);
            if (items.length === 0) return null;

            // Build ordered render units: clustered items (StudioDef.cluster)
            // collapse into ONE slide-out flyout (by first occurrence); everything
            // else renders as a standalone rail button.
            const seen = new Set<string>();
            const units: (
              | { kind: "flyout"; cluster: string; items: StudioDef[] }
              | { kind: "item"; item: StudioDef }
            )[] = [];
            for (const s of items) {
              if (s.cluster) {
                if (!seen.has(s.cluster)) {
                  seen.add(s.cluster);
                  units.push({ kind: "flyout", cluster: s.cluster, items: items.filter((x) => x.cluster === s.cluster) });
                }
              } else {
                units.push({ kind: "item", item: s });
              }
            }

            const renderItem = (s: StudioDef) => {
              const isActive = s.key === activeKey;
              const g = GROUPS.find((gg) => gg.id === s.group)!;
              const inner = (
                <button
                  type="button"
                  onClick={() => setActiveKey(s.key)}
                  aria-current={isActive ? "page" : undefined}
                  className={`group relative w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    isActive
                      ? `${g.accentBg} ${g.accent} border ${g.accentBorder}`
                      : "text-muted-foreground hover:text-foreground hover:bg-foreground/5 border border-transparent"
                  } ${railOpen ? "" : "justify-center"}`}
                >
                  {isActive && (
                    <span className={`absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-r ${g.accentBar}`} />
                  )}
                  <s.Icon className="w-4 h-4 shrink-0 transition-transform duration-200 group-hover:scale-110" />
                  {railOpen && (
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium leading-tight truncate">{s.label}</span>
                      <span className="block text-[9px] text-muted-foreground/70 leading-tight truncate">{s.blurb}</span>
                    </span>
                  )}
                </button>
              );
              return railOpen ? (
                <div key={s.key}>{inner}</div>
              ) : (
                <Tooltip key={s.key}>
                  <TooltipTrigger asChild>{inner}</TooltipTrigger>
                  <TooltipContent side="right" className="flex flex-col gap-0.5">
                    <span className="font-medium">{s.label}</span>
                    <span className="opacity-70 text-[10px]">{s.blurb}</span>
                  </TooltipContent>
                </Tooltip>
              );
            };

            return (
              <div key={group.id} className="px-2">
                {railOpen && (
                  <div className={`px-2 mb-1.5 text-[9px] font-semibold uppercase tracking-widest ${group.accent} opacity-70`}>
                    {group.label}
                  </div>
                )}
                <div className="space-y-0.5">
                  {units.map((u) => {
                    if (u.kind === "flyout") {
                      const meta = CLUSTERS[u.cluster];
                      return (
                        <GroupFlyout
                          key={u.cluster}
                          items={u.items}
                          activeKey={activeKey}
                          onSelect={setActiveKey}
                          railOpen={railOpen}
                          group={group}
                          TriggerIcon={meta?.Icon ?? u.items[0].Icon}
                          triggerLabel={meta?.label ?? u.cluster}
                          triggerBlurb={meta?.blurb ?? ""}
                        />
                      );
                    }
                    return renderItem(u.item);
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Footer: pinned System Settings + classic-UI escape hatch + collapse */}
        <div className="border-t border-border/60 p-2 space-y-1 shrink-0">
          {/* System Settings: a fixed system-tools entry (model paths, components,
              cache), pinned above the Classic UI switch per the vertical-nav design. */}
          <button
            type="button"
            onClick={() => setActiveKey(SETTINGS_KEY)}
            title="System Settings: model paths, components, cache"
            className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] transition-colors ${
              isSystemSettings
                ? "bg-slate-500/15 text-slate-200 border border-slate-500/40"
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/5 border border-transparent"
            } ${railOpen ? "" : "justify-center"}`}
          >
            <Cog className="w-4 h-4 shrink-0" />
            {railOpen && <span>System Settings</span>}
          </button>
          {/* Plain anchor (NOT next/link) => a full-page load. The classic and
              modern shells are separate self-contained UIs; a hard nav guarantees
              clean teardown (websockets/VRAM/effects) and fires the beforeunload
              dirty guard, matching the Classic->Modern switch. A soft <Link> nav
              here left stale App Router client-cache/state that broke the toggle
              after a few switches. */}
          <a
            href="/"
            onClick={(e) => { e.preventDefault(); switchLayout("/"); }}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors ${
              railOpen ? "" : "justify-center"
            }`}
            title="Open the classic UI"
          >
            <ExternalLink className="w-4 h-4 shrink-0" />
            {railOpen && <span>Classic UI</span>}
          </a>
          <button
            type="button"
            onClick={toggleRail}
            title={railOpen ? "Collapse sidebar (Ctrl+B)" : "Expand sidebar (Ctrl+B)"}
            className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] text-muted-foreground/80 hover:text-foreground hover:bg-foreground/5 transition-colors ${
              railOpen ? "" : "justify-center"
            }`}
          >
            {railOpen ? <PanelLeftClose className="w-4 h-4 shrink-0" /> : <PanelLeft className="w-4 h-4 shrink-0" />}
            {railOpen && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* ── Main column ── */}
      <main className={`flex-1 flex flex-col min-w-0 ${dockLeft ? "order-last" : ""}`}>
        {/* Header strip with group glow, doubles as the window title bar (drag) */}
        <header style={DRAG} className="relative h-14 shrink-0 border-b border-border/60 flex items-center px-5 overflow-hidden">
          <div className={`pointer-events-none absolute inset-0 bg-gradient-to-r ${headerGroup.glow} opacity-60`} />
          <div className="relative flex items-center gap-3 min-w-0">
            <span className={`flex items-center justify-center w-8 h-8 rounded-lg ${headerGroup.accentBg} ${headerGroup.accent} border ${headerGroup.accentBorder}`}>
              <HeaderIcon className="w-4 h-4" />
            </span>
            <div key={activeKey} className="min-w-0 animate-in fade-in-0 slide-in-from-left-1 duration-300">
              <h1 className="text-[15px] font-semibold leading-tight truncate">{headerLabel}</h1>
              <p className="text-[10px] text-muted-foreground leading-tight truncate">{headerBlurb}</p>
            </div>
          </div>
          <div className="relative ml-auto flex items-center gap-2 h-full">
            {/* Order (Developer's spec): ComfyUI status/service manager, then Open in
                ComfyUI, then Quick Settings, then the rest (theme, group, panels). */}
            <ComfyServiceControl />
            <OpenInComfyUIButton connected={connected} />
            <SettingsMenu onSave={handleV2Save} onLoad={handleV2Load} onFreshStart={handleV2FreshStart} freshStartLabel={activeKey === "timeline" ? "Clear Timeline" : "Reset Studios"} />
            <ThemeToggle />
            <span className={`hidden lg:inline text-[10px] uppercase tracking-widest font-semibold ${headerGroup.accent} opacity-70`}>
              {headerGroup.label}
            </span>
            <button
              type="button"
              onClick={toggleDock}
              style={NO_DRAG}
              title={dockOpen
                ? (layoutFull ? "Hide side panels" : "Hide panel")
                : (layoutFull ? "Show side panels (Workflow + System)" : "Show panel (Workflow / System)")}
              className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${dockOpen ? "border-violet-500/40 bg-violet-500/15 text-violet-200" : "border-border/60 text-muted-foreground hover:text-foreground"}`}
            >
              {dockOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRight className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => setLayout(layoutFull ? "compact" : "full")}
              style={NO_DRAG}
              title={layoutFull ? "Switch to Compact layout (single tabbed panel)" : "Switch to Full layout (separate Workflow + System panels)"}
              className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${layoutFull ? "border-violet-500/40 bg-violet-500/15 text-violet-200" : "border-border/60 text-muted-foreground hover:text-foreground"}`}
            >
              <Columns2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={toggleDockSide}
              style={NO_DRAG}
              title={dockLeft ? "Move panels to the right side" : "Move panels to the left side"}
              className={`inline-flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${dockLeft ? "border-violet-500/40 bg-violet-500/15 text-violet-200" : "border-border/60 text-muted-foreground hover:text-foreground"}`}
            >
              <ArrowLeftRight className="w-4 h-4" />
            </button>
            {/* Window controls live at the window's true top-right. When a side panel
                is open (right dock) OR the panels are docked left, the center <main>
                becomes the rightmost column, so the controls live here. */}
            {(dockLeft || !dockOpen) && <WindowControls />}
          </div>
        </header>

        {/* Studio surface */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-4">
            {/* Each studio renders its own self-contained UI. Keyed by studio so
                switching fully remounts (clean state per studio surface). */}
            <div
              key={isSpecial ? activeKey : `${active.key}:${loadNonce}`}
              className={`animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ${isSpecial ? "" : "rounded-xl border border-border/60 bg-card/40"}`}
            >
              {isSystemSettings ? <SystemSettingsStudio /> : active.render()}
            </div>
          </div>
        </div>

        {/* Status bar */}
        <footer className="h-7 shrink-0 border-t border-border/60 flex items-center gap-3 px-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ComfyDot connected={connected} />
            ComfyUI {connected ? "connected" : "offline"}
          </span>
          <span className="opacity-30">•</span>
          <span className="truncate">{headerLabel}</span>
          <span className="ml-auto opacity-60">Vek-Snap Studio · Ctrl+B toggles sidebar</span>
        </footer>
      </main>

      {/* ── Right panel(s) ──
          Compact = one tabbed dock (Workflow | System). Full = two side-by-side
          panels (Workflow Controls + a System/Resource monitor) for large monitors.
          Only one branch mounts, so the controls-portal slot (setControlsSlotEl)
          is always a single instance. The OS window controls always live in the
          RIGHTMOST visible header so min/max/close stay in the true corner. */}
      {layoutFull ? (
        <>
          {/* Workflow Controls panel (nearest the center canvas; no window controls). */}
          <aside
            style={{ width: dockOpen ? dockW : 0 }}
            className={`relative shrink-0 flex flex-col ${dockLeft ? "border-r order-2" : "border-l"} border-border/60 bg-[var(--sidebar)] backdrop-blur overflow-hidden ${resizing ? "" : "transition-[width] duration-200 ease-out"}`}
          >
            {dockOpen && (
              <>
                <div
                  onMouseDown={startDockResize}
                  style={NO_DRAG}
                  title="Drag to resize"
                  className={`absolute ${dockLeft ? "right-0" : "left-0"} top-0 z-10 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-violet-500/40 active:bg-violet-500/60`}
                />
                <div style={DRAG} className="flex items-center gap-2 px-3 h-14 border-b border-border/60 shrink-0">
                  {/* On the System Settings page there are no workflow controls, this
                      panel only carries the AI queue, so drop the sliders + title. */}
                  {isSystemSettings ? (
                    <>
                      <ListChecks className="w-4 h-4 text-violet-300 shrink-0" />
                      <span className="text-[12px] font-semibold truncate">AI Queue</span>
                    </>
                  ) : (
                    <>
                      <SlidersHorizontal className="w-4 h-4 text-violet-300 shrink-0" />
                      <span className="text-[12px] font-semibold truncate">Workflow Controls</span>
                    </>
                  )}
                </div>
                <div className="flex-1 min-h-0 relative">
                  <div className="absolute inset-0 flex flex-col">
                    <div ref={setControlsSlotEl} className="flex-1 min-h-0 overflow-y-auto p-3" />
                    {activeWf && (
                      <WorkflowConfigPanel workflow={activeWf.workflow} lsKey={activeWf.lsKey} label={activeWf.label}
                        onApplied={() => setLoadNonce((n) => n + 1)} />
                    )}
                    <AIProcessingQueue />
                    {!hasControls && !activeWf && !isSystemSettings && (
                      <div className="absolute inset-x-0 top-0 bottom-auto pt-16 flex flex-col items-center justify-center gap-2 px-6 text-center pointer-events-none">
                        <SlidersHorizontal className="w-6 h-6 text-muted-foreground/30" />
                        <p className="text-[11px] font-medium text-muted-foreground/70">No workflow controls here yet</p>
                        <p className="text-[10px] text-muted-foreground/40 leading-snug">
                          Controls for large workflows (like Continuum) appear on this panel.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </aside>
          {/* System / Resource monitor, outer-edge panel; hosts window controls only when docked right. */}
          <aside
            style={{ width: dockOpen ? sysW : 0 }}
            className={`relative shrink-0 flex flex-col ${dockLeft ? "border-r order-1" : "border-l"} border-border/60 bg-[var(--sidebar)] backdrop-blur overflow-hidden ${resizing ? "" : "transition-[width] duration-200 ease-out"}`}
          >
            {dockOpen && (
              <>
                <div
                  onMouseDown={startSysResize}
                  style={NO_DRAG}
                  title="Drag to resize"
                  className={`absolute ${dockLeft ? "right-0" : "left-0"} top-0 z-10 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-violet-500/40 active:bg-violet-500/60`}
                />
                <div style={DRAG} className="flex items-stretch h-14 border-b border-border/60 shrink-0 pr-5">
                  <div className="flex items-center gap-2 px-3 flex-1 min-w-0">
                    <Activity className="w-4 h-4 text-violet-300 shrink-0" />
                    <span className="text-[12px] font-semibold truncate">System Resource Management</span>
                  </div>
                  {!dockLeft && <WindowControls />}
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <HardwareDock />
                </div>
              </>
            )}
          </aside>
        </>
      ) : (
        // Compact: single tabbed dock (collapsible, user-resizable)
        <aside
          style={{ width: dockOpen ? dockW : 0 }}
          className={`relative shrink-0 flex flex-col ${dockLeft ? "border-r order-1" : "border-l"} border-border/60 bg-[var(--sidebar)] backdrop-blur overflow-hidden ${resizing ? "" : "transition-[width] duration-200 ease-out"}`}
        >
          {dockOpen && (
            <>
              <div
                onMouseDown={startDockResize}
                style={NO_DRAG}
                title="Drag to resize"
                className={`absolute ${dockLeft ? "right-0" : "left-0"} top-0 z-10 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-violet-500/40 active:bg-violet-500/60`}
              />
              {/* Header: tabs (left) + hide button + window controls (true corner). */}
              <div style={DRAG} className="flex items-stretch pl-2 pr-5 h-14 border-b border-border/60 shrink-0">
                <div style={NO_DRAG} className="flex items-end flex-1 min-w-0 overflow-hidden pt-2">
                  <DockTab
                    first
                    active={dockTab === "workflow"}
                    onClick={() => setDockTab("workflow")}
                    Icon={isSystemSettings ? ListChecks : SlidersHorizontal}
                    label={isSystemSettings ? "AI Queue" : "Workflow Controls"}
                  />
                  <DockTab
                    active={dockTab === "system"}
                    onClick={() => setDockTab("system")}
                    Icon={Activity}
                    label="System"
                  />
                </div>
                <div className="flex items-center self-stretch" style={NO_DRAG}>
                  <button
                    type="button"
                    onClick={toggleDock}
                    title="Hide panel"
                    className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 shrink-0"
                  >
                    <PanelRightClose className="w-4 h-4" />
                  </button>
                </div>
                {!dockLeft && <WindowControls />}
              </div>
              <div className="flex-1 min-h-0 relative">
                {/* Workflow Controls: context-sensitive; the active studio portals its controls here. */}
                <div className={`absolute inset-0 flex flex-col ${dockTab === "workflow" ? "" : "hidden"}`}>
                  <div ref={setControlsSlotEl} className="flex-1 min-h-0 overflow-y-auto p-3" />
                  {activeWf && (
                    <WorkflowConfigPanel workflow={activeWf.workflow} lsKey={activeWf.lsKey} label={activeWf.label}
                      onApplied={() => setLoadNonce((n) => n + 1)} />
                  )}
                  <AIProcessingQueue />
                  {!hasControls && !activeWf && !isSystemSettings && (
                    <div className="absolute inset-x-0 top-0 bottom-auto pt-16 flex flex-col items-center justify-center gap-2 px-6 text-center pointer-events-none">
                      <SlidersHorizontal className="w-6 h-6 text-muted-foreground/30" />
                      <p className="text-[11px] font-medium text-muted-foreground/70">No workflow controls here yet</p>
                      <p className="text-[10px] text-muted-foreground/40 leading-snug">
                        Controls for large workflows (like Continuum) appear on this tab.
                      </p>
                    </div>
                  )}
                </div>
                {/* System: hardware monitors */}
                <div className={`absolute inset-0 ${dockTab === "system" ? "" : "hidden"}`}>
                  <HardwareDock />
                </div>
              </div>
            </>
          )}
        </aside>
      )}

      <ConfirmDialog
        open={freshOpen}
        onOpenChange={setFreshOpen}
        title={activeKey === "timeline" ? "Clear the timeline?" : "Reset all studio settings?"}
        description={activeKey === "timeline"
          ? "This clears the current timeline project (tracks, clips, and edits) back to an empty timeline. Your generation-studio settings are not affected."
          : "This restores every generation studio in v2 (LTX-2, Director, TTS, …) to its defaults. Your timeline, saved settings files, and the classic UI are not affected."}
        confirmLabel={activeKey === "timeline" ? "Clear Timeline" : "Reset"}
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={executeV2FreshStart}
      />

      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title={closeDirty ? "Save changes before closing?" : "Close Vek-Snap?"}
        description={closeDirty
          ? "You have unsaved changes. Save them before quitting? All running services (ComfyUI, etc.) will be stopped."
          : "All running services (ComfyUI, etc.) will be stopped."}
        confirmLabel={closeDirty ? "Save & Quit" : "Quit"}
        cancelLabel="Cancel"
        variant={closeDirty ? "default" : "destructive"}
        tertiaryLabel={closeDirty ? "Don't Save" : undefined}
        onTertiary={closeDirty ? doQuit : undefined}
        onConfirm={closeDirty ? doSaveQuit : doQuit}
      />

      {shuttingDown && (
        <div className="fixed inset-0 z-[200] bg-black/80 backdrop-blur flex items-center justify-center">
          <div className="rounded-xl border border-border/60 bg-card px-8 py-6 text-center space-y-3 shadow-2xl">
            <div className="w-7 h-7 mx-auto rounded-full border-2 border-violet-500/30 border-t-violet-400 animate-spin" />
            <div className="text-sm font-medium">Shutting down…</div>
            <div className="text-[11px] text-muted-foreground">Stopping ComfyUI and background services.</div>
          </div>
        </div>
      )}
    </div>
    </WorkflowControlsSlotContext.Provider>
  );
}
