import { NextRequest, NextResponse } from "next/server";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const dynamic = "force-dynamic";

const INSTALL_ROOT = path.resolve(process.cwd(), "..");
const COMFYUI_INPUT = path.join(INSTALL_ROOT, "ComfyUI", "input");

/**
 * POST /api/director/trim-audio
 * Trims an audio file (already in ComfyUI input/) to the specified time range.
 * Returns the path to the trimmed file (relative to ComfyUI input/, e.g. "audio/trimmed_xxx.wav").
 *
 * Body: { audioFile: string, trimStart: number, trimEnd: number }
 */
export async function POST(req: NextRequest) {
  try {
    const { audioFile, trimStart, trimEnd } = await req.json();

    if (!audioFile || trimEnd <= trimStart) {
      return NextResponse.json({ error: "Invalid trim parameters" }, { status: 400 });
    }

    // Resolve the source file in ComfyUI input/
    const srcPath = path.join(COMFYUI_INPUT, audioFile);
    if (!existsSync(srcPath)) {
      return NextResponse.json({ error: `Audio file not found: ${audioFile}` }, { status: 404 });
    }

    // Ensure output directory exists
    const audioDir = path.join(COMFYUI_INPUT, "audio");
    mkdirSync(audioDir, { recursive: true });

    // Generate trimmed filename
    const timestamp = Date.now();
    const outName = `voice_ref_trimmed_${timestamp}.wav`;
    const outPath = path.join(audioDir, outName);

    const ff = getFFmpegPath();
    const duration = trimEnd - trimStart;

    await execAsync(
      `"${ff}" -y -ss ${trimStart.toFixed(3)} -t ${duration.toFixed(3)} -i "${srcPath}" -ar 44100 -ac 1 "${outPath}"`
    );

    if (!existsSync(outPath)) {
      return NextResponse.json({ error: "Trim failed: output not created" }, { status: 500 });
    }

    return NextResponse.json({
      audioFile: `audio/${outName}`,
      duration: parseFloat(duration.toFixed(3)),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
