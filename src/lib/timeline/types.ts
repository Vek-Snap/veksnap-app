// Timeline Editor (NLE): core data model.
// The editor operates on OUTPUTS of the other studios plus user imports; it is
// model-agnostic. All media is referenced by absolute path (ComfyUI output/input
// or a local file), never base64/blob, matching the edit-video source pattern.

import type { ClipEffect } from "./effects";
import type { TitlePreset } from "./titles";

export type TrackKind = "video" | "audio" | "text";

export type AssetKind = "video" | "audio" | "image" | "combined";

export interface TimelineAsset {
  id: string;
  kind: AssetKind;
  name: string;
  /** Browser-playable URL for in-app preview (object/blob URL or http). */
  src: string;
  /**
   * Absolute server-side file path for ffmpeg (export + frame previews).
   * Browser-imported files are uploaded to a working dir; ComfyUI/local assets
   * already have a real path. ffmpeg cannot read blob: URLs, so this is required
   * for any asset that must be rendered server-side.
   */
  filePath?: string;
  /** Intrinsic duration in seconds (images use a default still duration). */
  duration: number;
  /** Native pixel dimensions (video/image), if known, used for "match project to clip". */
  width?: number;
  height?: number;
  /** Native frame rate (video), if known. */
  fps?: number;
  /** Optional thumbnail data/URL for the media bin + clip head. */
  thumb?: string;
  /** Normalized peak buckets (0..1) for audio/video waveform rendering. */
  peaks?: number[];
  /** Which studio produced this asset, if any (provenance for round-tripping). */
  fromStudio?: string;
  /** For a video asset: the id of its extracted-audio companion asset. */
  linkedAudioAssetId?: string;
  /** For an extracted-audio companion: the source video asset id (hidden from Media Pool). */
  fromVideoAssetId?: string;
  /** For a "combined" (compound) asset: the nested timeline it represents. */
  nested?: TimelineProject;
  /** Organizational group ("bin") this asset belongs to. null/undefined = Master (ungrouped). */
  groupId?: string | null;
}

/** A Media Pool organizational group (professional editors call these "bins"). */
export interface TimelineGroup {
  id: string;
  name: string;
}

/** One automation point. `t` is seconds from the clip's start (clip-local). */
export interface Keyframe {
  t: number;
  value: number;
}

export type KeyframeProp =
  | "volume"
  | "pan"
  | "opacity"
  | "scale"
  | "posX"
  | "posY"
  | "rotation";

export type KeyframeMap = Partial<Record<KeyframeProp, Keyframe[]>>;

export interface TimelineClip {
  id: string;
  assetId: string;
  trackId: string;
  /** Position on the timeline, seconds from project start. */
  start: number;
  /** Visible duration on the timeline, seconds. */
  duration: number;
  /** In/out trim offsets into the source asset, seconds. */
  trimIn: number;
  trimOut: number;
  /**
   * Playback speed / retime factor (1 = normal). >1 is faster (shorter on the
   * timeline), <1 is slower (longer). The consumed source region is fixed at
   * `trimOut - trimIn`; the visible timeline `duration` = sourceSpan / speed.
   * Applied live in preview (playbackRate) and baked on export (video setpts,
   * audio atempo: pitch preserved).
   */
  speed?: number;
  /** Audio gain multiplier (1 = unity). */
  gain?: number;
  /** Stereo pan, -1 (L) .. 1 (R). Applied on export. */
  pan?: number;
  /** Pitch shift in semitones. Applied on export. */
  pitchSemitones?: number;
  /** Video opacity 0..100 (%). */
  opacity?: number;
  /** Video scale 10..400 (%). */
  scale?: number;
  /** Video position offset in px. */
  posX?: number;
  posY?: number;
  /** Video rotation in degrees. */
  rotation?: number;
  /** Per-property automation keyframes (clip-local time). Overrides the static value above. */
  keyframes?: KeyframeMap;
  /** For a text/title clip: the string to render (centered over the composite). */
  text?: string;
  /** Second line of text (used by two-line title presets). */
  text2?: string;
  /** Animated title preset (slide/fade in & out). Defaults to "none" (static). */
  titlePreset?: TitlePreset;
  /** In-house visual effects applied to a video clip, in render order. */
  effects?: ClipEffect[];
  /**
   * Marks an ADJUSTMENT LAYER: a no-asset clip on a video track whose `effects`
   * are applied to the COMPOSITE of every track below it (for the clip's time
   * span), then re-composited on top, the standard "adjustment/effects layer"
   * pattern. Carrying no media, it has no assetId and no text.
   */
  isAdjustment?: boolean;
  /** Fade-in / fade-out ramp lengths in seconds (video → to/from black, audio → 0..volume). */
  fadeIn?: number;
  fadeOut?: number;
  /** Cross-dissolve length (s) from the previous abutting clip on the same track. */
  crossfadeFromPrev?: number;
  /** Clips sharing a linkId move together (e.g. a video + its extracted audio). */
  linkId?: string;
  /**
   * Stacking priority among clips that overlap in time across video tracks.
   * Higher = rendered on top ("Bring to Top"). When unset, track order decides.
   */
  z?: number;
  /**
   * Marks a placeholder clip on an audio track that will be FILLED by AI audio
   * generation (DramaBox). Until it is generated the clip has no asset (no
   * waveform); its Component Control shows a script editor instead of
   * volume/pan/pitch, and the AI Processing Queue swaps in the generated audio.
   */
  pendingAudioGen?: PendingAudioGen;
}

/** Pending AI audio-generation request carried by a placeholder audio clip. */
export interface PendingAudioGen {
  /** The generator to run. Currently DramaBox (expressive TTS). */
  workflow: "dramabox";
  /** The user's DramaBox script / stage directions (maps to the studio prompt). */
  script: string;
  /** When true, a saved DramaBox configuration is layered under the script. */
  useSavedConfig: boolean;
  /** The saved configuration name to apply (when useSavedConfig). */
  configName?: string;
  /**
   * If set, this fixed duration (s) is sent to the generator so the output
   * length is known ahead of time, which lets the placeholder be filled in
   * place without risk of overrunning a neighbouring clip.
   */
  targetDuration?: number;
}

/** A clip with no source asset but text is a Title/text overlay (lives on a video track). */
export function isTitleClip(clip: TimelineClip): boolean {
  return !clip.assetId && clip.text != null;
}

/** A placeholder audio clip awaiting AI generation (no asset yet). */
export function isPendingAudioGenClip(clip: TimelineClip): boolean {
  return !clip.assetId && clip.pendingAudioGen != null;
}

/** An adjustment layer: no asset, no text, flagged; its effects apply to the composite below it. */
export function isAdjustmentClip(clip: TimelineClip): boolean {
  return !clip.assetId && clip.text == null && clip.isAdjustment === true;
}

export interface TimelineTrack {
  id: string;
  kind: TrackKind;
  name: string;
  /** Stacking order; lower renders lower in the lane stack. */
  index: number;
  muted: boolean;
  locked: boolean;
  /** Solo: when any audio track is soloed, only soloed tracks are audible. */
  solo?: boolean;
  /** Hidden: excluded from the preview AND the export (video/text tracks). */
  hidden?: boolean;
  /** Per-track lane height (px). Falls back to the editor's global lane height. */
  height?: number;
  /** Track accent color (hex). Tints the track header + a border on its clips. */
  color?: string;
}

/** A timeline marker (note / sync point) rendered on the ruler. */
export interface TimelineMarker {
  id: string;
  /** Position in seconds. */
  time: number;
  /** Optional label shown on hover / in the marker list. */
  name?: string;
  /** Marker color (hex); defaults to a warm accent. */
  color?: string;
}

/** Default marker palette (cycled when adding). */
export const MARKER_COLORS = ["#f59e0b", "#ef4444", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"] as const;

export interface TimelineProject {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  /** Media Pool organizational groups ("bins"). Assets reference these via groupId. */
  groups?: TimelineGroup[];
  /** Ruler markers (notes / sync points). */
  markers?: TimelineMarker[];
  tracks: TimelineTrack[];
  clips: TimelineClip[];
  assets: TimelineAsset[];
  /**
   * When true, clips may overlap on a track (compact stacking); overlaps are
   * highlighted and video priority is chosen per-clip. When false (default),
   * dropping/moving a clip over another overwrites the overlapped region
   * (standard NLE behavior).
   */
  allowStacking?: boolean;
}

export interface TimelineTransport {
  /** Playhead position in seconds. */
  playhead: number;
  isPlaying: boolean;
  /** Horizontal zoom: pixels per second. */
  pxPerSecond: number;
  selectedClipId: string | null;
  /** All selected clip ids (for multi-select / combine). Includes the primary. */
  selectedClipIds?: string[];
  /** Loop playback: when the playhead reaches the end, restart from 0. */
  loop?: boolean;
}

export const TIMELINE_PROJECT_DEFAULTS = {
  fps: 30,
  width: 1280,
  height: 720,
} as const;

export const TRANSPORT_DEFAULTS: TimelineTransport = {
  playhead: 0,
  isPlaying: false,
  pxPerSecond: 80,
  selectedClipId: null,
  selectedClipIds: [],
  loop: false,
};

let idCounter = 0;
export function timelineId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

/** A fresh project with the default V1 / V2 / A1 track layout (industry-standard). */
export function createEmptyProject(name = "Untitled Timeline"): TimelineProject {
  return {
    id: timelineId("proj"),
    name,
    fps: TIMELINE_PROJECT_DEFAULTS.fps,
    width: TIMELINE_PROJECT_DEFAULTS.width,
    height: TIMELINE_PROJECT_DEFAULTS.height,
    assets: [],
    clips: [],
    allowStacking: false,
    // Titles/text now live on ordinary video tracks (no dedicated "T" row).
    tracks: [
      { id: timelineId("trk"), kind: "video", name: "V2", index: 2, muted: false, locked: false },
      { id: timelineId("trk"), kind: "video", name: "V1", index: 1, muted: false, locked: false },
      { id: timelineId("trk"), kind: "audio", name: "A1", index: 0, muted: false, locked: false },
    ],
  };
}

// ── Keyframable parameter metadata + automation evaluation ──

export interface KfPropMeta {
  label: string;
  min: number;
  max: number;
  unit: string;
  decimals: number;
  kind: TrackKind;
}

/** UI ranges/units for each automatable property. Volume is in dB (industry-standard). */
export const KF_PROPS: Record<KeyframeProp, KfPropMeta> = {
  volume: { label: "Volume", min: -60, max: 30, unit: "dB", decimals: 1, kind: "audio" },
  pan: { label: "Pan", min: -100, max: 100, unit: "", decimals: 0, kind: "audio" },
  opacity: { label: "Opacity", min: 0, max: 100, unit: "%", decimals: 0, kind: "video" },
  scale: { label: "Scale", min: 10, max: 400, unit: "%", decimals: 0, kind: "video" },
  posX: { label: "Pos X", min: -2000, max: 2000, unit: "px", decimals: 0, kind: "video" },
  posY: { label: "Pos Y", min: -2000, max: 2000, unit: "px", decimals: 0, kind: "video" },
  rotation: { label: "Rotate", min: -180, max: 180, unit: "°", decimals: 0, kind: "video" },
};

export const AUDIO_KF_PROPS: KeyframeProp[] = ["volume", "pan"];
export const VIDEO_KF_PROPS: KeyframeProp[] = ["opacity", "scale", "posX", "posY", "rotation"];

/** dB ↔ linear amplitude. -60 dB is treated as silence. */
export const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g: number): number => (g <= 0 ? -60 : Math.max(-60, 20 * Math.log10(g)));

/** The clip's static (non-keyframed) value for a property, in that property's UI unit. */
export function clipPropStatic(clip: TimelineClip, prop: KeyframeProp): number {
  switch (prop) {
    case "volume": return gainToDb(clip.gain ?? 1);
    case "pan": return clip.pan ?? 0;
    case "opacity": return clip.opacity ?? 100;
    case "scale": return clip.scale ?? 100;
    case "posX": return clip.posX ?? 0;
    case "posY": return clip.posY ?? 0;
    case "rotation": return clip.rotation ?? 0;
  }
}

/** Evaluate a property at a clip-local time, linearly interpolating keyframes. */
export function evalClipProp(clip: TimelineClip, prop: KeyframeProp, localTime: number): number {
  const kfs = clip.keyframes?.[prop];
  if (!kfs || kfs.length === 0) return clipPropStatic(clip, prop);
  if (kfs.length === 1) return kfs[0].value;
  if (localTime <= kfs[0].t) return kfs[0].value;
  const last = kfs[kfs.length - 1];
  if (localTime >= last.t) return last.value;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (localTime >= a.t && localTime <= b.t) {
      const span = b.t - a.t || 1;
      return a.value + (b.value - a.value) * ((localTime - a.t) / span);
    }
  }
  return last.value;
}

/** Linear amplitude for an audio clip at a clip-local time (keyframes are in dB). */
export function evalClipGainLinear(clip: TimelineClip, localTime: number): number {
  return dbToGain(evalClipProp(clip, "volume", localTime));
}

/** Fade envelope multiplier (0..1) from clip fade-in/out ramps at a clip-local time. */
export function fadeMultiplier(clip: TimelineClip, localTime: number): number {
  const fi = Math.max(clip.fadeIn ?? 0, clip.crossfadeFromPrev ?? 0);
  const fo = clip.fadeOut ?? 0;
  let m = 1;
  if (fi > 0 && localTime < fi) m *= Math.max(0, localTime / fi);
  if (fo > 0 && localTime > clip.duration - fo) m *= Math.max(0, (clip.duration - localTime) / fo);
  return Math.max(0, Math.min(1, m));
}

/** Total project duration = end of the last clip (min 0). */
export function projectDuration(project: TimelineProject): number {
  return project.clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
}

/** Allowed clip speed / retime range. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/** A clip's effective playback speed (1 when unset/invalid). */
export const clipSpeed = (c: TimelineClip): number => (c.speed && c.speed > 0 ? c.speed : 1);
