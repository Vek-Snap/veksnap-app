"use client";

// Timeline Editor (NLE): Phase 4 (end-to-end edit + export).
// Multi-track lanes + ruler + Media Pool (import / mic-record / add-text → drag-to-
// add) with in-clip waveforms; clip move/trim/split; linked A/V pairs; per-track
// Mute/Solo; text/title clips (preview overlay + drawtext burn-in); a clip Inspector
// with dB volume (boost to +30 dB), pan, and video transform; an industry-standard
// Keyframe editor (linear automation). Audio runs through a Web Audio graph for live
// boost + pan. Resizable preview scrubs + plays. Project Save/Open (JSON) and MP4
// Export (ffmpeg: overlay composite + drawtext + amix w/ volume automation).
// Remaining (Phase 4+): cross-dissolve transitions between adjacent clips.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Play,
  Pause,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Scissors,
  Trash2,
  Upload,
  Film,
  Music,
  Image as ImageIcon,
  Link as LinkIcon,
  Mic,
  Diamond,
  Activity,
  Type,
  Save,
  FolderOpen,
  RefreshCw,
  Download,
  Loader2,
  Eye,
  EyeOff,
  Sparkles,
  Layers,
  ChevronRight,
  Repeat,
  Folder,
  FolderPlus,
  Plus,
  Check,
  X,
  ChevronsUpDown,
  ChevronsDownUp,
  Settings,
  SlidersHorizontal,
  ChevronDown,
  Palette,
  ArrowUp,
  ArrowDown,
  Pipette,
  Magnet,
  Rewind,
  FastForward,
  ArrowUpDown,
  ArrowLeftRight,
  LayoutGrid,
  Lock as LockIcon,
  Unlock as UnlockIcon,
  Copy as CopyIcon,
  ClipboardPaste,
} from "lucide-react";

import { timelineStore, useTimeline } from "@/lib/timeline/store";
import AIToolsMenu from "@/components/AIToolsMenu";
import { aiQueueStore } from "@/lib/ai-queue/store";
import {
  projectDuration,
  timelineId,
  evalClipProp,
  evalClipGainLinear,
  fadeMultiplier,
  dbToGain,
  KF_PROPS,
  MARKER_COLORS,
  isTitleClip,
  isPendingAudioGenClip,
  isAdjustmentClip,
  clipSpeed,
  SPEED_MIN,
  SPEED_MAX,
  type TimelineTrack,
  type TimelineClip,
  type TimelineProject,
  type TimelineAsset,
  type KeyframeProp,
} from "@/lib/timeline/types";
import { WorkflowControls } from "@/components/WorkflowControlsSlot";
import { TRANSITIONS, type TransitionType } from "@/lib/timeline/transitions";
import {
  EFFECTS,
  EFFECT_ORDER,
  effectsCssFilter,
  effectsVignette,
} from "@/lib/timeline/effects";
import {
  TITLE_PRESETS,
  TITLE_PRESET_MAP,
  titleProgress,
  titleLineCss,
} from "@/lib/timeline/titles";
import { buildAssetsFromFile, decodeAudioPeaks } from "@/lib/timeline/media";
import { saveJsonFile } from "@/lib/save-file";
import { useUiScale, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP, UI_SCALE_DEFAULT } from "@/lib/use-ui-scale";
import { TimelineAudioEngine } from "@/lib/timeline/audioEngine";
import TimelineHotkeysEditor from "@/components/TimelineHotkeysEditor";
import { loadBindings, saveBindings, matchAction, type HotkeyMap, type HotkeyActionId } from "@/lib/timeline/hotkeys";
import KeyframeEditor from "./KeyframeEditor";
import TimelineRelinkDialog from "@/components/TimelineRelinkDialog";

const MENU_ITEM = "w-full text-left px-3 py-1.5 hover:bg-foreground/10 disabled:opacity-40 disabled:hover:bg-transparent";

const ASSET_MIME = "text/timeline-asset";

// Drag payload for the "Audio Generation" add-menu item → dropping it on an audio
// track places a blank placeholder clip the user then scripts (DramaBox).
const AUDIOGEN_MIME = "text/timeline-audiogen";

// ── Export settings model ──
interface ExportSettings {
  container: "mp4" | "mov" | "webm";
  vcodec: "h264" | "h265" | "vp9";
  resKey: string; // "match" | "custom" | "WxH"
  customW: number;
  customH: number;
  fpsKey: string; // "match" | numeric string
  crf: number;
  fileName: string;
  hwEncode?: boolean; // use GPU (NVENC) encoder for H.264/H.265
}

const RES_PRESETS: { key: string; label: string; w: number; h: number }[] = [
  { key: "3840x2160", label: "3840 × 2160: 4K UHD", w: 3840, h: 2160 },
  { key: "2560x1440", label: "2560 × 1440: 1440p QHD", w: 2560, h: 1440 },
  { key: "1920x1080", label: "1920 × 1080: 1080p HD", w: 1920, h: 1080 },
  { key: "1280x720", label: "1280 × 720: 720p HD", w: 1280, h: 720 },
  { key: "1080x1920", label: "1080 × 1920: Vertical 1080 (Shorts/Reels)", w: 1080, h: 1920 },
  { key: "720x1280", label: "720 × 1280: Vertical 720", w: 720, h: 1280 },
];

const FPS_PRESETS = ["24", "25", "30", "48", "50", "60"];

const QUALITY_PRESETS: { label: string; crf: number }[] = [
  { label: "High: visually lossless (large)", crf: 18 },
  { label: "Standard: recommended", crf: 22 },
  { label: "Web: smaller file", crf: 26 },
  { label: "Low: smallest", crf: 30 },
];

const CODEC_LABEL: Record<ExportSettings["vcodec"], string> = {
  h264: "H.264 / AVC: most compatible (YouTube, social)",
  h265: "H.265 / HEVC: smaller, modern devices",
  vp9: "VP9: WebM, royalty-free",
};

// ── Audio export settings model (Export Audio panel) ──
type AudioFormat = "wav" | "mp3" | "flac" | "aac" | "ogg" | "opus";
interface AudioExportSettings {
  format: AudioFormat;
  sampleRate: number;      // 44100 | 48000 | 96000
  channels: 1 | 2;         // stereo / mono downmix
  bitDepth: 16 | 24 | 32;  // lossless (wav/flac); 32 = float (wav only)
  bitrate: string;         // lossy target, e.g. "256k"
  normalize: "none" | "ebu";
  lufs: number;            // EBU R128 integrated-loudness target
  fileName: string;
}
const AUDIO_FORMATS: { key: AudioFormat; label: string; lossy: boolean }[] = [
  { key: "wav",  label: "WAV: uncompressed PCM (lossless, largest)", lossy: false },
  { key: "flac", label: "FLAC: compressed lossless", lossy: false },
  { key: "mp3",  label: "MP3: universal lossy", lossy: true },
  { key: "aac",  label: "AAC / M4A: efficient lossy (Apple, mobile)", lossy: true },
  { key: "opus", label: "Opus: best quality at low bitrate", lossy: true },
  { key: "ogg",  label: "OGG Vorbis: royalty-free lossy", lossy: true },
];
const AUDIO_EXT: Record<AudioFormat, string> = { wav: "wav", flac: "flac", mp3: "mp3", aac: "m4a", ogg: "ogg", opus: "opus" };
const AUDIO_MIME: Record<AudioFormat, string> = { wav: "audio/wav", flac: "audio/flac", mp3: "audio/mpeg", aac: "audio/mp4", ogg: "audio/ogg", opus: "audio/opus" };
const AUDIO_SAMPLE_RATES = [44100, 48000, 96000];
const AUDIO_BITRATES = ["128k", "192k", "256k", "320k"];
const LUFS_TARGETS: { v: number; label: string }[] = [
  { v: -14, label: "-14 LUFS: streaming (Spotify, YouTube)" },
  { v: -16, label: "-16 LUFS: podcasts / Apple" },
  { v: -23, label: "-23 LUFS: EBU R128 broadcast" },
];
const isLossyAudio = (f: AudioFormat): boolean => AUDIO_FORMATS.find((x) => x.key === f)?.lossy ?? false;

// File System Access API (Chromium), lets us pick the save location BEFORE rendering.
type SaveFilePicker = (opts: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;
const getSaveFilePicker = (): SaveFilePicker | undefined =>
  (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;

const FIELD = "w-full bg-card/60 border border-border/60 rounded px-2 py-1.5 text-[12px] text-foreground";
const FLABEL = "block text-[10px] uppercase tracking-wide text-muted-foreground mb-1";

/** Project settings: resolution + frame rate, changeable at any time. */
function ProjectSettingsModal({ project, onClose, onResetLayout }: { project: TimelineProject; onClose: () => void; onResetLayout: () => void }) {
  const [w, setW] = useState(project.width);
  const [h, setH] = useState(project.height);
  const [fps, setFps] = useState(project.fps);
  const resKey = `${w}x${h}`;
  const apply = () => { timelineStore.setProjectFormat({ width: w, height: h, fps }); onClose(); };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-[420px] rounded-lg border border-border/60 bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60">
          <span className="text-[13px] font-semibold">Project Settings</span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className={FLABEL}>Timeline resolution</label>
            <select className={FIELD} value={RES_PRESETS.some((r) => r.key === resKey) ? resKey : "custom"}
              onChange={(e) => { const p = RES_PRESETS.find((r) => r.key === e.target.value); if (p) { setW(p.w); setH(p.h); } }}>
              {!RES_PRESETS.some((r) => r.key === resKey) && <option value="custom">Custom: {w} × {h}</option>}
              {RES_PRESETS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className={FLABEL}>Width</label>
              <input type="number" className={FIELD} value={w} onChange={(e) => setW(Number(e.target.value))} />
            </div>
            <button type="button" title="Swap the width and height (rotate orientation)."
              onClick={() => { setW(h); setH(w); }}
              className="h-9 px-2 rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5"><Repeat className="w-4 h-4" /></button>
            <div className="flex-1">
              <label className={FLABEL}>Height</label>
              <input type="number" className={FIELD} value={h} onChange={(e) => setH(Number(e.target.value))} />
            </div>
          </div>
          <div>
            <label className={FLABEL}>Frame rate (fps)</label>
            <select className={FIELD} value={FPS_PRESETS.includes(String(fps)) ? String(fps) : "custom"}
              onChange={(e) => { if (e.target.value !== "custom") setFps(Number(e.target.value)); }}>
              {!FPS_PRESETS.includes(String(fps)) && <option value="custom">Custom: {fps}</option>}
              {FPS_PRESETS.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <p className="mt-1 text-[10px] text-muted-foreground/80">Unlike some editors, the frame rate can be changed here at any time.</p>
          </div>
          <div className="pt-2 border-t border-border/60">
            <label className={FLABEL}>Editor layout</label>
            <button type="button" onClick={() => { onResetLayout(); onClose(); }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[12px] border border-border/60 hover:bg-foreground/5">
              <Repeat className="w-3.5 h-3.5" /> Reset to Default View
            </button>
            <p className="mt-1 text-[10px] text-muted-foreground/80">Restores panel sizes, snapping, and the media-pool view/sort to their defaults.</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border/60">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded text-[12px] border border-border/60 hover:bg-foreground/5">Cancel</button>
          <button type="button" onClick={apply} className="px-3 py-1.5 rounded text-[12px] font-medium border border-violet-500/50 bg-violet-500/20 text-violet-100 hover:bg-violet-500/30">Apply</button>
        </div>
      </div>
    </div>
  );
}

// Draws ONLY the portion of the source waveform that this clip actually covers.
// `peaks` spans the whole source (`srcDuration` seconds); a clip consumes the
// source window [trimIn, trimIn + duration*speed], so we index into that slice.
// Without this, every clip (and both halves of a split) rendered the entire
// source waveform stretched to its own width, hence the "duplicated" waveform.
function ClipWaveform({ peaks, width, height, trimIn, duration, srcDuration, speed }: {
  peaks: number[]; width: number; height: number;
  trimIn: number; duration: number; srcDuration: number; speed: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks.length || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(width * dpr));
    c.height = Math.max(1, Math.floor(height * dpr));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    // Map the clip's source window onto the peaks array (linear: peaks span
    // `srcDuration`). Guard against a zero/unknown source duration.
    const spd = speed > 0 ? speed : 1;
    const srcSpan = srcDuration > 0 ? srcDuration : duration * spd;
    const startFrac = srcSpan > 0 ? Math.min(1, Math.max(0, trimIn / srcSpan)) : 0;
    const endFrac = srcSpan > 0 ? Math.min(1, Math.max(startFrac, (trimIn + duration * spd) / srcSpan)) : 1;
    const lo = Math.floor(startFrac * peaks.length);
    const hi = Math.max(lo + 1, Math.ceil(endFrac * peaks.length));
    const viewLen = Math.max(1, hi - lo);
    // Per-pixel sampling: take the max peak across the buckets mapping to each
    // pixel column so a zoomed-in clip shows dense professional-grade detail.
    const cols = Math.max(1, Math.floor(width));
    const per = viewLen / cols;
    ctx.fillStyle = "rgba(16, 185, 129, 0.55)";
    for (let x = 0; x < cols; x++) {
      const s = lo + Math.floor(x * per);
      const e = Math.max(s + 1, lo + Math.floor((x + 1) * per));
      let peak = 0;
      for (let i = s; i < e && i < peaks.length; i++) { if (peaks[i] > peak) peak = peaks[i]; }
      const h = Math.max(1, peak * height * 0.92);
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
    // Faint center reference line.
    ctx.fillStyle = "rgba(16, 185, 129, 0.25)";
    ctx.fillRect(0, mid, width, 1);
  }, [peaks, width, height, trimIn, duration, srcDuration, speed]);
  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}

// Filmstrip thumbnails: industry-standard PERSISTENT media cache.
//
// The server decodes each SOURCE FILE exactly once (fixed height, fixed time
// interval) into <install>/Temp/timeline-thumbs and returns metadata only
// (key + frame count + interval). We then draw the strip by pointing each
// column at the NEAREST cached frame via an immutable GET url, so:
//   • Track-height changes  → same urls, the browser rescales (zero server work).
//   • Zoom changes          → re-pick columns from the same cached frames.
//   • App restart           → cache is keyed by path+mtime, so it's reused.
// Work is also deferred until the clip is actually on-screen (viewport
// virtualization) so off-screen clips never trigger a decode.
interface StripMeta { key: string; count: number; interval: number; height: number; duration: number; }
const filmMetaCache = new Map<string, StripMeta>();
const filmMetaInflight = new Map<string, Promise<StripMeta | null>>();

// Tiny pub/sub so the editor's bottom status bar knows when background media
// caching kicks off and can start polling the server's progress endpoint.
const thumbActivityListeners = new Set<() => void>();
function subscribeThumbActivity(fn: () => void): () => void {
  thumbActivityListeners.add(fn);
  return () => { thumbActivityListeners.delete(fn); };
}
function notifyThumbActivity(): void {
  thumbActivityListeners.forEach((l) => l());
}

// "Refresh previews" pub/sub. Clears the client strip caches and tells every
// mounted filmstrip / bin poster to re-fetch (forcing the server to re-decode),
// so a clip whose thumbnail decode was interrupted or failed can be recovered
// without deleting + re-importing it.
const thumbRefreshListeners = new Set<() => void>();
function subscribeThumbRefresh(fn: () => void): () => void {
  thumbRefreshListeners.add(fn);
  return () => { thumbRefreshListeners.delete(fn); };
}
function refreshThumbnails(): void {
  filmMetaCache.clear();
  filmMetaInflight.clear();
  thumbRefreshListeners.forEach((l) => l());
}

function fetchStripMeta(filePath: string, srcDuration: number, force = false): Promise<StripMeta | null> {
  // Force (Refresh Previews): drop any cached/failed result so we hit the server
  // again and have it re-decode from scratch.
  if (force) { filmMetaCache.delete(filePath); filmMetaInflight.delete(filePath); }
  const cached = filmMetaCache.get(filePath);
  if (cached) return Promise.resolve(cached);
  let p = filmMetaInflight.get(filePath);
  if (!p) {
    p = fetch("/api/timeline-thumbs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ src: filePath, srcDuration, force }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: StripMeta | null) => {
        filmMetaInflight.delete(filePath);
        if (d && d.count > 0) { filmMetaCache.set(filePath, d); return d; }
        return null;
      })
      .catch(() => { filmMetaInflight.delete(filePath); return null; });
    filmMetaInflight.set(filePath, p);
    notifyThumbActivity(); // a real POST fired → a decode may be starting
  }
  return p;
}

function ClipFilmstrip({ filePath, trimIn, duration, width, height, srcDuration }: {
  filePath: string; trimIn: number; duration: number; width: number; height: number; srcDuration: number;
}) {
  void height; // height no longer drives decoding, CSS scales the fixed-height frames.
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [meta, setMeta] = useState<StripMeta | null>(() => filmMetaCache.get(filePath) ?? null);
  const forceRef = useRef(false);

  // Viewport virtualization: only decode/draw once the clip scrolls into view.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  // Fetch the per-file strip metadata once it's visible (deduped across clips).
  useEffect(() => {
    if (!visible || meta) return;
    let cancelled = false;
    const force = forceRef.current; forceRef.current = false;
    fetchStripMeta(filePath, srcDuration, force).then((m) => { if (!cancelled && m) setMeta(m); });
    return () => { cancelled = true; };
  }, [visible, meta, filePath, srcDuration]);

  // Refresh Previews: forget the current strip and re-fetch (forced) when visible.
  useEffect(() => subscribeThumbRefresh(() => { forceRef.current = true; setMeta(null); }), []);

  // Columns are derived purely on the client from the current pixel width; each
  // maps to the nearest cached frame timestamp. No server call on zoom/resize.
  const cols = Math.max(1, Math.min(40, Math.ceil(width / 90)));
  const frames = useMemo(() => {
    if (!meta) return [];
    const out: string[] = [];
    for (let c = 0; c < cols; c++) {
      const srcTime = trimIn + ((c + 0.5) / cols) * duration;
      const idx = Math.max(0, Math.min(meta.count - 1, Math.round(srcTime / meta.interval)));
      out.push(`/api/timeline-thumbs?key=${meta.key}&i=${idx}`);
    }
    return out;
  }, [meta, cols, trimIn, duration]);

  // Hover-scrub: while the pointer is over the clip, overlay the exact frame at
  // the cursor position (nearest cached frame) plus a cursor line + timecode,
  // an industry-standard live media preview, without a per-move server call.
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);
  const hover = useMemo(() => {
    if (!meta || hoverFrac == null) return null;
    const srcTime = trimIn + hoverFrac * duration;
    const idx = Math.max(0, Math.min(meta.count - 1, Math.round(srcTime / meta.interval)));
    return { src: `/api/timeline-thumbs?key=${meta.key}&i=${idx}`, clipTime: hoverFrac * duration };
  }, [meta, hoverFrac, trimIn, duration]);

  return (
    <div
      ref={boxRef}
      className="absolute inset-0 flex opacity-90"
      onMouseMove={(e) => {
        const r = boxRef.current?.getBoundingClientRect();
        if (!r || r.width <= 0) return;
        setHoverFrac(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      onMouseLeave={() => setHoverFrac(null)}
    >
      {frames.map((src, i) => (
        <div key={i} className="h-full bg-center bg-cover pointer-events-none" style={{ flex: "1 1 0", backgroundImage: `url(${src})` }} />
      ))}
      {hover && (
        <>
          <div className="absolute inset-0 bg-center bg-cover pointer-events-none" style={{ backgroundImage: `url(${hover.src})` }} />
          <div className="absolute top-0 bottom-0 w-px bg-white/80 pointer-events-none" style={{ left: `${hoverFrac! * 100}%` }} />
          <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 px-1 rounded bg-black/70 text-[8px] text-white/90 tabular-nums pointer-events-none">
            {formatTime(hover.clipTime)}
          </span>
        </>
      )}
    </div>
  );
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

const TRACK_LABEL_W = 96; // px reserved for the left-hand track labels

// ── Editor layout persistence (panel sizes, snapping, media-pool view/sort) ──
// Stored in localStorage under a neutral key so both product trees share it and
// the user's timeline layout survives between sessions. "Reset to Default View"
// (Project Settings) restores DEFAULT_LAYOUT.
type MediaView = "xlarge" | "large" | "medium" | "small" | "list" | "details" | "tiles";
type MediaSortBy = "name" | "type" | "duration";
interface TimelineLayout {
  previewHeight: number;
  laneHeight: number;
  mediaPoolHeight: number;
  keyframeHeight: number;
  snapEnabled: boolean;
  /** Magnetic ripple mode: deleting a clip closes the gap on its track. */
  rippleEnabled: boolean;
  mediaView: MediaView;
  mediaSort: { by: MediaSortBy; dir: "asc" | "desc" };
}
const DEFAULT_LAYOUT: TimelineLayout = {
  previewHeight: 176,
  laneHeight: 56,
  mediaPoolHeight: 176,
  keyframeHeight: 176,
  snapEnabled: true,
  rippleEnabled: false,
  mediaView: "tiles",
  mediaSort: { by: "name", dir: "asc" },
};
const LAYOUT_KEY = "timeline:layout:v1";
function readTimelineLayout(): TimelineLayout {
  if (typeof window === "undefined") return { ...DEFAULT_LAYOUT };
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<TimelineLayout>) };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}
function writeTimelineLayout(l: TimelineLayout): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch { /* quota / private mode */ }
}

// One Media Pool entry, rendered per the current View mode (Windows-Explorer
// style: icon grids of varying size, List, Details, or Tiles). Always shows the
// FULL file name (wrapped, never truncated).
function MediaPoolItem({ asset, view, highlight, selected, onSelect, onRemove, onDragStartAsset, onDragEndAsset }: {
  asset: TimelineAsset;
  view: MediaView;
  highlight?: boolean;
  selected?: boolean;
  onSelect?: (e: React.MouseEvent) => void;
  onRemove?: () => void;
  onDragStartAsset: (e: React.DragEvent, a: TimelineAsset) => void;
  onDragEndAsset: () => void;
}) {
  const ICONS: Record<string, typeof Film> = { video: Film, audio: Music, image: ImageIcon, combined: Layers };
  const Icon = ICONS[asset.kind] ?? Film;
  const hl = highlight
    ? " ring-2 ring-amber-400 ring-offset-1 ring-offset-background"
    : selected ? " ring-2 ring-sky-400/80 bg-sky-500/10" : "";

  // Inline rename: right-click → Rename, or a slow second click on the name (the
  // OS file-explorer gesture: distinct from a fast double-click). The new name
  // is stored on the asset (persisted in the project file, never on disk).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(asset.name);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const lastClickRef = useRef(0);
  // Bin poster: prefer a supplied thumb; otherwise derive a REAL frame from the
  // shared filmstrip cache, sampled ~12% in so a black fade-in lead never becomes
  // the poster ("smart first bright frame"). Falls back to the kind icon.
  const [poster, setPoster] = useState<string | null>(asset.thumb ?? null);
  const [refreshTick, setRefreshTick] = useState(0);
  const posterForceRef = useRef(false);
  useEffect(() => {
    if (asset.thumb) { setPoster(asset.thumb); return; }
    if (asset.kind !== "video" || !asset.filePath) { setPoster(null); return; }
    let cancelled = false;
    const force = posterForceRef.current; posterForceRef.current = false;
    fetchStripMeta(asset.filePath, asset.duration, force).then((m) => {
      if (cancelled || !m) return;
      const idx = Math.max(0, Math.min(m.count - 1, Math.round((0.12 * asset.duration) / m.interval)));
      setPoster(`/api/timeline-thumbs?key=${m.key}&i=${idx}`);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [asset.thumb, asset.kind, asset.filePath, asset.duration, refreshTick]);

  // Refresh Previews: re-derive the bin poster (forced) on demand.
  useEffect(() => subscribeThumbRefresh(() => { posterForceRef.current = true; setRefreshTick((t) => t + 1); }), []);
  const beginEdit = () => { setDraft(asset.name); setEditing(true); setMenu(null); };
  const commit = () => {
    const n = draft.trim();
    if (n && n !== asset.name) timelineStore.renameAsset(asset.id, n);
    setEditing(false);
  };
  const onNameClick = () => {
    const now = Date.now();
    const dt = now - lastClickRef.current;
    lastClickRef.current = now;
    if (dt > 280 && dt < 1100) beginEdit(); // slow second click → rename
  };

  const dragProps = {
    draggable: !editing,
    "data-asset-id": asset.id,
    onClick: (e: React.MouseEvent) => onSelect?.(e),
    onDragStart: (e: React.DragEvent) => onDragStartAsset(e, asset),
    onDragEnd: onDragEndAsset,
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onSelect?.(e); setMenu({ x: e.clientX, y: e.clientY }); },
    title: `${asset.name} · ${asset.duration.toFixed(1)}s. Drag to a track or a group. Right-click or slow-double-click to rename.`,
  };

  // Editable name field (shared across views). Enter commits, Esc cancels.
  const nameInput = (className: string) => (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
        e.stopPropagation();
      }}
      onClick={(e) => e.stopPropagation()}
      draggable={false}
      className={`min-w-0 bg-background border border-sky-400/60 rounded px-1 py-0 outline-none ${className}`}
    />
  );

  const menuNode = menu && (
    <ContextMenu x={menu.x} y={menu.y} className="fixed z-[100] min-w-[160px] rounded-md border border-border/70 bg-popover py-1 text-[11px] shadow-xl">
      <button className={MENU_ITEM} onClick={() => beginEdit()}>Rename…</button>
      {onRemove && <button className={`${MENU_ITEM} text-rose-300`} onClick={() => { onRemove(); setMenu(null); }}>Remove from project</button>}
    </ContextMenu>
  );
  const closeMenu = menu ? <div className="fixed inset-0 z-[99]" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} /> : null;

  if (view === "list" || view === "details") {
    return (
      <>
        <div {...dragProps} className={`flex items-center gap-2 px-2 py-1 rounded border border-transparent hover:border-border/60 hover:bg-foreground/5 cursor-grab active:cursor-grabbing text-[11px]${hl}`}>
          <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />
          {editing ? nameInput("flex-1 text-[11px]") : <span className="flex-1 min-w-0 break-all" onClick={onNameClick}>{asset.name}</span>}
          {view === "details" && <span className="shrink-0 w-16 text-muted-foreground/70 capitalize">{asset.kind}</span>}
          <span className="shrink-0 w-12 text-right text-muted-foreground/60 tabular-nums">{asset.duration.toFixed(1)}s</span>
        </div>
        {closeMenu}{menuNode}
      </>
    );
  }
  if (view === "tiles") {
    return (
      <>
        <div {...dragProps} className={`inline-flex items-start gap-1.5 px-2 py-1 rounded-md border border-border/60 bg-card/60 cursor-grab active:cursor-grabbing text-[10px] w-[184px] h-fit${hl}`}>
          <Icon className="w-4 h-4 shrink-0 mt-0.5 text-muted-foreground" />
          {editing ? nameInput("flex-1 text-[10px]") : <span className="flex-1 min-w-0 break-words leading-snug" onClick={onNameClick}>{asset.name}</span>}
          <span className="shrink-0 text-muted-foreground/60 tabular-nums">{asset.duration.toFixed(1)}s</span>
        </div>
        {closeMenu}{menuNode}
      </>
    );
  }
  const size = view === "xlarge" ? 160 : view === "large" ? 128 : view === "medium" ? 96 : 64;
  return (
    <>
      <div {...dragProps} style={{ width: size }} className={`flex flex-col gap-1 p-1 rounded-md border border-border/60 bg-card/60 cursor-grab active:cursor-grabbing${hl}`}>
        <div className="relative w-full rounded bg-black/40 overflow-hidden flex items-center justify-center" style={{ height: Math.round(size * 0.6) }}>
          {poster ? (
            // eslint-disable-next-line @next/next/no-img-element
            // draggable=false: the CARD owns the drag (it sets our asset id). Without
            // this the browser drags the <img> itself and synthesizes a phantom image
            // file on drop, which got re-imported as a bogus 5s still.
            <img src={poster} alt={asset.name} draggable={false} className="w-full h-full object-cover" />
          ) : (
            <Icon className="w-6 h-6 text-muted-foreground/70" />
          )}
          <span className="absolute bottom-0.5 right-0.5 px-1 rounded bg-black/60 text-[8px] text-white/90 tabular-nums">{asset.duration.toFixed(1)}s</span>
        </div>
        {editing ? nameInput("text-[9px]") : <span className="text-[9px] leading-tight break-words" onClick={onNameClick}>{asset.name}</span>}
      </div>
      {closeMenu}{menuNode}
    </>
  );
}

// Right-click / context menu shell. Anchored at the cursor (x, y) but, like
// professional editors, NEVER clipped by the viewport: after measuring its real size
// it flips UP when it would overrun the bottom edge and shifts LEFT off the
// right edge, so long option lists stay fully visible. Stops click-through.
function ContextMenu({ x, y, className, children }: {
  x: number;
  y: number;
  className: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Flip up if the menu would overflow the bottom; otherwise keep at cursor.
    let top = y;
    if (y + r.height + pad > vh) top = Math.max(pad, y - r.height);
    // Shift left off the right edge; clamp to the viewport.
    let left = x;
    if (x + r.width + pad > vw) left = Math.max(pad, vw - r.width - pad);
    setPos({ left, top });
  }, [x, y]);
  return (
    <div ref={ref} className={className} style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

/**
 * Map a video track to its mirrored audio track (and vice-versa) for keeping
 * linked A/V clips in sync when one is dragged to a different lane. Pairing is
 * by DISTANCE FROM THE V/A BOUNDARY (the standard NLE convention): the bottom
 * video track (V1) mirrors the top audio track (A1), the next-up video (V2)
 * mirrors the next-down audio (A2), etc. Returns null if no counterpart exists.
 */
function mirrorTrackId(tracks: TimelineTrack[], fromTrackId: string): string | null {
  const from = tracks.find((t) => t.id === fromTrackId);
  if (!from) return null;
  const videoAsc = tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index);
  const audioDesc = tracks.filter((t) => t.kind === "audio").sort((a, b) => b.index - a.index);
  if (from.kind === "video") {
    const i = videoAsc.findIndex((t) => t.id === fromTrackId);
    return i >= 0 ? audioDesc[i]?.id ?? null : null;
  }
  if (from.kind === "audio") {
    const i = audioDesc.findIndex((t) => t.id === fromTrackId);
    return i >= 0 ? videoAsc[i]?.id ?? null : null;
  }
  return null;
}

/**
 * Rebuild playable `src` for a loaded project's assets. Saved projects drop
 * ephemeral blob:/data: URLs (they die on reload) but keep the absolute
 * `filePath`; here we point `src` at the range-capable /api/timeline-media
 * server so preview/scrub work again. Recurses into nested (combined) clips.
 */
function restoreTimelineMediaSrc(project: TimelineProject): TimelineProject {
  const fix = (assets: TimelineAsset[]): TimelineAsset[] =>
    assets.map((a) => {
      let out = a;
      const dead = !a.src || a.src.startsWith("blob:") || a.src.startsWith("data:");
      if (dead && a.filePath) {
        out = { ...a, src: `/api/timeline-media?path=${encodeURIComponent(a.filePath)}` };
      }
      if (out.nested?.assets) {
        out = { ...out, nested: { ...out.nested, assets: fix(out.nested.assets) } };
      }
      return out;
    });
  return { ...project, assets: fix(project.assets ?? []) };
}

/**
 * Editable + drag-scrubbable numeric readout (industry-standard style). Click-drag
 * left/right on the value to scrub (Shift = fine); click without moving to type
 * an exact value. Values clamp to [min,max] (position ranges are intentionally
 * wide, so titles/clips can be pushed out of frame).
 */
function NumberField({ value, min, max, step = 1, decimals = 0, suffix = "", onChange }: {
  value: number; min: number; max: number; step?: number; suffix?: string; decimals?: number;
  onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const dragRef = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
    setEditing(false);
  };
  const onDown = (e: React.PointerEvent) => {
    if (editing) return;
    e.preventDefault();
    dragRef.current = { x: e.clientX, v: value, moved: false };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.x;
      if (!d.moved && Math.abs(dx) > 2) { d.moved = true; timelineStore.beginInteraction(); }
      if (!d.moved) return;
      const perPx = (ev.shiftKey ? (max - min) / 2000 : (max - min) / 200) || step;
      const nv = Math.max(min, Math.min(max, d.v + dx * perPx));
      onChange(Number(nv.toFixed(decimals)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const d = dragRef.current;
      dragRef.current = null;
      if (d && !d.moved) { setDraft(value.toFixed(decimals)); setEditing(true); }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") commit((e.target as HTMLInputElement).value); if (e.key === "Escape") setEditing(false); }}
        className="w-14 shrink-0 bg-card border border-violet-400/60 rounded px-1 text-[10px] tabular-nums text-foreground text-right"
      />
    );
  }
  return (
    <span
      onPointerDown={onDown}
      title="Drag to scrub, click to type, or hold Shift for fine control."
      className="w-14 shrink-0 text-[10px] tabular-nums text-foreground/80 text-right cursor-ew-resize select-none hover:text-violet-300"
    >
      {value.toFixed(decimals)}{suffix}
    </span>
  );
}

function SliderRow({ label, value, min, max, step = 1, suffix = "", decimals = 0, onChange, onKeyframe, hasKeyframes }: {
  label: string; value: number; min: number; max: number; step?: number; suffix?: string; decimals?: number;
  onChange: (v: number) => void; onKeyframe?: () => void; hasKeyframes?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 py-1">
      {onKeyframe && (
        <button type="button" onClick={onKeyframe} title="Add a keyframe at the playhead."
          className={hasKeyframes ? "text-amber-400" : "text-muted-foreground hover:text-foreground"}>
          <Diamond className="w-3 h-3" fill={hasKeyframes ? "currentColor" : "none"} />
        </button>
      )}
      <span className="w-12 shrink-0 text-[10px] text-muted-foreground text-right">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Math.max(min, Math.min(max, value))}
        onPointerDown={() => timelineStore.beginInteraction()}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 min-w-0 accent-violet-400"
      />
      <NumberField value={value} min={min} max={max} step={step} decimals={decimals} suffix={suffix} onChange={onChange} />
    </div>
  );
}

function EffectsPanel({ clip }: { clip: TimelineClip }) {
  const [adding, setAdding] = useState(false);
  const effects = clip.effects ?? [];
  return (
    <div className="pt-2 mt-2 border-t border-border/60">
      <div className="flex items-center justify-between px-1 mb-1">
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Sparkles className="w-3 h-3" /> Effects
        </span>
        <div className="relative">
          <button type="button" onClick={() => setAdding((s) => !s)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-border/60 bg-card/60 text-foreground/80 hover:bg-foreground/10">
            + Add
          </button>
          {adding && (
            <div className="absolute right-0 top-full mt-1 z-30 min-w-[150px] rounded-md border border-border/60 bg-card shadow-xl py-1">
              {EFFECT_ORDER.map((t) => (
                <button key={t} type="button"
                  onClick={() => { timelineStore.addEffect(clip.id, t); setAdding(false); }}
                  className="w-full text-left px-2.5 py-1 text-[11px] hover:bg-foreground/10">
                  {EFFECTS[t].label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {effects.length === 0 && (
        <p className="px-1 text-[9px] text-muted-foreground/70">No effects yet. Add a glitch, blur, B&amp;W…</p>
      )}
      {effects.map((e) => {
        const def = EFFECTS[e.type];
        return (
          <div key={e.id} className="mb-1.5 rounded border border-border/60 bg-card/50">
            <div className="flex items-center gap-1.5 px-1.5 py-1">
              <button type="button" onClick={() => timelineStore.toggleEffect(clip.id, e.id)}
                title="Enable or disable this effect." className={e.enabled ? "text-emerald-400" : "text-muted-foreground"}>
                {e.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              </button>
              <span className="flex-1 text-[11px] font-medium text-foreground/90">{def.label}</span>
              <button type="button" onClick={() => timelineStore.removeEffect(clip.id, e.id)}
                className="text-muted-foreground hover:text-rose-300"><Trash2 className="w-3 h-3" /></button>
            </div>
            {e.enabled && (
              <div className="px-1.5 pb-1.5">
                {def.params.map((pd) => (
                  <SliderRow key={pd.key} label={pd.label} value={e.params[pd.key] ?? pd.default}
                    min={pd.min} max={pd.max} step={pd.step} suffix={pd.unit ? ` ${pd.unit}` : ""}
                    onChange={(v) => timelineStore.setEffectParam(clip.id, e.id, pd.key, v)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      <p className="px-1 pt-1 text-[9px] text-muted-foreground/70">Preview is approximate; effects are burned into the export.</p>
    </div>
  );
}

/**
 * Component Control for a placeholder AUDIO-generation clip (DramaBox). Instead of
 * volume/pan/pitch it exposes a script editor + an optional saved configuration and
 * an optional fixed duration. "Add to AI Queue" enqueues the job; the queue runner
 * later fills this clip (or parks the result in the Media Pool if it would overlap).
 */
function PendingAudioGenPanel({ clip }: { clip: TimelineClip }) {
  const gen = clip.pendingAudioGen!;
  const [configs, setConfigs] = useState<{ name: string }[]>([]);
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/workflow-config?workflow=dramabox")
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d.ok) setConfigs(d.configs ?? []); })
      .catch(() => { /* offline / route missing */ });
    return () => { cancelled = true; };
  }, []);

  const upd = (patch: Partial<NonNullable<TimelineClip["pendingAudioGen"]>>) => {
    timelineStore.updatePendingAudioGen(clip.id, patch);
    setQueued(false);
  };
  const hasFixedDuration = gen.targetDuration != null;
  const canQueue = gen.script.trim().length > 0 && (!gen.useSavedConfig || !!gen.configName);

  const enqueue = () => {
    if (!canQueue) return;
    aiQueueStore.add({
      workflow: "dramabox",
      workflowLabel: "DramaBox",
      configName: gen.useSavedConfig ? (gen.configName ?? "") : "",
      clipId: clip.id,
      assetId: "",
      sourcePath: "",
      sourceSrc: "",
      sourceName: gen.script.trim().slice(0, 40) || "Audio Generation",
      kind: "audio",
      audioGen: { script: gen.script.trim(), targetDuration: gen.targetDuration },
    });
    setQueued(true);
  };

  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5">
      <div className="px-3 py-2 border-b border-rose-500/20 text-[10px] font-semibold uppercase tracking-wide text-rose-300 flex items-center gap-1.5">
        <Mic className="w-3 h-3" /> Component Control <span className="text-rose-300/80">• Audio Generation</span>
        <Sparkles className="w-3 h-3 ml-auto text-fuchsia-300" />
      </div>
      <div className="px-2.5 py-2 space-y-2">
        <div>
          <label className="block text-[10px] text-muted-foreground mb-1">DramaBox script</label>
          <textarea
            value={gen.script}
            onFocus={() => timelineStore.beginInteraction()}
            onChange={(e) => upd({ script: e.target.value })}
            rows={3}
            placeholder={'A woman speaks warmly, "Hello, how are you today?" She laughs, "Hahaha!"'}
            className="w-full bg-card/60 border border-border/60 rounded px-2 py-1 text-[11px] text-foreground resize-y"
          />
          <p className="pt-0.5 text-[9px] text-muted-foreground/70">Inside &quot;quotes&quot; = spoken; outside = stage directions (emotion, action).</p>
        </div>

        <label className="flex items-center gap-1.5 text-[10px] text-foreground/80 cursor-pointer">
          <input type="checkbox" checked={gen.useSavedConfig}
            onChange={(e) => upd({ useSavedConfig: e.target.checked })}
            className="accent-rose-500 w-3.5 h-3.5" />
          Use a saved DramaBox configuration (voice, LoRAs, settings)
        </label>
        {gen.useSavedConfig && (
          configs.length > 0 ? (
            <select value={gen.configName ?? ""} onChange={(e) => upd({ configName: e.target.value })}
              className="w-full bg-card/60 border border-border/60 rounded px-2 py-1 text-[11px] text-foreground">
              <option value="">Select a configuration…</option>
              {configs.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          ) : (
            <p className="text-[9px] text-muted-foreground/70 px-1">No saved DramaBox configurations yet. Create one in the DramaBox studio (Timeline Integration → Save Configuration).</p>
          )
        )}

        <label className="flex items-center gap-1.5 text-[10px] text-foreground/80 cursor-pointer">
          <input type="checkbox" checked={hasFixedDuration}
            onChange={(e) => upd({ targetDuration: e.target.checked ? Math.max(0.5, clip.duration) : undefined })}
            className="accent-rose-500 w-3.5 h-3.5" />
          Request a fixed duration
        </label>
        {hasFixedDuration && (
          <div className="flex items-center gap-1.5 pl-5">
            <input type="number" min={0.5} max={120} step={0.5}
              value={gen.targetDuration ?? 0}
              onChange={(e) => upd({ targetDuration: Math.max(0.5, parseFloat(e.target.value) || 0.5) })}
              className="w-20 bg-card/60 border border-border/60 rounded px-2 py-1 text-[11px] text-foreground" />
            <span className="text-[10px] text-muted-foreground">seconds</span>
          </div>
        )}

        <div className={`text-[9px] rounded px-2 py-1 ${hasFixedDuration ? "text-emerald-300/90 bg-emerald-500/10 border border-emerald-500/20" : "text-amber-300/90 bg-amber-500/10 border border-amber-500/20"}`}>
          {hasFixedDuration
            ? "The output will match your fixed duration and fill this placeholder in place."
            : "Speech length is unknown until it finishes. If it would overlap existing audio, the result is sent to the Media Pool instead of overwriting the timeline. Drag it in where you like."}
        </div>

        <button type="button" onClick={enqueue} disabled={!canQueue}
          className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium border border-rose-500/50 bg-rose-500/20 text-rose-100 hover:bg-rose-500/30 disabled:opacity-50">
          <Sparkles className="w-3.5 h-3.5" /> Add to AI Queue
        </button>
        {queued && <p className="text-[10px] text-emerald-300 text-center">Queued. Start it from the AI Processing Queue.</p>}
      </div>
    </div>
  );
}

// ── Audio loudness (Normalize / Gain-match) ──
// EBU R128 targets: broadcast/streaming standard integrated loudness with a
// true-peak ceiling so a boost never clips.
const LOUDNESS_TARGET_LUFS = -14;
const TRUE_PEAK_CEIL_DB = -1;

interface LoudnessMeasure { integratedLufs: number; truePeakDb: number | null }

/** Measure a clip's trimmed source region via the ebur128 analysis route. */
async function analyzeClipLoudness(clip: TimelineClip, asset: TimelineAsset | undefined): Promise<LoudnessMeasure | null> {
  if (!asset?.filePath) return null;
  try {
    const res = await fetch("/api/timeline-audio-analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: asset.filePath, trimIn: clip.trimIn, duration: clip.duration, speed: clipSpeed(clip) }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (typeof j.integratedLufs !== "number") return null;
    return { integratedLufs: j.integratedLufs, truePeakDb: typeof j.truePeakDb === "number" ? j.truePeakDb : null };
  } catch { return null; }
}

/** Linear gain that brings `meas` to `targetLufs`, clamped by the true-peak ceiling. */
function gainForLoudness(meas: LoudnessMeasure, targetLufs: number): number {
  let db = targetLufs - meas.integratedLufs;
  if (meas.truePeakDb != null) db = Math.min(db, TRUE_PEAK_CEIL_DB - meas.truePeakDb);
  return dbToGain(db);
}

/** Live master-output stereo peak meter, driven by the audio engine's analysers. */
function AudioMeter({ engineRef, playing }: { engineRef: React.MutableRefObject<TimelineAudioEngine | null>; playing: boolean }) {
  const [levels, setLevels] = useState({ l: 0, r: 0 });
  useEffect(() => {
    if (!playing) { setLevels({ l: 0, r: 0 }); return; }
    let raf = 0;
    let pl = 0, pr = 0;
    const tick = () => {
      const m = engineRef.current?.meterLevels();
      if (m) {
        // Fast attack, slow release for a readable meter.
        pl = m.l > pl ? m.l : pl * 0.85 + m.l * 0.15;
        pr = m.r > pr ? m.r : pr * 0.85 + m.r * 0.15;
        setLevels({ l: pl, r: pr });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, engineRef]);
  const bar = (v: number) => {
    const db = v > 0 ? 20 * Math.log10(v) : -60;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100)); // −60..0 dB → 0..100%
    const color = db > -3 ? "bg-rose-500" : db > -12 ? "bg-amber-400" : "bg-emerald-500";
    return (
      <div className="relative h-1.5 w-16 rounded-sm bg-foreground/10 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${color} transition-[width] duration-75`} style={{ width: `${pct}%` }} />
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-0.5" title="Master output level (L / R)">
      {bar(levels.l)}
      {bar(levels.r)}
    </div>
  );
}

/**
 * Timeline overview / minimap: a compact strip showing the whole project with a
 * block per clip, the playhead, and a draggable viewport rectangle that scrolls
 * the main lane area. Click or drag anywhere to jump the view there.
 */
function TimelineMinimap({ project, pxPerSecond, playhead, laneAreaRef }: {
  project: TimelineProject;
  pxPerSecond: number;
  playhead: number;
  laneAreaRef: React.RefObject<HTMLDivElement | null>;
}) {
  const total = Math.max(0.1, projectDuration(project));
  const stripRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [view, setView] = useState({ start: 0, width: 1 });

  // Mirror the lane scroller's visible time window into 0..1 fractions.
  useEffect(() => {
    const el = laneAreaRef.current;
    if (!el) return;
    const update = () => {
      const startSec = el.scrollLeft / pxPerSecond;
      const widthSec = Math.max(0, el.clientWidth - TRACK_LABEL_W) / pxPerSecond;
      setView({ start: Math.max(0, Math.min(1, startSec / total)), width: Math.min(1, widthSec / total) });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, [laneAreaRef, total, pxPerSecond, project.clips]);

  const scrollToClientX = (clientX: number) => {
    const strip = stripRef.current;
    const el = laneAreaRef.current;
    if (!strip || !el) return;
    const rect = strip.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const centerSec = frac * total;
    const visPx = Math.max(0, el.clientWidth - TRACK_LABEL_W);
    el.scrollLeft = Math.max(0, centerSec * pxPerSecond - visPx / 2);
  };

  const rows = [...project.tracks].sort((a, b) => b.index - a.index); // top→bottom, matching the lanes
  return (
    <div className="shrink-0 border-b border-border/60 bg-card/40 px-2 py-1 flex items-stretch gap-2">
      <div className="shrink-0 w-[80px] flex items-center text-[9px] uppercase tracking-widest text-muted-foreground/60">Overview</div>
      <div
        ref={stripRef}
        className="relative flex-1 h-10 rounded bg-foreground/5 overflow-hidden cursor-pointer select-none"
        onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); scrollToClientX(e.clientX); }}
        onPointerMove={(e) => { if (dragging.current) scrollToClientX(e.clientX); }}
        onPointerUp={(e) => { dragging.current = false; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }}
        title="Timeline overview: click or drag to scroll the view"
      >
        <div className="absolute inset-0 flex flex-col">
          {rows.map((tr) => (
            <div key={tr.id} className="relative flex-1 border-b border-border/10 last:border-b-0">
              {project.clips.filter((c) => c.trackId === tr.id).map((c) => (
                <div
                  key={c.id}
                  className="absolute top-0.5 bottom-0.5 rounded-[1px]"
                  style={{
                    left: `${(c.start / total) * 100}%`,
                    width: `${Math.max(0.3, (c.duration / total) * 100)}%`,
                    backgroundColor: tr.color ?? (tr.kind === "audio" ? "#10b981" : "#8b5cf6"),
                    opacity: 0.75,
                  }}
                />
              ))}
            </div>
          ))}
        </div>
        {/* Playhead */}
        <div className="absolute top-0 bottom-0 w-px bg-white/80 pointer-events-none" style={{ left: `${(Math.min(total, playhead) / total) * 100}%` }} />
        {/* Viewport rectangle */}
        <div
          className="absolute top-0 bottom-0 border border-violet-400/80 bg-violet-400/10 rounded-sm pointer-events-none"
          style={{ left: `${view.start * 100}%`, width: `${Math.max(1.5, view.width * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** Component Control for an ADJUSTMENT LAYER: just the effect stack, plus a note
 *  explaining that its effects apply to the tracks below it. */
function AdjustmentPanel({ clip }: { clip: TimelineClip }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40">
      <div className="px-3 py-2 border-b border-border/60 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Sparkles className="w-3 h-3 text-rose-300" />
        Component Control <span className="text-rose-300">• ADJUSTMENT</span>
      </div>
      <div className="px-2 py-1">
        <p className="px-1 py-1 text-[9px] text-muted-foreground/70">Effects here apply to everything on the tracks <strong>below</strong> this layer, for its span on the timeline. Park it over a cut to glitch the transition. Preview is approximate; effects are burned into the export.</p>
        <EffectsPanel clip={clip} />
      </div>
    </div>
  );
}

function ClipInspector({ clip, kind, playhead, assets }: { clip: TimelineClip; kind: "video" | "audio" | "text"; playhead: number; assets: TimelineAsset[] }) {
  const [loudBusy, setLoudBusy] = useState<false | "one" | "match">(false);
  const [loudMsg, setLoudMsg] = useState("");
  if (isPendingAudioGenClip(clip)) return <PendingAudioGenPanel clip={clip} />;
  if (isAdjustmentClip(clip)) return <AdjustmentPanel clip={clip} />;
  const local = Math.max(0, Math.min(clip.duration, playhead - clip.start));
  const has = (p: KeyframeProp) => (clip.keyframes?.[p]?.length ?? 0) > 0;
  const change = (prop: KeyframeProp, staticPatch: (v: number) => Partial<TimelineClip>) => (v: number) => {
    if (has(prop)) timelineStore.upsertKeyframeNoHistory(clip.id, prop, local, v);
    else timelineStore.setClip(clip.id, staticPatch(v));
  };
  const kf = (prop: KeyframeProp) => () => timelineStore.addKeyframe(clip.id, prop, local, evalClipProp(clip, prop, local));
  const row = (prop: KeyframeProp, staticPatch: (v: number) => Partial<TimelineClip>) => {
    const m = KF_PROPS[prop];
    return (
      <SliderRow key={prop} label={m.label} value={evalClipProp(clip, prop, local)}
        min={m.min} max={m.max} step={m.decimals ? 0.1 : 1} decimals={m.decimals}
        suffix={m.unit ? ` ${m.unit}` : ""}
        onChange={change(prop, staticPatch)} onKeyframe={kf(prop)} hasKeyframes={has(prop)} />
    );
  };
  const audioAsset = assets.find((a) => a.id === clip.assetId);
  const canLoud = kind === "audio" && !!audioAsset?.filePath;
  // Normalize THIS clip to the loudness target (true-peak safe).
  const doNormalize = async () => {
    setLoudBusy("one"); setLoudMsg("Analyzing…");
    const meas = await analyzeClipLoudness(clip, audioAsset);
    if (!meas) { setLoudBusy(false); setLoudMsg("Analysis failed"); return; }
    timelineStore.beginInteraction();
    timelineStore.setClip(clip.id, { gain: gainForLoudness(meas, LOUDNESS_TARGET_LUFS) });
    setLoudBusy(false); setLoudMsg(`${meas.integratedLufs.toFixed(1)} → ${LOUDNESS_TARGET_LUFS} LUFS`);
  };
  // Match every SELECTED audio clip to their shared average loudness.
  const doMatch = async () => {
    const snap = timelineStore.getSnapshot();
    const ids = new Set(snap.transport.selectedClipIds?.length ? snap.transport.selectedClipIds : [clip.id]);
    const audioTrackIds = new Set(snap.project.tracks.filter((t) => t.kind === "audio").map((t) => t.id));
    const targets = snap.project.clips.filter((c) => ids.has(c.id) && audioTrackIds.has(c.trackId));
    if (targets.length === 0) { setLoudMsg("Select audio clips"); return; }
    setLoudBusy("match"); setLoudMsg(`Analyzing ${targets.length}…`);
    const measured: { id: string; meas: LoudnessMeasure }[] = [];
    for (const c of targets) {
      const meas = await analyzeClipLoudness(c, snap.project.assets.find((a) => a.id === c.assetId));
      if (meas) measured.push({ id: c.id, meas });
    }
    if (measured.length === 0) { setLoudBusy(false); setLoudMsg("Analysis failed"); return; }
    const avg = measured.reduce((s, m) => s + m.meas.integratedLufs, 0) / measured.length;
    timelineStore.beginInteraction();
    for (const m of measured) timelineStore.setClip(m.id, { gain: gainForLoudness(m.meas, avg) });
    setLoudBusy(false); setLoudMsg(`Matched ${measured.length} to ${avg.toFixed(1)} LUFS`);
  };
  const kindLabel = kind === "text" ? "TITLE" : kind.toUpperCase();
  return (
    <div className="rounded-lg border border-border/60 bg-card/40">
      <div className="px-3 py-2 border-b border-border/60 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <SlidersHorizontal className="w-3 h-3 text-violet-300" />
        Component Control <span className="text-violet-300">• {kindLabel}</span>
      </div>
      <div className="px-2 py-1">
        {kind !== "text" && (
          <SliderRow label="Speed" value={clipSpeed(clip)} min={SPEED_MIN} max={SPEED_MAX} step={0.05} decimals={2} suffix="x"
            onChange={(v) => timelineStore.setClipSpeed(clip.id, v)} />
        )}
        {kind === "video" && (
          <>
            {row("opacity", (v) => ({ opacity: v }))}
            {row("scale", (v) => ({ scale: v }))}
            {row("posX", (v) => ({ posX: v }))}
            {row("posY", (v) => ({ posY: v }))}
            {row("rotation", (v) => ({ rotation: v }))}
            <EffectsPanel clip={clip} />
          </>
        )}
        {kind === "audio" && (
          <>
            {row("volume", (v) => ({ gain: dbToGain(v) }))}
            {row("pan", (v) => ({ pan: v }))}
            <SliderRow label="Pitch" value={clip.pitchSemitones ?? 0} min={-12} max={12} suffix=" st"
              onChange={(v) => timelineStore.setClip(clip.id, { pitchSemitones: v })} />
            {/* Loudness: normalize this clip to the target, or match every selected clip. */}
            <div className="flex items-center gap-1.5 px-1 pt-2">
              <button type="button" onClick={doNormalize} disabled={!canLoud || loudBusy !== false}
                className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border border-border/60 text-foreground/80 hover:bg-foreground/10 disabled:opacity-40"
                title={canLoud ? `Normalize to ${LOUDNESS_TARGET_LUFS} LUFS (true-peak safe)` : "Analysis needs an uploaded source file"}>
                <Activity className="w-3 h-3" /> {loudBusy === "one" ? "Analyzing…" : "Normalize"}
              </button>
              <button type="button" onClick={doMatch} disabled={!canLoud || loudBusy !== false}
                className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium border border-border/60 text-foreground/80 hover:bg-foreground/10 disabled:opacity-40"
                title="Match the loudness of all selected audio clips to their average">
                <SlidersHorizontal className="w-3 h-3" /> {loudBusy === "match" ? "Matching…" : "Match selected"}
              </button>
            </div>
            {loudMsg && <p className="px-1 pt-1 text-[9px] text-emerald-300/90 tabular-nums">{loudMsg}</p>}
            <p className="px-1 pt-2 text-[9px] text-muted-foreground/70">Volume boosts up to +30 dB (live). Pitch applies on export. Normalize targets {LOUDNESS_TARGET_LUFS} LUFS.</p>
          </>
        )}
        {kind === "text" && (() => {
          const preset = clip.titlePreset ?? "none";
          const presetDef = TITLE_PRESET_MAP[preset];
          return (
            <div className="py-1">
              <label className="block text-[10px] text-muted-foreground mb-1">Title text</label>
              <textarea
                value={clip.text ?? ""}
                onFocus={() => timelineStore.beginInteraction()}
                onChange={(e) => timelineStore.setClip(clip.id, { text: e.target.value })}
                rows={2}
                placeholder="Enter title…"
                className="w-full bg-card/60 border border-border/60 rounded px-2 py-1 text-[11px] text-foreground resize-none"
              />
              <label className="block text-[10px] text-muted-foreground mb-1 mt-2">Animation</label>
              <select
                value={preset}
                onChange={(e) => { timelineStore.beginInteraction(); timelineStore.setClip(clip.id, { titlePreset: e.target.value as typeof preset }); }}
                className="w-full bg-card/60 border border-border/60 rounded px-2 py-1 text-[11px] text-foreground"
              >
                {TITLE_PRESETS.map((p) => (
                  <option key={p.type} value={p.type}>{p.label}</option>
                ))}
              </select>
              {presetDef?.twoLines && (
                <>
                  <label className="block text-[10px] text-muted-foreground mb-1 mt-2">Second line</label>
                  <textarea
                    value={clip.text2 ?? ""}
                    onFocus={() => timelineStore.beginInteraction()}
                    onChange={(e) => timelineStore.setClip(clip.id, { text2: e.target.value })}
                    rows={1}
                    placeholder="Second line…"
                    className="w-full bg-card/60 border border-border/60 rounded px-2 py-1 text-[11px] text-foreground resize-none"
                  />
                </>
              )}
              <div className="mt-2 pt-2 border-t border-border/60">
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Position &amp; Layout</span>
                {row("posX", (v) => ({ posX: v }))}
                {row("posY", (v) => ({ posY: v }))}
                {row("scale", (v) => ({ scale: v }))}
                {row("rotation", (v) => ({ rotation: v }))}
                {row("opacity", (v) => ({ opacity: v }))}
                <p className="pt-1 text-[9px] text-muted-foreground/70">Position may go out of frame. Drag a value to scrub, or click to type an exact number.</p>
              </div>
              <p className="pt-1 text-[9px] text-muted-foreground/70">Animations play at the clip&apos;s head and tail, and are burned into the export.</p>
              <EffectsPanel clip={clip} />
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// Core track colors (a short curated set; "Custom" opens a full picker). Values
// are hex so they can tint headers + clip borders and round-trip through save.
const TRACK_COLORS: { name: string; hex: string }[] = [
  { name: "Orange", hex: "#f59e0b" },
  { name: "Yellow", hex: "#eab308" },
  { name: "Lime", hex: "#84cc16" },
  { name: "Green", hex: "#22c55e" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Violet", hex: "#8b5cf6" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Red", hex: "#ef4444" },
];

/** Collapsible titled section used to group the "add to timeline" menus. */
function CollapsibleSection({ title, icon, defaultOpen = false, children }: {
  title: string; icon: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold text-foreground/90 hover:bg-foreground/5">
        {icon}
        <span className="flex-1 text-left">{title}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
      </button>
      {open && <div className="px-2 pb-2 pt-1">{children}</div>}
    </div>
  );
}

/** Track color chooser: core swatches + a custom color wheel / hex / eyedropper. */
function TrackColorMenu({ current, onPick, onClear }: {
  current?: string; onPick: (hex: string) => void; onClear: () => void;
}) {
  const [hex, setHex] = useState(current ?? "#8b5cf6");
  const hasEyeDropper = typeof window !== "undefined" && "EyeDropper" in window;
  const pickWithDropper = async () => {
    try {
      // EyeDropper is a modern browser API (available in the Electron/Chromium shell).
      const ED = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const res = await new ED().open();
      if (res?.sRGBHex) { setHex(res.sRGBHex); onPick(res.sRGBHex); }
    } catch { /* user cancelled */ }
  };
  return (
    <div className="p-2 w-[188px]">
      <div className="grid grid-cols-5 gap-1.5 mb-2">
        {TRACK_COLORS.map((c) => (
          <button key={c.hex} type="button" title={c.name} onClick={() => onPick(c.hex)}
            className={`w-6 h-6 rounded-full border ${current?.toLowerCase() === c.hex.toLowerCase() ? "border-white ring-1 ring-white/60" : "border-black/40"}`}
            style={{ backgroundColor: c.hex }} />
        ))}
        <button type="button" title="Default (no color)." onClick={onClear}
          className={`w-6 h-6 rounded-full border flex items-center justify-center ${!current ? "border-white ring-1 ring-white/60" : "border-black/40"} bg-foreground/10`}>
          <X className="w-3 h-3 text-muted-foreground" />
        </button>
      </div>
      <div className="border-t border-border/60 pt-2">
        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Custom</span>
        <div className="flex items-center gap-1.5">
          <input type="color" value={hex} onChange={(e) => { setHex(e.target.value); onPick(e.target.value); }}
            title="Open the color wheel." className="w-7 h-7 rounded cursor-pointer bg-transparent border border-border/60" />
          <input type="text" value={hex}
            onChange={(e) => setHex(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && /^#?[0-9a-fA-F]{6}$/.test(hex)) onPick(hex.startsWith("#") ? hex : `#${hex}`); }}
            onBlur={() => { if (/^#?[0-9a-fA-F]{6}$/.test(hex)) onPick(hex.startsWith("#") ? hex : `#${hex}`); }}
            className="flex-1 min-w-0 bg-card border border-border/60 rounded px-1.5 py-1 text-[10px] font-mono" />
          {hasEyeDropper && (
            <button type="button" onClick={pickWithDropper} title="Pick a color from the screen."
              className="w-7 h-7 rounded border border-border/60 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/5">
              <Pipette className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TimelineEditorStudio() {
  const { project, transport } = useTimeline();
  const laneAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [showRelink, setShowRelink] = useState(false);
  // Drag-to-timeline: the pool asset currently being dragged (for an industry-standard
  // length ghost) + the live drop preview {track, start, duration}.
  const [dragAsset, setDragAsset] = useState<TimelineAsset | null>(null);
  const [dropGhost, setDropGhost] = useState<{ segments: { trackId: string; start: number; duration: number }[] } | null>(null);
  const [previewHeight, setPreviewHeight] = useState(() => readTimelineLayout().previewHeight);
  const [laneHeight, setLaneHeight] = useState(() => readTimelineLayout().laneHeight);
  const [mediaPoolHeight, setMediaPoolHeight] = useState(() => readTimelineLayout().mediaPoolHeight);
  const [keyframeHeight, setKeyframeHeight] = useState(() => readTimelineLayout().keyframeHeight);
  const [mediaView, setMediaView] = useState<MediaView>(() => readTimelineLayout().mediaView);
  const [mediaSort, setMediaSort] = useState<{ by: MediaSortBy; dir: "asc" | "desc" }>(() => readTimelineLayout().mediaSort);
  const mediaResizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const keyframeResizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const [showExportPanel, setShowExportPanel] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [importPrompt, setImportPrompt] = useState<{ width: number; height: number; fps: number; name: string } | null>(null);
  const [exportSettings, setExportSettings] = useState<ExportSettings>({
    container: "mp4", vcodec: "h264", resKey: "match", customW: 1920, customH: 1080, fpsKey: "match", crf: 18, fileName: "Untitled_Timeline",
  });
  const [showAudioExportPanel, setShowAudioExportPanel] = useState(false);
  const [audioExportSettings, setAudioExportSettings] = useState<AudioExportSettings>({
    format: "wav", sampleRate: 48000, channels: 2, bitDepth: 24, bitrate: "256k", normalize: "none", lufs: -14, fileName: "Untitled_Timeline",
  });
  const trackResizeRef = useRef<{ id: string; startY: number; startH: number } | null>(null);
  const [previewQuality, setPreviewQuality] = useState<"full" | "half" | "quarter">("full");
  // Program-wide display scale (accessibility): shared with Quick Settings.
  const [uiScale, setUiScale] = useUiScale();
  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string } | null>(null);
  // Track (row) right-click menu + "show clip names below" display option.
  const [trackMenu, setTrackMenu] = useState<{ x: number; y: number; trackId: string } | null>(null);
  // Empty audio-lane right-click menu (add an Audio Generation placeholder there).
  const [laneMenu, setLaneMenu] = useState<{ x: number; y: number; trackId: string; time: number } | null>(null);
  // Marker right-click menu (rename / recolor / delete).
  const [markerMenu, setMarkerMenu] = useState<{ x: number; y: number; markerId: string } | null>(null);
  const [clipNamesBelow, setClipNamesBelow] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  // Recorder output format (persisted for convenience). WAV = lossless, MP3 = small.
  const [recordFormat, setRecordFormat] = useState<"wav" | "mp3">("wav");
  const recordStartRef = useRef<number>(0);
  const [showKeyframes, setShowKeyframes] = useState(false);
  // Snapping (magnet): clip edges + the playhead pull the dragged edge into
  // alignment. Default ON, mirroring every pro NLE. Toggled from the toolbar.
  const [snapEnabled, setSnapEnabled] = useState(() => readTimelineLayout().snapEnabled);
  // Magnetic ripple mode: when on, deleting a clip closes the gap on its track.
  const [rippleEnabled, setRippleEnabled] = useState(() => readTimelineLayout().rippleEnabled);
  // Active trim tool: changes how dragging a clip's edges/body behaves.
  const [trimTool, setTrimTool] = useState<"normal" | "ripple" | "roll" | "slip" | "slide">("normal");
  // Marquee (rubber-band) selection box over the lanes, in container coords.
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // User-remappable keyboard shortcuts (persisted to localStorage).
  const [hotkeys, setHotkeys] = useState<HotkeyMap>(() => loadBindings());
  const updateHotkeys = useCallback((m: HotkeyMap) => { setHotkeys(m); saveBindings(m); }, []);
  // The keydown listener reads bindings through a ref so remapping takes effect
  // immediately without tearing down / re-adding the global listener.
  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDetail, setExportDetail] = useState<string | null>(null);
  const [exportLogPath, setExportLogPath] = useState<string | null>(null);
  const [showExportDetail, setShowExportDetail] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ percent: number; phase: string; etaSec: number | null; speed: number; encoder?: string } | null>(null);
  // Background media-caching (thumbnail decode) progress for the bottom status bar.
  const [thumbProgress, setThumbProgress] = useState<{ jobs: number; percent: number } | null>(null);
  const thumbPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fmtEta = (sec: number): string => {
    const s = Math.max(0, Math.round(sec));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  };
  // Detect GPU (NVENC) encode support; default the toggle ON when available.
  const [nvencAvail, setNvencAvail] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/encoders")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.nvenc) { setNvencAvail(true); setExportSettings((s) => ({ ...s, hwEncode: true })); }
      })
      .catch(() => { /* no hardware encoders */ });
    return () => { cancelled = true; };
  }, []);

  // Poll the media-cache progress endpoint while background thumbnail decoding
  // is happening (started on demand when a clip first requests its strip).
  useEffect(() => {
    const poll = async () => {
      try {
        const r = await fetch("/api/timeline-thumbs?progress=1");
        const d = (await r.json()) as { jobs: number; percent: number };
        if (d.jobs > 0) {
          setThumbProgress(d);
          thumbPollRef.current = setTimeout(poll, 500);
        } else {
          setThumbProgress(null);
          thumbPollRef.current = null;
        }
      } catch {
        setThumbProgress(null);
        thumbPollRef.current = null;
      }
    };
    const onActivity = () => { if (!thumbPollRef.current) thumbPollRef.current = setTimeout(poll, 0); };
    const unsub = subscribeThumbActivity(onActivity);
    return () => {
      unsub();
      if (thumbPollRef.current) { clearTimeout(thumbPollRef.current); thumbPollRef.current = null; }
    };
  }, []);

  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  // Media-pool reveal: transiently ring + scroll to an asset (Match Frame / Reveal).
  const [revealAssetId, setRevealAssetId] = useState<string | null>(null);
  const mediaPoolScrollRef = useRef<HTMLDivElement>(null);
  // ── Media-pool multi-selection (mirrors the timeline: click / Shift-range /
  // Ctrl-toggle, marquee drag, Ctrl+A, Delete to remove) ──
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const lastPickedAssetRef = useRef<string | null>(null);
  const [poolMarquee, setPoolMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const poolMarqueeStart = useRef<{ x: number; y: number; additive: boolean } | null>(null);
  const poolMarqueeActive = useRef(false);
  const poolMarqueeClient = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | "master" | null>(null);
  const [effectFrame, setEffectFrame] = useState<string | null>(null);
  const [frameRendering, setFrameRendering] = useState(false);
  const frameCacheRef = useRef<Map<string, string>>(new Map());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const projectInputRef = useRef<HTMLInputElement>(null);

  const handleImport = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setImporting(true);
    let matchCandidate: { width: number; height: number; fps: number; name: string } | null = null;
    try {
      for (const file of Array.from(files)) {
        try {
          const assets = await buildAssetsFromFile(file);
          for (const a of assets) timelineStore.addAsset(a);
          // Offer to match the project format to the first video that has known dimensions.
          const vid = assets.find((a) => a.kind === "video" && a.width && a.height);
          if (!matchCandidate && vid?.width && vid?.height) {
            matchCandidate = { width: vid.width, height: vid.height, fps: vid.fps ?? 30, name: vid.name };
          }
        } catch {
          // skip files that fail to decode; keep importing the rest
        }
      }
    } finally {
      setImporting(false);
    }
    // Prompt only if the project format differs from the imported clip.
    if (matchCandidate) {
      const p = timelineStore.getSnapshot().project;
      const differs = p.width !== matchCandidate.width || p.height !== matchCandidate.height || Math.abs(p.fps - matchCandidate.fps) > 0.01;
      if (differs) setImportPrompt(matchCandidate);
    }
  }, []);

  // Mic capture: record from the user's microphone into a new audio asset.
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        // Precise wall-clock length: a reliable fallback if probing ever fails.
        const elapsed = recordStartRef.current ? (Date.now() - recordStartRef.current) / 1000 : 0;
        const webm = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        const stamp = new Date().toLocaleTimeString().replace(/[^\w]+/g, "-").replace(/-+$/, "");
        try {
          // Transcode the (duration-less, non-seekable) MediaRecorder WebM into a
          // real WAV/MP3 with a proper header + known duration, server-side.
          const fd = new FormData();
          fd.append("file", new File([webm], "voice.webm", { type: webm.type }));
          fd.append("format", recordFormat);
          const res = await fetch("/api/timeline-audio-encode", { method: "POST", body: fd });
          if (!res.ok) throw new Error("encode failed");
          const filePath = res.headers.get("X-File-Path") || undefined;
          const probed = parseFloat(res.headers.get("X-Duration") || "");
          const outBlob = await res.blob();
          const src = URL.createObjectURL(outBlob);
          const { peaks, duration: decodedDur } = await decodeAudioPeaks(await outBlob.arrayBuffer());
          const duration = (Number.isFinite(probed) && probed > 0) ? probed : (decodedDur || elapsed || 1);
          timelineStore.addAsset({
            id: timelineId("asset"), kind: "audio",
            name: `Voice ${stamp}.${recordFormat}`, src, filePath, duration, peaks,
          });
        } catch {
          // Fallback: import the raw recording (media.ts still derives a real
          // duration from the decoded audio buffer for duration-less containers).
          try {
            const file = new File([webm], `Voice ${stamp}.webm`, { type: webm.type });
            const assets = await buildAssetsFromFile(file);
            for (const a of assets) timelineStore.addAsset(a);
          } catch { /* recording failed to decode; ignore */ }
        }
        setIsRecording(false);
      };
      mediaRecorderRef.current = rec;
      recordStartRef.current = Date.now();
      rec.start();
      setIsRecording(true);
    } catch {
      setIsRecording(false);
    }
  }, []);
  const stopRecording = useCallback(() => { mediaRecorderRef.current?.stop(); }, []);

  // ── Export (Phase 4): render the timeline via ffmpeg using the chosen settings. ──
  // Save location is picked BEFORE rendering (File System Access API) when available.
  const runExport = useCallback(async (settings: ExportSettings) => {
    const proj = timelineStore.getSnapshot().project;
    // Resolve output resolution from the preset key.
    let width: number | undefined;
    let height: number | undefined;
    if (settings.resKey === "custom") { width = settings.customW; height = settings.customH; }
    else if (settings.resKey !== "match") {
      const p = RES_PRESETS.find((r) => r.key === settings.resKey);
      if (p) { width = p.w; height = p.h; }
    }
    const fps = settings.fpsKey === "match" ? undefined : Number(settings.fpsKey);
    const output = { container: settings.container, vcodec: settings.vcodec, width, height, fps, crf: settings.crf, hwEncode: settings.hwEncode };
    const safeName = (settings.fileName || "Untitled_Timeline").replace(/[^\w.\-]+/g, "_");
    const ext = settings.container;
    const mime = ext === "mov" ? "video/quicktime" : ext === "webm" ? "video/webm" : "video/mp4";

    // 1) Pick the destination first (so the dialog appears BEFORE the render).
    const picker = getSaveFilePicker();
    let handle: FileSystemFileHandle | undefined;
    if (picker) {
      try {
        handle = await picker({ suggestedName: `${safeName}.${ext}`, types: [{ description: "Video", accept: { [mime]: [`.${ext}`] } }] });
      } catch {
        return; // user cancelled the save dialog, abort cleanly
      }
    }

    setShowExportPanel(false);
    setExportError(null);
    setExportDetail(null);
    setExportLogPath(null);
    setShowExportDetail(false);
    setExporting(true);
    setExportProgress({ percent: 0, phase: "preparing", etaSec: null, speed: 0 });

    // Live progress channel: ffmpeg -progress is relayed over SSE, keyed by jobId.
    const jobId = `tlx_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/timeline-export/progress?jobId=${jobId}`);
      es.addEventListener("progress", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data);
          setExportProgress({ percent: d.percent ?? 0, phase: d.phase ?? "rendering", etaSec: d.etaSec ?? null, speed: d.speed ?? 0, encoder: d.encoder });
        } catch { /* ignore malformed frame */ }
      });
      es.addEventListener("done", () => setExportProgress((p) => (p ? { ...p, percent: 100, phase: "done", etaSec: 0 } : p)));
    } catch { es = null; }

    try {
      const res = await fetch("/api/timeline-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: proj, output, jobId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Export failed" }));
        setExportDetail(data.detail ?? null);
        setExportLogPath(data.logPath ?? null);
        throw new Error(data.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        // Fallback (no File System Access API): browser download.
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    } finally {
      es?.close();
      setExporting(false);
      setExportProgress(null);
    }
  }, []);

  // ── Audio-only export: render just the timeline's audio mixdown to a file. ──
  // Shares the export progress / error UI with the video export (same states).
  const runAudioExport = useCallback(async (settings: AudioExportSettings) => {
    const proj = timelineStore.getSnapshot().project;
    const audio = {
      format: settings.format,
      sampleRate: settings.sampleRate,
      channels: settings.channels,
      bitDepth: settings.bitDepth,
      bitrate: settings.bitrate,
      normalize: settings.normalize,
      lufs: settings.lufs,
    };
    const safeName = (settings.fileName || "Untitled_Timeline").replace(/[^\w.\-]+/g, "_");
    const ext = AUDIO_EXT[settings.format];
    const mime = AUDIO_MIME[settings.format];

    // Pick the destination first (dialog appears BEFORE the render), like video export.
    const picker = getSaveFilePicker();
    let handle: FileSystemFileHandle | undefined;
    if (picker) {
      try {
        handle = await picker({ suggestedName: `${safeName}.${ext}`, types: [{ description: "Audio", accept: { [mime]: [`.${ext}`] } }] });
      } catch {
        return; // user cancelled the save dialog, abort cleanly
      }
    }

    setShowAudioExportPanel(false);
    setExportError(null);
    setExportDetail(null);
    setExportLogPath(null);
    setShowExportDetail(false);
    setExporting(true);
    setExportProgress({ percent: 0, phase: "preparing", etaSec: null, speed: 0 });

    const jobId = `tla_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/timeline-export/progress?jobId=${jobId}`);
      es.addEventListener("progress", (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data);
          setExportProgress({ percent: d.percent ?? 0, phase: d.phase ?? "rendering", etaSec: d.etaSec ?? null, speed: d.speed ?? 0, encoder: d.encoder });
        } catch { /* ignore malformed frame */ }
      });
      es.addEventListener("done", () => setExportProgress((p) => (p ? { ...p, percent: 100, phase: "done", etaSec: 0 } : p)));
    } catch { es = null; }

    try {
      const res = await fetch("/api/timeline-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: proj, audio, jobId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Audio export failed" }));
        setExportDetail(data.detail ?? null);
        setExportLogPath(data.logPath ?? null);
        throw new Error(data.error || `Audio export failed (${res.status})`);
      }
      const blob = await res.blob();
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${safeName}.${ext}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Audio export failed");
    } finally {
      es?.close();
      setExporting(false);
      setExportProgress(null);
    }
  }, []);

  const dismissExportError = useCallback(() => {
    setExportError(null);
    setExportDetail(null);
    setExportLogPath(null);
    setShowExportDetail(false);
  }, []);

  // Drop an asset onto a group row to (re)assign it (null = Master / ungrouped).
  const moveAssetToGroup = useCallback((e: React.DragEvent, groupId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverGroup(null);
    const id = e.dataTransfer.getData(ASSET_MIME);
    if (id) timelineStore.setAssetGroup(id, groupId);
  }, []);

  // ── Project save / load: portable, self-contained JSON document, INDEPENDENT
  // of the app-wide Save/Load (studio-v2). saveJsonFile drops ephemeral
  // blob:/data: URLs (dead on reload) while keeping each asset's absolute
  // filePath; load rebuilds src from filePath via /api/timeline-media. ──
  const handleSaveProject = useCallback(async () => {
    const proj = timelineStore.getSnapshot().project;
    const name = `${(proj.name || "timeline").replace(/\s+/g, "_")}.veksnaptl.json`;
    await saveJsonFile(name, { ...proj, _source: "timeline", _version: 1 });
  }, []);

  const handleOpenProject = useCallback(async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const proj = JSON.parse(text);
      if (!proj?.tracks || !proj?.clips) throw new Error("Not a timeline project file");
      timelineStore.loadProject(restoreTimelineMediaSrc(proj as TimelineProject));
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Could not open project");
    }
  }, []);

  // Drag a clip's corner handle inward to set a linear fade-in/out (Image 5 behavior).
  const onFadePointerDown = useCallback(
    (e: React.PointerEvent, clip: TimelineClip, edge: "in" | "out") => {
      e.stopPropagation();
      e.preventDefault();
      timelineStore.beginInteraction();
      const startX = e.clientX;
      const orig = edge === "in" ? (clip.fadeIn ?? 0) : (clip.fadeOut ?? 0);
      const pps = transport.pxPerSecond;
      const move = (ev: PointerEvent) => {
        const deltaSec = (ev.clientX - startX) / pps;
        if (edge === "in") {
          const max = clip.duration - (clip.fadeOut ?? 0);
          timelineStore.setClip(clip.id, { fadeIn: Math.max(0, Math.min(max, orig + deltaSec)) });
        } else {
          const max = clip.duration - (clip.fadeIn ?? 0);
          timelineStore.setClip(clip.id, { fadeOut: Math.max(0, Math.min(max, orig - deltaSec)) });
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [transport.pxPerSecond],
  );

  // Import OS files dropped straight onto the timeline: add each to the media
  // pool AND place it on a kind-appropriate track, laying them end-to-end from
  // the drop position. A video with an extracted-audio companion lands as a
  // linked A/V pair.
  const importFilesToTimeline = useCallback(async (files: FileList, track: TimelineTrack, startAt: number) => {
    setImporting(true);
    let cursor = Math.max(0, startAt);
    let matchCandidate: { width: number; height: number; fps: number; name: string } | null = null;
    try {
      for (const file of Array.from(files)) {
        try {
          const assets = await buildAssetsFromFile(file);
          for (const a of assets) timelineStore.addAsset(a);
          // Offer to match the project format to the first video with known dimensions
          // (same behaviour as the Import Media button, a drag-to-timeline import
          // is still an import and must not skip this prompt).
          const vid = assets.find((a) => a.kind === "video" && a.width && a.height);
          if (!matchCandidate && vid?.width && vid?.height) {
            matchCandidate = { width: vid.width, height: vid.height, fps: vid.fps ?? 30, name: vid.name };
          }
          const primary = assets.find((a) => !a.fromVideoAssetId) ?? assets[0];
          if (!primary) continue;
          const companion = primary.linkedAudioAssetId ? assets.find((a) => a.id === primary.linkedAudioAssetId) : undefined;
          const tracks = timelineStore.getSnapshot().project.tracks;
          const videoTrack = track.kind === "video" ? track : [...tracks].filter((t) => t.kind === "video").sort((a, b) => b.index - a.index)[0];
          const audioTrack = track.kind === "audio" ? track : [...tracks].filter((t) => t.kind === "audio").sort((a, b) => a.index - b.index)[0];
          if (primary.kind === "video" && companion && videoTrack) {
            const linkId = timelineId("link");
            const vId = timelineId("clip");
            const clips: TimelineClip[] = [
              { id: vId, assetId: primary.id, trackId: videoTrack.id, start: cursor, duration: primary.duration, trimIn: 0, trimOut: primary.duration, linkId },
            ];
            if (audioTrack) clips.push({ id: timelineId("clip"), assetId: companion.id, trackId: audioTrack.id, start: cursor, duration: companion.duration, trimIn: 0, trimOut: companion.duration, linkId });
            timelineStore.addClips(clips);
            timelineStore.selectClip(vId);
          } else {
            let dest = track;
            if (primary.kind === "audio" && track.kind !== "audio") dest = audioTrack ?? track;
            else if (primary.kind !== "audio" && track.kind === "audio") dest = videoTrack ?? track;
            const id = timelineId("clip");
            timelineStore.addClip({ id, assetId: primary.id, trackId: dest.id, start: cursor, duration: primary.duration, trimIn: 0, trimOut: primary.duration });
            timelineStore.selectClip(id);
          }
          cursor += primary.duration;
        } catch {
          // one bad file shouldn't abort the rest of the drop
        }
      }
    } finally {
      setImporting(false);
    }
    // Prompt to match the project format only if it differs from the import.
    if (matchCandidate) {
      const p = timelineStore.getSnapshot().project;
      const differs = p.width !== matchCandidate.width || p.height !== matchCandidate.height || Math.abs(p.fps - matchCandidate.fps) > 0.01;
      if (differs) setImportPrompt(matchCandidate);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, track: TimelineTrack) => {
      e.preventDefault();
      setDropGhost(null);
      setDragAsset(null);
      const rect = e.currentTarget.getBoundingClientRect();
      const start = Math.max(0, (e.clientX - rect.left) / transport.pxPerSecond);

      // An internal media-pool drag always carries our asset id. Read it FIRST so a
      // dragged poster <img> (which the browser may ALSO expose as a synthesized
      // image file on dataTransfer) can never be re-imported as a phantom still.
      const assetId = e.dataTransfer.getData(ASSET_MIME);

      // OS files dragged straight from the file system → import + place here.
      if (!assetId && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        void importFilesToTimeline(e.dataTransfer.files, track, start);
        return;
      }

      // "Audio Generation" add-menu item → a blank placeholder on an audio track.
      if (!assetId && e.dataTransfer.getData(AUDIOGEN_MIME) && track.kind === "audio") {
        timelineStore.addPendingAudioClip(start, track.id);
        return;
      }

      const asset = project.assets.find((a) => a.id === assetId);
      if (!asset) return;

      // Video with extracted audio → drop a linked, synced A/V pair.
      const audioAsset = asset.linkedAudioAssetId ? project.assets.find((a) => a.id === asset.linkedAudioAssetId) : undefined;
      const videoTrack = track.kind === "video" ? track : [...project.tracks].filter((t) => t.kind === "video").sort((a, b) => b.index - a.index)[0];
      const audioTrack = track.kind === "audio" ? track : [...project.tracks].filter((t) => t.kind === "audio").sort((a, b) => a.index - b.index)[0];
      if (asset.kind === "video" && audioAsset && videoTrack) {
        const linkId = timelineId("link");
        const vId = timelineId("clip");
        const clips: TimelineClip[] = [
          { id: vId, assetId: asset.id, trackId: videoTrack.id, start, duration: asset.duration, trimIn: 0, trimOut: asset.duration, linkId },
        ];
        if (audioTrack) {
          clips.push({ id: timelineId("clip"), assetId: audioAsset.id, trackId: audioTrack.id, start, duration: audioAsset.duration, trimIn: 0, trimOut: audioAsset.duration, linkId });
        }
        timelineStore.addClips(clips);
        if (!(project.allowStacking ?? false)) for (const cc of clips) timelineStore.resolveTrackOverlaps(cc.id);
        timelineStore.selectClip(vId);
        return;
      }

      // Place on a track matching the asset's kind, redirecting if dropped on the
      // wrong lane kind (e.g. an audio file dropped on a video lane → nearest A track).
      let destTrack = track;
      if (asset.kind === "audio" && track.kind !== "audio") destTrack = audioTrack ?? track;
      else if (asset.kind !== "audio" && track.kind === "audio") destTrack = videoTrack ?? track;
      const id = timelineId("clip");
      timelineStore.addClip({ id, assetId: asset.id, trackId: destTrack.id, start, duration: asset.duration, trimIn: 0, trimOut: asset.duration });
      if (!(project.allowStacking ?? false)) timelineStore.resolveTrackOverlaps(id);
      timelineStore.selectClip(id);
    },
    [project.assets, project.tracks, project.allowStacking, transport.pxPerSecond, importFilesToTimeline],
  );

  // ── Clip move / trim drag ──
  type TrimTool = "normal" | "ripple" | "roll" | "slip" | "slide";
  const dragRef = useRef<{
    mode: "move" | "trim-l" | "trim-r";
    tool: TrimTool;
    id: string; startX: number; orig: TimelineClip; assetDur: number;
    partners: { id: string; orig: TimelineClip }[];
    // Same-track neighbours + downstream clips captured at drag start, for the
    // advanced trim tools (roll consumes a neighbour; slide fills both; ripple
    // slides everything after).
    prev: { orig: TimelineClip; assetDur: number } | null;
    next: { orig: TimelineClip; assetDur: number } | null;
    after: { id: string; start: number }[];
  } | null>(null);

  // ── Marquee (rubber-band) multi-select over empty lane space ──
  const lanesRef = useRef<HTMLDivElement>(null);
  const marqueeStart = useRef<{ x: number; y: number; additive: boolean } | null>(null);
  const marqueeActive = useRef(false);
  const marqueeClient = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const snap = useCallback(
    (val: number, excludeId: string) => {
      if (!snapEnabled) return Math.max(0, val);
      const thresh = 8 / transport.pxPerSecond;
      // Snap to other clip edges, the current playhead, AND every marker.
      const targets = [transport.playhead];
      for (const c of project.clips) {
        if (c.id === excludeId) continue;
        targets.push(c.start, c.start + c.duration);
      }
      for (const m of project.markers ?? []) targets.push(m.time);
      let best = val;
      let bd = thresh;
      for (const t of targets) {
        const dd = Math.abs(t - val);
        if (dd < bd) { bd = dd; best = t; }
      }
      return Math.max(0, best);
    },
    [project.clips, project.markers, transport.pxPerSecond, transport.playhead, snapEnabled],
  );

  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, clip: TimelineClip, mode: "move" | "trim-l" | "trim-r") => {
      e.stopPropagation();
      // Shift-click toggles multi-selection (for Combine) without starting a drag.
      if (e.shiftKey && mode === "move") {
        timelineStore.toggleSelectClip(clip.id);
        return;
      }
      timelineStore.selectClip(clip.id);
      timelineStore.beginInteraction();
      const asset = project.assets.find((a) => a.id === clip.assetId);
      const assetDur = asset && asset.kind !== "image" ? asset.duration : Infinity;
      const linked = clip.linkId ? project.clips.filter((c) => c.linkId === clip.linkId && c.id !== clip.id) : [];
      // Capture same-track neighbours + downstream clips for the advanced tools.
      const durOf = (c: TimelineClip): number => {
        const a = project.assets.find((x) => x.id === c.assetId);
        return a && a.kind !== "image" ? a.duration : Infinity;
      };
      const sameTrack = project.clips
        .filter((c) => c.trackId === clip.trackId && c.id !== clip.id)
        .sort((a, b) => a.start - b.start);
      const prevClip = [...sameTrack].reverse().find((c) => c.start + c.duration <= clip.start + 0.05) ?? null;
      const nextClip = sameTrack.find((c) => c.start >= clip.start + clip.duration - 0.05) ?? null;
      const after = sameTrack
        .filter((c) => c.start >= clip.start + clip.duration - 0.05)
        .map((c) => ({ id: c.id, start: c.start }));
      dragRef.current = {
        mode, tool: trimTool, id: clip.id, startX: e.clientX, orig: clip, assetDur,
        partners: linked.map((c) => ({ id: c.id, orig: c })),
        prev: prevClip ? { orig: prevClip, assetDur: durOf(prevClip) } : null,
        next: nextClip ? { orig: nextClip, assetDur: durOf(nextClip) } : null,
        after,
      };
    },
    [project.assets, project.clips, trimTool],
  );

  // ── Scrub preview: the video/image clip under the playhead (topmost video track) ──
  const previewRef = useRef<HTMLVideoElement>(null);
  const audioEngineRef = useRef<TimelineAudioEngine | null>(null);
  const activeVideo = useMemo(() => {
    // Real (asset-backed) video clips under the playhead across all visible video
    // tracks. Titles (no asset) are handled separately as overlays. Solo-aware:
    // if ANY video track is soloed, only soloed (and non-hidden) video tracks show.
    const anyVideoSolo = project.tracks.some((t) => t.kind === "video" && t.solo);
    const vtrackIds = new Set(project.tracks.filter((t) => t.kind === "video" && !t.hidden && (!anyVideoSolo || t.solo)).map((t) => t.id));
    const trackIndex = new Map(project.tracks.map((t) => [t.id, t.index] as const));
    const hits = project.clips.filter(
      (c) => c.assetId && vtrackIds.has(c.trackId) && transport.playhead >= c.start && transport.playhead < c.start + c.duration,
    );
    if (!hits.length) return null;
    // Priority: explicit z ("Bring to Top") > higher track > latest-starting (incoming dissolve).
    return hits.reduce((a, b) => {
      const az = a.z ?? 0, bz = b.z ?? 0;
      if (bz !== az) return bz > az ? b : a;
      const ai = trackIndex.get(a.trackId) ?? 0, bi = trackIndex.get(b.trackId) ?? 0;
      if (bi !== ai) return bi > ai ? b : a;
      return b.start > a.start ? b : a;
    });
  }, [project.tracks, project.clips, transport.playhead]);
  const activeVideoAsset = activeVideo ? project.assets.find((a) => a.id === activeVideo.assetId) : undefined;

  const duration = useMemo(() => projectDuration(project), [project]);
  // Always render some empty runway past the content so the timeline isn't cramped.
  const viewDuration = Math.max(duration + 10, 30);
  const contentWidth = viewDuration * transport.pxPerSecond;

  // Tracks are stacked highest-index first (V2 above V1 above A1).
  const orderedTracks = useMemo(
    () => [...project.tracks].sort((a, b) => b.index - a.index),
    [project.tracks],
  );

  // Media Pool hides extracted-audio companions (they ride with their video).
  const poolAssets = useMemo(() => project.assets.filter((a) => !a.fromVideoAssetId), [project.assets]);
  const groups = useMemo(() => project.groups ?? [], [project.groups]);
  // Master (null) shows everything; a group shows only its members.
  const effectiveGroupId = activeGroupId && groups.some((g) => g.id === activeGroupId) ? activeGroupId : null;
  const visibleAssets = useMemo(
    () => (effectiveGroupId == null ? poolAssets : poolAssets.filter((a) => (a.groupId ?? null) === effectiveGroupId)),
    [poolAssets, effectiveGroupId],
  );
  // Apply the chosen Media Pool sort (name / type / duration, asc or desc).
  const sortedAssets = useMemo(() => {
    const dir = mediaSort.dir === "asc" ? 1 : -1;
    return [...visibleAssets].sort((a, b) => {
      if (mediaSort.by === "duration") return (a.duration - b.duration) * dir;
      if (mediaSort.by === "type") return (a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)) * dir;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * dir;
    });
  }, [visibleAssets, mediaSort]);
  const groupCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of poolAssets) if (a.groupId) m.set(a.groupId, (m.get(a.groupId) ?? 0) + 1);
    return m;
  }, [poolAssets]);

  // ── Media-pool selection helpers ──
  const selectAsset = useCallback((id: string, e: React.MouseEvent) => {
    const orderedIds = sortedAssets.map((a) => a.id);
    setSelectedAssetIds((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastPickedAssetRef.current) {
        const a = orderedIds.indexOf(lastPickedAssetRef.current);
        const b = orderedIds.indexOf(id);
        if (a >= 0 && b >= 0) { const [lo, hi] = [Math.min(a, b), Math.max(a, b)]; for (let i = lo; i <= hi; i++) next.add(orderedIds[i]); }
        else next.add(id);
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(id)) next.delete(id); else next.add(id);
        lastPickedAssetRef.current = id;
      } else {
        next.clear(); next.add(id); lastPickedAssetRef.current = id;
      }
      return next;
    });
  }, [sortedAssets]);
  const removePoolAssets = useCallback((clickedId: string) => {
    setSelectedAssetIds((prev) => {
      const ids = prev.has(clickedId) && prev.size ? [...prev] : [clickedId];
      timelineStore.removeAssets(ids);
      return new Set();
    });
  }, []);
  const selectAllPoolAssets = useCallback(() => {
    setSelectedAssetIds(new Set(sortedAssets.map((a) => a.id)));
  }, [sortedAssets]);
  // Deselect when the visible set changes out from under the selection.
  useEffect(() => {
    const visible = new Set(sortedAssets.map((a) => a.id));
    setSelectedAssetIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) { if (visible.has(id)) next.add(id); else changed = true; }
      return changed ? next : prev;
    });
  }, [sortedAssets]);

  // Media-pool marquee: rubber-band over empty pool space selects the assets it
  // covers (Shift/Ctrl adds). Mirrors the timeline lane marquee.
  const startPoolMarquee = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    mediaPoolScrollRef.current?.focus();
    if ((e.target as HTMLElement).closest("[data-asset-id]")) return; // clicked an item → let it select
    poolMarqueeStart.current = { x: e.clientX, y: e.clientY, additive: e.shiftKey || e.ctrlKey || e.metaKey };
    poolMarqueeActive.current = false;
    poolMarqueeClient.current = null;
    if (!(e.shiftKey || e.ctrlKey || e.metaKey)) setSelectedAssetIds(new Set()); // plain click on empty space clears
  }, []);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const s = poolMarqueeStart.current;
      if (!s) return;
      if (!poolMarqueeActive.current && Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) < 4) return;
      poolMarqueeActive.current = true;
      const cont = mediaPoolScrollRef.current;
      if (!cont) return;
      const r = cont.getBoundingClientRect();
      const x0 = Math.min(s.x, e.clientX), x1 = Math.max(s.x, e.clientX);
      const y0 = Math.min(s.y, e.clientY), y1 = Math.max(s.y, e.clientY);
      poolMarqueeClient.current = { x0, y0, x1, y1 };
      // Box is drawn relative to the scroll container (account for scrollTop).
      setPoolMarquee({ left: x0 - r.left, top: y0 - r.top + cont.scrollTop, width: x1 - x0, height: y1 - y0 });
    };
    const onUp = () => {
      const s = poolMarqueeStart.current;
      const box = poolMarqueeClient.current;
      const wasActive = poolMarqueeActive.current;
      poolMarqueeStart.current = null;
      poolMarqueeActive.current = false;
      poolMarqueeClient.current = null;
      setPoolMarquee(null);
      if (!s || !wasActive || !box) return;
      const cont = mediaPoolScrollRef.current;
      if (!cont) return;
      const hits: string[] = [];
      cont.querySelectorAll<HTMLElement>("[data-asset-id]").forEach((el) => {
        const cr = el.getBoundingClientRect();
        if (!(cr.right < box.x0 || cr.left > box.x1 || cr.bottom < box.y0 || cr.top > box.y1)) {
          const id = el.getAttribute("data-asset-id");
          if (id) hits.push(id);
        }
      });
      setSelectedAssetIds((prev) => {
        const next = s.additive ? new Set(prev) : new Set<string>();
        for (const id of hits) next.add(id);
        return next;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);

  // industry-standard ruler: pick a labeled step (~64px apart) with 5 minor subdivisions.
  const { labelStep, minorStep, showMinor } = useMemo(() => {
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    let labelStep = steps[steps.length - 1];
    for (const s of steps) { if (s * transport.pxPerSecond >= 64) { labelStep = s; break; } }
    const minorStep = labelStep / 5;
    return { labelStep, minorStep, showMinor: minorStep * transport.pxPerSecond >= 5 };
  }, [transport.pxPerSecond]);

  const ticks = useMemo(() => {
    const out: { t: number; major: boolean }[] = [];
    const step = showMinor ? minorStep : labelStep;
    const n = Math.floor(viewDuration / step) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i * step;
      const major = Math.abs(t / labelStep - Math.round(t / labelStep)) < 1e-6;
      out.push({ t, major });
    }
    return out;
  }, [viewDuration, labelStep, minorStep, showMinor]);

  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = laneAreaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Subtract the left-hand track-label column so x=0 maps to time 0:00.
      const x = clientX - rect.left + el.scrollLeft - TRACK_LABEL_W;
      timelineStore.setPlayhead(Math.max(0, x / transport.pxPerSecond));
    },
    [transport.pxPerSecond],
  );

  // Click-and-drag scrubbing: pause playback, then track the pointer until release.
  const startScrub = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      timelineStore.setPlaying(false);
      seekFromEvent(e.clientX);
      const onMove = (ev: PointerEvent) => seekFromEvent(ev.clientX);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [seekFromEvent],
  );

  // Jump the playhead to the previous / next edit point (clip boundary). Shared
  // by the transport's prev/next-segment buttons and the Up/Down keyboard shortcuts.
  const jumpToEdit = useCallback((dir: "prev" | "next") => {
    const snap = timelineStore.getSnapshot();
    const cur = snap.transport.playhead;
    const bounds = new Set<number>([0]);
    for (const c of snap.project.clips) {
      bounds.add(Number(c.start.toFixed(4)));
      bounds.add(Number((c.start + c.duration).toFixed(4)));
    }
    const sorted = [...bounds].sort((a, b) => a - b);
    const eps = 1e-3;
    timelineStore.setPlaying(false);
    if (dir === "next") {
      const next = sorted.find((b) => b > cur + eps);
      if (next !== undefined) timelineStore.setPlayhead(next);
    } else {
      const prev = [...sorted].reverse().find((b) => b < cur - eps);
      timelineStore.setPlayhead(prev ?? 0);
    }
  }, []);

  // Set the zoom so a given time span fits the visible lane width (minus the
  // fixed track-label column), clamped to the store's zoom range. Used by
  // Zoom-to-fit (whole project) and Zoom-to-selection (selected clips' span).
  const zoomToSpan = useCallback((span: number) => {
    const el = laneAreaRef.current;
    if (!el || span <= 0) return;
    const avail = Math.max(120, el.clientWidth - TRACK_LABEL_W - 24);
    const px = Math.max(8, Math.min(400, Math.floor(avail / span)));
    timelineStore.setZoom(px);
  }, []);

  const zoomToFit = useCallback(() => {
    const snap = timelineStore.getSnapshot();
    const dur = projectDuration(snap.project);
    if (dur > 0) { zoomToSpan(dur); requestAnimationFrame(() => { if (laneAreaRef.current) laneAreaRef.current.scrollLeft = 0; }); }
  }, [zoomToSpan]);

  const zoomToSelection = useCallback(() => {
    const snap = timelineStore.getSnapshot();
    const ids = new Set(snap.transport.selectedClipIds?.length ? snap.transport.selectedClipIds : (snap.transport.selectedClipId ? [snap.transport.selectedClipId] : []));
    const picked = snap.project.clips.filter((c) => ids.has(c.id));
    if (picked.length === 0) { zoomToFit(); return; }
    const start = Math.min(...picked.map((c) => c.start));
    const end = Math.max(...picked.map((c) => c.start + c.duration));
    zoomToSpan(end - start);
    requestAnimationFrame(() => { if (laneAreaRef.current) laneAreaRef.current.scrollLeft = Math.max(0, start * timelineStore.getSnapshot().transport.pxPerSecond - 20); });
  }, [zoomToSpan, zoomToFit]);

  // Reveal an asset in the Media Pool (Match Frame / "Reveal in Media Pool"):
  // switch to the bin that contains it, then ring + scroll it into view briefly.
  const revealInPool = useCallback((assetId: string) => {
    const p = timelineStore.getSnapshot().project;
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset) return;
    // Extracted-audio companions aren't shown; reveal their parent video instead.
    const target = asset.fromVideoAssetId ?? assetId;
    const targetAsset = p.assets.find((a) => a.id === target);
    setActiveGroupId(targetAsset?.groupId ?? null);
    setRevealAssetId(target);
    requestAnimationFrame(() => {
      const el = mediaPoolScrollRef.current?.querySelector(`[data-asset-id="${target}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => setRevealAssetId(null), 1800);
  }, []);

  // Persist the editor layout whenever any tracked value changes.
  useEffect(() => {
    writeTimelineLayout({ previewHeight, laneHeight, mediaPoolHeight, keyframeHeight, snapEnabled, rippleEnabled, mediaView, mediaSort });
  }, [previewHeight, laneHeight, mediaPoolHeight, keyframeHeight, snapEnabled, rippleEnabled, mediaView, mediaSort]);

  // Restore every panel/view value to the shipped defaults ("Reset to Default View").
  const resetLayout = useCallback(() => {
    setPreviewHeight(DEFAULT_LAYOUT.previewHeight);
    setLaneHeight(DEFAULT_LAYOUT.laneHeight);
    setMediaPoolHeight(DEFAULT_LAYOUT.mediaPoolHeight);
    setKeyframeHeight(DEFAULT_LAYOUT.keyframeHeight);
    setSnapEnabled(DEFAULT_LAYOUT.snapEnabled);
    setRippleEnabled(DEFAULT_LAYOUT.rippleEnabled);
    setMediaView(DEFAULT_LAYOUT.mediaView);
    setMediaSort({ ...DEFAULT_LAYOUT.mediaSort });
  }, []);

  const selectedClip = project.clips.find((c) => c.id === transport.selectedClipId) ?? null;
  const selectedTrack = selectedClip ? project.tracks.find((t) => t.id === selectedClip.trackId) ?? null : null;
  // A linked A/V selection shows the controls for EVERY member (video + audio),
  // so selecting the video half also surfaces the audio half's controls.
  const linkedSelection = selectedClip?.linkId
    ? project.clips.filter((c) => c.linkId === selectedClip.linkId)
    : selectedClip ? [selectedClip] : [];
  // A title clip lives on a video track but is edited as a "text" component.
  const selectedKind: "video" | "audio" | "text" | null = selectedClip
    ? (isTitleClip(selectedClip) ? "text" : (selectedTrack?.kind ?? null))
    : null;

  // Live (keyframe-evaluated) video transform for the clip under the playhead.
  const vLocal = activeVideo ? Math.max(0, Math.min(activeVideo.duration, transport.playhead - activeVideo.start)) : 0;
  const vOpacity = activeVideo ? evalClipProp(activeVideo, "opacity", vLocal) : 100;
  const vScale = activeVideo ? evalClipProp(activeVideo, "scale", vLocal) : 100;
  const vPosX = activeVideo ? evalClipProp(activeVideo, "posX", vLocal) : 0;
  const vPosY = activeVideo ? evalClipProp(activeVideo, "posY", vLocal) : 0;
  const vRot = activeVideo ? evalClipProp(activeVideo, "rotation", vLocal) : 0;

  // Text/title clips visible under the playhead (overlaid on the preview). Solo-aware.
  const anyVideoSolo = project.tracks.some((t) => t.kind === "video" && t.solo);
  const activeTexts = project.clips.filter((c) => {
    const tr = project.tracks.find((t) => t.id === c.trackId);
    return tr != null && !tr.hidden && (!anyVideoSolo || tr.solo) && isTitleClip(c) && (c.text ?? "").trim() !== "" && transport.playhead >= c.start && transport.playhead < c.start + c.duration;
  });

  // Keyboard: Space=play/pause, Del=delete, Ctrl+Z/Shift+Z=undo/redo, Ctrl+C/X/V
  // copy/cut/paste, Ctrl+D duplicate, Ctrl+K/B blade-all at playhead, N snap toggle,
  // arrows nudge the selected clip (or step the playhead when nothing is selected).
  useEffect(() => {
    const selectedIds = () => {
      const tr = timelineStore.getSnapshot().transport;
      return tr.selectedClipIds?.length ? tr.selectedClipIds : (tr.selectedClipId ? [tr.selectedClipId] : []);
    };
    // Run a remappable action. Returns true when it actually did something (so
    // the caller only swallows the key when the shortcut had an effect).
    const runAction = (action: HotkeyActionId): boolean => {
      const snap = timelineStore.getSnapshot();
      const ids = selectedIds();
      switch (action) {
        case "playPause": timelineStore.setPlaying(!snap.transport.isPlaying); return true;
        case "selectAll": timelineStore.selectClips(snap.project.clips.map((c) => c.id)); return true;
        case "delete": {
          if (!ids.length) return false;
          // Magnetic ripple mode makes a plain delete close the gap too.
          for (const id of ids) { if (rippleEnabled) timelineStore.rippleDelete(id); else timelineStore.removeClip(id); }
          return true;
        }
        case "rippleDelete": {
          if (!ids.length) return false;
          for (const id of ids) timelineStore.rippleDelete(id);
          return true;
        }
        case "undo": timelineStore.undo(); return true;
        case "redo": timelineStore.redo(); return true;
        case "copy": if (!ids.length) return false; timelineStore.copyClips(ids); return true;
        case "cut": if (!ids.length) return false; timelineStore.cutClips(ids); return true;
        case "paste": if (!timelineStore.hasClipboard()) return false; timelineStore.pasteClips(snap.transport.playhead); return true;
        case "duplicate": if (!ids.length) return false; timelineStore.duplicateClips(ids); return true;
        case "bladeAll": timelineStore.bladeAllAtPlayhead(snap.transport.playhead); return true;
        case "toggleSnap": setSnapEnabled((s) => !s); return true;
        case "addMarker": timelineStore.addMarker(snap.transport.playhead); return true;
        case "prevMarker": timelineStore.jumpToMarker("prev"); return true;
        case "nextMarker": timelineStore.jumpToMarker("next"); return true;
      }
      return false;
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing) return;

      // Remappable shortcuts take priority (consult the live binding map).
      const action = matchAction(e, hotkeysRef.current);
      if (action) {
        if (runAction(action)) e.preventDefault();
        return;
      }

      // ── Fixed aliases + navigation (not remappable) ──
      if (e.key === "Backspace") {
        // Backspace mirrors the Delete shortcut regardless of remap.
        const ids = selectedIds();
        if (ids.length) {
          e.preventDefault();
          for (const id of ids) { if (rippleEnabled) timelineStore.rippleDelete(id); else timelineStore.removeClip(id); }
        }
      } else if (e.ctrlKey && (e.key === "k" || e.key === "K")) {
        // Ctrl+K ("add edit"): a fixed alias for Blade at playhead.
        e.preventDefault();
        timelineStore.bladeAllAtPlayhead(timelineStore.getSnapshot().transport.playhead);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Left / Right: nudge the selected clip(s) by one frame (Shift = one second);
        // with nothing selected, step the playhead instead.
        e.preventDefault();
        const snap = timelineStore.getSnapshot();
        const frame = 1 / (snap.project.fps || 30);
        const step = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : frame);
        const ids = selectedIds();
        if (ids.length) {
          timelineStore.nudgeClips(ids, step);
        } else {
          timelineStore.setPlaying(false);
          timelineStore.setPlayhead(snap.transport.playhead + step);
        }
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // Up / Down: jump to the previous / next edit point (clip boundary).
        e.preventDefault();
        const snap = timelineStore.getSnapshot();
        const cur = snap.transport.playhead;
        const bounds = new Set<number>([0]);
        for (const c of snap.project.clips) {
          bounds.add(Number(c.start.toFixed(4)));
          bounds.add(Number((c.start + c.duration).toFixed(4)));
        }
        const sorted = [...bounds].sort((a, b) => a - b);
        const eps = 1e-3;
        timelineStore.setPlaying(false);
        if (e.key === "ArrowDown") {
          const next = sorted.find((b) => b > cur + eps);
          if (next !== undefined) timelineStore.setPlayhead(next);
        } else {
          const prev = [...sorted].reverse().find((b) => b < cur - eps);
          timelineStore.setPlayhead(prev ?? 0);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rippleEnabled]);

  // Marquee drag: track the box while the pointer is down on empty lane space,
  // then select every clip whose rectangle intersects it (Shift/Ctrl = add to
  // the current selection). Clips stop propagation on pointer-down, so a drag
  // that reaches the lanes container is guaranteed to have begun on empty space.
  const startMarquee = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (!(e.target as HTMLElement).closest("[data-track-id]")) return; // ignore the label column
    marqueeStart.current = { x: e.clientX, y: e.clientY, additive: e.shiftKey || e.ctrlKey || e.metaKey };
    marqueeActive.current = false;
    marqueeClient.current = null;
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const s = marqueeStart.current;
      if (!s) return;
      if (!marqueeActive.current && Math.abs(e.clientX - s.x) + Math.abs(e.clientY - s.y) < 4) return;
      marqueeActive.current = true;
      const cont = lanesRef.current;
      if (!cont) return;
      const r = cont.getBoundingClientRect();
      const x0 = Math.min(s.x, e.clientX), x1 = Math.max(s.x, e.clientX);
      const y0 = Math.min(s.y, e.clientY), y1 = Math.max(s.y, e.clientY);
      marqueeClient.current = { x0, y0, x1, y1 };
      setMarquee({ left: x0 - r.left, top: y0 - r.top, width: x1 - x0, height: y1 - y0 });
    };
    const onUp = () => {
      const s = marqueeStart.current;
      const box = marqueeClient.current;
      const wasActive = marqueeActive.current;
      marqueeStart.current = null;
      marqueeActive.current = false;
      marqueeClient.current = null;
      setMarquee(null);
      if (!s || !wasActive || !box) return;
      const cont = lanesRef.current;
      if (!cont) return;
      const hits: string[] = [];
      cont.querySelectorAll<HTMLElement>("[data-clip-id]").forEach((el) => {
        const cr = el.getBoundingClientRect();
        if (!(cr.right < box.x0 || cr.left > box.x1 || cr.bottom < box.y0 || cr.top > box.y1)) {
          const id = el.getAttribute("data-clip-id");
          if (id) hits.push(id);
        }
      });
      const base = s.additive ? (timelineStore.getSnapshot().transport.selectedClipIds ?? []) : [];
      timelineStore.selectClips(Array.from(new Set([...base, ...hits])));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);

  // Drag move/trim listeners (live updates without flooding undo history).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dSec = (e.clientX - d.startX) / transport.pxPerSecond;
      const o = d.orig;
      const min = 0.1;
      const spd = o.speed && o.speed > 0 ? o.speed : 1;

      // ── SLIP (body drag): shift the source in/out window; keep position + length. ──
      if (d.tool === "slip" && d.mode === "move") {
        const span = o.duration * spd;
        const maxIn = Number.isFinite(d.assetDur) ? Math.max(0, d.assetDur - span) : Infinity;
        const newIn = Math.min(maxIn, Math.max(0, o.trimIn + dSec * spd));
        timelineStore.setClip(d.id, { trimIn: newIn, trimOut: newIn + span });
        for (const p of d.partners) {
          const psp = p.orig.speed && p.orig.speed > 0 ? p.orig.speed : 1;
          const pSpan = p.orig.duration * psp;
          const pIn = Math.max(0, p.orig.trimIn + dSec * psp);
          timelineStore.setClip(p.id, { trimIn: pIn, trimOut: pIn + pSpan });
        }
        return;
      }

      // ── SLIDE (body drag): move the clip; the previous/next clips absorb the move. ──
      if (d.tool === "slide" && d.mode === "move") {
        const lo = d.prev ? d.prev.orig.start + min : 0;
        const hi = d.next ? d.next.orig.start + d.next.orig.duration - o.duration - min : Infinity;
        let newStart = o.start + dSec;
        newStart = Math.max(lo, newStart);
        if (Number.isFinite(hi)) newStart = Math.min(hi, newStart);
        newStart = Math.max(0, newStart);
        const delta = newStart - o.start;
        timelineStore.setClip(d.id, { start: newStart });
        if (d.prev) {
          const psp = d.prev.orig.speed && d.prev.orig.speed > 0 ? d.prev.orig.speed : 1;
          const nd = Math.max(min, d.prev.orig.duration + delta);
          let tOut = d.prev.orig.trimIn + nd * psp;
          if (Number.isFinite(d.prev.assetDur) && tOut > d.prev.assetDur) tOut = d.prev.assetDur;
          timelineStore.setClip(d.prev.orig.id, { duration: nd, trimOut: tOut });
        }
        if (d.next) {
          const nsp = d.next.orig.speed && d.next.orig.speed > 0 ? d.next.orig.speed : 1;
          const nd = Math.max(min, d.next.orig.duration - delta);
          const tIn = Math.max(0, d.next.orig.trimIn + delta * nsp);
          timelineStore.setClip(d.next.orig.id, { start: newStart + o.duration, duration: nd, trimIn: tIn });
        }
        return;
      }

      // ── ROLL (edge drag): move the cut between this clip and its neighbour; total length fixed. ──
      if (d.tool === "roll" && d.mode !== "move") {
        if (d.mode === "trim-r" && d.next) {
          const nsp = d.next.orig.speed && d.next.orig.speed > 0 ? d.next.orig.speed : 1;
          let delta = Math.max(-(o.duration - min), Math.min(d.next.orig.duration - min, dSec));
          let thisOut = o.trimIn + (o.duration + delta) * spd;
          if (Number.isFinite(d.assetDur) && thisOut > d.assetDur) { thisOut = d.assetDur; delta = (thisOut - o.trimIn) / spd - o.duration; }
          let nextIn = d.next.orig.trimIn + delta * nsp;
          if (nextIn < 0) { delta = -d.next.orig.trimIn / nsp; nextIn = 0; thisOut = o.trimIn + (o.duration + delta) * spd; }
          timelineStore.setClip(d.id, { duration: o.duration + delta, trimOut: thisOut });
          timelineStore.setClip(d.next.orig.id, { start: o.start + o.duration + delta, duration: d.next.orig.duration - delta, trimIn: nextIn });
          return;
        }
        if (d.mode === "trim-l" && d.prev) {
          const psp = d.prev.orig.speed && d.prev.orig.speed > 0 ? d.prev.orig.speed : 1;
          let delta = Math.max(-(d.prev.orig.duration - min), Math.min(o.duration - min, dSec));
          let thisIn = o.trimIn + delta * spd;
          if (thisIn < 0) { delta = -o.trimIn / spd; thisIn = 0; }
          let prevOut = d.prev.orig.trimIn + (d.prev.orig.duration + delta) * psp;
          if (Number.isFinite(d.prev.assetDur) && prevOut > d.prev.assetDur) { prevOut = d.prev.assetDur; delta = (prevOut - d.prev.orig.trimIn) / psp - d.prev.orig.duration; thisIn = o.trimIn + delta * spd; }
          timelineStore.setClip(d.prev.orig.id, { duration: d.prev.orig.duration + delta, trimOut: prevOut });
          timelineStore.setClip(d.id, { start: o.start + delta, duration: o.duration - delta, trimIn: thisIn });
          return;
        }
        // No neighbour on that side → fall through to a normal trim.
      }

      // ── RIPPLE (edge drag): move this edge; slide everything after it to close the gap. ──
      if (d.tool === "ripple" && d.mode !== "move") {
        if (d.mode === "trim-r") {
          let newDur = Math.max(min, o.duration + dSec);
          let newOut = o.trimIn + newDur * spd;
          if (Number.isFinite(d.assetDur) && newOut > d.assetDur) { newOut = d.assetDur; newDur = Math.max(min, (newOut - o.trimIn) / spd); }
          const delta = newDur - o.duration;
          timelineStore.setClip(d.id, { duration: newDur, trimOut: newOut });
          for (const a of d.after) timelineStore.setClip(a.id, { start: Math.max(0, a.start + delta) });
          return;
        }
        // trim-l ripple: trim the head (start anchored), then slide the rest to follow.
        let newIn = o.trimIn + dSec * spd;
        if (newIn < 0) newIn = 0;
        const maxIn = Number.isFinite(d.assetDur) ? d.assetDur - min * spd : Infinity;
        if (Number.isFinite(maxIn) && newIn > maxIn) newIn = maxIn;
        const actual = (newIn - o.trimIn) / spd;
        const newDur = Math.max(min, o.duration - actual);
        timelineStore.setClip(d.id, { trimIn: newIn, duration: newDur });
        const delta = newDur - o.duration;
        for (const a of d.after) timelineStore.setClip(a.id, { start: Math.max(0, a.start + delta) });
        return;
      }

      if (d.mode === "move") {
        const ns = snap(Math.max(0, o.start + dSec), d.id);
        const delta = ns - o.start;
        // Vertical track reassignment: find the lane under the pointer and, if it
        // is the same kind as the clip's original track, move the clip there.
        const tracks = timelineStore.getSnapshot().project.tracks;
        const origTrack = tracks.find((t) => t.id === o.trackId);
        const laneEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest("[data-track-id]");
        const targetId = laneEl?.getAttribute("data-track-id") ?? o.trackId;
        const targetTrack = tracks.find((t) => t.id === targetId);
        const newTrackId = targetTrack && origTrack && targetTrack.kind === origTrack.kind ? targetTrack.id : o.trackId;
        timelineStore.setClip(d.id, { start: ns, trackId: newTrackId });
        // Mirror each linked partner: keep time delta AND move it to the track
        // that mirrors the clip's (new) track across the V/A boundary.
        for (const p of d.partners) {
          const patch: Partial<TimelineClip> = { start: Math.max(0, p.orig.start + delta) };
          if (newTrackId !== o.trackId) {
            patch.trackId = mirrorTrackId(tracks, newTrackId) ?? p.orig.trackId;
          } else {
            patch.trackId = p.orig.trackId;
          }
          timelineStore.setClip(p.id, patch);
        }
      } else if (d.mode === "trim-l") {
        // Retimed clips consume `speed` seconds of source per timeline second.
        const sp = o.speed && o.speed > 0 ? o.speed : 1;
        const endTime = o.start + o.duration;
        let newStart = Math.max(0, o.start + dSec);
        let newTrimIn = o.trimIn + (newStart - o.start) * sp;
        if (newTrimIn < 0) { newStart += -newTrimIn / sp; newTrimIn = 0; }
        let newDur = endTime - newStart;
        if (newDur < min) { newDur = min; newStart = endTime - min; newTrimIn = o.trimIn + (newStart - o.start) * sp; }
        timelineStore.setClip(d.id, { start: newStart, trimIn: newTrimIn, duration: newDur });
        // Trim the linked partner(s) in lock-step so an A/V pair stays in sync.
        for (const p of d.partners) {
          const psp = p.orig.speed && p.orig.speed > 0 ? p.orig.speed : 1;
          timelineStore.setClip(p.id, { start: newStart, trimIn: Math.max(0, p.orig.trimIn + (newStart - p.orig.start) * psp), duration: newDur });
        }
      } else {
        const sp = o.speed && o.speed > 0 ? o.speed : 1;
        let newDur = Math.max(min, o.duration + dSec);
        let newTrimOut = o.trimIn + newDur * sp;
        if (Number.isFinite(d.assetDur) && newTrimOut > d.assetDur) { newTrimOut = d.assetDur; newDur = Math.max(min, (newTrimOut - o.trimIn) / sp); }
        timelineStore.setClip(d.id, { duration: newDur, trimOut: newTrimOut });
        for (const p of d.partners) {
          const psp = p.orig.speed && p.orig.speed > 0 ? p.orig.speed : 1;
          timelineStore.setClip(p.id, { duration: newDur, trimOut: p.orig.trimIn + newDur * psp });
        }
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      // A linked clip dragged to a lane with no mirror creates the mirror track.
      if (d.mode === "move" && d.tool === "normal") timelineStore.ensureLinkedMirrors(d.id);
      // Overwrite mode (stacking off): trim/remove overlapped portions on each affected
      // track. Skipped for the advanced tools, ripple/roll/slide already keep the
      // track gap/overlap-consistent, so re-resolving would fight their placement.
      if (d.tool === "normal" && !(timelineStore.getSnapshot().project.allowStacking ?? false)) {
        for (const id of [d.id, ...d.partners.map((p) => p.id)]) timelineStore.resolveTrackOverlaps(id);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [transport.pxPerSecond, snap]);

  // Per-track vertical resize (drag the bottom edge of a track label).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = trackResizeRef.current;
      if (!d) return;
      timelineStore.setTrackHeight(d.id, d.startH + (e.clientY - d.startY));
    };
    const onUp = () => { trackResizeRef.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);

  const startTrackResize = (e: React.PointerEvent, track: TimelineTrack) => {
    e.preventDefault();
    e.stopPropagation();
    trackResizeRef.current = { id: track.id, startY: e.clientY, startH: track.height ?? laneHeight };
  };

  // Effect-preview render cache: while PAUSED on a clip with enabled effects,
  // render one effect-baked frame via ffmpeg (same path as export) and overlay it.
  // CSS-only previews can't reproduce sharpen / glitch / true vignette, so this
  // gives an accurate "what you'll get" still, debounced + cached per frame+effects.
  useEffect(() => {
    const enabledFx = activeVideo?.effects?.filter((e) => e.enabled) ?? [];
    const isVisual = activeVideoAsset?.kind === "video" || activeVideoAsset?.kind === "image";
    if (transport.isPlaying || !activeVideo || !activeVideoAsset || !isVisual || enabledFx.length === 0) {
      setEffectFrame(null);
      setFrameRendering(false);
      return;
    }
    const fps = project.fps || 30;
    const isImage = activeVideoAsset.kind === "image";
    const renderSrc = activeVideoAsset.filePath || activeVideoAsset.src;
    // ffmpeg can't read blob: URLs - only attempt a frame if we have a real path.
    if (renderSrc.startsWith("blob:")) { setEffectFrame(null); setFrameRendering(false); return; }
    const local = isImage ? 0 : activeVideo.trimIn + (transport.playhead - activeVideo.start) * clipSpeed(activeVideo);
    const tq = Math.round(local * fps) / fps; // quantize to a frame boundary
    const key = `${renderSrc}|${tq.toFixed(3)}|${JSON.stringify(enabledFx)}`;
    const cached = frameCacheRef.current.get(key);
    if (cached) { setEffectFrame(cached); setFrameRendering(false); return; }

    let cancelled = false;
    setFrameRendering(true);
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch("/api/timeline-frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ src: renderSrc, t: tq, width: project.width, height: project.height, effects: enabledFx, isImage }),
        });
        if (!res.ok) throw new Error("frame render failed");
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        const cache = frameCacheRef.current;
        cache.set(key, url);
        if (cache.size > 60) {
          const oldest = cache.keys().next().value as string | undefined;
          if (oldest) { const u = cache.get(oldest); if (u) URL.revokeObjectURL(u); cache.delete(oldest); }
        }
        setEffectFrame(url);
      } catch {
        if (!cancelled) setEffectFrame(null);
      } finally {
        if (!cancelled) setFrameRendering(false);
      }
    }, 280);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [transport.isPlaying, transport.playhead, activeVideo, activeVideoAsset, project.fps, project.width, project.height]);

  // Revoke any cached frame object URLs on unmount.
  useEffect(() => {
    const cache = frameCacheRef.current;
    return () => { for (const u of cache.values()) URL.revokeObjectURL(u); cache.clear(); };
  }, []);

  // Playback clock: advance the playhead in real time while playing; stop at the end.
  useEffect(() => {
    if (!transport.isPlaying) return;
    const total = projectDuration(project);
    // Preview quality throttles the visual update rate (helps weak hardware).
    const minInterval = previewQuality === "full" ? 0 : previewQuality === "half" ? 1000 / 30 : 1000 / 15;
    let raf = 0;
    let last = performance.now();
    let lastEmit = 0;
    let local = timelineStore.getSnapshot().transport.playhead;
    const tick = (now: number) => {
      local += (now - last) / 1000;
      last = now;
      if (total > 0 && local >= total) {
        if (timelineStore.getSnapshot().transport.loop) {
          // Loop: wrap back to the start and keep playing.
          local = 0;
          timelineStore.setPlayhead(0);
        } else {
          timelineStore.setPlayhead(total);
          timelineStore.setPlaying(false);
          return;
        }
      }
      if (now - lastEmit >= minInterval) { lastEmit = now; timelineStore.setPlayhead(local); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [transport.isPlaying, project, previewQuality]);

  // Follow the playhead during playback (industry-standard behavior): when it crosses
  // the visible right edge, PAGE the view forward by ~one viewport at the current
  // zoom so the playhead reappears near the left. Also snaps back on a loop wrap.
  useEffect(() => {
    if (!transport.isPlaying) return;
    const el = laneAreaRef.current;
    if (!el) return;
    const coord = transport.playhead * transport.pxPerSecond + TRACK_LABEL_W; // playhead x in content space
    const viewLeft = el.scrollLeft + TRACK_LABEL_W; // lanes begin after the label column
    const viewRight = el.scrollLeft + el.clientWidth;
    if (coord > viewRight || coord < viewLeft) {
      // Page so the playhead lands just inside the left lane edge → a fresh page ahead.
      el.scrollLeft = Math.max(0, coord - TRACK_LABEL_W - 8);
    }
  }, [transport.playhead, transport.isPlaying, transport.pxPerSecond]);

  // Media controller: keep the video preview + per-clip audio in sync with the
  // playhead, whether scrubbing (paused) or playing. Video plays muted (audio
  // tracks provide sound); clips' own embedded audio support comes later.
  useEffect(() => {
    const playing = transport.isPlaying;
    const v = previewRef.current;
    if (v && activeVideo && activeVideoAsset?.kind === "video") {
      if (v.src !== activeVideoAsset.src) v.src = activeVideoAsset.src;
      const vsp = clipSpeed(activeVideo);
      if (v.playbackRate !== vsp) { try { v.playbackRate = vsp; } catch { /* clamped by browser */ } }
      const target = activeVideo.trimIn + (transport.playhead - activeVideo.start) * vsp;
      if (playing) {
        if (v.paused) { try { v.currentTime = Math.max(0, target); } catch { /* not ready */ } void v.play().catch(() => {}); }
        else if (Math.abs(v.currentTime - target) > 0.3 * vsp) { try { v.currentTime = Math.max(0, target); } catch { /* not ready */ } }
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - target) > 0.08) { try { v.currentTime = Math.max(0, target); } catch { /* not ready */ } }
      }
    } else if (v && !v.paused) {
      v.pause();
    }

    const engine = audioEngineRef.current ?? (audioEngineRef.current = new TimelineAudioEngine());
    if (playing) engine.resume();
    const anyAudioSolo = project.tracks.some((t) => t.kind === "audio" && t.solo);
    for (const clip of project.clips) {
      const tr = project.tracks.find((t) => t.id === clip.trackId);
      if (!tr || tr.kind !== "audio") continue;
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (!asset) continue;
      const local = transport.playhead - clip.start;
      const active = local >= 0 && local < clip.duration;
      const audible = active && playing && !tr.muted && (!anyAudioSolo || !!tr.solo);
      if (audible) {
        // Web Audio graph: gain can exceed unity (boost), pan is live. Both keyframe-driven.
        const node = engine.ensure(clip.id, asset.src);
        engine.setParams(clip.id, evalClipGainLinear(clip, local) * fadeMultiplier(clip, local), evalClipProp(clip, "pan", local) / 100);
        const asp = clipSpeed(clip);
        if (node.el.playbackRate !== asp) { try { node.el.playbackRate = asp; } catch { /* clamped by browser */ } }
        const target = clip.trimIn + local * asp;
        if (node.el.paused) { try { node.el.currentTime = Math.max(0, target); } catch { /* not ready */ } void node.el.play().catch(() => {}); }
        else if (Math.abs(node.el.currentTime - target) > 0.3 * asp) { try { node.el.currentTime = Math.max(0, target); } catch { /* not ready */ } }
      } else {
        const node = engine.get(clip.id);
        if (node && !node.el.paused) node.el.pause();
      }
    }

    // Pause + drop graphs whose clip no longer exists (split/delete/undo).
    const liveIds = new Set(project.clips.map((c) => c.id));
    for (const id of engine.ids()) {
      if (!liveIds.has(id)) engine.release(id);
    }
  }, [transport.playhead, transport.isPlaying, activeVideo, activeVideoAsset, project.clips, project.tracks, project.assets]);

  // Pause all media on unmount.
  useEffect(() => {
    const engine = audioEngineRef;
    const video = previewRef.current;
    return () => {
      video?.pause();
      engine.current?.releaseAll();
    };
  }, []);

  // Alt + wheel = zoom toward the cursor.  Ctrl + wheel = scroll the timeline left/right.
  useEffect(() => {
    const el = laneAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.altKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const px = timelineStore.getSnapshot().transport.pxPerSecond;
        const time = (e.clientX - rect.left + el.scrollLeft - TRACK_LABEL_W) / px;
        const newPx = Math.max(8, Math.min(400, Math.round(px * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
        timelineStore.setZoom(newPx);
        requestAnimationFrame(() => { el.scrollLeft = time * newPx + TRACK_LABEL_W - (e.clientX - rect.left); });
        return;
      }
      if (e.ctrlKey) {
        // Horizontal scroll (prevents the browser's Ctrl+wheel page-zoom too).
        e.preventDefault();
        el.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Close the clip + track context menus on any outside click / scroll / Escape.
  useEffect(() => {
    if (!menu && !trackMenu && !laneMenu && !markerMenu) return;
    const close = () => { setMenu(null); setTrackMenu(null); setLaneMenu(null); setMarkerMenu(null); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onEsc);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", onEsc); };
  }, [menu, trackMenu, laneMenu, markerMenu]);

  // Preview pane vertical resize (drag the divider below it).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      setPreviewHeight(Math.max(80, Math.min(640, r.startH + (e.clientY - r.startY))));
    };
    const onUp = () => { resizeRef.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);

  // Media Pool + Keyframe panel vertical resize (drag their bottom dividers).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const m = mediaResizeRef.current;
      if (m) { setMediaPoolHeight(Math.max(96, Math.min(520, m.startH + (e.clientY - m.startY)))); return; }
      const k = keyframeResizeRef.current;
      if (k) setKeyframeHeight(Math.max(96, Math.min(520, k.startH + (e.clientY - k.startY))));
    };
    const onUp = () => { mediaResizeRef.current = null; keyframeResizeRef.current = null; };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, []);

  // Apply one of the basic transitions to a clip (all map onto existing
  // crossfade / fade ramps already honored by preview + export).
  const applyTransition = (id: string, type: TransitionType) => {
    if (type === "cross-dissolve") timelineStore.addCrossDissolve(id, 1);
    else if (type === "fade-in") timelineStore.updateClip(id, { fadeIn: 1 });
    else if (type === "fade-out") timelineStore.updateClip(id, { fadeOut: 1 });
  };

  const nav = timelineStore.getNav();

  return (
    <div className="flex flex-col h-[calc(100vh-9rem)] min-h-[420px] text-foreground">
      {/* ── Controls projected into the shell's "Workflow Controls" dock ──
          Component Control (per-clip), add-menus (Titles / Effects / Transitions),
          and preview/timeline options live here so they never obscure the preview. */}
      <WorkflowControls>
        <div className="flex flex-col gap-3">
          <CollapsibleSection title="Titles" icon={<Type className="w-3.5 h-3.5 text-amber-300" />}>
            <div className="flex flex-col gap-1">
              {TITLE_PRESETS.map((tp) => (
                <button key={tp.type} type="button"
                  title={`Add a ${tp.label.toLowerCase()} title on a video track at the playhead.`}
                  onClick={() => timelineStore.addTextClip(transport.playhead, "Title", 4, tp.type)}
                  className="text-[10px] px-2 py-1 rounded border border-border/60 bg-card/60 hover:bg-foreground/10 text-left">
                  <span className="font-medium">{tp.label}</span>
                  <span className="block text-[8px] text-muted-foreground/70">Adds a title layer at the playhead.</span>
                </button>
              ))}
            </div>
            <p className="pt-1.5 text-[9px] text-muted-foreground/70">A title is a layer on a video track. Edit its text, position and effects in Component Control below.</p>
          </CollapsibleSection>

          <CollapsibleSection title="Adjustment Layer" icon={<Sparkles className="w-3.5 h-3.5 text-rose-300" />}>
            <button type="button"
              title="Add an adjustment layer at the playhead. Its effects apply to every track below it."
              onClick={() => timelineStore.addAdjustmentClip(transport.playhead, 2)}
              className="w-full text-[10px] px-2 py-1 rounded border border-border/60 bg-card/60 hover:bg-foreground/10 text-left">
              <span className="font-medium">Add Adjustment Layer</span>
              <span className="block text-[8px] text-muted-foreground/70">Effects apply to the tracks below. Great for a glitch transition over a cut.</span>
            </button>
            <p className="pt-1.5 text-[9px] text-muted-foreground/70">Seeded with a Glitch effect. Add/remove effects in Component Control; stretch it across a cut to glitch both clips.</p>
          </CollapsibleSection>

          <CollapsibleSection title="Effects" icon={<Sparkles className="w-3.5 h-3.5 text-violet-300" />}>
            {selectedClip && (selectedKind === "video" || selectedKind === "text") ? (
              <div className="grid grid-cols-2 gap-1">
                {EFFECT_ORDER.map((t) => (
                  <button key={t} type="button" onClick={() => timelineStore.addEffect(selectedClip.id, t)}
                    className="text-[10px] px-2 py-1 rounded border border-border/60 bg-card/60 hover:bg-foreground/10 text-left">
                    {EFFECTS[t].label}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[9px] text-muted-foreground/70 px-1">Select a video clip to add an effect. Applied effects are edited in Component Control.</p>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="Transitions" icon={<ChevronRight className="w-3.5 h-3.5 text-sky-300" />}>
            {selectedClip ? (
              <div className="flex flex-col gap-1">
                {TRANSITIONS.map((tr) => (
                  <button key={tr.type} type="button" title={tr.summary}
                    onClick={() => applyTransition(selectedClip.id, tr.type)}
                    className="text-[10px] px-2 py-1 rounded border border-border/60 bg-card/60 hover:bg-foreground/10 text-left">
                    <span className="font-medium">{tr.label}</span>
                    <span className="block text-[8px] text-muted-foreground/70">{tr.summary}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[9px] text-muted-foreground/70 px-1">Select a clip to apply a transition.</p>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="Audio" icon={<Mic className="w-3.5 h-3.5 text-rose-300" />}>
            <div
              draggable
              onDragStart={(e) => { e.dataTransfer.setData(AUDIOGEN_MIME, "1"); e.dataTransfer.effectAllowed = "copy"; }}
              onClick={() => timelineStore.addPendingAudioClip(transport.playhead)}
              title="Drag onto an audio track, or click to add at the playhead. Script the speech (DramaBox) in Component Control, then run it from the AI Processing Queue."
              className="flex items-center gap-2 text-[10px] px-2 py-1.5 rounded border border-rose-500/30 bg-rose-500/5 hover:bg-rose-500/15 cursor-grab active:cursor-grabbing text-left"
            >
              <Sparkles className="w-3.5 h-3.5 text-rose-300 shrink-0" />
              <span className="flex-1">
                <span className="font-medium text-rose-200">Audio Generation</span>
                <span className="block text-[8px] text-muted-foreground/70">Adds a 2s placeholder; script it, then run it from the AI queue.</span>
              </span>
            </div>
            <p className="pt-1.5 text-[9px] text-muted-foreground/70">Drag onto an audio track (or right-click an empty audio lane). Generated speech fills the placeholder, or lands in the Media Pool if it would overlap existing audio.</p>
          </CollapsibleSection>

          {selectedClip && selectedKind ? (
            linkedSelection.map((lc) => {
              const lt = project.tracks.find((t) => t.id === lc.trackId);
              const lk: "video" | "audio" | "text" = isTitleClip(lc) ? "text" : (lt?.kind === "audio" ? "audio" : "video");
              return <ClipInspector key={lc.id} clip={lc} kind={lk} playhead={transport.playhead} assets={project.assets} />;
            })
          ) : (
            <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-3 text-[10px] text-muted-foreground/70">
              Select a clip on the timeline to edit its Component Control.
            </div>
          )}

          <CollapsibleSection title="Shortcuts" icon={<Settings className="w-3.5 h-3.5 text-sky-300" />}>
            <TimelineHotkeysEditor bindings={hotkeys} onChange={updateHotkeys} />
          </CollapsibleSection>

          <CollapsibleSection title="Options" icon={<Settings className="w-3.5 h-3.5 text-muted-foreground" />} defaultOpen>
            <label className="flex items-center justify-between gap-2 py-1 text-[11px]">
              <span className="text-foreground/80">Preview quality</span>
              <select value={previewQuality} onChange={(e) => setPreviewQuality(e.target.value as "full" | "half" | "quarter")}
                className="bg-card border border-border/60 rounded text-[10px] px-1 py-0.5">
                <option value="full">Full</option><option value="half">Half</option><option value="quarter">Quarter</option>
              </select>
            </label>
            <label className="flex items-center justify-between gap-2 py-1 text-[11px] cursor-pointer">
              <span className="text-foreground/80">Allow stacking (overlap clips)</span>
              <input type="checkbox" checked={project.allowStacking ?? false}
                onChange={(e) => timelineStore.setAllowStacking(e.target.checked)} className="accent-violet-500 w-3.5 h-3.5" />
            </label>
            <label className="flex items-center justify-between gap-2 py-1 text-[11px] cursor-pointer">
              <span className="text-foreground/80">Show clip names below</span>
              <input type="checkbox" checked={clipNamesBelow}
                onChange={(e) => setClipNamesBelow(e.target.checked)} className="accent-violet-500 w-3.5 h-3.5" />
            </label>
            {/* Accessibility: program-wide display size (CSS zoom on the app root).
                Shared with Quick Settings so both stay in sync. */}
            <div className="flex items-center justify-between gap-2 py-1 text-[11px]">
              <span className="text-foreground/80">Display size</span>
              <div className="flex items-center gap-1">
                <button type="button" aria-label="Decrease display size" title="Smaller"
                  disabled={uiScale <= UI_SCALE_MIN}
                  onClick={() => setUiScale(uiScale - UI_SCALE_STEP)}
                  className="inline-flex items-center justify-center w-5 h-5 rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors disabled:opacity-30 disabled:pointer-events-none">
                  <ZoomOut className="w-3 h-3" />
                </button>
                <button type="button" title="Reset to 100%"
                  onClick={() => setUiScale(UI_SCALE_DEFAULT)}
                  className="w-10 text-center text-[10px] font-semibold tabular-nums text-foreground hover:text-violet-300 transition-colors">
                  {Math.round(uiScale * 100)}%
                </button>
                <button type="button" aria-label="Increase display size" title="Larger"
                  disabled={uiScale >= UI_SCALE_MAX}
                  onClick={() => setUiScale(uiScale + UI_SCALE_STEP)}
                  className="inline-flex items-center justify-center w-5 h-5 rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors disabled:opacity-30 disabled:pointer-events-none">
                  <ZoomIn className="w-3 h-3" />
                </button>
              </div>
            </div>
            <p className="pt-1 text-[9px] text-muted-foreground/70">
              {project.allowStacking
                ? "Overlaps are allowed and highlighted; use a clip's Bring to Top for video priority."
                : "Dropping/moving a clip over another overwrites the overlapped part (compact editing)."}
            </p>
          </CollapsibleSection>
        </div>
      </WorkflowControls>

      {/* Breadcrumb: shown while editing a nested Combined Clip timeline */}
      {nav.length > 0 && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-fuchsia-500/40 bg-fuchsia-500/10 text-[11px]">
          <Layers className="w-3.5 h-3.5 text-fuchsia-300" />
          <button type="button" onClick={() => { while (timelineStore.getNav().length) timelineStore.exitCombined(); }}
            className="text-fuchsia-200 hover:text-white">Main Timeline</button>
          {nav.map((n, i) => (
            <span key={n.assetId} className="flex items-center gap-1">
              <ChevronRight className="w-3 h-3 text-fuchsia-300/70" />
              <span className={i === nav.length - 1 ? "text-white font-medium" : "text-fuchsia-200"}>{n.name}</span>
            </span>
          ))}
          <button type="button" onClick={() => timelineStore.exitCombined()}
            className="ml-auto shrink-0 px-2 py-0.5 rounded border border-fuchsia-400/50 bg-fuchsia-500/20 text-fuchsia-100 hover:bg-fuchsia-500/30">
            Done editing
          </button>
        </div>
      )}
      {/* Media Pool: paneled, with a Groups ("bins") sidebar */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*,image/*"
        multiple
        className="hidden"
        onChange={(e) => { void handleImport(e.target.files); e.target.value = ""; }}
      />
      <div className="flex shrink-0 border-b border-border/60" style={{ height: mediaPoolHeight }}>
        {/* Groups sidebar */}
        <aside className="w-40 shrink-0 border-r border-border/60 flex flex-col bg-card/30">
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/60">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Groups</span>
            <button type="button" title="Create a new group."
              onClick={() => { const id = timelineStore.addGroup(); setActiveGroupId(id); setEditingGroupId(id); }}
              className="text-muted-foreground hover:text-foreground"><FolderPlus className="w-3.5 h-3.5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {/* Master = all assets */}
            <button type="button" onClick={() => setActiveGroupId(null)}
              onDragOver={(e) => { e.preventDefault(); setDragOverGroup("master"); }}
              onDragLeave={() => setDragOverGroup((g) => (g === "master" ? null : g))}
              onDrop={(e) => moveAssetToGroup(e, null)}
              className={`w-full flex items-center gap-1.5 px-2 py-1 text-[11px] ${
                effectiveGroupId == null ? "bg-violet-500/15 text-violet-200" : "text-foreground/80 hover:bg-foreground/5"
              } ${dragOverGroup === "master" ? "ring-1 ring-inset ring-sky-400/70" : ""}`}>
              <Layers className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1 text-left truncate">Master</span>
              <span className="text-muted-foreground/60 tabular-nums">{poolAssets.length}</span>
            </button>
            {groups.map((g) => (
              <div key={g.id}
                onDragOver={(e) => { e.preventDefault(); setDragOverGroup(g.id); }}
                onDragLeave={() => setDragOverGroup((d) => (d === g.id ? null : d))}
                onDrop={(e) => moveAssetToGroup(e, g.id)}
                className={`group/row flex items-center gap-1.5 px-2 py-1 text-[11px] cursor-pointer ${
                  effectiveGroupId === g.id ? "bg-violet-500/15 text-violet-200" : "text-foreground/80 hover:bg-foreground/5"
                } ${dragOverGroup === g.id ? "ring-1 ring-inset ring-sky-400/70" : ""}`}
                onClick={() => setActiveGroupId(g.id)}>
                <Folder className="w-3.5 h-3.5 shrink-0" />
                {editingGroupId === g.id ? (
                  <input autoFocus defaultValue={g.name}
                    onBlur={(e) => { timelineStore.renameGroup(g.id, e.target.value.trim() || g.name); setEditingGroupId(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setEditingGroupId(null); }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-card border border-border rounded px-1 text-[11px]" />
                ) : (
                  <span className="flex-1 text-left truncate" onDoubleClick={(e) => { e.stopPropagation(); setEditingGroupId(g.id); }}>{g.name}</span>
                )}
                <span className="text-muted-foreground/60 tabular-nums group-hover/row:hidden">{groupCount.get(g.id) ?? 0}</span>
                <button type="button" title="Delete this group."
                  onClick={(e) => { e.stopPropagation(); timelineStore.deleteGroup(g.id); if (activeGroupId === g.id) setActiveGroupId(null); }}
                  className="hidden group-hover/row:inline text-muted-foreground hover:text-rose-300"><X className="w-3 h-3" /></button>
              </div>
            ))}
          </div>
        </aside>

        {/* Main: toolbar + asset grid */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/60 overflow-x-auto">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mr-1">
              {effectiveGroupId == null ? "Master" : groups.find((g) => g.id === effectiveGroupId)?.name}
            </span>
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={importing}
              className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium border border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 disabled:opacity-50"
              title="Import video, audio, or an image.">
              <Upload className="w-3.5 h-3.5" />
              {importing ? "Importing…" : "Import media"}
            </button>
            <button type="button" onClick={() => setShowRelink(true)}
              className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium border border-border/60 bg-card/60 text-muted-foreground hover:bg-foreground/5"
              title="Relink offline media (re-point clips whose source files moved on disk).">
              <FolderOpen className="w-3.5 h-3.5" />
              Relink
            </button>
            <button type="button" onClick={() => refreshThumbnails()}
              className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium border border-border/60 bg-card/60 text-muted-foreground hover:bg-foreground/5"
              title="Refresh previews: re-generate any missing or failed clip thumbnails / posters (e.g. if a decode was interrupted during import).">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh previews
            </button>
            <div className="shrink-0 inline-flex items-stretch rounded-md border border-border/60 overflow-hidden">
              <button type="button" onClick={isRecording ? stopRecording : startRecording}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium ${isRecording ? "bg-rose-500/20 text-rose-300 animate-pulse" : "bg-card/60 text-muted-foreground hover:bg-foreground/5"}`}
                title="Record voice / audio from your microphone.">
                <Mic className="w-3.5 h-3.5" />
                {isRecording ? "Stop recording" : "Record"}
              </button>
              <select value={recordFormat} onChange={(e) => setRecordFormat(e.target.value as "wav" | "mp3")}
                disabled={isRecording}
                className="text-[10px] bg-card/60 border-l border-border/60 px-1 text-muted-foreground hover:bg-foreground/5 disabled:opacity-40 focus:outline-none"
                title="Recording file format: WAV (lossless) or MP3 (smaller).">
                <option value="wav">WAV</option>
                <option value="mp3">MP3</option>
              </select>
            </div>
            {/* Project Save / Open / Settings, right-aligned in the panel header. */}
            <input
              ref={projectInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => { void handleOpenProject(e.target.files); e.target.value = ""; }}
            />
            <div className="ml-auto shrink-0 flex items-center gap-1.5">
              <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" title="Sort the media pool.">
                <ArrowUpDown className="w-3.5 h-3.5" />
                <select
                  value={`${mediaSort.by}:${mediaSort.dir}`}
                  onChange={(e) => { const [by, dir] = e.target.value.split(":") as [MediaSortBy, "asc" | "desc"]; setMediaSort({ by, dir }); }}
                  className="bg-card border border-border/60 rounded text-[10px] px-1 py-0.5">
                  <option value="name:asc">Name (A–Z)</option>
                  <option value="name:desc">Name (Z–A)</option>
                  <option value="type:asc">Type</option>
                  <option value="duration:asc">Duration (shortest)</option>
                  <option value="duration:desc">Duration (longest)</option>
                </select>
              </label>
              <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" title="Change the preview size / layout.">
                <LayoutGrid className="w-3.5 h-3.5" />
                <select value={mediaView} onChange={(e) => setMediaView(e.target.value as MediaView)}
                  className="bg-card border border-border/60 rounded text-[10px] px-1 py-0.5">
                  <option value="xlarge">Extra large icons</option>
                  <option value="large">Large icons</option>
                  <option value="medium">Medium icons</option>
                  <option value="small">Small icons</option>
                  <option value="list">List</option>
                  <option value="details">Details</option>
                  <option value="tiles">Tiles</option>
                </select>
              </label>
              <div className="w-px h-5 bg-border/60 mx-0.5" />
              <button type="button" onClick={() => void handleSaveProject()}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                title="Save timeline project (.veksnaptl.json), independent of the app Save/Load."><Save className="w-4 h-4" /></button>
              <button type="button" onClick={() => projectInputRef.current?.click()}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                title="Open a timeline project."><FolderOpen className="w-4 h-4" /></button>
              <button type="button" onClick={() => setShowProjectSettings(true)}
                className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
                title="Project settings (resolution and frame rate)."><Settings className="w-4 h-4" /></button>
              <button type="button" onClick={() => setShowExportPanel(true)} disabled={exporting || project.clips.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-[11px] font-medium border border-violet-500/50 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25 disabled:opacity-40"
                title="Export the timeline">
                {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {exporting ? `Exporting… ${Math.round(exportProgress?.percent ?? 0)}%` : "Export"}
              </button>
              <button type="button" onClick={() => setShowAudioExportPanel(true)} disabled={exporting || project.clips.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-[11px] font-medium border border-sky-500/50 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25 disabled:opacity-40"
                title="Export just the timeline's audio mixdown as an audio file">
                <Music className="w-4 h-4" /> Export Audio
              </button>
            </div>
          </div>
          <div
            className="relative flex-1 overflow-y-auto p-2 outline-none"
            ref={mediaPoolScrollRef}
            tabIndex={0}
            onPointerDown={startPoolMarquee}
            onKeyDown={(e) => {
              if (e.ctrlKey && (e.key === "a" || e.key === "A")) {
                e.preventDefault(); e.stopPropagation(); selectAllPoolAssets();
              } else if ((e.key === "Delete" || e.key === "Backspace") && selectedAssetIds.size) {
                // Remove selected assets (undoable). Stop the timeline's global
                // Delete handler from also firing on the timeline clips.
                e.preventDefault(); e.stopPropagation();
                timelineStore.removeAssets([...selectedAssetIds]);
                setSelectedAssetIds(new Set());
              }
            }}
          >
            {poolMarquee && (
              <div
                className="absolute z-30 border border-sky-300/80 bg-sky-400/15 rounded-sm pointer-events-none"
                style={{ left: poolMarquee.left, top: poolMarquee.top, width: poolMarquee.width, height: poolMarquee.height }}
              />
            )}
            {sortedAssets.length === 0 ? (
              <span className="text-[10px] text-muted-foreground">
                {poolAssets.length === 0 ? "Import clips, then drag them onto a track." : "This group is empty. Drag assets here from Master."}
              </span>
            ) : (
              <div className={
                mediaView === "list" || mediaView === "details" ? "flex flex-col gap-0.5"
                  : mediaView === "tiles" ? "flex flex-wrap gap-1.5 content-start"
                  : "flex flex-wrap gap-2 content-start"
              }>
                {sortedAssets.map((a) => (
                  <MediaPoolItem key={a.id} asset={a} view={mediaView} highlight={a.id === revealAssetId}
                    selected={selectedAssetIds.has(a.id)}
                    onSelect={(e) => selectAsset(a.id, e)}
                    onRemove={() => removePoolAssets(a.id)}
                    onDragStartAsset={(e, ast) => { e.dataTransfer.setData(ASSET_MIME, ast.id); e.dataTransfer.effectAllowed = "copy"; setDragAsset(ast); }}
                    onDragEndAsset={() => { setDragAsset(null); setDropGhost(null); }} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Media Pool resize handle (also resizes the Groups sidebar height). */}
      <div
        onPointerDown={(e) => { mediaResizeRef.current = { startY: e.clientY, startH: mediaPoolHeight }; }}
        className="h-1.5 cursor-ns-resize bg-border/40 hover:bg-sky-500/50 shrink-0"
        title="Drag to resize the media pool."
      />
      {/* Preview + Inspector */}
      <div className="flex shrink-0 border-b border-border/60" style={{ height: previewHeight }}>
        <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
          <video
            ref={previewRef}
            muted
            playsInline
            className="max-h-full max-w-full"
            style={{
              display: activeVideoAsset?.kind === "video" ? "block" : "none",
              opacity: (vOpacity / 100) * (activeVideo ? fadeMultiplier(activeVideo, vLocal) : 1),
              transform: `translate(${vPosX}px, ${vPosY}px) scale(${vScale / 100}) rotate(${vRot}deg)`,
              filter: effectsCssFilter(activeVideo?.effects) || undefined,
            }}
          />
          {/* Still images render directly (no <video>); same transform/opacity/effects. */}
          {activeVideoAsset?.kind === "image" && activeVideoAsset.src && !effectFrame && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={activeVideoAsset.src}
              alt={activeVideoAsset.name}
              className="max-h-full max-w-full object-contain"
              style={{
                opacity: (vOpacity / 100) * (activeVideo ? fadeMultiplier(activeVideo, vLocal) : 1),
                transform: `translate(${vPosX}px, ${vPosY}px) scale(${vScale / 100}) rotate(${vRot}deg)`,
                filter: effectsCssFilter(activeVideo?.effects) || undefined,
              }}
            />
          )}
          {activeVideoAsset?.kind === "image" && !effectFrame && effectsVignette(activeVideo?.effects) > 0 && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ boxShadow: `inset 0 0 ${Math.round(120 * effectsVignette(activeVideo?.effects))}px ${Math.round(80 * effectsVignette(activeVideo?.effects))}px rgba(0,0,0,0.9)` }}
            />
          )}
          {activeVideoAsset?.kind === "video" && !effectFrame && effectsVignette(activeVideo?.effects) > 0 && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ boxShadow: `inset 0 0 ${Math.round(120 * effectsVignette(activeVideo?.effects))}px ${Math.round(80 * effectsVignette(activeVideo?.effects))}px rgba(0,0,0,0.9)` }}
            />
          )}
          {/* Accurate effect-baked frame (rendered while paused), shown over the source. */}
          {effectFrame && !transport.isPlaying && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={effectFrame}
              alt="effect preview"
              className="absolute inset-0 m-auto max-h-full max-w-full pointer-events-none object-contain"
              style={{
                opacity: (vOpacity / 100) * (activeVideo ? fadeMultiplier(activeVideo, vLocal) : 1),
                transform: `translate(${vPosX}px, ${vPosY}px) scale(${vScale / 100}) rotate(${vRot}deg)`,
              }}
            />
          )}
          {frameRendering && (
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/70 text-[10px] text-amber-200 pointer-events-none">
              <Loader2 className="w-3 h-3 animate-spin" /> Rendering effect preview…
            </div>
          )}
          {activeVideoAsset?.kind !== "video" && activeVideoAsset?.kind !== "image" && activeTexts.length === 0 && (
            <span className="text-[11px] text-muted-foreground flex flex-col items-center gap-1">
              {activeVideoAsset?.kind === "combined" ? (
                <>
                  <Layers className="w-5 h-5 text-fuchsia-300" />
                  Combined clip. Open it in the timeline to view, or export to render.
                </>
              ) : activeVideoAsset ? "Preview for this clip type lands later" : "No clip under the playhead"}
            </span>
          )}
          {activeTexts.map((c) => {
            const preset = c.titlePreset ?? "none";
            const twoLines = TITLE_PRESET_MAP[preset]?.twoLines;
            const p = titleProgress(transport.playhead - c.start, c.duration);
            const fontSize = Math.max(14, previewHeight / 8);
            const l1 = titleLineCss(preset, 1, p);
            const l2 = titleLineCss(preset, 2, p);
            // Apply the title clip's own position/scale/rotation/opacity (Component Control).
            const tl = Math.max(0, Math.min(c.duration, transport.playhead - c.start));
            const tOpacity = evalClipProp(c, "opacity", tl) / 100;
            const tScale = evalClipProp(c, "scale", tl) / 100;
            const tPosX = evalClipProp(c, "posX", tl);
            const tPosY = evalClipProp(c, "posY", tl);
            const tRot = evalClipProp(c, "rotation", tl);
            return (
              <div key={c.id} className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-6 text-center gap-1"
                style={{ transform: `translate(${tPosX}px, ${tPosY}px) scale(${tScale}) rotate(${tRot}deg)`, opacity: tOpacity }}>
                <span className="text-white font-bold leading-tight"
                  style={{ fontSize, textShadow: "0 2px 6px rgba(0,0,0,0.85)", transform: l1.transform, opacity: l1.opacity }}>
                  {c.text}
                </span>
                {twoLines && c.text2 && (
                  <span className="text-white font-bold leading-tight"
                    style={{ fontSize: fontSize * 0.8, textShadow: "0 2px 6px rgba(0,0,0,0.85)", transform: l2.transform, opacity: l2.opacity }}>
                    {c.text2}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {/* Preview resize handle */}
      <div
        onPointerDown={(e) => { resizeRef.current = { startY: e.clientY, startH: previewHeight }; }}
        className="h-1.5 cursor-ns-resize bg-border/40 hover:bg-sky-500/50 shrink-0"
        title="Drag to resize the preview"
      />
      {/* Transport / toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/60">
        <button
          type="button"
          onClick={() => jumpToEdit("prev")}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          title="Go to previous segment"
        >
          <Rewind className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => timelineStore.setPlaying(!transport.isPlaying)}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md bg-violet-500/15 text-violet-300 border border-violet-500/40 hover:bg-violet-500/25"
          title={transport.isPlaying ? "Pause (Space)" : "Play (Space)"}
        >
          {transport.isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>

        <button
          type="button"
          onClick={() => timelineStore.setLoop(!transport.loop)}
          className={`inline-flex items-center justify-center w-8 h-8 rounded-md border ${
            transport.loop
              ? "bg-violet-500/25 text-violet-200 border-violet-500/60"
              : "text-muted-foreground border-transparent hover:text-foreground hover:bg-foreground/5"
          }`}
          title={transport.loop ? "Loop: on" : "Loop: off"}
        >
          <Repeat className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => jumpToEdit("next")}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          title="Go to next segment"
        >
          <FastForward className="w-4 h-4" />
        </button>

        <span className="ml-1 font-mono text-[12px] tabular-nums text-muted-foreground w-24">
          {formatTime(transport.playhead)}
        </span>

        <AudioMeter engineRef={audioEngineRef} playing={transport.isPlaying} />

        <div className="w-px h-5 bg-border/60 mx-1" />

        <button type="button" onClick={timelineStore.undo} disabled={!timelineStore.canUndo()}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-30"
          title="Undo (Ctrl+Z)"><Undo2 className="w-4 h-4" /></button>
        <button type="button" onClick={timelineStore.redo} disabled={!timelineStore.canRedo()}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-30"
          title="Redo (Ctrl+Shift+Z)"><Redo2 className="w-4 h-4" /></button>

        <div className="w-px h-5 bg-border/60 mx-1" />

        <button type="button" disabled={!selectedClip}
          onClick={() => selectedClip && timelineStore.splitClip(selectedClip.id, transport.playhead)}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-30"
          title="Split the selected clip at the playhead."><Scissors className="w-4 h-4" /></button>
        <button type="button"
          onClick={() => timelineStore.bladeAllAtPlayhead(transport.playhead)}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          title="Blade / add edit: split every clip under the playhead on all unlocked tracks (Ctrl+K)."><Scissors className="w-4 h-4" /><span className="text-[8px] font-bold ml-0.5">*</span></button>
        <button type="button" disabled={!selectedClip}
          onClick={() => selectedClip && timelineStore.removeClip(selectedClip.id)}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-30"
          title="Delete clip (Del)"><Trash2 className="w-4 h-4" /></button>

        <div className="w-px h-5 bg-border/60 mx-1" />

        <button type="button"
          onClick={() => setShowKeyframes((s) => !s)}
          className={`inline-flex items-center justify-center w-8 h-8 rounded-md ${showKeyframes ? "text-amber-300 bg-amber-500/15" : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"}`}
          title="Toggle the keyframe editor."><Activity className="w-4 h-4" /></button>

        <div className="w-px h-5 bg-border/60 mx-1" />

        <button type="button" onClick={() => setSnapEnabled((s) => !s)}
          className={`inline-flex items-center justify-center w-8 h-8 rounded-md border ${snapEnabled ? "bg-sky-500/20 text-sky-200 border-sky-500/50" : "text-muted-foreground border-transparent hover:text-foreground hover:bg-foreground/5"}`}
          title={snapEnabled ? "Snapping: on. Clip edges and the playhead pull into alignment while dragging. (N)" : "Snapping: off. Drag freely without alignment. (N)"}><Magnet className="w-4 h-4" /></button>
        <button type="button" onClick={() => setRippleEnabled((s) => !s)}
          className={`inline-flex items-center justify-center w-8 h-8 rounded-md border ${rippleEnabled ? "bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-500/50" : "text-muted-foreground border-transparent hover:text-foreground hover:bg-foreground/5"}`}
          title={rippleEnabled ? "Magnetic ripple: on. Deleting a clip closes the gap on its track." : "Magnetic ripple: off. Deleting a clip leaves a gap (Shift+Delete still ripples)."}><ArrowLeftRight className="w-4 h-4" /></button>

        <div className="w-px h-5 bg-border/60 mx-1" />

        {/* Trim tool: changes how dragging a clip's edges (ripple/roll) or body (slip/slide) behaves. */}
        <div className="flex items-center gap-0.5" title="Trim tool">
          {([
            ["normal", "Std", "Standard: move the clip or trim an edge."],
            ["ripple", "Ripple", "Ripple: drag an edge; every clip after it slides to close the gap."],
            ["roll", "Roll", "Roll: drag the edge between two clips to move the cut (total length unchanged)."],
            ["slip", "Slip", "Slip: drag the clip body to shift its source in/out without moving it."],
            ["slide", "Slide", "Slide: drag the clip body to reposition it; neighbours absorb the change."],
          ] as const).map(([key, label, desc]) => (
            <button key={key} type="button" onClick={() => setTrimTool(key)} title={desc}
              className={`px-1.5 h-7 rounded text-[10px] font-medium border transition-colors ${trimTool === key ? "bg-violet-500/25 text-violet-100 border-violet-500/60" : "text-muted-foreground border-transparent hover:text-foreground hover:bg-foreground/5"}`}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" disabled={!selectedClip}
          onClick={() => {
            if (!selectedClip) return;
            const sel = transport.selectedClipIds ?? [];
            if (selectedClip.linkId) timelineStore.unlinkClip(selectedClip.id);
            else if (sel.length >= 2) timelineStore.linkClips(sel);
            else timelineStore.relinkClip(selectedClip.id);
          }}
          className={`inline-flex items-center justify-center w-8 h-8 rounded-md border disabled:opacity-30 ${selectedClip?.linkId ? "bg-violet-500/20 text-violet-200 border-violet-500/50" : "text-muted-foreground border-transparent hover:text-foreground hover:bg-foreground/5"}`}
          title={selectedClip?.linkId ? "Unlink audio and video so they move independently." : "Link the selected audio and video so they move together."}><LinkIcon className="w-4 h-4" /></button>

        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => timelineStore.addTrack("video")}
            className="inline-flex items-center gap-1 px-2 h-8 rounded-md text-[11px] font-medium border border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
            title="Add a video track"><Plus className="w-3.5 h-3.5" />V</button>
          <button type="button" onClick={() => timelineStore.addTrack("audio")}
            className="inline-flex items-center gap-1 px-2 h-8 rounded-md text-[11px] font-medium border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
            title="Add an audio track"><Plus className="w-3.5 h-3.5" />A</button>
          <div className="w-px h-5 bg-border/60 mx-0.5" />
          <button type="button" onClick={() => setLaneHeight((h) => Math.max(32, h - 12))}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            title="Compress track height"><ChevronsDownUp className="w-4 h-4" /></button>
          <button type="button" onClick={() => setLaneHeight((h) => Math.min(220, h + 12))}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            title="Expand track height"><ChevronsUpDown className="w-4 h-4" /></button>
          <div className="w-px h-5 bg-border/60 mx-0.5" />
          <button type="button" onClick={() => timelineStore.setZoom(transport.pxPerSecond - 16)}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            title="Zoom out"><ZoomOut className="w-4 h-4" /></button>
          <span className="text-[10px] text-muted-foreground w-10 text-center tabular-nums">{transport.pxPerSecond}px/s</span>
          <button type="button" onClick={() => timelineStore.setZoom(transport.pxPerSecond + 16)}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            title="Zoom in"><ZoomIn className="w-4 h-4" /></button>
          <button type="button" onClick={zoomToFit}
            className="inline-flex items-center justify-center px-2 h-8 rounded-md text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            title="Zoom to fit the whole timeline">Fit</button>
          <button type="button" onClick={zoomToSelection} disabled={!selectedClip}
            className="inline-flex items-center justify-center px-2 h-8 rounded-md text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-30"
            title="Zoom to the selected clip(s)">Sel</button>
          <div className="w-px h-5 bg-border/60 mx-0.5" />
          <button type="button" onClick={() => timelineStore.addMarker(transport.playhead)}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-amber-300 hover:bg-amber-500/10"
            title="Add a marker at the playhead (M). Right-click a marker to rename / recolor / delete.">
            <Diamond className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Export progress bar (accurate percent from ffmpeg -progress over SSE) */}
      {exporting && (
        <div className="border-b border-violet-500/30 bg-violet-500/10 px-3 py-2">
          <div className="flex items-center justify-between text-[11px] text-violet-200 mb-1">
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {exportProgress?.phase === "preparing"
                ? "Preparing compound clips…"
                : exportProgress?.phase === "done"
                  ? "Finalizing…"
                  : "Rendering export…"}
              {exportProgress?.encoder && exportProgress.phase !== "preparing" && (
                <span className={`px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wide ${exportProgress.encoder === "gpu" ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40" : "bg-sky-500/20 text-sky-300 border border-sky-500/40"}`}>
                  {exportProgress.encoder === "gpu" ? "GPU" : "CPU"}
                </span>
              )}
            </span>
            <span className="tabular-nums">
              {Math.round(exportProgress?.percent ?? 0)}%
              {exportProgress && exportProgress.percent > 0 && exportProgress.etaSec != null
                ? ` · ~${fmtEta(exportProgress.etaSec)} left` : ""}
              {exportProgress && exportProgress.speed > 0 ? ` · ${exportProgress.speed.toFixed(1)}×` : ""}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-violet-500/15 overflow-hidden">
            <div
              className={`h-full bg-violet-400 rounded-full transition-[width] duration-200 ${exportProgress?.phase === "preparing" ? "animate-pulse" : ""}`}
              style={{ width: `${Math.max(3, Math.round(exportProgress?.percent ?? 0))}%` }}
            />
          </div>
        </div>
      )}

      {/* Export / load error banner + diagnostics */}
      {exportError && (
        <div className="bg-rose-500/15 text-rose-200 border-b border-rose-500/30">
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px]">
            <span className="min-w-0 flex-1 break-words">{exportError}</span>
            <div className="shrink-0 flex items-center gap-2">
              {exportDetail && (
                <button type="button" onClick={() => setShowExportDetail((v) => !v)} className="underline hover:no-underline">
                  {showExportDetail ? "Hide log" : "Show log"}
                </button>
              )}
              <button type="button" onClick={dismissExportError} className="underline hover:no-underline">Dismiss</button>
            </div>
          </div>
          {showExportDetail && exportDetail && (
            <div className="px-3 pb-2">
              {exportLogPath && (
                <div className="flex items-center gap-2 mb-1 text-[10px] text-rose-200/80">
                  <span className="truncate">Full log: {exportLogPath}</span>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(exportDetail)}
                    className="shrink-0 underline hover:no-underline">Copy log</button>
                </div>
              )}
              <pre className="max-h-48 overflow-auto rounded bg-black/50 border border-rose-500/20 p-2 text-[10px] leading-snug text-rose-100/90 whitespace-pre-wrap">
                {exportDetail}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Keyframe editor panel: stays open once toggled on. If nothing is
          selected it shows a prompt rather than vanishing, so the layout is stable.
          Resizable in height via the divider below it. */}
      {showKeyframes && (
        <>
          <div className="shrink-0 overflow-y-auto border-b border-border/60 bg-background/60" style={{ height: keyframeHeight }}>
            {selectedClip && selectedTrack ? (
              <KeyframeEditor clip={selectedClip} kind={selectedKind ?? selectedTrack.kind} pxPerSecond={transport.pxPerSecond} playhead={transport.playhead} />
            ) : (
              <div className="px-3 py-4 text-[11px] text-muted-foreground">Select a clip to edit its keyframes.</div>
            )}
          </div>
          <div
            onPointerDown={(e) => { keyframeResizeRef.current = { startY: e.clientY, startH: keyframeHeight }; }}
            className="h-1.5 cursor-ns-resize bg-border/40 hover:bg-amber-500/50 shrink-0"
            title="Drag to resize the keyframe editor."
          />
        </>
      )}

      {/* Overview minimap: whole-project view + draggable viewport. */}
      <TimelineMinimap project={project} pxPerSecond={transport.pxPerSecond} playhead={transport.playhead} laneAreaRef={laneAreaRef} />

      {/* Ruler + lanes (shared horizontal scroll) */}
      <div className="flex-1 overflow-auto" ref={laneAreaRef}>
        <div style={{ width: contentWidth + TRACK_LABEL_W, minWidth: "100%" }}>
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex h-6 bg-card/80 backdrop-blur border-b border-border/60">
            <div className="sticky left-0 z-10 shrink-0 border-r border-border/60 bg-card/95" style={{ width: TRACK_LABEL_W }} />
            <div className="relative flex-1 cursor-ew-resize" onPointerDown={startScrub}>
              {ticks.map(({ t, major }) => (
                <div
                  key={t}
                  className={`absolute border-l ${major ? "top-0 h-full border-border/50" : "bottom-0 h-2 border-border/30"}`}
                  style={{ left: t * transport.pxPerSecond }}
                >
                  {major && (
                    <span className="absolute top-0.5 left-1 text-[8px] text-muted-foreground/60 tabular-nums">
                      {formatTime(t).replace(/\.\d+$/, "")}
                    </span>
                  )}
                </div>
              ))}
              {/* Markers: click to seek, right-click for rename / recolor / delete. */}
              {(project.markers ?? []).map((m) => (
                <div
                  key={m.id}
                  className="absolute top-0 h-full z-10 -ml-[5px] cursor-pointer group/marker"
                  style={{ left: m.time * transport.pxPerSecond }}
                  title={m.name ? `${m.name}: ${formatTime(m.time)}` : `Marker: ${formatTime(m.time)}`}
                  onPointerDown={(e) => { e.stopPropagation(); timelineStore.setPlayhead(m.time); timelineStore.setPlaying(false); }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMarkerMenu({ x: e.clientX, y: e.clientY, markerId: m.id }); }}
                >
                  <div className="w-[10px] h-[10px] rounded-b-sm rounded-tl-sm rotate-45 shadow" style={{ backgroundColor: m.color ?? "#f59e0b" }} />
                  {m.name && (
                    <span className="absolute top-3 left-2 whitespace-nowrap text-[8px] font-medium px-1 rounded bg-black/50 text-white opacity-0 group-hover/marker:opacity-100 pointer-events-none">{m.name}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Track lanes */}
          <div className="relative" ref={lanesRef} onPointerDown={startMarquee}>
            {marquee && (
              <div
                className="absolute z-40 border border-violet-300/80 bg-violet-400/15 rounded-sm pointer-events-none"
                style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}
              />
            )}
            {orderedTracks.map((track) => {
              const lh = track.height ?? laneHeight;
              return (
              <div key={track.id} className="flex border-b border-border/40" style={{ height: lh }}>
                <div className="sticky left-0 z-30 shrink-0 flex flex-col justify-center px-2 border-r border-border/60 bg-card/95"
                  style={{ width: TRACK_LABEL_W, borderLeft: track.color ? `3px solid ${track.color}` : undefined }}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTrackMenu({ x: e.clientX, y: e.clientY, trackId: track.id }); }}
                  title="Right-click to manage this track (move, delete, or recolor).">
                  <span className={`text-[11px] font-medium flex items-center gap-1 ${track.hidden ? "text-muted-foreground/40 line-through" : "text-muted-foreground"}`}>
                    {track.color && <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: track.color }} />}
                    {track.name}
                  </span>
                  <div className="flex gap-1 mt-0.5">
                    {track.kind === "audio" ? (
                      <>
                        <button type="button" onClick={() => timelineStore.toggleTrackSolo(track.id)} title="Solo"
                          className={`w-4 h-4 rounded text-[8px] font-bold leading-none ${track.solo ? "bg-amber-400 text-black" : "bg-foreground/10 text-muted-foreground hover:bg-foreground/20"}`}>S</button>
                        <button type="button" onClick={() => timelineStore.toggleTrackMuted(track.id)} title="Mute"
                          className={`w-4 h-4 rounded text-[8px] font-bold leading-none ${track.muted ? "bg-rose-500 text-white" : "bg-foreground/10 text-muted-foreground hover:bg-foreground/20"}`}>M</button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => timelineStore.toggleTrackSolo(track.id)} title="Solo (show only soloed video tracks in the preview & export)"
                          className={`w-4 h-4 rounded text-[8px] font-bold leading-none ${track.solo ? "bg-amber-400 text-black" : "bg-foreground/10 text-muted-foreground hover:bg-foreground/20"}`}>S</button>
                        <button type="button" onClick={() => timelineStore.toggleTrackHidden(track.id)}
                          title={track.hidden ? "Show track (include in preview & export)" : "Hide track (exclude from preview & export)"}
                          className={`inline-flex items-center justify-center w-4 h-4 rounded ${track.hidden ? "bg-rose-500/80 text-white" : "bg-foreground/10 text-muted-foreground hover:bg-foreground/20"}`}>
                          {track.hidden ? <EyeOff className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
                        </button>
                      </>
                    )}
                    <button type="button" onClick={() => timelineStore.toggleTrackLock(track.id)}
                      title={track.locked ? "Unlock track (allow edits)" : "Lock track (protect from edits: blade, ripple, snapping)"}
                      className={`inline-flex items-center justify-center w-4 h-4 rounded ${track.locked ? "bg-sky-500/80 text-white" : "bg-foreground/10 text-muted-foreground hover:bg-foreground/20"}`}>
                      {track.locked ? <LockIcon className="w-2.5 h-2.5" /> : <UnlockIcon className="w-2.5 h-2.5" />}
                    </button>
                  </div>
                  {/* Drag the bottom edge to resize this track independently. */}
                  <div
                    onPointerDown={(e) => startTrackResize(e, track)}
                    className="absolute left-0 right-0 -bottom-0.5 h-1.5 hover:bg-violet-400/50 z-20"
                    style={{ cursor: "row-resize" }}
                    title="Drag to resize the track height."
                  />
                </div>
                <div
                  data-track-id={track.id}
                  data-track-kind={track.kind}
                  className="relative flex-1"
                  style={{ width: contentWidth }}
                  onMouseDown={(e) => seekFromEvent(e.clientX)}
                  onContextMenu={track.kind === "audio" ? (e) => {
                    // Right-click on EMPTY audio-lane space (clips stop propagation) →
                    // offer to add an Audio Generation placeholder right there.
                    e.preventDefault(); e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    const time = Math.max(0, (e.clientX - r.left) / transport.pxPerSecond);
                    setLaneMenu({ x: e.clientX, y: e.clientY, trackId: track.id, time });
                  } : undefined}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    if (dragAsset) {
                      const r = e.currentTarget.getBoundingClientRect();
                      const s = Math.max(0, (e.clientX - r.left) / transport.pxPerSecond);
                      // Linked A/V pair ghost (like Adobe/DaVinci): if the dragged asset
                      // has a companion audio (or is the audio of a video), ghost BOTH
                      // target lanes so the user previews where the pair will land.
                      const companionAudio = dragAsset.kind === "video" && dragAsset.linkedAudioAssetId
                        ? project.assets.find((a) => a.id === dragAsset.linkedAudioAssetId) : undefined;
                      const parentVideo = dragAsset.kind === "audio" && dragAsset.fromVideoAssetId
                        ? project.assets.find((a) => a.id === dragAsset.fromVideoAssetId) : undefined;
                      const segs: { trackId: string; start: number; duration: number }[] = [];
                      if (companionAudio || parentVideo) {
                        const vTrack = track.kind === "video" ? track : [...project.tracks].filter((t) => t.kind === "video").sort((a, b) => b.index - a.index)[0];
                        const aTrack = track.kind === "audio" ? track : [...project.tracks].filter((t) => t.kind === "audio").sort((a, b) => a.index - b.index)[0];
                        const vDur = companionAudio ? dragAsset.duration : parentVideo!.duration;
                        const aDur = companionAudio ? companionAudio.duration : dragAsset.duration;
                        if (vTrack) segs.push({ trackId: vTrack.id, start: s, duration: vDur });
                        if (aTrack) segs.push({ trackId: aTrack.id, start: s, duration: aDur });
                      } else {
                        segs.push({ trackId: track.id, start: s, duration: dragAsset.duration });
                      }
                      setDropGhost({ segments: segs });
                    }
                  }}
                  onDragLeave={() => setDropGhost((g) => (g?.segments.some((seg) => seg.trackId === track.id) ? null : g))}
                  onDrop={(e) => handleDrop(e, track)}
                >
                  {dropGhost?.segments.filter((seg) => seg.trackId === track.id).map((seg, gi) => (
                    <div
                      key={gi}
                      className="absolute top-1 bottom-1 rounded-md border border-dashed border-violet-300/80 bg-violet-400/20 pointer-events-none z-10 flex items-center justify-center overflow-hidden"
                      style={{ left: seg.start * transport.pxPerSecond, width: Math.max(2, seg.duration * transport.pxPerSecond) }}
                    >
                      <span className="text-[9px] text-violet-100/90 tabular-nums">{seg.duration.toFixed(1)}s</span>
                    </div>
                  ))}
                  {project.clips
                    .filter((c) => c.trackId === track.id)
                    .map((clip) => {
                      const selIds = transport.selectedClipIds ?? [];
                      const isSel = clip.id === transport.selectedClipId || selIds.includes(clip.id);
                      const isAudio = track.kind === "audio";
                      const isText = isTitleClip(clip);
                      const isAdjustment = isAdjustmentClip(clip);
                      const isPendingGen = isPendingAudioGenClip(clip);
                      const asset = project.assets.find((a) => a.id === clip.assetId);
                      const isCombined = asset?.kind === "combined";
                      // Highlight the other half of a linked A/V pair when one is selected.
                      const isPartner = !isSel && !!clip.linkId && clip.linkId === selectedClip?.linkId;
                      const w = Math.max(2, clip.duration * transport.pxPerSecond);
                      // In stacking mode, mark time-overlap regions with same-kind clips on other tracks.
                      const overlapBands = project.allowStacking
                        ? project.clips
                            .filter((o) => {
                              if (o.id === clip.id || o.trackId === clip.trackId) return false;
                              const ot = project.tracks.find((t) => t.id === o.trackId);
                              return ot?.kind === track.kind && o.start < clip.start + clip.duration && o.start + o.duration > clip.start;
                            })
                            .map((o) => {
                              const s = Math.max(clip.start, o.start);
                              const e2 = Math.min(clip.start + clip.duration, o.start + o.duration);
                              return { key: o.id, left: (s - clip.start) * transport.pxPerSecond, width: Math.max(1, (e2 - s) * transport.pxPerSecond) };
                            })
                        : [];
                      return (
                        <div
                          key={clip.id}
                          data-clip-id={clip.id}
                          onPointerDown={(e) => onClipPointerDown(e, clip, "move")}
                          onMouseDown={(e) => e.stopPropagation()}
                          onContextMenu={(e) => {
                            e.preventDefault(); e.stopPropagation();
                            // Preserve an existing multi-selection if right-clicking inside it.
                            if (!((transport.selectedClipIds ?? []).length > 1 && (transport.selectedClipIds ?? []).includes(clip.id))) {
                              timelineStore.selectClip(clip.id);
                            }
                            setMenu({ x: e.clientX, y: e.clientY, clipId: clip.id });
                          }}
                          className={`group absolute top-1 bottom-1 rounded-md border cursor-grab active:cursor-grabbing overflow-hidden ${
                            isSel ? "border-violet-300 ring-1 ring-violet-300/60"
                              : isPartner ? "border-violet-300/70 ring-1 ring-violet-300/40"
                              : "border-border/60"
                          } ${isPendingGen ? "bg-rose-500/15 border-dashed border-rose-400/70" : isCombined ? "bg-fuchsia-500/25" : isAudio ? "bg-emerald-500/20" : isText ? "bg-amber-500/20" : isAdjustment ? "bg-rose-500/20 border-dashed border-rose-400/60" : "bg-violet-500/20"}`}
                          style={{ left: clip.start * transport.pxPerSecond, width: w, borderColor: track.color && !isSel && !isPartner && !isPendingGen ? track.color : undefined }}
                          title={isPendingGen ? "Audio Generation placeholder. Script it in Component Control, then run it from the AI queue." : (asset?.name ?? clip.text ?? clip.id)}
                        >
                          {isPendingGen && (
                            <div className="absolute inset-0 flex items-center justify-center gap-1 pointer-events-none text-rose-200/90">
                              <Mic className="w-3 h-3 shrink-0" />
                              {w > 70 && <span className="text-[9px] font-medium truncate">Audio Generation</span>}
                              <Sparkles className="w-2.5 h-2.5 shrink-0 text-fuchsia-300" />
                            </div>
                          )}
                          {isAudio && asset?.peaks && asset.peaks.length > 0 && (
                            <div className="absolute inset-0 opacity-80 pointer-events-none">
                              <ClipWaveform peaks={asset.peaks} width={w} height={lh - 8}
                                trimIn={clip.trimIn} duration={clip.duration}
                                srcDuration={asset.duration} speed={clipSpeed(clip)} />
                            </div>
                          )}
                          {!isAudio && !isText && !isCombined && asset?.kind === "video" && asset.filePath && w > 24 && (
                            <ClipFilmstrip filePath={asset.filePath} trimIn={clip.trimIn} duration={clip.duration} width={w} height={lh - 8} srcDuration={asset.duration} />
                          )}
                          {overlapBands.map((b) => (
                            <div key={b.key} className="absolute top-0 bottom-0 bg-amber-400/30 border-x border-amber-300/50 pointer-events-none z-[5]"
                              style={{ left: b.left, width: b.width }} title="Overlap (stacking on)" />
                          ))}
                          {!isPendingGen && (
                            <span className={`absolute left-0 right-0 z-10 px-1.5 py-0.5 text-[9px] truncate text-foreground/90 pointer-events-none ${clipNamesBelow ? "bottom-0 bg-black/40" : "top-0"}`}>
                              {asset?.name ?? (isText ? (clip.text || "Title") : isAdjustment ? "Adjustment" : "clip")}
                            </span>
                          )}
                          {clip.linkId && (
                            <LinkIcon className="absolute top-0.5 right-1.5 w-2.5 h-2.5 text-foreground/50 pointer-events-none" />
                          )}
                          {clip.effects?.some((e) => e.enabled) && (
                            <Sparkles className="absolute bottom-0.5 right-1 w-2.5 h-2.5 text-amber-300 pointer-events-none" />
                          )}
                          {isCombined && (
                            <Layers className="absolute top-0.5 left-1 w-2.5 h-2.5 text-fuchsia-200 pointer-events-none" />
                          )}
                          {!isText && (() => {
                            const h = lh - 8;
                            const fiW = (clip.fadeIn ?? 0) * transport.pxPerSecond;
                            const foW = (clip.fadeOut ?? 0) * transport.pxPerSecond;
                            const cfW = (clip.crossfadeFromPrev ?? 0) * transport.pxPerSecond;
                            return (
                              <>
                                {cfW > 0 && (
                                  <div
                                    className="absolute top-0 bottom-0 left-0 bg-sky-400/25 border-r border-sky-300/60 pointer-events-none"
                                    style={{ width: cfW }}
                                    title="Cross-dissolve"
                                  />
                                )}
                                <svg className="absolute inset-0 w-full h-full pointer-events-none" width={w} height={h} preserveAspectRatio="none">
                                  {fiW > 0 && <polygon points={`0,0 ${fiW},0 0,${h}`} fill="rgba(0,0,0,0.55)" />}
                                  {foW > 0 && <polygon points={`${w},0 ${w - foW},0 ${w},${h}`} fill="rgba(0,0,0,0.55)" />}
                                </svg>
                                <div
                                  onPointerDown={(e) => onFadePointerDown(e, clip, "in")}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="absolute -top-0.5 w-2.5 h-2.5 rounded-full bg-white border border-black/40 cursor-ew-resize opacity-0 group-hover:opacity-100 z-20"
                                  style={{ left: Math.max(0, fiW - 5) }}
                                  title="Drag to set the fade-in."
                                />
                                <div
                                  onPointerDown={(e) => onFadePointerDown(e, clip, "out")}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  className="absolute -top-0.5 w-2.5 h-2.5 rounded-full bg-white border border-black/40 cursor-ew-resize opacity-0 group-hover:opacity-100 z-20"
                                  style={{ left: Math.max(0, w - foW - 5) }}
                                  title="Drag to set the fade-out."
                                />
                              </>
                            );
                          })()}
                          <div
                            onPointerDown={(e) => onClipPointerDown(e, clip, "trim-l")}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/40 z-10"
                          />
                          <div
                            onPointerDown={(e) => onClipPointerDown(e, clip, "trim-r")}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/40 z-10"
                          />
                        </div>
                      );
                    })}
                </div>
              </div>
              );
            })}

            {/* Playhead (spans the lane stack, offset past the labels). The line is
                click-through, but a grab strip + head let you drag it to scrub. */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-rose-400/80 z-20"
              style={{ left: TRACK_LABEL_W + transport.playhead * transport.pxPerSecond }}
            >
              <div
                onPointerDown={(e) => { e.stopPropagation(); startScrub(e); }}
                className="pointer-events-auto absolute top-0 bottom-0 -left-[5px] w-[11px] cursor-ew-resize z-10"
                title="Drag to scrub through the timeline."
              />
              <div
                onPointerDown={(e) => { e.stopPropagation(); startScrub(e); }}
                className="pointer-events-auto absolute -top-0.5 -left-[5px] w-[11px] h-[11px] rotate-45 bg-rose-400 cursor-ew-resize"
                title="Drag to scrub through the timeline."
              />
            </div>
          </div>
        </div>
      </div>

      {/* Empty-state hint */}
      {project.clips.length === 0 && (
        <div className="px-3 py-2 text-[11px] text-muted-foreground border-t border-border/60">
          Import media above, then drag a clip onto a track. Right-click a clip for options.
          Space = play/pause, Del = delete, Alt+wheel = zoom, Ctrl+wheel = scroll, Ctrl+Z / Ctrl+Shift+Z = undo / redo.
        </div>
      )}

      {/* Clip context menu */}
      {menu && (() => {
        const mc = project.clips.find((c) => c.id === menu.clipId);
        if (!mc) return null;
        const mcAsset = project.assets.find((a) => a.id === mc.assetId);
        const mcCombined = mcAsset?.kind === "combined";
        const mcTrack = project.tracks.find((t) => t.id === mc.trackId);
        const canLink = mcTrack?.kind === "video" || mcTrack?.kind === "audio";
        const multi = (transport.selectedClipIds ?? []).filter((id) => id !== menu.clipId).length > 0
          ? transport.selectedClipIds ?? []
          : [];
        return (
          <ContextMenu x={menu.x} y={menu.y}
            className="fixed z-50 min-w-[190px] rounded-md border border-border/60 bg-card shadow-xl py-1 text-[12px]"
          >
            {(mcAsset?.kind === "image" || mcAsset?.kind === "audio") && (
              <AIToolsMenu
                kind={mcAsset.kind}
                clipId={menu.clipId}
                assetId={mcAsset.id}
                sourcePath={mcAsset.filePath}
                sourceSrc={mcAsset.src}
                sourceName={mcAsset.name}
                onPicked={() => setMenu(null)}
              />
            )}
            {multi.length > 1 && (
              <>
                <button className={MENU_ITEM} onClick={() => { timelineStore.combineClips(multi); setMenu(null); }}>Combine clips ({multi.length})</button>
                <div className="my-1 h-px bg-border/60" />
              </>
            )}
            {mcCombined && mcAsset && (
              <>
                <button className={MENU_ITEM} onClick={() => { timelineStore.enterCombined(mcAsset.id); setMenu(null); }}>Open in Timeline</button>
                <button className={MENU_ITEM} onClick={() => { const n = window.prompt("Rename combined clip", mcAsset.name); if (n) timelineStore.renameAsset(mcAsset.id, n); setMenu(null); }}>Rename combined clip…</button>
                <div className="my-1 h-px bg-border/60" />
              </>
            )}
            <button className={MENU_ITEM} onClick={() => { timelineStore.splitClip(menu.clipId, transport.playhead); setMenu(null); }}>Split at playhead</button>
            <div className="my-1 h-px bg-border/60" />
            {(() => {
              const ids = (transport.selectedClipIds ?? []).length > 1 && (transport.selectedClipIds ?? []).includes(menu.clipId)
                ? (transport.selectedClipIds ?? [])
                : [menu.clipId];
              return (
                <>
                  <button className={`${MENU_ITEM} inline-flex items-center gap-2`} onClick={() => { timelineStore.copyClips(ids); setMenu(null); }}><CopyIcon className="w-3.5 h-3.5" /> Copy <span className="ml-auto text-[10px] text-muted-foreground">Ctrl+C</span></button>
                  <button className={`${MENU_ITEM} inline-flex items-center gap-2`} onClick={() => { timelineStore.cutClips(ids); setMenu(null); }}><Scissors className="w-3.5 h-3.5" /> Cut <span className="ml-auto text-[10px] text-muted-foreground">Ctrl+X</span></button>
                  <button className={`${MENU_ITEM} inline-flex items-center gap-2`} onClick={() => { timelineStore.duplicateClips(ids); setMenu(null); }}><CopyIcon className="w-3.5 h-3.5" /> Duplicate <span className="ml-auto text-[10px] text-muted-foreground">Ctrl+D</span></button>
                  <button className={`${MENU_ITEM} inline-flex items-center gap-2`} disabled={!timelineStore.hasClipboard()} onClick={() => { timelineStore.pasteClips(transport.playhead); setMenu(null); }}><ClipboardPaste className="w-3.5 h-3.5" /> Paste at playhead <span className="ml-auto text-[10px] text-muted-foreground">Ctrl+V</span></button>
                  <button className={`${MENU_ITEM} inline-flex items-center gap-2`} onClick={() => { timelineStore.rippleDelete(menu.clipId); setMenu(null); }}><ArrowLeftRight className="w-3.5 h-3.5" /> Ripple delete (close gap) <span className="ml-auto text-[10px] text-muted-foreground">Shift+Del</span></button>
                </>
              );
            })()}
            {mcAsset && (
              <>
                <div className="my-1 h-px bg-border/60" />
                <button className={`${MENU_ITEM} inline-flex items-center gap-2`} onClick={() => { revealInPool(mcAsset.id); setMenu(null); }}><FolderOpen className="w-3.5 h-3.5" /> Reveal in Media Pool</button>
                {(() => {
                  // Replace source: swap the clip's asset but keep its edits. Offer
                  // compatible pool assets (visual for video tracks, audio for audio).
                  const wantAudio = mcTrack?.kind === "audio";
                  const options = poolAssets.filter((a) => a.id !== mcAsset.id && (wantAudio ? a.kind === "audio" : a.kind !== "audio"));
                  if (options.length === 0) return null;
                  return (
                    <>
                      <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Replace source (keep edits)</div>
                      <div className="max-h-40 overflow-y-auto">
                        {options.map((a) => (
                          <button key={a.id} className={`${MENU_ITEM} inline-flex items-center gap-2 w-full`}
                            onClick={() => { timelineStore.replaceClipSource(menu.clipId, a.id); setMenu(null); }}>
                            <span className="flex-1 min-w-0 truncate">{a.name}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">{a.duration.toFixed(1)}s</span>
                          </button>
                        ))}
                      </div>
                    </>
                  );
                })()}
              </>
            )}
            <div className="my-1 h-px bg-border/60" />
            {mc.crossfadeFromPrev ? (
              <button className={MENU_ITEM} onClick={() => { timelineStore.removeTransition(menu.clipId); setMenu(null); }}>Remove cross-dissolve</button>
            ) : (
              <button className={MENU_ITEM} onClick={() => { timelineStore.addCrossDissolve(menu.clipId, 1); setMenu(null); }}>Cross-dissolve from previous (1s)</button>
            )}
            {mcTrack?.kind === "video" && (
              <>
                <div className="my-1 h-px bg-border/60" />
                <button className={MENU_ITEM} onClick={() => { timelineStore.bringClipToTop(menu.clipId); setMenu(null); }}>Bring to Top</button>
              </>
            )}
            <div className="my-1 h-px bg-border/60" />
            <button className={MENU_ITEM} onClick={() => { timelineStore.removeClip(menu.clipId); setMenu(null); }}>Delete</button>
            <button className={MENU_ITEM} onClick={() => { timelineStore.rippleDelete(menu.clipId); setMenu(null); }}>Ripple delete (close gap)</button>
            {canLink && (
              <>
                <div className="my-1 h-px bg-border/60" />
                <button
                  className={`${MENU_ITEM} flex items-center gap-2`}
                  title="Linked audio & video move together; uncheck to move them independently"
                  onClick={() => {
                    const sel = transport.selectedClipIds ?? [];
                    if (mc.linkId) timelineStore.unlinkClip(menu.clipId);
                    else if (sel.length >= 2) timelineStore.linkClips(sel);
                    else timelineStore.relinkClip(menu.clipId);
                    setMenu(null);
                  }}
                >
                  <Check className={`w-3.5 h-3.5 ${mc.linkId ? "opacity-100 text-violet-300" : "opacity-0"}`} />
                  Link
                </button>
              </>
            )}
          </ContextMenu>
        );
      })()}

      {/* Empty audio-lane context menu, add an Audio Generation placeholder here */}
      {laneMenu && (
        <ContextMenu x={laneMenu.x} y={laneMenu.y}
          className="fixed z-50 min-w-[200px] rounded-md border border-border/60 bg-card shadow-xl py-1 text-[12px]"
        >
          <button className={`${MENU_ITEM} inline-flex items-center gap-2`}
            onClick={() => { timelineStore.addPendingAudioClip(laneMenu.time, laneMenu.trackId); setLaneMenu(null); }}>
            <Sparkles className="w-3.5 h-3.5 text-rose-300" /> Add Audio Generation here
          </button>
        </ContextMenu>
      )}

      {/* Marker context menu: rename / recolor / delete */}
      {markerMenu && (() => {
        const mk = (project.markers ?? []).find((m) => m.id === markerMenu.markerId);
        if (!mk) return null;
        return (
          <ContextMenu x={markerMenu.x} y={markerMenu.y}
            className="fixed z-50 min-w-[180px] rounded-md border border-border/60 bg-card shadow-xl py-1 text-[12px]"
          >
            <button className={MENU_ITEM} onClick={() => { const n = window.prompt("Marker name", mk.name ?? ""); if (n !== null) timelineStore.updateMarker(mk.id, { name: n }); setMarkerMenu(null); }}>Rename marker…</button>
            <div className="px-3 py-1.5 flex items-center gap-1.5">
              {MARKER_COLORS.map((c) => (
                <button key={c} type="button" title={c}
                  onClick={() => { timelineStore.updateMarker(mk.id, { color: c }); setMarkerMenu(null); }}
                  className={`w-4 h-4 rounded-full border ${mk.color === c ? "border-foreground" : "border-transparent"}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
            <div className="my-1 h-px bg-border/60" />
            <button className={MENU_ITEM} onClick={() => { timelineStore.removeMarker(mk.id); setMarkerMenu(null); }}>Delete marker</button>
            <button className={MENU_ITEM} onClick={() => { timelineStore.clearMarkers(); setMarkerMenu(null); }}>Delete all markers</button>
          </ContextMenu>
        );
      })()}

      {/* Track (row) context menu, industry-standard track management */}
      {trackMenu && (() => {
        const tk = project.tracks.find((t) => t.id === trackMenu.trackId);
        if (!tk) return null;
        return (
          <ContextMenu x={trackMenu.x} y={trackMenu.y}
            className="fixed z-50 min-w-[190px] rounded-md border border-border/60 bg-card shadow-xl py-1 text-[12px]"
          >
            <button className={MENU_ITEM} onClick={() => { timelineStore.addTrack("video"); setTrackMenu(null); }}>Add Video Track</button>
            <button className={MENU_ITEM} onClick={() => { timelineStore.addTrack("audio"); setTrackMenu(null); }}>Add Audio Track</button>
            <div className="my-1 h-px bg-border/60" />
            <button className={`${MENU_ITEM} inline-flex items-center gap-2`} onClick={() => { timelineStore.moveTrack(trackMenu.trackId, "up"); setTrackMenu(null); }}><ArrowUp className="w-3.5 h-3.5" />Move Track Up</button>
            <button className={`${MENU_ITEM} inline-flex items-center gap-2`} onClick={() => { timelineStore.moveTrack(trackMenu.trackId, "down"); setTrackMenu(null); }}><ArrowDown className="w-3.5 h-3.5" />Move Track Down</button>
            <div className="my-1 h-px bg-border/60" />
            <button className={MENU_ITEM} onClick={() => { timelineStore.removeTrack(trackMenu.trackId); setTrackMenu(null); }}>Delete Track</button>
            <button className={MENU_ITEM} onClick={() => { timelineStore.deleteEmptyTracks(); setTrackMenu(null); }}>Delete Empty Tracks</button>
            <div className="my-1 h-px bg-border/60" />
            <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Track Height</div>
            <div className="px-3 pb-1.5 flex items-center gap-1">
              {([["S", 40], ["M", 72], ["L", 120], ["XL", 180]] as const).map(([lbl, h]) => (
                <button key={lbl} type="button"
                  onClick={() => { timelineStore.setTrackHeight(trackMenu.trackId, h); setTrackMenu(null); }}
                  className={`flex-1 px-1.5 py-1 rounded text-[11px] border ${((tk.height ?? DEFAULT_LAYOUT.laneHeight) === h) ? "border-violet-400 bg-violet-500/15 text-violet-100" : "border-border/60 hover:bg-foreground/10"}`}
                  title={`Set this track's height to ${h}px`}>{lbl}</button>
              ))}
            </div>
            <div className="my-1 h-px bg-border/60" />
            <div className="px-3 py-1 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground"><Palette className="w-3 h-3" />Change Track Color</div>
            <TrackColorMenu current={tk.color}
              onPick={(hex) => timelineStore.setTrackColor(trackMenu.trackId, hex)}
              onClear={() => timelineStore.setTrackColor(trackMenu.trackId, undefined)} />
            <div className="my-1 h-px bg-border/60" />
            <button className={`${MENU_ITEM} flex items-center gap-2`} title="Show each clip's name below it (default: inside)"
              onClick={() => { setClipNamesBelow((v) => !v); setTrackMenu(null); }}>
              <Check className={`w-3.5 h-3.5 ${clipNamesBelow ? "opacity-100 text-violet-300" : "opacity-0"}`} />
              Show clip names below
            </button>
          </ContextMenu>
        );
      })()}

      {/* Project settings */}
      {showProjectSettings && (
        <ProjectSettingsModal project={project} onClose={() => setShowProjectSettings(false)} onResetLayout={resetLayout} />
      )}

      {/* Import: offer to match the project format to the imported clip */}
      {importPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setImportPrompt(null)}>
          <div className="w-[440px] rounded-lg border border-border/60 bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-2.5 border-b border-border/60 text-[13px] font-semibold">Match project to imported clip?</div>
            <div className="p-4 text-[12px] text-foreground/80 space-y-2">
              <p><span className="font-medium text-foreground">{importPrompt.name}</span> is
                <span className="font-medium text-foreground"> {importPrompt.width} × {importPrompt.height}</span> at
                <span className="font-medium text-foreground"> {importPrompt.fps} fps</span>.</p>
              <p className="text-muted-foreground">Your project is currently {project.width} × {project.height} @ {project.fps} fps. Set the project to match this clip?</p>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-border/60">
              <button type="button" onClick={() => setImportPrompt(null)}
                className="px-3 py-1.5 rounded text-[12px] border border-border/60 hover:bg-foreground/5">Keep current</button>
              <button type="button"
                onClick={() => { timelineStore.setProjectFormat({ width: importPrompt.width, height: importPrompt.height, fps: importPrompt.fps }); setImportPrompt(null); }}
                className="px-3 py-1.5 rounded text-[12px] font-medium border border-violet-500/50 bg-violet-500/20 text-violet-100 hover:bg-violet-500/30">Match project</button>
            </div>
          </div>
        </div>
      )}

      <TimelineRelinkDialog open={showRelink} onClose={() => setShowRelink(false)} assets={poolAssets} />

      {/* Export settings panel */}
      {showExportPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowExportPanel(false)}>
          <div className="w-[480px] max-h-[88vh] overflow-y-auto rounded-lg border border-border/60 bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60">
              <span className="text-[13px] font-semibold inline-flex items-center gap-1.5"><Download className="w-4 h-4" /> Export Settings</span>
              <button type="button" onClick={() => setShowExportPanel(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className={FLABEL}>File name</label>
                <input className={FIELD} value={exportSettings.fileName}
                  onChange={(e) => setExportSettings((s) => ({ ...s, fileName: e.target.value }))} />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className={FLABEL}>Format</label>
                  <select className={FIELD} value={exportSettings.container}
                    onChange={(e) => setExportSettings((s) => {
                      const container = e.target.value as ExportSettings["container"];
                      // WebM requires VP9; keep codec coherent with the container.
                      const vcodec = container === "webm" ? "vp9" : (s.vcodec === "vp9" ? "h264" : s.vcodec);
                      return { ...s, container, vcodec };
                    })}>
                    <option value="mp4">MP4: H.264/H.265 (recommended)</option>
                    <option value="mov">MOV: QuickTime</option>
                    <option value="webm">WebM: VP9</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className={FLABEL}>Codec</label>
                  <select className={FIELD} value={exportSettings.vcodec}
                    onChange={(e) => setExportSettings((s) => {
                      const vcodec = e.target.value as ExportSettings["vcodec"];
                      const container = vcodec === "vp9" ? "webm" : (s.container === "webm" ? "mp4" : s.container);
                      return { ...s, vcodec, container };
                    })}>
                    <option value="h264">{CODEC_LABEL.h264}</option>
                    <option value="h265">{CODEC_LABEL.h265}</option>
                    <option value="vp9">{CODEC_LABEL.vp9}</option>
                  </select>
                </div>
              </div>
              {nvencAvail && exportSettings.vcodec !== "vp9" && (
                <label className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-emerald-500"
                    checked={exportSettings.hwEncode ?? false}
                    onChange={(e) => setExportSettings((s) => ({ ...s, hwEncode: e.target.checked }))}
                  />
                  <span className="text-[10px] leading-tight">
                    <span className="font-medium text-emerald-300">Use GPU encoder (NVENC)</span>
                    <span className="block text-muted-foreground/70">Much faster {exportSettings.vcodec.toUpperCase()} encoding on your NVIDIA GPU. Falls back to CPU automatically if it's unavailable.</span>
                  </span>
                </label>
              )}
              <div>
                <label className={FLABEL}>Resolution</label>
                <select className={FIELD} value={exportSettings.resKey}
                  onChange={(e) => setExportSettings((s) => ({ ...s, resKey: e.target.value }))}>
                  <option value="match">Match Timeline: {project.width} × {project.height}</option>
                  {RES_PRESETS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  <option value="custom">Custom…</option>
                </select>
                {exportSettings.resKey === "custom" && (
                  <div className="flex gap-2 mt-2">
                    <input type="number" className={FIELD} value={exportSettings.customW}
                      onChange={(e) => setExportSettings((s) => ({ ...s, customW: Number(e.target.value) }))} />
                    <input type="number" className={FIELD} value={exportSettings.customH}
                      onChange={(e) => setExportSettings((s) => ({ ...s, customH: Number(e.target.value) }))} />
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className={FLABEL}>Frame rate</label>
                  <select className={FIELD} value={exportSettings.fpsKey}
                    onChange={(e) => setExportSettings((s) => ({ ...s, fpsKey: e.target.value }))}>
                    <option value="match">Match Timeline: {project.fps} fps</option>
                    {FPS_PRESETS.map((f) => <option key={f} value={f}>{f} fps</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className={FLABEL}>Quality</label>
                  <select className={FIELD} value={exportSettings.crf}
                    onChange={(e) => setExportSettings((s) => ({ ...s, crf: Number(e.target.value) }))}>
                    {QUALITY_PRESETS.map((q) => <option key={q.crf} value={q.crf}>{q.label}</option>)}
                  </select>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground/80">
                {getSaveFilePicker()
                  ? "You'll choose the save location next, then rendering begins."
                  : "Your browser will download the file when rendering completes."}
              </p>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-border/60">
              <button type="button" onClick={() => setShowExportPanel(false)}
                className="px-3 py-1.5 rounded text-[12px] border border-border/60 hover:bg-foreground/5">Cancel</button>
              <button type="button" onClick={() => void runExport(exportSettings)}
                className="px-3 py-1.5 rounded text-[12px] font-medium border border-violet-500/50 bg-violet-500/20 text-violet-100 hover:bg-violet-500/30 inline-flex items-center gap-1.5">
                <Download className="w-3.5 h-3.5" /> {getSaveFilePicker() ? "Choose location & Render" : "Render & Download"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Audio export settings panel */}
      {showAudioExportPanel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowAudioExportPanel(false)}>
          <div className="w-[480px] max-h-[88vh] overflow-y-auto rounded-lg border border-border/60 bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/60">
              <span className="text-[13px] font-semibold inline-flex items-center gap-1.5"><Music className="w-4 h-4" /> Export Audio</span>
              <button type="button" onClick={() => setShowAudioExportPanel(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className={FLABEL}>File name</label>
                <input className={FIELD} value={audioExportSettings.fileName}
                  onChange={(e) => setAudioExportSettings((s) => ({ ...s, fileName: e.target.value }))} />
              </div>
              <div>
                <label className={FLABEL}>Format</label>
                <select className={FIELD} value={audioExportSettings.format}
                  onChange={(e) => setAudioExportSettings((s) => ({ ...s, format: e.target.value as AudioFormat }))}>
                  {AUDIO_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className={FLABEL}>Sample rate</label>
                  <select className={FIELD} value={audioExportSettings.sampleRate}
                    onChange={(e) => setAudioExportSettings((s) => ({ ...s, sampleRate: Number(e.target.value) }))}>
                    {AUDIO_SAMPLE_RATES.map((r) => <option key={r} value={r}>{(r / 1000).toFixed(1)} kHz</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className={FLABEL}>Channels</label>
                  <select className={FIELD} value={audioExportSettings.channels}
                    onChange={(e) => setAudioExportSettings((s) => ({ ...s, channels: Number(e.target.value) as 1 | 2 }))}>
                    <option value={2}>Stereo</option>
                    <option value={1}>Mono</option>
                  </select>
                </div>
                <div className="flex-1">
                  {isLossyAudio(audioExportSettings.format) ? (
                    <>
                      <label className={FLABEL}>Bitrate</label>
                      <select className={FIELD} value={audioExportSettings.bitrate}
                        onChange={(e) => setAudioExportSettings((s) => ({ ...s, bitrate: e.target.value }))}>
                        {AUDIO_BITRATES.map((b) => <option key={b} value={b}>{b.replace("k", " kbps")}</option>)}
                      </select>
                    </>
                  ) : (
                    <>
                      <label className={FLABEL}>Bit depth</label>
                      <select className={FIELD} value={audioExportSettings.bitDepth}
                        onChange={(e) => setAudioExportSettings((s) => ({ ...s, bitDepth: Number(e.target.value) as 16 | 24 | 32 }))}>
                        <option value={16}>16-bit</option>
                        <option value={24}>24-bit</option>
                        {audioExportSettings.format === "wav" && <option value={32}>32-bit float</option>}
                      </select>
                    </>
                  )}
                </div>
              </div>
              <div>
                <label className={FLABEL}>Loudness normalization</label>
                <select className={FIELD} value={audioExportSettings.normalize}
                  onChange={(e) => setAudioExportSettings((s) => ({ ...s, normalize: e.target.value as "none" | "ebu" }))}>
                  <option value="none">None: preserve mix levels</option>
                  <option value="ebu">EBU R128: normalize to target loudness</option>
                </select>
                {audioExportSettings.normalize === "ebu" && (
                  <select className={`${FIELD} mt-2`} value={audioExportSettings.lufs}
                    onChange={(e) => setAudioExportSettings((s) => ({ ...s, lufs: Number(e.target.value) }))}>
                    {LUFS_TARGETS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                  </select>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/80">
                Renders the full timeline audio mix (all audio tracks, honoring mute/solo, fades, pan and volume automation).
                {getSaveFilePicker()
                  ? " You'll choose the save location next, then rendering begins."
                  : " Your browser will download the file when rendering completes."}
              </p>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-border/60">
              <button type="button" onClick={() => setShowAudioExportPanel(false)}
                className="px-3 py-1.5 rounded text-[12px] border border-border/60 hover:bg-foreground/5">Cancel</button>
              <button type="button" onClick={() => void runAudioExport(audioExportSettings)}
                className="px-3 py-1.5 rounded text-[12px] font-medium border border-sky-500/50 bg-sky-500/20 text-sky-100 hover:bg-sky-500/30 inline-flex items-center gap-1.5">
                <Music className="w-3.5 h-3.5" /> {getSaveFilePicker() ? "Choose location & Render" : "Render & Download"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom status bar: background media caching (thumbnail decode) progress.
          Mirrors how professional editors surface conforming/indexing. Only shown
          while a decode is actually running; long/large files report real %. */}
      {thumbProgress && (
        <div className="shrink-0 border-t border-sky-500/30 bg-sky-500/10 px-3 py-1.5">
          <div className="flex items-center justify-between text-[11px] text-sky-200 mb-1">
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Caching media thumbnails…
              {thumbProgress.jobs > 1 && <span className="text-sky-300/70">({thumbProgress.jobs} files)</span>}
            </span>
            <span className="tabular-nums">{thumbProgress.percent}%</span>
          </div>
          <div className="h-1 rounded-full bg-sky-500/15 overflow-hidden">
            <div className="h-full bg-sky-400 rounded-full transition-[width] duration-200"
              style={{ width: `${Math.max(3, thumbProgress.percent)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
