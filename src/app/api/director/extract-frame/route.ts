import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const dynamic = "force-dynamic";

/**
 * POST /api/director/extract-frame
 * Extracts the last (or first) frame from a ComfyUI output video and saves it
 * as a PNG in ComfyUI/input/ for I2V chaining.
 *
 * Body JSON:
 *   videoUrl: string          - ComfyUI output URL (e.g. /view?filename=...)
 *   framePosition: "last" | "first"  - which frame to extract (default: "last")
 *
 * Returns: { filename: string } - the filename in ComfyUI/input/
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { videoUrl, framePosition = "last" } = body;

    if (!videoUrl) {
      return NextResponse.json({ error: "Missing videoUrl" }, { status: 400 });
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    let videoPath: string;

    // Parse ComfyUI URL to file path
    try {
      const url = new URL(videoUrl, "http://localhost");
      const filename = url.searchParams.get("filename");
      const subfolder = url.searchParams.get("subfolder") || "";
      const type = url.searchParams.get("type") || "output";

      if (!filename) {
        return NextResponse.json({ error: "Could not parse filename from videoUrl" }, { status: 400 });
      }

      videoPath = path.join(comfyDir, type, subfolder, filename);
    } catch {
      videoPath = videoUrl;
    }

    if (!existsSync(videoPath)) {
      return NextResponse.json({ error: `Video file not found: ${videoPath}` }, { status: 404 });
    }

    const ff = getFFmpegPath();
    const outputFilename = `director_frame_${Date.now()}.png`;
    const outputPath = path.join(comfyDir, "input", outputFilename);

    if (framePosition === "first") {
      // Extract first frame
      await execAsync(
        `"${ff}" -y -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`
      );
    } else {
      // Extract last frame: seek to near end, grab last frame
      // First get duration
      const ffprobe = ff.replace("ffmpeg", "ffprobe");
      let duration = 0;
      try {
        const { stdout } = await execAsync(
          `"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`
        );
        duration = parseFloat(stdout.trim()) || 0;
      } catch { /* fallback to sseof */ }

      if (duration > 0.5) {
        // Seek to 0.1s before end to grab last frame
        await execAsync(
          `"${ff}" -y -sseof -0.1 -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`
        );
      } else {
        // Very short video, just grab last frame without seeking
        await execAsync(
          `"${ff}" -y -i "${videoPath}" -vf "select=eq(n\\,0)" -vframes 1 -q:v 2 "${outputPath}"`
        );
      }

      // If sseof approach didn't work, try alternative
      if (!existsSync(outputPath)) {
        await execAsync(
          `"${ff}" -y -i "${videoPath}" -vf "select=gte(n\\,0)" -vframes 1 -update 1 -q:v 2 "${outputPath}"`
        );
      }
    }

    if (!existsSync(outputPath)) {
      return NextResponse.json({ error: "Frame extraction failed" }, { status: 500 });
    }

    return NextResponse.json({ filename: outputFilename });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Frame extraction failed" },
      { status: 500 }
    );
  }
}
