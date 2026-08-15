/**
 * Video Pipeline API client: talks to /api/video-process routes.
 */

export interface VideoProbeResult {
  inputPath: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  codec: string;
}

export interface FrameExtractionResult {
  framesDir: string;
  sessionId: string;
  frameCount: number;
  frames: string[];
}

export interface VideoSegment {
  startFrame: number;
  endFrame: number;
  prompt: string;
  negativePrompt: string;
  denoise: number;
}

export interface VideoPipelineSession {
  sessionId: string;
  probe: VideoProbeResult;
  trimStart: number;
  trimEnd: number;
  extraction: FrameExtractionResult | null;
  audioPath: string | null;
  segments: VideoSegment[];
}

export async function probeVideo(file: File): Promise<VideoProbeResult> {
  const form = new FormData();
  form.append("action", "probe");
  form.append("video", file);
  const res = await fetch("/api/video-process", { method: "POST", body: form });
  if (!res.ok) throw new Error(`Probe failed: ${res.status}`);
  return res.json();
}

export async function extractFrames(
  inputPath: string,
  startTime: number,
  endTime: number,
  sessionId: string
): Promise<FrameExtractionResult> {
  const form = new FormData();
  form.append("action", "extract-frames");
  form.append("inputPath", inputPath);
  form.append("startTime", String(startTime));
  form.append("endTime", String(endTime));
  form.append("sessionId", sessionId);
  const res = await fetch("/api/video-process", { method: "POST", body: form });
  if (!res.ok) throw new Error(`Frame extraction failed: ${res.status}`);
  return res.json();
}

export async function extractAudio(
  inputPath: string,
  startTime: number,
  endTime: number,
  sessionId: string
): Promise<{ audioPath: string }> {
  const form = new FormData();
  form.append("action", "extract-audio");
  form.append("inputPath", inputPath);
  form.append("startTime", String(startTime));
  form.append("endTime", String(endTime));
  form.append("sessionId", sessionId);
  const res = await fetch("/api/video-process", { method: "POST", body: form });
  if (!res.ok) throw new Error(`Audio extraction failed: ${res.status}`);
  return res.json();
}

export async function reassembleVideo(
  framesDir: string,
  audioPath: string | null,
  fps: number,
  sessionId: string
): Promise<{ outputPath: string }> {
  const form = new FormData();
  form.append("action", "reassemble");
  form.append("framesDir", framesDir);
  if (audioPath) form.append("audioPath", audioPath);
  form.append("fps", String(fps));
  form.append("sessionId", sessionId);
  const res = await fetch("/api/video-process", { method: "POST", body: form });
  if (!res.ok) throw new Error(`Reassembly failed: ${res.status}`);
  return res.json();
}

export function getFrameUrl(framePath: string): string {
  return `/api/video-process?file=${encodeURIComponent(framePath)}`;
}

/**
 * Calculate batch plan for cascaded AnimateDiff generation.
 * AnimateDiff max is 16 frames per batch. Last frame of each batch → first frame of next.
 * So effective new frames per batch = 15 (first frame is carried over).
 */
export function planBatches(totalFrames: number, batchSize: number = 16): Array<{ startFrame: number; endFrame: number; initFrame: number | null }> {
  const batches: Array<{ startFrame: number; endFrame: number; initFrame: number | null }> = [];
  let pos = 0;
  while (pos < totalFrames) {
    const end = Math.min(pos + batchSize, totalFrames);
    batches.push({
      startFrame: pos,
      endFrame: end - 1,
      initFrame: pos > 0 ? pos - 1 : null, // use previous batch's last frame as init
    });
    // Advance by batchSize-1 so last frame overlaps with next batch's first
    pos += batchSize - 1;
    if (pos >= totalFrames - 1) break;
  }
  return batches;
}

export function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
