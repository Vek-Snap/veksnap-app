import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { mkdir, readdir, unlink } from "fs/promises";
import path from "path";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST /api/director/foley-stage
 * Extracts frames from a video (ComfyUI output URL or director output) into
 * foley_staging/ for the HunyuanVideo-Foley workflow.
 *
 * Body JSON:
 *   videoUrl: string   - proxy URL like /api/comfyui/view?filename=...&type=output
 *                         OR a director/concatenated output path
 *
 * Returns: { directory, frameCount, fps, duration }
 */
export async function POST(req: NextRequest) {
  try {
    const { videoUrl } = await req.json();
    if (!videoUrl) {
      return NextResponse.json({ error: "Missing videoUrl" }, { status: 400 });
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    let videoPath: string;

    // Parse the URL to resolve to filesystem path
    try {
      const parsed = new URL(videoUrl, "http://localhost");
      const filename = parsed.searchParams.get("filename");
      const subfolder = parsed.searchParams.get("subfolder") || "";
      const type = parsed.searchParams.get("type") || "output";
      if (filename) {
        videoPath = path.join(comfyDir, type, subfolder, filename);
      } else {
        videoPath = videoUrl;
      }
    } catch {
      videoPath = videoUrl;
    }

    if (!existsSync(videoPath)) {
      return NextResponse.json({ error: `Video not found: ${videoPath}` }, { status: 404 });
    }

    // Probe video
    const ffprobe = getFFprobePath();
    const { stdout } = await execAsync(
      `"${ffprobe}" -v quiet -print_format json -show_format -show_streams "${videoPath}"`
    );
    const info = JSON.parse(stdout);
    const videoStream = info.streams?.find((s: Record<string, unknown>) => s.codec_type === "video");

    let fps = 24;
    if (videoStream?.r_frame_rate) {
      const parts = (videoStream.r_frame_rate as string).split("/");
      fps = parts.length === 2 ? parseInt(parts[0]) / parseInt(parts[1]) : parseFloat(parts[0]);
    }
    fps = Math.round(fps * 100) / 100;
    const duration = parseFloat(info.format?.duration ?? "0");

    // Extract frames to foley_staging
    const stagingDir = path.join(comfyDir, "input", "foley_staging");
    if (!existsSync(stagingDir)) {
      await mkdir(stagingDir, { recursive: true });
    } else {
      const oldFiles = await readdir(stagingDir);
      for (const f of oldFiles) await unlink(path.join(stagingDir, f));
    }

    // Cap at 24fps for foley
    const MAX_FOLEY_FPS = 24;
    const extractFps = fps > MAX_FOLEY_FPS ? MAX_FOLEY_FPS : fps;
    const fpsFilter = fps > MAX_FOLEY_FPS ? `-vf "fps=${MAX_FOLEY_FPS}"` : "-fps_mode vfr";

    const ff = getFFmpegPath();
    await execAsync(
      `"${ff}" -y -i "${videoPath}" ${fpsFilter} "${path.join(stagingDir, "frame_%05d.png")}"`
    );

    const frames = (await readdir(stagingDir)).filter(f => f.endsWith(".png")).sort();

    return NextResponse.json({
      directory: stagingDir,
      frameCount: frames.length,
      fps: Math.round(extractFps * 100) / 100,
      duration: Math.round(duration * 10) / 10,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to stage frames for foley" },
      { status: 500 }
    );
  }
}
