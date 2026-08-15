import { NextRequest, NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const dynamic = "force-dynamic";

const INSTALL_ROOT = path.resolve(process.cwd(), "..");
const COMFYUI_OUTPUT = path.join(INSTALL_ROOT, "ComfyUI", "output");
const COMFYUI_INPUT = path.join(INSTALL_ROOT, "ComfyUI", "input");

/**
 * POST /api/director/swap-audio
 * Replaces the audio track of a video with a different audio file.
 *
 * Body: {
 *   videoFile: string,      // filename in ComfyUI output (e.g. "ltx2/VekSnap_LTX2_Official_00001.mp4")
 *   audioFile: string,      // filename in ComfyUI input (e.g. "ltx2_a2v_1234.wav")
 *   mode: "original" | "strip"  // "original" = replace with audioFile, "strip" = remove audio entirely
 * }
 *
 * Returns the re-muxed video as a binary response (video/mp4).
 */
export async function POST(req: NextRequest) {
  try {
    const { videoFile, audioFile, mode = "original" } = await req.json();

    if (!videoFile) {
      return NextResponse.json({ error: "videoFile is required" }, { status: 400 });
    }

    // Resolve video path in ComfyUI output directory
    const videoPath = path.join(COMFYUI_OUTPUT, videoFile);
    if (!existsSync(videoPath)) {
      return NextResponse.json({ error: `Video not found: ${videoFile}` }, { status: 404 });
    }

    const ffmpeg = await getFFmpegPath();
    const ts = Date.now();
    const outName = `swap_audio_${ts}.mp4`;
    const outPath = path.join(COMFYUI_OUTPUT, "ltx2", outName);

    if (mode === "strip") {
      // Remove audio entirely
      await execAsync(
        `"${ffmpeg}" -y -i "${videoPath}" -an -c:v copy "${outPath}"`
      );
    } else {
      // Replace audio with the provided audio file
      if (!audioFile) {
        return NextResponse.json({ error: "audioFile is required for mode=original" }, { status: 400 });
      }

      // Audio file could be in input/ or input/audio/
      let audioPath = path.join(COMFYUI_INPUT, audioFile);
      if (!existsSync(audioPath)) {
        audioPath = path.join(COMFYUI_INPUT, "audio", audioFile);
      }
      if (!existsSync(audioPath)) {
        return NextResponse.json({ error: `Audio not found: ${audioFile}` }, { status: 404 });
      }

      await execAsync(
        `"${ffmpeg}" -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 -shortest "${outPath}"`
      );
    }

    if (!existsSync(outPath)) {
      return NextResponse.json({ error: "FFmpeg produced no output" }, { status: 500 });
    }

    // Return the file as binary
    const fileBuffer = readFileSync(outPath);
    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `inline; filename="${outName}"`,
        "X-Output-File": `ltx2/${outName}`,
      },
    });
  } catch (err) {
    console.error("[swap-audio] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "swap-audio failed" },
      { status: 500 }
    );
  }
}
