import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/director/extract-keyframes
 * Extracts multiple keyframes from a video at specified frame indices.
 * Saves them to ComfyUI/input/ for use with Z-Image I2I refinement.
 *
 * Body JSON:
 *   videoFile: string        - path relative to ComfyUI/output/ (e.g. "LTX2/video.mp4")
 *   frameIndices: number[]   - 0-based frame indices to extract
 *   frameRate: number        - video frame rate (for timestamp calculation)
 *
 * Returns: { keyframes: [{ frameFile: string, frameIdx: number, timestamp: number }] }
 */
export async function POST(req: NextRequest) {
  try {
    const { videoFile, frameIndices, frameRate } = await req.json();

    if (!videoFile || !Array.isArray(frameIndices) || !frameRate) {
      return NextResponse.json(
        { error: "Missing videoFile, frameIndices, or frameRate" },
        { status: 400 }
      );
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    let videoPath: string;

    // Handle ComfyUI-style URLs (e.g. /api/comfyui/view?filename=...&subfolder=...&type=output)
    if (videoFile.includes("?") || videoFile.includes("filename=")) {
      try {
        const parsed = new URL(videoFile, "http://localhost");
        const filename = parsed.searchParams.get("filename");
        const subfolder = parsed.searchParams.get("subfolder") || "";
        const type = parsed.searchParams.get("type") || "output";
        if (!filename) {
          return NextResponse.json({ error: "Could not parse filename from URL" }, { status: 400 });
        }
        videoPath = path.join(comfyDir, type, subfolder, filename);
      } catch {
        videoPath = path.join(comfyDir, "output", videoFile);
      }
    } else {
      videoPath = path.join(comfyDir, "output", videoFile);
    }

    if (!existsSync(videoPath)) {
      return NextResponse.json(
        { error: `Video not found: ${videoPath}` },
        { status: 404 }
      );
    }

    const inputDir = path.join(comfyDir, "input");
    if (!existsSync(inputDir)) await mkdir(inputDir, { recursive: true });

    const ff = getFFmpegPath();
    const ts = Date.now();
    const keyframes: { frameFile: string; frameIdx: number; timestamp: number }[] = [];

    // Extract frames sequentially to avoid FFmpeg contention
    for (const frameIdx of frameIndices) {
      const timestamp = frameIdx / frameRate;
      const frameFile = `zrefine_${ts}_f${frameIdx}.png`;
      const framePath = path.join(inputDir, frameFile);

      await execAsync(
        `"${ff}" -y -ss ${timestamp.toFixed(3)} -i "${videoPath}" -frames:v 1 -q:v 2 "${framePath}"`
      );

      if (!existsSync(framePath)) {
        // Fallback: try without seeking (for very short videos or frame 0)
        await execAsync(
          `"${ff}" -y -i "${videoPath}" -vf "select=eq(n\\,${frameIdx})" -fps_mode vfr -frames:v 1 -q:v 2 "${framePath}"`
        );
      }

      if (existsSync(framePath)) {
        keyframes.push({ frameFile, frameIdx, timestamp });
      }
    }

    if (keyframes.length === 0) {
      return NextResponse.json(
        { error: "No frames could be extracted" },
        { status: 500 }
      );
    }

    return NextResponse.json({ keyframes });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Keyframe extraction failed" },
      { status: 500 }
    );
  }
}
