import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * POST /api/director/analyze-video
 * Accepts a video file upload via multipart form data.
 * Probes the video for metadata (fps, frame count, resolution, duration),
 * extracts the first frame, uploads it to ComfyUI input/, and returns
 * all metadata needed for the Audio-for-Video pipeline.
 *
 * FormData fields:
 *   file: File  - the video to analyze
 *
 * Returns: { fps, frameCount, width, height, duration, hasAudio,
 *            firstFrameFile, videoPath }
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const inputDir = path.join(comfyDir, "input");
    const v2aDir = path.join(inputDir, "v2a_staging");

    // Ensure directories exist
    if (!existsSync(v2aDir)) await mkdir(v2aDir, { recursive: true });

    // Save uploaded video to staging
    const timestamp = Date.now();
    const ext = path.extname(file.name) || ".mp4";
    const videoFilename = `v2a_source_${timestamp}${ext}`;
    const videoPath = path.join(v2aDir, videoFilename);
    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(videoPath, buffer);

    // Probe video with ffprobe
    const ffprobe = getFFprobePath();
    const { stdout } = await execAsync(
      `"${ffprobe}" -v quiet -print_format json -show_format -show_streams "${videoPath}"`
    );
    const info = JSON.parse(stdout);
    const videoStream = info.streams?.find(
      (s: Record<string, unknown>) => s.codec_type === "video"
    );
    const audioStream = info.streams?.find(
      (s: Record<string, unknown>) => s.codec_type === "audio"
    );

    if (!videoStream) {
      return NextResponse.json({ error: "No video stream found in file" }, { status: 400 });
    }

    // Parse FPS
    let fps = 24;
    if (videoStream.r_frame_rate) {
      const parts = (videoStream.r_frame_rate as string).split("/");
      fps = parts.length === 2
        ? parseInt(parts[0]) / parseInt(parts[1])
        : parseFloat(parts[0]);
    }
    fps = Math.round(fps * 100) / 100;

    const width = videoStream.width as number || 768;
    const height = videoStream.height as number || 512;
    const duration = parseFloat(info.format?.duration ?? "0");
    const hasAudio = !!audioStream;

    // Calculate frame count
    let frameCount = Math.round(fps * duration);
    if (videoStream.nb_frames && parseInt(videoStream.nb_frames as string) > 0) {
      frameCount = parseInt(videoStream.nb_frames as string);
    }

    // Extract first frame and save to ComfyUI input/
    const firstFrameFilename = `v2a_firstframe_${timestamp}.png`;
    const firstFramePath = path.join(inputDir, firstFrameFilename);

    const ff = getFFmpegPath();
    await execAsync(
      `"${ff}" -y -i "${videoPath}" -frames:v 1 -q:v 2 "${firstFramePath}"`
    );

    if (!existsSync(firstFramePath)) {
      return NextResponse.json(
        { error: "Failed to extract first frame" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      fps,
      frameCount,
      width,
      height,
      duration: Math.round(duration * 100) / 100,
      hasAudio,
      firstFrameFile: firstFrameFilename,
      videoPath,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Video analysis failed" },
      { status: 500 }
    );
  }
}
