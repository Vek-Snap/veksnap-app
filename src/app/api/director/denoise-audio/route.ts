import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * POST /api/director/denoise-audio
 * Applies spectral noise reduction to a pre-extracted audio file.
 *
 * Body JSON:
 *   audioPath: string - filesystem path to a WAV file (from audio-transfer audioOnly mode)
 *
 * Returns: denoised WAV binary with X-Audio-Path header
 */
export async function POST(req: NextRequest) {
  try {
    const {
      audioPath,
      highpass = 80,
      noiseReduction = 30,
      noiseFloor = -30,
      trackNoise = 1,
      lowpass = 14000,
    } = await req.json();

    if (!audioPath || !existsSync(audioPath)) {
      return NextResponse.json(
        { error: `Audio file not found: ${audioPath}` },
        { status: 404 }
      );
    }

    const ff = getFFmpegPath();
    const dir = path.dirname(audioPath);
    const ext = path.extname(audioPath);
    const base = path.basename(audioPath, ext);
    const denoisedPath = path.join(dir, `${base}_denoised_${Date.now()}${ext}`);

    // Build denoise filter chain from parameters
    const filterChain = `highpass=f=${highpass},afftdn=nr=${noiseReduction}:nf=${noiseFloor}:tn=${trackNoise},lowpass=f=${lowpass}`;

    try {
      await execAsync(
        `"${ff}" -y -i "${audioPath}" -af ${filterChain} -acodec pcm_s16le -ar 44100 "${denoisedPath}"`
      );
    } catch (e) {
      console.warn("[denoise-audio] Denoise filter failed:", e);
      return NextResponse.json(
        { error: "FFmpeg denoise filter failed: your FFmpeg build may not support afftdn" },
        { status: 500 }
      );
    }

    if (!existsSync(denoisedPath)) {
      return NextResponse.json({ error: "Denoise failed: no output file" }, { status: 500 });
    }

    const wavBuffer = await readFile(denoisedPath);
    // Keep on disk: client may reference for merge
    return new NextResponse(wavBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "X-Audio-Path": denoisedPath,
        "Content-Length": wavBuffer.length.toString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Denoise failed" },
      { status: 500 }
    );
  }
}
