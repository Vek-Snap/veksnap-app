import { NextRequest, NextResponse } from "next/server";
import { readFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST /api/audio-denoise
 * Applies FFmpeg spectral noise reduction to a video's audio track.
 *
 * Body JSON:
 *   videoUrl: string     - URL to the source video (ComfyUI output)
 *   mode: "audio" | "merge"
 *     - "audio": returns denoised audio as WAV download
 *     - "merge": returns new MP4 with denoised audio + original video
 *   noiseFloor: number   - noise floor in dB (default -30, range -60 to -10)
 *   noiseAmount: number  - noise reduction amount 0-1 (default 0.75)
 *
 * FFmpeg filter chain:
 *   afftdn: Adaptive FFT-based noise reduction (spectral gating)
 *   - nr: noise reduction in dB (derived from noiseAmount * 40)
 *   - nf: noise floor in dB
 *   - tn: track noise (1 = auto-adapt to changing noise profile)
 *   highpass: Remove sub-bass rumble below 80Hz
 *   lowpass: Remove ultrasonic artifacts above 14kHz
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      videoUrl,
      mode = "merge",
      noiseFloor = -30,
      noiseAmount = 0.75,
    } = body;

    if (!videoUrl) {
      return NextResponse.json({ error: "Missing videoUrl" }, { status: 400 });
    }

    // Resolve the video file path from ComfyUI URL
    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    let videoPath: string;

    // Parse the URL to extract filename and subfolder
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
      // Fallback: try treating it as a direct path
      videoPath = videoUrl;
    }

    if (!existsSync(videoPath)) {
      return NextResponse.json({ error: `Video file not found: ${videoPath}` }, { status: 404 });
    }

    // Output directory
    const denoiseDir = path.join(comfyDir, "output", "denoised");
    if (!existsSync(denoiseDir)) await mkdir(denoiseDir, { recursive: true });

    const timestamp = Date.now();
    const nrDb = Math.round(noiseAmount * 40); // 0-1 → 0-40dB reduction

    // Probe audio sample rate to clamp lowpass below Nyquist (sampleRate / 2)
    const ffprobe = getFFprobePath();
    let lowpassFreq = 14000;
    try {
      const { stdout } = await execAsync(
        `"${ffprobe}" -v error -select_streams a:0 -show_entries stream=sample_rate -of csv=p=0 "${videoPath}"`
      );
      const sampleRate = parseInt(stdout.trim());
      if (sampleRate > 0) {
        // Lowpass must be < sampleRate/2 (Nyquist). Use 90% of Nyquist as safe ceiling.
        lowpassFreq = Math.min(lowpassFreq, Math.floor(sampleRate * 0.45));
      }
    } catch { /* fall back to 14kHz, will still fail if rate is too low, but that's rare for non-LTX audio */ }

    if (mode === "audio") {
      // Extract and denoise audio only → WAV
      const outputPath = path.join(denoiseDir, `denoised_audio_${timestamp}.wav`);
      const ff = getFFmpegPath();
      await execAsync(
        `"${ff}" -y -i "${videoPath}" -vn -af "highpass=f=80,afftdn=nr=${nrDb}:nf=${noiseFloor}:tn=1,lowpass=f=${lowpassFreq}" -c:a pcm_s16le "${outputPath}"`
      );

      if (!existsSync(outputPath)) {
        return NextResponse.json({ error: "FFmpeg audio denoise failed" }, { status: 500 });
      }

      const fileBuffer = await readFile(outputPath);
      const outputName = `denoised_audio_${timestamp}.wav`;
      try { await unlink(outputPath); } catch { /* ignore */ }

      return new NextResponse(fileBuffer, {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "Content-Disposition": `attachment; filename="${outputName}"`,
          "Content-Length": fileBuffer.length.toString(),
        },
      });
    } else {
      // Merge denoised audio with original video → MP4
      const outputPath = path.join(denoiseDir, `denoised_${timestamp}.mp4`);
      const ff = getFFmpegPath();
      await execAsync(
        `"${ff}" -y -i "${videoPath}" -af "highpass=f=80,afftdn=nr=${nrDb}:nf=${noiseFloor}:tn=1,lowpass=f=${lowpassFreq}" -c:v copy -c:a aac -b:a 192k "${outputPath}"`
      );

      if (!existsSync(outputPath)) {
        return NextResponse.json({ error: "FFmpeg denoise+merge failed" }, { status: 500 });
      }

      const fileBuffer = await readFile(outputPath);
      const outputName = `denoised_${timestamp}.mp4`;
      try { await unlink(outputPath); } catch { /* ignore */ }

      return new NextResponse(fileBuffer, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="${outputName}"`,
          "Content-Length": fileBuffer.length.toString(),
        },
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Audio denoise failed" },
      { status: 500 }
    );
  }
}
