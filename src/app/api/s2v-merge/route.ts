import { NextRequest, NextResponse } from "next/server";
import { readFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getScratchDir } from "@/lib/scratch-dir";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST /api/s2v-merge
 * Merges a WAN S2V video output with the user's uploaded audio into a single MP4.
 *
 * Body JSON:
 *   videoFilename: string   - filename from ComfyUI video output
 *   videoSubfolder: string  - subfolder in ComfyUI output (usually "")
 *   audioFilename: string   - filename from ComfyUI input (user-uploaded audio)
 *
 * Returns: the merged MP4 file as a binary download
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { videoFilename, videoSubfolder, audioFilename } = body;

    if (!videoFilename || !audioFilename) {
      return NextResponse.json({ error: "Missing videoFilename or audioFilename" }, { status: 400 });
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");

    // Video is in ComfyUI output folder
    const videoPath = path.join(comfyDir, "output", videoSubfolder || "", videoFilename);
    if (!existsSync(videoPath)) {
      return NextResponse.json({ error: `Video file not found: ${videoPath}` }, { status: 404 });
    }

    // Audio is in ComfyUI input folder (user-uploaded)
    const audioPath = path.join(comfyDir, "input", audioFilename);
    if (!existsSync(audioPath)) {
      return NextResponse.json({ error: `Audio file not found: ${audioPath}` }, { status: 404 });
    }

    // Output merged file in temp dir
    // Install-local scratch, NOT os.tmpdir() (see src/lib/scratch-dir.ts), user
    // audio/video content. Swept by the `appScratch` cleanup category.
    const tmpDir = path.join(getScratchDir("s2v-merge"), String(Date.now()));
    await mkdir(tmpDir, { recursive: true });

    const timestamp = Date.now();
    const outputPath = path.join(tmpDir, `VekSnap_S2V_${timestamp}.mp4`);

    // FFmpeg: mux video + audio → MP4
    // -c:v copy preserves original video codec (no re-encode)
    // -c:a aac converts audio to AAC for broad compatibility
    // -shortest trims to the shorter of the two streams
    const ff = getFFmpegPath();
    await execAsync(
      `"${ff}" -y -i "${videoPath}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}"`
    );

    if (!existsSync(outputPath)) {
      await unlink(tmpDir).catch(() => {});
      return NextResponse.json({ error: "FFmpeg merge failed: no output file" }, { status: 500 });
    }

    // Return the merged file as a download
    const fileBuffer = await readFile(outputPath);
    const outputName = `VekSnap_S2V_${timestamp}.mp4`;

    // Clean up temp files after reading
    try { await unlink(outputPath); } catch { /* ignore */ }
    try { await unlink(tmpDir).catch(() => {}); } catch { /* ignore */ }

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
