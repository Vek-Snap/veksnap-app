import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir, readdir, unlink } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { getScratchDir } from "@/lib/scratch-dir";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";

// Next.js App Router: allow large body for frame uploads, long timeout for FFmpeg
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Temp directory for video processing
// Install-local scratch, NOT os.tmpdir() (see src/lib/scratch-dir.ts), this holds the
// user's video content. Swept by the `appScratch` cleanup category.
const WORK_DIR = getScratchDir("video-pipeline");

async function ensureWorkDir(subdir?: string) {
  const dir = subdir ? path.join(WORK_DIR, subdir) : WORK_DIR;
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * POST /api/video-process
 * Actions: probe, extract-frames, extract-audio, reassemble
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const action = formData.get("action") as string;

    if (action === "probe") {
      // Get video metadata (duration, fps, resolution, has audio)
      const videoFile = formData.get("video") as File;
      if (!videoFile) return NextResponse.json({ error: "No video file" }, { status: 400 });

      const dir = await ensureWorkDir();
      const inputPath = path.join(dir, "input_" + Date.now() + ".mp4");
      const buffer = Buffer.from(await videoFile.arrayBuffer());
      await writeFile(inputPath, buffer);

      const ff = getFFmpegPath();
      const ffprobe = ff.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
      const { stdout } = await execAsync(
        `"${ffprobe}" -v quiet -print_format json -show_format -show_streams "${inputPath}"`
      );
      const info = JSON.parse(stdout);
      const videoStream = info.streams?.find((s: any) => s.codec_type === "video");
      const audioStream = info.streams?.find((s: any) => s.codec_type === "audio");

      // Parse frame rate (e.g. "30000/1001" → 29.97, or "30/1" → 30)
      let fps = 30;
      if (videoStream?.r_frame_rate) {
        const parts = videoStream.r_frame_rate.split("/");
        fps = parts.length === 2 ? parseInt(parts[0]) / parseInt(parts[1]) : parseFloat(parts[0]);
      }

      return NextResponse.json({
        inputPath,
        duration: parseFloat(info.format?.duration ?? "0"),
        fps: Math.round(fps * 100) / 100,
        width: videoStream?.width ?? 0,
        height: videoStream?.height ?? 0,
        hasAudio: !!audioStream,
        codec: videoStream?.codec_name ?? "unknown",
      });
    }

    if (action === "extract-frames") {
      // Extract frames from video between start and end times
      const inputPath = formData.get("inputPath") as string;
      const startTime = parseFloat(formData.get("startTime") as string || "0");
      const endTime = parseFloat(formData.get("endTime") as string || "0");
      const sessionId = formData.get("sessionId") as string || Date.now().toString();

      if (!inputPath || !existsSync(inputPath)) {
        return NextResponse.json({ error: "Input file not found" }, { status: 400 });
      }

      const framesDir = await ensureWorkDir(`frames_${sessionId}`);

      // Clean any existing frames
      const existing = await readdir(framesDir);
      for (const f of existing) await unlink(path.join(framesDir, f));

      const duration = endTime > startTime ? endTime - startTime : undefined;
      const durationArg = duration ? `-t ${duration}` : "";
      const startArg = startTime > 0 ? `-ss ${startTime}` : "";

      const ff = getFFmpegPath();
      await execAsync(
        `"${ff}" -y ${startArg} -i "${inputPath}" ${durationArg} -fps_mode vfr "${path.join(framesDir, "frame_%05d.png")}"`
      );

      const frames = (await readdir(framesDir)).filter(f => f.endsWith(".png")).sort();

      return NextResponse.json({
        framesDir,
        sessionId,
        frameCount: frames.length,
        frames: frames.map(f => path.join(framesDir, f)),
      });
    }

    if (action === "extract-audio") {
      // Extract audio track from video
      const inputPath = formData.get("inputPath") as string;
      const startTime = parseFloat(formData.get("startTime") as string || "0");
      const endTime = parseFloat(formData.get("endTime") as string || "0");
      const sessionId = formData.get("sessionId") as string || Date.now().toString();

      if (!inputPath || !existsSync(inputPath)) {
        return NextResponse.json({ error: "Input file not found" }, { status: 400 });
      }

      const dir = await ensureWorkDir();
      const audioPath = path.join(dir, `audio_${sessionId}.aac`);

      const duration = endTime > startTime ? endTime - startTime : undefined;
      const durationArg = duration ? `-t ${duration}` : "";
      const startArg = startTime > 0 ? `-ss ${startTime}` : "";

      const ff = getFFmpegPath();
      await execAsync(
        `"${ff}" -y ${startArg} -i "${inputPath}" ${durationArg} -vn -acodec copy "${audioPath}"`
      );

      return NextResponse.json({ audioPath });
    }

    if (action === "reassemble") {
      // Reassemble processed frames + audio → MP4
      const framesDir = formData.get("framesDir") as string;
      const audioPath = formData.get("audioPath") as string | null;
      const fps = parseFloat(formData.get("fps") as string || "30");
      const sessionId = formData.get("sessionId") as string || Date.now().toString();

      if (!framesDir || !existsSync(framesDir)) {
        return NextResponse.json({ error: "Frames directory not found" }, { status: 400 });
      }

      const dir = await ensureWorkDir();
      const outputPath = path.join(dir, `output_${sessionId}.mp4`);

      const audioArg = audioPath && existsSync(audioPath)
        ? `-i "${audioPath}" -c:a aac -shortest`
        : "";

      const ff = getFFmpegPath();
      await execAsync(
        `"${ff}" -y -framerate ${fps} -i "${path.join(framesDir, "frame_%05d.png")}" ${audioArg} -c:v libx264 -pix_fmt yuv420p -crf 18 "${outputPath}"`
      );

      return NextResponse.json({ outputPath });
    }

    if (action === "reassemble-comfyui") {
      // Fetch frames directly from ComfyUI server-side, write to disk, reassemble with audio.
      // This avoids uploading hundreds of PNGs through the client.
      const sessionId = formData.get("sessionId") as string || Date.now().toString();
      const fps = parseFloat(formData.get("fps") as string || "30");
      const audioPath = formData.get("audioPath") as string | null;
      // JSON array of { filename, subfolder, type } objects
      const imagesJson = formData.get("images") as string;

      if (!imagesJson) {
        return NextResponse.json({ error: "No images list provided" }, { status: 400 });
      }

      const images: Array<{ filename: string; subfolder: string; type: string }> = JSON.parse(imagesJson);
      if (!images.length) {
        return NextResponse.json({ error: "Empty images list" }, { status: 400 });
      }

      const outFramesDir = await ensureWorkDir(`output_frames_${sessionId}`);

      // Clean existing frames
      const existing = await readdir(outFramesDir);
      for (const f of existing) await unlink(path.join(outFramesDir, f));

      // Fetch each frame from ComfyUI and write to disk
      // Falls back to direct disk read if HTTP proxy fails (e.g. TinyWall blocking loopback)
      const COMFYUI = COMFYUI_HTTP;
      const COMFYUI_ROOT = path.resolve(process.cwd(), "..", "ComfyUI");
      const TYPE_DIR_MAP: Record<string, string> = { output: "output", temp: "temp", input: "input" };
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const frameName = `frame_${String(i + 1).padStart(5, "0")}.png`;
        const framePath = path.join(outFramesDir, frameName);
        let fetched = false;

        // Try HTTP proxy first
        try {
          const params = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" });
          const res = await fetch(`${COMFYUI}/view?${params.toString()}`);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            await writeFile(framePath, buffer);
            fetched = true;
          }
        } catch { /* proxy failed, try disk */ }

        // Fallback: read directly from ComfyUI directory on disk
        if (!fetched) {
          const dir = TYPE_DIR_MAP[img.type || "output"] || "output";
          const diskPath = path.join(COMFYUI_ROOT, dir, img.subfolder || "", img.filename);
          if (existsSync(diskPath)) {
            await writeFile(framePath, readFileSync(diskPath));
          } else {
            return NextResponse.json({ error: `Failed to fetch frame ${i}: ${img.filename}` }, { status: 500 });
          }
        }
      }

      const dir = await ensureWorkDir();
      const outputPath = path.join(dir, `final_${sessionId}.mp4`);

      const audioArg = audioPath && existsSync(audioPath)
        ? `-i "${audioPath}" -c:a aac -shortest`
        : "";

      const ff = getFFmpegPath();
      await execAsync(
        `"${ff}" -y -framerate ${fps} -i "${path.join(outFramesDir, "frame_%05d.png")}" ${audioArg} -c:v libx264 -pix_fmt yuv420p -crf 18 "${outputPath}"`
      );

      return NextResponse.json({
        outputPath,
        frameCount: images.length,
      });
    }

    if (action === "serve-frame") {
      // Serve a single frame by path (for thumbnail display)
      const framePath = formData.get("framePath") as string;
      if (!framePath || !existsSync(framePath)) {
        return NextResponse.json({ error: "Frame not found" }, { status: 404 });
      }
      const { readFile } = await import("fs/promises");
      const data = await readFile(framePath);
      return new Response(data, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err: any) {
    console.error("[video-process]", err);
    return NextResponse.json(
      { error: err.message || "Video processing failed" },
      { status: 500 }
    );
  }
}

// GET: serve a frame or output video by path
export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get("file");
  if (!filePath || !existsSync(filePath) || !filePath.startsWith(WORK_DIR)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { readFile } = await import("fs/promises");
  const data = await readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".mp4" ? "video/mp4" : ext === ".png" ? "image/png" : "application/octet-stream";
  return new Response(data, {
    headers: { "Content-Type": mime, "Cache-Control": "public, max-age=3600" },
  });
}
