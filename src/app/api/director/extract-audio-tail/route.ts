import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * POST /api/director/extract-audio-tail
 * Extracts the last N seconds of audio from a video file (or audio file),
 * saves it as a WAV in ComfyUI input/ for use as overlap conditioning.
 *
 * Body JSON:
 *   sourcePath: string    - filesystem path to the source video/audio
 *   duration: number      - how many seconds from the end to extract
 *
 * Returns: { audioFile: string, actualDuration: number }
 *   audioFile: filename in ComfyUI input/
 *   actualDuration: actual duration of the extracted audio (may be shorter if source is shorter)
 */
export async function POST(req: NextRequest) {
  try {
    const { sourcePath, duration } = await req.json();

    if (!sourcePath || typeof duration !== "number" || duration <= 0) {
      return NextResponse.json(
        { error: "Missing sourcePath or invalid duration" },
        { status: 400 }
      );
    }

    if (!existsSync(sourcePath)) {
      return NextResponse.json(
        { error: `Source not found: ${sourcePath}` },
        { status: 404 }
      );
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const inputDir = path.join(comfyDir, "input");
    if (!existsSync(inputDir)) await mkdir(inputDir, { recursive: true });

    const ff = getFFmpegPath();

    // Get total duration of the source
    let totalDuration = 0;
    try {
      const { stdout } = await execAsync(
        `"${ff}" -i "${sourcePath}" 2>&1`
      );
      const match = stdout.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (match) {
        totalDuration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
      }
    } catch (err) {
      // ffmpeg -i without output returns non-zero; parse from stderr
      const errStr = err instanceof Error ? (err as Error & { stderr?: string }).stderr || err.message : "";
      const match = errStr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      if (match) {
        totalDuration = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
      }
    }

    if (totalDuration <= 0) {
      return NextResponse.json(
        { error: "Could not determine source duration" },
        { status: 500 }
      );
    }

    // Calculate start time for the tail extraction
    const actualDuration = Math.min(duration, totalDuration);
    const startTime = Math.max(0, totalDuration - actualDuration);

    const ts = Date.now();
    const audioFile = `v2a_overlap_${ts}.wav`;
    const audioPath = path.join(inputDir, audioFile);

    // Extract the last N seconds as WAV (PCM 16-bit, mono, 44100Hz for LTX-2 audio VAE)
    await execAsync(
      `"${ff}" -y -ss ${startTime.toFixed(3)} -i "${sourcePath}" -t ${actualDuration.toFixed(3)} -vn -acodec pcm_s16le -ar 44100 -ac 1 "${audioPath}"`
    );

    if (!existsSync(audioPath)) {
      return NextResponse.json(
        { error: "Failed to extract audio tail" },
        { status: 500 }
      );
    }

    return NextResponse.json({ audioFile, actualDuration });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Audio tail extraction failed" },
      { status: 500 }
    );
  }
}
