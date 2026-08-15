// Timeline Editor: media ingest + Web Audio peak extraction.
// Phase 1 imports browser File objects; src is an object URL for in-app preview.
// Export (Phase 4) reconciles to absolute ComfyUI/local paths.

"use client";

import { TimelineAsset, AssetKind, timelineId } from "./types";

const IMAGE_STILL_DURATION = 5; // seconds a still image occupies by default

function kindFromFile(file: File): AssetKind {
  const t = file.type;
  if (t.startsWith("video")) return "video";
  if (t.startsWith("audio")) return "audio";
  if (t.startsWith("image")) return "image";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "mkv", "avi", "m4v"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "flac", "m4a", "aac"].includes(ext)) return "audio";
  return "image";
}

// Waveform resolution: ~peak buckets per second of audio. High enough that a
// zoomed-in clip shows fine, professional-grade detail (sampled per-pixel at draw
// time). Capped so very long clips don't bloat the project JSON unreasonably.
const PEAK_BUCKETS_PER_SEC = 300;
const MIN_PEAK_BUCKETS = 1000;
const MAX_PEAK_BUCKETS = 20000;

/** Decode an audio buffer into normalized (0..1) peak buckets + duration. */
export async function decodeAudioPeaks(
  arrayBuffer: ArrayBuffer,
  buckets?: number,
): Promise<{ peaks: number[]; duration: number }> {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const audioBuf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    // Mix down all channels so the waveform reflects the full signal.
    const chCount = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    const channels: Float32Array[] = [];
    for (let c = 0; c < chCount; c++) channels.push(audioBuf.getChannelData(c));

    const targetBuckets = Math.round(
      buckets ?? Math.min(MAX_PEAK_BUCKETS, Math.max(MIN_PEAK_BUCKETS, audioBuf.duration * PEAK_BUCKETS_PER_SEC)),
    );
    const block = Math.max(1, Math.floor(len / targetBuckets));
    const peaks: number[] = [];
    let max = 0;
    for (let i = 0; i < targetBuckets; i++) {
      const start = i * block;
      let peak = 0;
      for (let j = 0; j < block; j++) {
        const idx = start + j;
        if (idx >= len) break;
        let s = 0;
        for (let c = 0; c < chCount; c++) s += channels[c][idx] || 0;
        const v = Math.abs(s / chCount);
        if (v > peak) peak = v;
      }
      peaks.push(peak);
      if (peak > max) max = peak;
    }
    if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
    return { peaks, duration: audioBuf.duration };
  } finally {
    void ctx.close();
  }
}

/**
 * Persist a browser File to the server working dir so ffmpeg (export + frame
 * previews) has a real path, blob: URLs are not readable server-side.
 * Returns the absolute server path, or undefined if the upload failed.
 */
interface UploadResult { path?: string; width?: number; height?: number; fps?: number; duration?: number }

export async function uploadFileForRender(file: File): Promise<UploadResult> {
  try {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const res = await fetch("/api/timeline-upload", { method: "POST", body: fd });
    if (!res.ok) return {};
    return (await res.json()) as UploadResult;
  } catch {
    return {};
  }
}

function getVideoDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => resolve(0);
    v.src = url;
  });
}

/**
 * Build the TimelineAsset(s) for a user-imported File.
 * A video with a decodable audio track yields TWO assets: the video and a hidden
 * extracted-audio companion (linked), so the timeline can place a synced A/V pair.
 */
export async function buildAssetsFromFile(file: File): Promise<TimelineAsset[]> {
  const kind = kindFromFile(file);
  const src = URL.createObjectURL(file);
  // Upload once; export + frame previews need a server-side path (ffmpeg can't read blob:).
  const up = await uploadFileForRender(file);
  const filePath = up.path;

  if (kind === "audio") {
    const buf = await file.arrayBuffer();
    const { peaks, duration } = await decodeAudioPeaks(buf);
    return [{ id: timelineId("asset"), kind, name: file.name, src, filePath, duration, peaks }];
  }

  if (kind === "video") {
    // Decode the audio track FIRST, the decoded buffer's length is the only
    // reliable duration for containers that omit it. MediaRecorder / Chrome WebM
    // (and many recorder outputs) report `Duration: N/A` to ffprobe AND yield
    // `Infinity` from an HTMLMediaElement, so without this we fell back to an
    // arbitrary 5s default that truncated the clip (the audio was unreachable
    // past 5s) and squeezed the full waveform into a too-short clip.
    let audioPeaks: number[] | undefined;
    let audioDuration = 0;
    try {
      const buf = await file.arrayBuffer();
      const decoded = await decodeAudioPeaks(buf);
      audioDuration = Number.isFinite(decoded.duration) ? decoded.duration : 0;
      if (decoded.peaks.some((p) => p > 0.001)) audioPeaks = decoded.peaks;
    } catch {
      // no decodable audio track: video-only asset
    }

    // ffprobe only reports width/height when a real video stream exists. If it
    // found none, this is actually an audio-only file that merely carries a
    // video-ish extension (e.g. an audio-only `.webm` recording). Import it as a
    // single AUDIO asset: not a blank video + audio pair.
    const hasVideoStream = !!(up.width && up.height);
    if (!hasVideoStream && audioPeaks) {
      return [{
        id: timelineId("asset"), kind: "audio", name: file.name, src, filePath,
        duration: audioDuration || IMAGE_STILL_DURATION, peaks: audioPeaks,
      }];
    }

    // Prefer the container duration, then the element's, then the decoded audio
    // length; only fall back to a fixed default when nothing else is known.
    const duration = up.duration || (await getVideoDuration(src)) || audioDuration || 5;
    const videoId = timelineId("asset");
    const companion: TimelineAsset | undefined = audioPeaks
      ? {
          id: timelineId("asset"),
          kind: "audio",
          name: `${file.name} (audio)`,
          src,
          filePath,
          duration,
          peaks: audioPeaks,
          fromVideoAssetId: videoId,
        }
      : undefined;
    const video: TimelineAsset = {
      id: videoId,
      kind: "video",
      name: file.name,
      src,
      filePath,
      duration,
      width: up.width,
      height: up.height,
      fps: up.fps,
      peaks: companion?.peaks,
      linkedAudioAssetId: companion?.id,
    };
    return companion ? [video, companion] : [video];
  }

  return [{ id: timelineId("asset"), kind, name: file.name, src, filePath, duration: IMAGE_STILL_DURATION, thumb: src }];
}
