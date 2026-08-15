import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * POST /api/director/prepare-v2a-chunk
 * Trims a source video to a specific time range at the target resolution and FPS,
 * saving the result to ComfyUI input/ for use by VHS_LoadVideoPath in V2A Fast Mode.
 *
 * The output video has exactly the right frame count for the LTX-2 model (8n+1 frames
 * at the target FPS). FFmpeg re-encodes at the target resolution and FPS.
 *
 * Body JSON:
 *   videoPath: string     - absolute path to the source video
 *   startTime: number     - chunk start time in seconds
 *   endTime: number       - chunk end time in seconds
 *   width: number         - target width (must be divisible by 32)
 *   height: number        - target height (must be divisible by 32)
 *   fps: number           - target FPS (typically 24)
 *   numFrames: number     - exact number of frames needed (8n+1)
 *
 * Returns: { chunkVideoPath: string, frameCount: number }
 *   chunkVideoPath is the absolute path to the trimmed video in ComfyUI input/
 */
export async function POST(req: NextRequest) {
  try {
    const { videoPath, startTime, endTime, width, height, fps, numFrames } = await req.json();

    if (!videoPath || typeof startTime !== "number" || typeof endTime !== "number") {
      return NextResponse.json(
        { error: "Missing videoPath, startTime, or endTime" },
        { status: 400 }
      );
    }

    if (!existsSync(videoPath)) {
      return NextResponse.json(
        { error: `Video not found: ${videoPath}` },
        { status: 404 }
      );
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const inputDir = path.join(comfyDir, "input");
    if (!existsSync(inputDir)) await mkdir(inputDir, { recursive: true });

    const ts = Date.now();
    const chunkFile = `v2a_chunk_${ts}.mp4`;
    const chunkPath = path.join(inputDir, chunkFile);

    const ff = getFFmpegPath();
    const duration = endTime - startTime;
    const targetWidth = width || 768;
    const targetHeight = height || 512;
    const targetFps = fps || 24;
    const targetFrames = numFrames || 97;

    // FFmpeg: seek to startTime, extract duration, re-encode at target resolution/FPS,
    // limit to exact frame count. Using -ss before -i for fast seeking.
    // Scale + pad to exact dimensions (handles aspect ratio mismatches).
    const cmd = [
      `"${ff}"`,
      "-y",
      `-ss ${startTime.toFixed(3)}`,
      `-i "${videoPath}"`,
      `-t ${duration.toFixed(3)}`,
      `-vf "fps=${targetFps},scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black"`,
      `-frames:v ${targetFrames}`,
      "-c:v libx264",
      "-preset ultrafast",
      "-crf 18",
      "-an",
      `-r ${targetFps}`,
      `"${chunkPath}"`,
    ].join(" ");

    await execAsync(cmd);

    if (!existsSync(chunkPath)) {
      return NextResponse.json(
        { error: "Failed to prepare V2A chunk video" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      chunkVideoPath: chunkPath,
      chunkVideoFile: chunkFile,
      frameCount: targetFrames,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "V2A chunk preparation failed" },
      { status: 500 }
    );
  }
}
