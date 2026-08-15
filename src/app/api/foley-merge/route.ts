import { NextRequest, NextResponse } from "next/server";
import { readFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST /api/foley-merge
 * Merges a video source with Foley-generated audio into a single MP4.
 *
 * Body JSON:
 *   videoSource: { type: "upload", path: string }
 *               | { type: "comfyui", filename: string, subfolder: string }
 *   audioFilename: string   - filename from ComfyUI audio output
 *   audioSubfolder: string  - subfolder (usually "audio")
 *
 * Returns: the merged MP4 file as a binary download
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { videoSource, audioFilename, audioSubfolder } = body;

    if (!videoSource || !audioFilename) {
      return NextResponse.json({ error: "Missing videoSource or audioFilename" }, { status: 400 });
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");

    // Resolve video path
    let videoPath: string;
    if (videoSource.type === "upload") {
      videoPath = videoSource.path;
    } else if (videoSource.type === "comfyui") {
      videoPath = path.join(comfyDir, "output", videoSource.subfolder || "", videoSource.filename);
    } else {
      return NextResponse.json({ error: "Invalid videoSource type" }, { status: 400 });
    }

    if (!existsSync(videoPath)) {
      return NextResponse.json({ error: `Video file not found: ${videoPath}` }, { status: 404 });
    }

    // Resolve audio path
    const audioPath = path.join(comfyDir, "output", audioSubfolder || "audio", audioFilename);
    if (!existsSync(audioPath)) {
      return NextResponse.json({ error: `Audio file not found: ${audioPath}` }, { status: 404 });
    }

    // Output merged file
    const mergeDir = path.join(comfyDir, "output", "merged");
    if (!existsSync(mergeDir)) await mkdir(mergeDir, { recursive: true });

    const timestamp = Date.now();
    const outputPath = path.join(mergeDir, `VekSnap_Foley_${timestamp}.mp4`);

    // FFmpeg: mux video + audio → MP4
    // -c:v copy preserves original video codec (no re-encode)
    // -c:a aac converts audio to AAC for broad compatibility
    // -shortest trims to the shorter of the two streams
    // -map 0:v:0 takes video from first input, -map 1:a:0 takes audio from second
    const ff = getFFmpegPath();
    await execAsync(
      `"${ff}" -y -i "${videoPath}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}"`
    );

    if (!existsSync(outputPath)) {
      return NextResponse.json({ error: "FFmpeg merge failed: no output file" }, { status: 500 });
    }

    // Return the merged file as a download
    const fileBuffer = await readFile(outputPath);
    const outputName = `VekSnap_Foley_${timestamp}.mp4`;

    // Clean up merged file after reading (it's been buffered)
    try { await unlink(outputPath); } catch { /* ignore */ }

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="${outputName}"`,
        "Content-Length": fileBuffer.length.toString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to merge video and audio" },
      { status: 500 }
    );
  }
}
