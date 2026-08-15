import { NextRequest, NextResponse } from "next/server";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const INSTALL_ROOT = path.resolve(process.cwd(), "..");
const COMFYUI_INPUT = path.join(INSTALL_ROOT, "ComfyUI", "input");

/**
 * POST /api/director/audio-slice
 * Slice a master audio file into segment chunks for Music Video mode.
 *
 * Body JSON:
 *   masterAudioFile: string    - ComfyUI input/ filename for the master audio
 *   segmentDuration: number    - [legacy] target duration per segment (seconds); used as the
 *                                fallback when sliceDuration/stepDuration are not supplied.
 *   sliceDuration?: number     - exact length of each slice (seconds). Should equal the
 *                                segment's video duration (numFrames/fps) so audio and video
 *                                line up at any frame rate.
 *   stepDuration?: number      - distance between consecutive slice START times (seconds).
 *                                When less than sliceDuration the slices overlap by that
 *                                difference; set it to (numFrames-1)/fps so that, after the
 *                                assembler trims the 1-frame guide overlap, the song stays
 *                                perfectly contiguous. Defaults to sliceDuration (no overlap).
 *
 * Returns: {
 *   totalDuration: number,
 *   segments: Array<{ audioFile: string, startTime: number, endTime: number, duration: number }>
 * }
 *
 * Each slice is saved as "audio/mv_slice_{timestamp}_{index}.wav" in ComfyUI input/.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { masterAudioFile, segmentDuration, sliceDuration, stepDuration } = body;

    if (!masterAudioFile) {
      return NextResponse.json({ error: "Missing masterAudioFile" }, { status: 400 });
    }
    // Resolve slice length and step. Prefer the frame-accurate values; fall back to the
    // legacy `segmentDuration` (which makes step == slice == segmentDuration, i.e. no overlap).
    const sliceLen = Number(sliceDuration ?? segmentDuration);
    const step = Number(stepDuration ?? sliceDuration ?? segmentDuration);
    if (!sliceLen || sliceLen <= 0) {
      return NextResponse.json({ error: "sliceDuration (or segmentDuration) must be > 0" }, { status: 400 });
    }
    if (!step || step <= 0) {
      return NextResponse.json({ error: "stepDuration must be > 0" }, { status: 400 });
    }

    // Resolve master audio path
    const srcPath = path.join(COMFYUI_INPUT, masterAudioFile);
    if (!existsSync(srcPath)) {
      return NextResponse.json({ error: `Master audio not found: ${masterAudioFile}` }, { status: 404 });
    }

    // Get total duration via ffprobe
    const ffprobe = getFFprobePath();
    const { stdout: durationStr } = await execAsync(
      `"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${srcPath}"`
    );
    const totalDuration = parseFloat(durationStr.trim());
    if (!totalDuration || totalDuration <= 0) {
      return NextResponse.json({ error: "Could not determine audio duration" }, { status: 500 });
    }

    // Ensure output directory exists
    const audioDir = path.join(COMFYUI_INPUT, "audio");
    mkdirSync(audioDir, { recursive: true });

    const ff = getFFmpegPath();
    const timestamp = Date.now();
    // Number of segments is driven by the STEP (advance), not the slice length: overlapping
    // slices still advance by `step`, so the count matches the trimmed timeline coverage.
    const segCount = Math.max(1, Math.ceil(totalDuration / step));
    const segments: Array<{ audioFile: string; startTime: number; endTime: number; duration: number }> = [];

    for (let i = 0; i < segCount; i++) {
      const startTime = i * step;
      if (startTime >= totalDuration) break;
      const endTime = Math.min(startTime + sliceLen, totalDuration);
      const duration = endTime - startTime;

      if (duration < 0.1) continue; // skip tiny trailing fragments

      const sliceName = `mv_slice_${timestamp}_${String(i).padStart(3, "0")}.wav`;
      const slicePath = path.join(audioDir, sliceName);

      await execAsync(
        `"${ff}" -y -ss ${startTime.toFixed(3)} -t ${duration.toFixed(3)} -i "${srcPath}" -ar 48000 -ac 2 "${slicePath}"`
      );

      if (!existsSync(slicePath)) {
        return NextResponse.json(
          { error: `Failed to create audio slice ${i + 1}` },
          { status: 500 }
        );
      }

      segments.push({
        audioFile: `audio/${sliceName}`,
        startTime: parseFloat(startTime.toFixed(3)),
        endTime: parseFloat(endTime.toFixed(3)),
        duration: parseFloat(duration.toFixed(3)),
      });
    }

    return NextResponse.json({ totalDuration, segments });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
