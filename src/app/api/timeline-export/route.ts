import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { spawn } from "child_process";
import path from "path";
import { getScratchDir } from "@/lib/scratch-dir";
import { getFFmpegPath, execFileAsync } from "@/lib/ffmpeg-path";
import { effectsFfmpeg, type ClipEffect } from "@/lib/timeline/effects";
import { titleDrawtextFilters, type TitlePreset } from "@/lib/timeline/titles";
import { initProgress, updateProgress, finishProgress } from "@/lib/timeline/export-progress";

// Timeline Editor export (Phase 4).
// Renders the multi-track NLE project into a single H.264 MP4 with ffmpeg:
//   - Video tracks are composited bottom→top via `overlay` with per-clip static
//     transform (scale / position / rotation / opacity) and timeline windowing.
//   - Text/title clips are burned in with `drawtext`, centered.
//   - Audio tracks are mixed (`amix`) with per-clip delay, stereo pan, and a
//     time-varying `volume` expression that reproduces dB keyframe automation
//     (including amplification past unity, up to +30 dB).
// Mute / solo are honored. All media is referenced by absolute path.

export const maxDuration = 600;

type TrackKind = "video" | "audio" | "text";
type AssetKind = "video" | "audio" | "image" | "combined";

interface Keyframe { t: number; value: number }
type KProp = "volume" | "pan" | "opacity" | "scale" | "posX" | "posY" | "rotation";
interface Asset { id: string; kind: AssetKind; src: string; filePath?: string; nested?: Project }
interface Track { id: string; kind: TrackKind; muted?: boolean; solo?: boolean; hidden?: boolean; index: number }
interface Clip {
  id: string; assetId: string; trackId: string;
  start: number; duration: number; trimIn: number; speed?: number;
  gain?: number; pan?: number; opacity?: number; scale?: number;
  posX?: number; posY?: number; rotation?: number; text?: string;
  text2?: string; titlePreset?: TitlePreset;
  fadeIn?: number; fadeOut?: number; crossfadeFromPrev?: number;
  effects?: ClipEffect[]; isAdjustment?: boolean;
  keyframes?: Partial<Record<KProp, Keyframe[]>>;
}
interface Project {
  width: number; height: number; fps: number;
  tracks: Track[]; clips: Clip[]; assets: Asset[];
}

/** Output/encode settings chosen in the Export panel (applied to the final render only). */
interface ExportSettings {
  width?: number;
  height?: number;
  fps?: number;
  /** "h264" | "h265" | "vp9" */
  vcodec?: string;
  /** "mp4" | "mov" | "webm" */
  container?: string;
  /** Lower = higher quality (x264/x265: 0-51; vp9: 0-63). */
  crf?: number;
  preset?: string;
  audioBitrate?: string;
  /** Use the GPU (NVENC) encoder for H.264/H.265 instead of CPU libx26x. */
  hwEncode?: boolean;
}

const VCODEC_MAP: Record<string, string> = { h264: "libx264", h265: "libx265", vp9: "libvpx-vp9" };
const CONTAINER_MIME: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

/**
 * Audio-only export settings (chosen in the "Export Audio" panel). When present
 * on the request the route renders JUST the timeline's audio mixdown, the exact
 * same per-clip processing (fades, pan, keyframed dB automation, pitch-preserving
 * retime, per-track mute/solo) and `amix` used by the video export, encoded to a
 * standalone audio file instead of muxed into video.
 */
type AudioFormat = "wav" | "mp3" | "flac" | "aac" | "ogg" | "opus";
interface AudioExportSettings {
  format: AudioFormat;
  /** Output sample rate in Hz (default 48000). */
  sampleRate?: number;
  /** 1 = mono downmix, 2 = stereo (default 2). */
  channels?: 1 | 2;
  /** PCM/FLAC bit depth: 16 | 24 | 32 (32 = float, WAV only). Ignored for lossy. */
  bitDepth?: 16 | 24 | 32;
  /** Lossy target bitrate, e.g. "192k" | "256k" | "320k" (mp3/aac/ogg/opus). */
  bitrate?: string;
  /** "none" (preserve mix levels) or "ebu" (EBU R128 loudness normalize). */
  normalize?: "none" | "ebu";
  /** EBU R128 integrated-loudness target in LUFS (default -14). */
  lufs?: number;
}
const AUDIO_EXT: Record<AudioFormat, string> = { wav: "wav", mp3: "mp3", flac: "flac", aac: "m4a", ogg: "ogg", opus: "opus" };
const AUDIO_MIME: Record<AudioFormat, string> = {
  wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", aac: "audio/mp4", ogg: "audio/ogg", opus: "audio/opus",
};

/** ffmpeg encode-tail (codec + rate/channels + depth/bitrate) for an audio export. */
function audioEncodeTail(a: AudioExportSettings): string[] {
  const ar = a.sampleRate && a.sampleRate > 0 ? String(a.sampleRate) : "48000";
  const ac = a.channels === 1 ? "1" : "2";
  const br = a.bitrate || "256k";
  const common = ["-ar", ar, "-ac", ac];
  switch (a.format) {
    case "wav": {
      const pcm = a.bitDepth === 16 ? "pcm_s16le" : a.bitDepth === 32 ? "pcm_f32le" : "pcm_s24le";
      return ["-c:a", pcm, ...common];
    }
    case "flac": {
      const tail = ["-c:a", "flac", "-compression_level", "8", ...common];
      // FLAC is integer-only: 24-bit rides in an s32 sample_fmt tagged as 24 real bits.
      if (a.bitDepth === 24) tail.push("-sample_fmt", "s32", "-bits_per_raw_sample", "24");
      else tail.push("-sample_fmt", "s16");
      return tail;
    }
    case "mp3": return ["-c:a", "libmp3lame", "-b:a", br, ...common];
    case "aac": return ["-c:a", "aac", "-b:a", br, ...common, "-movflags", "+faststart"];
    case "ogg": return ["-c:a", "libvorbis", "-b:a", br, ...common];
    case "opus": return ["-c:a", "libopus", "-b:a", br, ...common];
    default: return ["-c:a", "pcm_s24le", ...common];
  }
}

const dbToGain = (db: number): number => (db <= -60 ? 0 : Math.pow(10, db / 20));
const f3 = (n: number): string => Number(n).toFixed(3);
const clipSpeed = (c: Clip): number => (c.speed && c.speed > 0 ? c.speed : 1);

/**
 * Decompose a speed factor into a chain of `atempo` filters. atempo only accepts
 * 0.5–2.0 per instance, so out-of-range factors are split into a product of
 * in-range steps (e.g. 4x → 2.0*2.0, 0.25x → 0.5*0.5). Tempo change preserves
 * pitch, matching a professional retime.
 */
function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  if (!Number.isFinite(s) || s <= 0) return out;
  while (s > 2.0 + 1e-6) { out.push("atempo=2.0"); s /= 2.0; }
  while (s < 0.5 - 1e-6) { out.push("atempo=0.5"); s *= 2.0; }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${f3(s)}`);
  return out;
}

/**
 * Run the final ffmpeg encode while parsing `-progress pipe:1` for an ACCURATE
 * percentage. ffmpeg emits key=value blocks ending in `progress=continue|end`;
 * `out_time_us` (microseconds) over the total timeline duration gives the
 * percent, and `speed` gives a realtime ETA. Resolves/rejects with the same
 * shape as execFileAsync so the caller's diagnostics path is unchanged.
 */
function runFfmpegWithProgress(
  ffmpeg: string,
  args: string[],
  jobId: string,
  totalSec: number,
): Promise<{ stdout: string; stderr: string }> {
  // `-nostats -progress pipe:1` are global options; prepend so progress is
  // machine-readable on stdout while stderr keeps the human banner for logs.
  const fullArgs = ["-nostats", "-progress", "pipe:1", ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, fullArgs, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buf = "";
    let curOut = 0, curSpeed = 0, curFps = 0;

    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      buf += text;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() || "";
      for (const line of parts) {
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (key === "out_time_us" || key === "out_time_ms") {
          const us = Number(val); // both report microseconds in modern ffmpeg
          if (Number.isFinite(us) && us >= 0) curOut = us / 1e6;
        } else if (key === "out_time") {
          const m = val.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (m) curOut = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
        } else if (key === "speed") {
          const s = parseFloat(val); if (Number.isFinite(s)) curSpeed = s;
        } else if (key === "fps") {
          const f = parseFloat(val); if (Number.isFinite(f)) curFps = f;
        } else if (key === "progress") {
          const pct = totalSec > 0 ? Math.min(99, (curOut / totalSec) * 100) : 0;
          const etaSec = curSpeed > 0 && totalSec > 0 ? Math.max(0, (totalSec - curOut) / curSpeed) : null;
          updateProgress(jobId, { phase: "rendering", percent: pct, outTimeSec: curOut, speed: curSpeed, fps: curFps, etaSec });
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`Command failed (exit ${code}): ${stderr.slice(-2000)}`) as Error & { stdout?: string; stderr?: string; code?: number };
        err.stdout = stdout; err.stderr = stderr; err.code = code ?? undefined;
        reject(err);
      }
    });
  });
}

/** Resolve a usable Windows font path for drawtext (escaped for the filtergraph). */
function fontPathEscaped(): string {
  const win = process.env.WINDIR || "C:\\Windows";
  const p = path.join(win, "Fonts", "arial.ttf").replace(/\\/g, "/");
  return p.replace(/:/g, "\\:");
}

function escDrawtext(s: string): string {
  return (s || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ");
}

const hasKf = (c: Clip, prop: KProp): boolean => (c.keyframes?.[prop]?.length ?? 0) > 0;

/** The clip's static (non-keyframed) value for a property, in its UI unit. */
function staticOf(c: Clip, prop: KProp): number {
  switch (prop) {
    case "volume": return c.gain ?? 1; // already linear
    case "pan": return c.pan ?? 0;
    case "opacity": return c.opacity ?? 100;
    case "scale": return c.scale ?? 100;
    case "posX": return c.posX ?? 0;
    case "posY": return c.posY ?? 0;
    case "rotation": return c.rotation ?? 0;
  }
}

/**
 * Build a piecewise-linear ffmpeg expression over absolute timeline time for a
 * keyframed property. `timeVar` is the filter's time variable ("t" for most,
 * "T" for geq). `transform` maps the keyframe's UI value to the filter's unit.
 */
function kfExpr(c: Clip, prop: KProp, timeVar: string, transform: (v: number) => number = (v) => v): string {
  const kfs = c.keyframes?.[prop];
  if (!kfs || kfs.length === 0) return f3(transform(staticOf(c, prop)));
  const pts = [...kfs].sort((a, b) => a.t - b.t).map((k) => ({ T: c.start + k.t, V: transform(k.value) }));
  if (pts.length === 1) return f3(pts[0].V);
  let e = f3(pts[pts.length - 1].V);
  for (let i = pts.length - 1; i >= 1; i--) {
    const a = pts[i - 1];
    const b = pts[i];
    const span = (b.T - a.T) || 0.001;
    const lerp = `(${f3(a.V)}+(${f3(b.V)}-${f3(a.V)})*(${timeVar}-${f3(a.T)})/${f3(span)})`;
    e = `if(lt(${timeVar},${f3(b.T)}),${lerp},${e})`;
  }
  return `if(lt(${timeVar},${f3(pts[0].T)}),${f3(pts[0].V)},${e})`;
}

/** Linear volume expression (dB keyframes → linear), over absolute time `t`. */
function volumeExpr(c: Clip): string {
  if (!hasKf(c, "volume")) return f3(c.gain ?? 1);
  return kfExpr(c, "volume", "t", (db) => dbToGain(db));
}

/**
 * Flatten combined (compound) clips: render each nested project to a temp MP4
 * and rewrite the asset as a plain video input. Recurses for nested-in-nested.
 */
async function prerenderCombined(project: Project, tmpDir: string): Promise<Project> {
  const assets = await Promise.all(
    project.assets.map(async (a) => {
      if (a.kind !== "combined" || !a.nested) return a;
      const out = await renderProjectToFile(a.nested, tmpDir);
      return { ...a, kind: "video" as AssetKind, src: out, nested: undefined };
    }),
  );
  return { ...project, assets };
}

/** Render a (possibly nested) timeline project to a file; returns its path.
 *  `output` (top-level render only) overrides resolution/fps/codec/container. */
async function renderProjectToFile(rawProject: Project, tmpDir: string, output?: ExportSettings, progressJobId?: string): Promise<string> {
  const project = await prerenderCombined(rawProject, tmpDir);
  // Internal render is always at the project's pixel space (geometry/positions
  // are authored there); a final scale rescales to the chosen output resolution.
  const W = Math.round(project.width) || 1280;
  const H = Math.round(project.height) || 720;
  const FPS = project.fps || 30;
  const total = Math.max(
    0.1,
    project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0),
  );
  const trackById = new Map(project.tracks.map((t) => [t.id, t]));
  const assetById = new Map(project.assets.map((a) => [a.id, a]));
  const anySolo = project.tracks.some((t) => t.kind === "audio" && t.solo);
  const anyVideoSolo = project.tracks.some((t) => t.kind === "video" && t.solo);

  const args: string[] = ["-y"];
  let inputIdx = 0;
  const vEntries: { clip: Clip; idx: number; track: Track }[] = [];
  const adjEntries: { clip: Clip; track: Track }[] = [];
  const aEntries: { clip: Clip; idx: number }[] = [];
  const textClips: Clip[] = [];

  for (const clip of project.clips) {
    if (clip.duration <= 0) continue;
    const track = trackById.get(clip.trackId);
    if (!track) continue;

    if (track.kind === "text") {
      if (track.hidden) continue; // hidden tracks are excluded from the render
      if (anyVideoSolo && !track.solo) continue; // solo: only soloed visual tracks render
      if ((clip.text ?? "").trim()) textClips.push(clip);
      continue;
    }

    // Adjustment layer: no media; its effects post-process the composite BELOW
    // it (all lower-index video tracks) for the clip's span. It creates no input.
    if (track.kind === "video" && clip.isAdjustment) {
      if (track.hidden) continue;
      if (anyVideoSolo && !track.solo) continue;
      if ((clip.effects ?? []).some((e) => e.enabled)) adjEntries.push({ clip, track });
      continue;
    }

    const asset = assetById.get(clip.assetId);
    if (!asset) continue;
    // Prefer the uploaded server-side path; ffmpeg cannot read blob: URLs.
    const inPath = asset.filePath || asset.src;
    // Retimed clips consume `duration * speed` seconds of source; the filtergraph
    // then compresses/stretches it back to `duration` on the timeline.
    const spd = clipSpeed(clip);
    const srcSpan = f3(clip.duration * spd);

    if (track.kind === "video") {
      if (track.hidden) continue; // hidden video tracks are excluded from the render
      if (anyVideoSolo && !track.solo) continue; // solo: only soloed video tracks render
      if (asset.kind === "image") {
        args.push("-loop", "1", "-t", f3(clip.duration), "-i", inPath);
      } else {
        args.push("-ss", f3(clip.trimIn), "-t", srcSpan, "-i", inPath);
      }
      vEntries.push({ clip, idx: inputIdx, track });
      inputIdx++;
    } else if (track.kind === "audio") {
      if (track.muted) continue;
      if (anySolo && !track.solo) continue;
      args.push("-ss", f3(clip.trimIn), "-t", srcSpan, "-i", inPath);
      aEntries.push({ clip, idx: inputIdx });
      inputIdx++;
    }
  }

  // ── Build the filtergraph ──
  const lines: string[] = [];
  lines.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${f3(total)}[base]`);
  let prev = "base";

  // Fold video clips AND adjustment layers into one bottom→top pass, ordered by
  // track.index. At each step `prev` is the composite of everything lower, so an
  // adjustment layer sees exactly the tracks beneath it (DaVinci semantics).
  type VisualOp =
    | { kind: "clip"; e: { clip: Clip; idx: number; track: Track } }
    | { kind: "adj"; clip: Clip; track: Track };
  const visualOps: VisualOp[] = [
    ...vEntries.map((e) => ({ kind: "clip" as const, e })),
    ...adjEntries.map((a) => ({ kind: "adj" as const, clip: a.clip, track: a.track })),
  ].sort(
    (a, b) =>
      (a.kind === "clip" ? a.e.track.index : a.track.index) -
      (b.kind === "clip" ? b.e.track.index : b.track.index),
  );

  visualOps.forEach((op, i) => {
      if (op.kind === "adj") {
        const c = op.clip;
        const frags = effectsFfmpeg(c.effects);
        if (frags.length === 0) return;
        const end = c.start + c.duration;
        const out = `adj${i}`;
        // Duplicate the composite: one clean pass-through, one run through the
        // effect chain; overlay the effected copy back only within the layer's
        // time window (outside it, overlay is disabled and the clean copy shows).
        lines.push(`[${prev}]split[abase${i}][afx${i}]`);
        lines.push(`[afx${i}]${frags.join(",")},format=rgba[afxo${i}]`);
        lines.push(
          `[abase${i}][afxo${i}]overlay=enable='between(t,${f3(c.start)},${f3(end)})':eof_action=pass[${out}]`,
        );
        prev = out;
        return;
      }
      const e = op.e;
      const c = e.clip;
      const s = (c.scale ?? 100) / 100; // scale stays static (ffmpeg scale can't vary per-frame reliably)
      const rot = c.rotation ?? 0;
      const spd = clipSpeed(c);
      // Retime: compress/stretch the clip's PTS so it plays over `duration`.
      const fl: string[] = [spd !== 1 ? `setpts=(PTS-STARTPTS)/${f3(spd)}` : "setpts=PTS-STARTPTS"];
      if (Math.abs(s - 1) > 0.001) fl.push(`scale=iw*${f3(s)}:ih*${f3(s)}`);
      // In-house visual effects (glitch / blur / B&W / vignette / eq / sharpen), in order.
      // Applied BEFORE alpha is introduced (rotate/format=rgba) so each filter sees a
      // plain RGB/YUV frame and ffmpeg auto-inserts any needed pixel-format conversion.
      for (const frag of effectsFfmpeg(c.effects)) fl.push(frag);
      // Rotation: bake keyframes via a t-expression (rotate evaluates `a` per frame).
      if (hasKf(c, "rotation")) {
        fl.push(`rotate='${kfExpr(c, "rotation", "t", (deg) => deg * Math.PI / 180)}':c=none@0.0`);
      } else if (Math.abs(rot) > 0.001) {
        fl.push(`rotate=${(rot * Math.PI / 180).toFixed(5)}:c=none@0.0`);
      }
      fl.push("format=rgba");
      // Opacity: keyframed → per-frame alpha via geq (uses timestamp var `T`); else static mix.
      if (hasKf(c, "opacity")) {
        const aExpr = kfExpr(c, "opacity", "T", (v) => v / 100);
        fl.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='clip((${aExpr}),0,1)*alpha(X,Y)'`);
      } else {
        const op = (c.opacity ?? 100) / 100;
        if (op < 0.999) fl.push(`colorchannelmixer=aa=${f3(op)}`);
      }
      fl.push(`setpts=PTS-STARTPTS+${f3(c.start)}/TB`);
      // Fade in/out via alpha. A crossfade is a fade-in over the underlying clip
      // (which sits below in the overlay chain) instead of over black.
      const fi = Math.max(c.fadeIn ?? 0, c.crossfadeFromPrev ?? 0);
      const fo = c.fadeOut ?? 0;
      if (fi > 0) fl.push(`fade=t=in:st=${f3(c.start)}:d=${f3(fi)}:alpha=1`);
      if (fo > 0) fl.push(`fade=t=out:st=${f3(c.start + c.duration - fo)}:d=${f3(fo)}:alpha=1`);
      lines.push(`[${e.idx}:v]${fl.join(",")}[v${i}]`);
      const end = c.start + c.duration;
      const out = `vt${i}`;
      // Position: bake keyframes into the overlay x/y expressions (evaluated per frame).
      const xExpr = hasKf(c, "posX") ? kfExpr(c, "posX", "t") : `${Math.round(c.posX ?? 0)}`;
      const yExpr = hasKf(c, "posY") ? kfExpr(c, "posY", "t") : `${Math.round(c.posY ?? 0)}`;
      lines.push(
        `[${prev}][v${i}]overlay=x='(W-w)/2+(${xExpr})':y='(H-h)/2+(${yExpr})':enable='between(t,${f3(c.start)},${f3(end)})':eof_action=pass[${out}]`,
      );
      prev = out;
    });

  const font = fontPathEscaped();
  textClips.forEach((c, i) => {
    const fontSize = Math.round(H / 14);
    // Animated title presets reproduce the live preview's slide/fade via expressions.
    const filters = titleDrawtextFilters({
      preset: c.titlePreset ?? "none",
      fontEsc: font,
      textEsc: escDrawtext(c.text ?? ""),
      text2Esc: c.text2 ? escDrawtext(c.text2) : undefined,
      H,
      fontSize,
      start: c.start,
      duration: c.duration,
    });
    filters.forEach((filt, j) => {
      const out = `tx${i}_${j}`;
      lines.push(`[${prev}]${filt}[${out}]`);
      prev = out;
    });
  });

  lines.push(`[${prev}]null[vout]`);

  aEntries.forEach((e, i) => {
    const c = e.clip;
    const ms = Math.round(c.start * 1000);
    const afi = Math.max(c.fadeIn ?? 0, c.crossfadeFromPrev ?? 0);
    const afo = c.fadeOut ?? 0;
    const fades: string[] = [];
    if (afi > 0) fades.push(`afade=t=in:st=${f3(c.start)}:d=${f3(afi)}`);
    if (afo > 0) fades.push(`afade=t=out:st=${f3(c.start + c.duration - afo)}:d=${f3(afo)}`);

    const pre: string[] = ["aformat=channel_layouts=stereo:sample_rates=48000", "asetpts=PTS-STARTPTS"];
    // Retime (pitch-preserving) BEFORE placing on the timeline via adelay.
    for (const at of atempoChain(clipSpeed(c))) pre.push(at);
    if (ms > 0) pre.push(`adelay=${ms}:all=1`);
    pre.push(`volume='${volumeExpr(c)}':eval=frame`);

    if (hasKf(c, "pan")) {
      // Keyframed pan: split channels, apply per-channel gain expressions, rejoin.
      // p = pan/100 ∈ [-1,1]; left gain = 1-max(0,p), right gain = 1+min(0,p).
      const panE = kfExpr(c, "pan", "t", (v) => v / 100);
      lines.push(`[${e.idx}:a]${pre.join(",")},channelsplit=channel_layout=stereo[${i}L][${i}R]`);
      lines.push(`[${i}L]volume='1-max(0,(${panE}))':eval=frame[${i}Lp]`);
      lines.push(`[${i}R]volume='1+min(0,(${panE}))':eval=frame[${i}Rp]`);
      lines.push(`[${i}Lp][${i}Rp]join=inputs=2:channel_layout=stereo[${i}j]`);
      lines.push(`[${i}j]${fades.length ? fades.join(",") : "anull"}[a${i}]`);
    } else {
      const pan = (c.pan ?? 0) / 100;
      const fl = [...pre];
      if (Math.abs(pan) > 0.001) {
        const lg = (pan <= 0 ? 1 : 1 - pan).toFixed(3);
        const rg = (pan >= 0 ? 1 : 1 + pan).toFixed(3);
        fl.push(`pan=stereo|c0=${lg}*c0|c1=${rg}*c1`);
      }
      fl.push(...fades);
      lines.push(`[${e.idx}:a]${fl.join(",")}[a${i}]`);
    }
  });

  let hasAudio = false;
  if (aEntries.length === 1) {
    lines.push(`[a0]anull[aout]`);
    hasAudio = true;
  } else if (aEntries.length > 1) {
    lines.push(`${aEntries.map((_, i) => `[a${i}]`).join("")}amix=inputs=${aEntries.length}:normalize=0:dropout_transition=0[aout]`);
    hasAudio = true;
  }

  // ── Output (encode) settings: applied to the top-level render only ──
  const container = output?.container || "mp4";
  const baseCodec = output?.vcodec || "h264";
  const cpuCodec = VCODEC_MAP[baseCodec] || "libx264";
  // NVENC (GPU) encode only applies to H.264/H.265 (VP9 has no NVENC path here).
  const canNvenc = !!output?.hwEncode && (baseCodec === "h264" || baseCodec === "h265");
  const outW = Math.round(output?.width || W);
  const outH = Math.round(output?.height || H);
  const outFps = output?.fps || FPS;
  const crf = output?.crf;

  // Final rescale to the chosen output resolution if it differs from the canvas.
  let vmap = "[vout]";
  if (outW !== W || outH !== H) {
    lines.push(`[vout]scale=${outW}:${outH}:flags=bicubic[voutS]`);
    vmap = "[voutS]";
  }

  const rand = Math.random().toString(36).slice(2);
  const scriptPath = path.join(tmpDir, `graph_${rand}.txt`);
  const outPath = path.join(tmpDir, `render_${rand}.${container}`);
  await fs.writeFile(scriptPath, lines.join(";\n"), "utf8");

  // `-/filter_complex <file>` is the modern replacement for the deprecated
  // `-filter_complex_script`; it reads the filtergraph from the script file.
  const baseArgs = [...args, "-/filter_complex", scriptPath, "-map", vmap];
  if (hasAudio) baseArgs.push("-map", "[aout]");

  // Encode tail: `useNv` swaps libx26x (CPU) for *_nvenc (GPU). Built as a function
  // so a runtime NVENC failure can transparently retry on CPU (see below).
  const encodeTail = (useNv: boolean): string[] => {
    const a: string[] = ["-r", String(outFps)];
    if (useNv) {
      a.push(
        "-c:v", baseCodec === "h265" ? "hevc_nvenc" : "h264_nvenc",
        "-preset", "p5",            // p1 (fastest) … p7 (slowest/best); p5 = balanced
        "-rc", "vbr", "-cq", String(crf ?? 19), "-b:v", "0", // quality-targeted VBR (CQ ~ CRF)
        "-pix_fmt", "yuv420p",
      );
      if (baseCodec === "h265") a.push("-tag:v", "hvc1");
    } else if (cpuCodec === "libvpx-vp9") {
      a.push("-c:v", cpuCodec, "-b:v", "0", "-crf", String(crf ?? 31), "-pix_fmt", "yuv420p");
    } else {
      a.push("-c:v", cpuCodec, "-pix_fmt", "yuv420p", "-crf", String(crf ?? 18), "-preset", output?.preset || "medium");
      if (cpuCodec === "libx265") a.push("-tag:v", "hvc1");
    }
    if (hasAudio) {
      if (container === "webm") a.push("-c:a", "libopus", "-b:a", output?.audioBitrate || "192k");
      else a.push("-c:a", "aac", "-b:a", output?.audioBitrate || "192k");
    }
    if (container === "mp4" || container === "mov") a.push("-movflags", "+faststart");
    a.push("-t", f3(total), outPath);
    return a;
  };

  const ffmpeg = getFFmpegPath();
  let lastArgs: string[] = [];
  const runOnce = async (useNv: boolean) => {
    lastArgs = [...baseArgs, ...encodeTail(useNv)];
    if (progressJobId) {
      // Top-level render: report accurate progress as ffmpeg encodes.
      updateProgress(progressJobId, { phase: "rendering", percent: 0, totalSec: total, outTimeSec: 0, encoder: useNv ? "gpu" : "cpu" });
      await runFfmpegWithProgress(ffmpeg, lastArgs, progressJobId, total);
    } else {
      // Nested/compound pre-render (or no job), no per-clip progress needed.
      await execFileAsync(ffmpeg, lastArgs);
    }
  };
  try {
    try {
      await runOnce(canNvenc);
    } catch (nvErr) {
      // NVENC can fail at runtime (driver mismatch, encode-session limit, unsupported on
      // older GPUs). Fall back to CPU once so an export never hard-fails for that reason.
      if (canNvenc) {
        if (progressJobId) updateProgress(progressJobId, { message: "GPU encoder unavailable: retrying on CPU…" });
        await runOnce(false);
      } else {
        throw nvErr;
      }
    }
  } catch (e) {
    // Persist a full diagnostic log so failures (esp. filtergraph errors) are
    // recoverable: the truncated message alone usually only shows the banner.
    const ex = e as { stderr?: string; stdout?: string; code?: number; message?: string };
    const detail = (ex.stderr || ex.message || "").trim();
    const logLines = [
      `# Timeline export failed: ${new Date().toISOString()}`,
      `# ffmpeg exit code: ${ex.code}`,
      ``,
      `## ffmpeg binary`,
      ffmpeg,
      ``,
      `## arguments`,
      lastArgs.join(" "),
      ``,
      `## filter_complex_script`,
      lines.join(";\n"),
      ``,
      `## stderr`,
      ex.stderr || "(empty)",
      ``,
      `## stdout`,
      ex.stdout || "(empty)",
      "",
    ].join("\n");
    let logPath: string | undefined;
    try {
      const logDir = getScratchDir("logs");
      await fs.mkdir(logDir, { recursive: true });
      logPath = path.join(logDir, `export_${Date.now()}_${rand}.log`);
      await fs.writeFile(logPath, logLines, "utf8");
    } catch { /* logging is best-effort */ }
    // Extract the most relevant ffmpeg error line(s) for a concise headline.
    const errLines = detail.split(/\r?\n/).filter((l) =>
      /error|invalid|failed|no such|unable|not found|cannot|unrecognized|deprecated pixel|impossible/i.test(l));
    const headline = errLines.slice(-3).join(" | ") || `ffmpeg exited with code ${ex.code}`;
    const err = new Error(`Export failed: ${headline}`) as Error & { detail?: string; logPath?: string; code?: number };
    err.detail = detail;
    err.logPath = logPath;
    err.code = ex.code;
    throw err;
  }
  return outPath;
}

/**
 * Render ONLY the timeline's audio mixdown to a standalone audio file.
 * Reuses the exact per-clip audio filtergraph as the video export (per-clip fades,
 * pan, keyframed dB automation, pitch-preserving retime, adelay placement) plus the
 * same `amix`, then optionally loudness-normalizes (EBU R128) and pads trailing
 * silence so the file length matches the FULL timeline. Honors per-track mute/solo.
 */
async function renderAudioToFile(project: Project, tmpDir: string, audio: AudioExportSettings, progressJobId?: string): Promise<string> {
  const total = Math.max(0.1, project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0));
  const trackById = new Map(project.tracks.map((t) => [t.id, t]));
  const assetById = new Map(project.assets.map((a) => [a.id, a]));
  const anySolo = project.tracks.some((t) => t.kind === "audio" && t.solo);

  const args: string[] = ["-y"];
  let inputIdx = 0;
  const aEntries: { clip: Clip; idx: number }[] = [];
  for (const clip of project.clips) {
    if (clip.duration <= 0) continue;
    const track = trackById.get(clip.trackId);
    if (!track || track.kind !== "audio") continue;
    if (track.muted) continue;
    if (anySolo && !track.solo) continue;
    const asset = assetById.get(clip.assetId);
    if (!asset) continue;
    const inPath = asset.filePath || asset.src;
    if (!inPath) continue;
    args.push("-ss", f3(clip.trimIn), "-t", f3(clip.duration * clipSpeed(clip)), "-i", inPath);
    aEntries.push({ clip, idx: inputIdx });
    inputIdx++;
  }
  if (aEntries.length === 0) {
    const err = new Error("Timeline has no audible audio to export (no audio-track clips, or they're all muted).") as Error & { userError?: boolean };
    err.userError = true;
    throw err;
  }

  const lines: string[] = [];
  aEntries.forEach((e, i) => {
    const c = e.clip;
    const ms = Math.round(c.start * 1000);
    const afi = Math.max(c.fadeIn ?? 0, c.crossfadeFromPrev ?? 0);
    const afo = c.fadeOut ?? 0;
    const fades: string[] = [];
    if (afi > 0) fades.push(`afade=t=in:st=${f3(c.start)}:d=${f3(afi)}`);
    if (afo > 0) fades.push(`afade=t=out:st=${f3(c.start + c.duration - afo)}:d=${f3(afo)}`);

    const pre: string[] = ["aformat=channel_layouts=stereo:sample_rates=48000", "asetpts=PTS-STARTPTS"];
    for (const at of atempoChain(clipSpeed(c))) pre.push(at);
    if (ms > 0) pre.push(`adelay=${ms}:all=1`);
    pre.push(`volume='${volumeExpr(c)}':eval=frame`);

    if (hasKf(c, "pan")) {
      const panE = kfExpr(c, "pan", "t", (v) => v / 100);
      lines.push(`[${e.idx}:a]${pre.join(",")},channelsplit=channel_layout=stereo[${i}L][${i}R]`);
      lines.push(`[${i}L]volume='1-max(0,(${panE}))':eval=frame[${i}Lp]`);
      lines.push(`[${i}R]volume='1+min(0,(${panE}))':eval=frame[${i}Rp]`);
      lines.push(`[${i}Lp][${i}Rp]join=inputs=2:channel_layout=stereo[${i}j]`);
      lines.push(`[${i}j]${fades.length ? fades.join(",") : "anull"}[a${i}]`);
    } else {
      const pan = (c.pan ?? 0) / 100;
      const fl = [...pre];
      if (Math.abs(pan) > 0.001) {
        const lg = (pan <= 0 ? 1 : 1 - pan).toFixed(3);
        const rg = (pan >= 0 ? 1 : 1 + pan).toFixed(3);
        fl.push(`pan=stereo|c0=${lg}*c0|c1=${rg}*c1`);
      }
      fl.push(...fades);
      lines.push(`[${e.idx}:a]${fl.join(",")}[a${i}]`);
    }
  });

  if (aEntries.length === 1) lines.push(`[a0]anull[amix]`);
  else lines.push(`${aEntries.map((_, i) => `[a${i}]`).join("")}amix=inputs=${aEntries.length}:normalize=0:dropout_transition=0[amix]`);

  let alabel = "amix";
  if (audio.normalize === "ebu") {
    const I = Number.isFinite(audio.lufs as number) ? (audio.lufs as number) : -14;
    lines.push(`[amix]loudnorm=I=${I}:TP=-1.5:LRA=11[anorm]`);
    alabel = "anorm";
  }
  // Pad trailing silence so the exported track spans the FULL timeline length
  // (e.g. video that outlasts the music still yields a correctly-timed file).
  lines.push(`[${alabel}]apad[aout]`);

  const rand = Math.random().toString(36).slice(2);
  const ext = AUDIO_EXT[audio.format] || "wav";
  const scriptPath = path.join(tmpDir, `agraph_${rand}.txt`);
  const outPath = path.join(tmpDir, `audio_${rand}.${ext}`);
  await fs.writeFile(scriptPath, lines.join(";\n"), "utf8");

  const outArgs = [...args, "-/filter_complex", scriptPath, "-map", "[aout]", "-vn", ...audioEncodeTail(audio), "-t", f3(total), outPath];
  const ffmpeg = getFFmpegPath();
  try {
    if (progressJobId) {
      updateProgress(progressJobId, { phase: "rendering", percent: 0, totalSec: total, outTimeSec: 0 });
      await runFfmpegWithProgress(ffmpeg, outArgs, progressJobId, total);
    } else {
      await execFileAsync(ffmpeg, outArgs);
    }
  } catch (e) {
    const ex = e as { stderr?: string; stdout?: string; code?: number; message?: string };
    const detail = (ex.stderr || ex.message || "").trim();
    const logText = [
      `# Timeline AUDIO export failed: ${new Date().toISOString()}`,
      `# ffmpeg exit code: ${ex.code}`, ``,
      `## ffmpeg binary`, ffmpeg, ``,
      `## arguments`, outArgs.join(" "), ``,
      `## filter_complex_script`, lines.join(";\n"), ``,
      `## stderr`, ex.stderr || "(empty)", ``,
      `## stdout`, ex.stdout || "(empty)", "",
    ].join("\n");
    let logPath: string | undefined;
    try {
      const logDir = getScratchDir("logs");
      await fs.mkdir(logDir, { recursive: true });
      logPath = path.join(logDir, `audio_export_${Date.now()}_${rand}.log`);
      await fs.writeFile(logPath, logText, "utf8");
    } catch { /* logging is best-effort */ }
    const errLines = detail.split(/\r?\n/).filter((l) =>
      /error|invalid|failed|no such|unable|not found|cannot|unrecognized/i.test(l));
    const headline = errLines.slice(-3).join(" | ") || `ffmpeg exited with code ${ex.code}`;
    const err = new Error(`Audio export failed: ${headline}`) as Error & { detail?: string; logPath?: string; code?: number };
    err.detail = detail; err.logPath = logPath; err.code = ex.code;
    throw err;
  }
  return outPath;
}

export async function POST(req: NextRequest) {
  let project: Project;
  let output: ExportSettings | undefined;
  let audio: AudioExportSettings | undefined;
  let jobId = "";
  try {
    const body = await req.json();
    project = body.project as Project;
    output = body.output as ExportSettings | undefined;
    audio = body.audio as AudioExportSettings | undefined;
    jobId = typeof body.jobId === "string" ? body.jobId : "";
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!project?.clips?.length) {
    return NextResponse.json({ error: "Timeline is empty" }, { status: 400 });
  }

  // ── Audio-only export branch (Export Audio panel) ──
  if (audio?.format) {
    const ext = AUDIO_EXT[audio.format] || "wav";
    const mime = AUDIO_MIME[audio.format] || "audio/wav";
    const tmpDir = path.join(getScratchDir("timeline"), String(Date.now()));
    if (jobId) initProgress(jobId, 0);
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      const outPath = await renderAudioToFile(project, tmpDir, audio, jobId || undefined);
      if (jobId) finishProgress(jobId, "done");
      const stat = await fs.stat(outPath);
      const nodeStream = createReadStream(outPath);
      const webStream = new ReadableStream({
        start(controller) {
          nodeStream.on("data", (chunk) => controller.enqueue(chunk as Uint8Array));
          nodeStream.on("end", () => { controller.close(); fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); });
          nodeStream.on("error", (err) => { controller.error(err); fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); });
        },
      });
      return new Response(webStream, {
        status: 200,
        headers: {
          "Content-Type": mime,
          "Content-Disposition": `attachment; filename="timeline_audio.${ext}"`,
          "Content-Length": String(stat.size),
        },
      });
    } catch (err) {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      const e = err as Error & { detail?: string; logPath?: string; code?: number; userError?: boolean };
      const message = e instanceof Error ? e.message : "Audio export failed";
      if (jobId) finishProgress(jobId, "error", message);
      return NextResponse.json(
        { error: message, detail: e.detail, logPath: e.logPath, code: e.code },
        { status: e.userError ? 400 : 500 },
      );
    }
  }

  const container = output?.container || "mp4";
  const mime = CONTAINER_MIME[container] || "video/mp4";
  const tmpDir = path.join(getScratchDir("timeline"), String(Date.now()));
  if (jobId) initProgress(jobId, 0);
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    const outPath = await renderProjectToFile(project, tmpDir, output, jobId || undefined);
    if (jobId) finishProgress(jobId, "done");
    const stat = await fs.stat(outPath);
    const nodeStream = createReadStream(outPath);
    const webStream = new ReadableStream({
      start(controller) {
        nodeStream.on("data", (chunk) => controller.enqueue(chunk as Uint8Array));
        nodeStream.on("end", () => { controller.close(); fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); });
        nodeStream.on("error", (err) => { controller.error(err); fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); });
      },
    });

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="timeline_export.${container}"`,
        "Content-Length": String(stat.size),
      },
    });
  } catch (err) {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const e = err as Error & { detail?: string; logPath?: string; code?: number };
    const message = e instanceof Error ? e.message : "Export failed";
    if (jobId) finishProgress(jobId, "error", message);
    return NextResponse.json(
      { error: message, detail: e.detail, logPath: e.logPath, code: e.code },
      { status: 500 },
    );
  }
}
