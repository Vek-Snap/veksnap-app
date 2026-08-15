import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * POST /api/director/extract-frame-at
 * Extracts a single frame from a video at a specified timestamp.
 * Saves it to ComfyUI input/ for use as an I2V source image.
 *
 * Body JSON:
 *   videoPath: string    - filesystem path to the source video
 *   timestamp: number    - time in seconds to extract the frame at
 *
 * Returns: { frameFile: string } - filename in ComfyUI input/
 */
export async function POST(req: NextRequest) {
  try {
    const { videoPath, timestamp } = await req.json();

    if (!videoPath || typeof timestamp !== "number") {
      return NextResponse.json(
        { error: "Missing videoPath or timestamp" },
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
    const frameFile = `v2a_frame_${ts}_${Math.round(timestamp * 100)}.png`;
    const framePath = path.join(inputDir, frameFile);

    const ff = getFFmpegPath();
    await execAsync(
      `"${ff}" -y -ss ${timestamp.toFixed(3)} -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}"`
    );

    if (!existsSync(framePath)) {
      return NextResponse.json(
        { error: "Failed to extract frame at timestamp" },
        { status: 500 }
      );
    }

    return NextResponse.json({ frameFile });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Frame extraction failed" },
      { status: 500 }
    );
  }
}
