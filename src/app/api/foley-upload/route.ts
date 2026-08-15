import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir, readdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST /api/foley-upload
 * Accepts a video file, probes it for fps/duration, extracts all frames
 * to ComfyUI/input/foley_staging/ for the Foley audio workflow.
 *
 * Body: multipart form with "video" file
 * Returns: { directory, frameCount, fps, duration, width, height }
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const videoFile = formData.get("video") as File;
    if (!videoFile) {
      return NextResponse.json({ error: "No video file provided" }, { status: 400 });
    }

    // Save uploaded video to staging area (kept for later merge with audio)
    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const stagingParent = path.join(comfyDir, "input");
    if (!existsSync(stagingParent)) await mkdir(stagingParent, { recursive: true });
    const inputPath = path.join(stagingParent, `foley_upload_video.mp4`);
    const buffer = Buffer.from(await videoFile.arrayBuffer());
    await writeFile(inputPath, buffer);

    // Probe video for fps & duration
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${inputPath}"`
    );
    const info = JSON.parse(stdout);
    const videoStream = info.streams?.find((s: any) => s.codec_type === "video");

    let fps = 24;
    if (videoStream?.r_frame_rate) {
      const parts = videoStream.r_frame_rate.split("/");
      fps = parts.length === 2 ? parseInt(parts[0]) / parseInt(parts[1]) : parseFloat(parts[0]);
    }
    fps = Math.round(fps * 100) / 100;
    const duration = parseFloat(info.format?.duration ?? "0");
    const width = videoStream?.width ?? 0;
    const height = videoStream?.height ?? 0;

    // Extract frames to foley_staging
    const stagingDir = path.join(comfyDir, "input", "foley_staging");

    if (!existsSync(stagingDir)) {
      await mkdir(stagingDir, { recursive: true });
    } else {
      // Clean old frames
      const oldFiles = await readdir(stagingDir);
      for (const f of oldFiles) await unlink(path.join(stagingDir, f));
    }

    // Cap extraction at 24fps: higher FPS floods the model with redundant frames
    const MAX_FOLEY_FPS = 24;
    const extractFps = fps > MAX_FOLEY_FPS ? MAX_FOLEY_FPS : fps;
    const fpsFilter = fps > MAX_FOLEY_FPS ? `-vf "fps=${MAX_FOLEY_FPS}"` : "-fps_mode vfr";

    await execAsync(
      `ffmpeg -y -i "${inputPath}" ${fpsFilter} "${path.join(stagingDir, "frame_%05d.png")}"`
    );

    const frames = (await readdir(stagingDir)).filter(f => f.endsWith(".png")).sort();

    return NextResponse.json({
      directory: stagingDir,
      videoPath: inputPath,
      frameCount: frames.length,
      fps: Math.round(extractFps * 100) / 100,
      duration: Math.round(duration * 10) / 10,
      width,
      height,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to process video" },
      { status: 500 }
    );
  }
}
