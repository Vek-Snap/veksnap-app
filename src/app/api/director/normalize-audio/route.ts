import { NextRequest, NextResponse } from "next/server";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export const dynamic = "force-dynamic";

const INSTALL_ROOT = path.resolve(process.cwd(), "..");
const COMFYUI_INPUT = path.join(INSTALL_ROOT, "ComfyUI", "input");

/**
 * POST /api/director/normalize-audio
 * Normalizes an audio file to match a target duration:
 *   - If audio is LONGER than targetDuration: clips it to targetDuration
 *   - If audio is SHORTER than targetDuration: pads with silence to targetDuration
 *   - If audio matches: returns the original file unchanged
 *
 * Body: { audioFile: string, targetDuration: number, trimStart?: number, trimEnd?: number }
 *   audioFile: path relative to ComfyUI input/ (e.g. "ltx2_a2v_1234.wav")
 *   targetDuration: target duration in seconds
 *   trimStart: optional start time in seconds (manual trim region)
 *   trimEnd: optional end time in seconds (manual trim region)
 *   When trimStart/trimEnd are provided, the audio is first trimmed to that region,
 *   then the trimmed audio is normalized to targetDuration (clipped or padded).
 *
 * Returns: { audioFile: string, originalDuration: number, targetDuration: number, action: "clipped" | "padded" | "unchanged" | "trimmed" | "trimmed+clipped" | "trimmed+padded" }
 */
export async function POST(req: NextRequest) {
  try {
    const { audioFile, targetDuration, trimStart, trimEnd } = await req.json();

    if (!audioFile || !targetDuration || targetDuration <= 0) {
      return NextResponse.json({ error: "Invalid parameters: need audioFile and targetDuration > 0" }, { status: 400 });
    }

    const srcPath = path.join(COMFYUI_INPUT, audioFile);
    if (!existsSync(srcPath)) {
      return NextResponse.json({ error: `Audio file not found: ${audioFile}` }, { status: 404 });
    }

    // Get the audio duration using ffprobe
    const ffprobe = getFFprobePath();
    const probeResult = await execAsync(
      `"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${srcPath}"`
    );
    const originalDuration = parseFloat(probeResult.stdout.trim());
    if (isNaN(originalDuration) || originalDuration <= 0) {
      return NextResponse.json({ error: "Could not determine audio duration" }, { status: 500 });
    }

    // Ensure output directory exists
    const audioDir = path.join(COMFYUI_INPUT, "audio");
    mkdirSync(audioDir, { recursive: true });

    const ff = getFFmpegPath();
    const timestamp = Date.now();

    // ── Step 1: If manual trim is specified, extract that region first ──
    const hasTrim = typeof trimStart === "number" && typeof trimEnd === "number"
      && trimEnd > trimStart && (trimStart > 0.05 || trimEnd < originalDuration - 0.05);

    let workingPath = srcPath;
    let workingDuration = originalDuration;
    let trimAction = "";

    if (hasTrim) {
      const trimDuration = (trimEnd as number) - (trimStart as number);
      const trimOutName = `a2v_trimmed_${timestamp}.wav`;
      const trimOutPath = path.join(audioDir, trimOutName);
      await execAsync(
        `"${ff}" -y -i "${srcPath}" -ss ${(trimStart as number).toFixed(3)} -t ${trimDuration.toFixed(3)} -ar 44100 -ac 1 "${trimOutPath}"`
      );
      if (!existsSync(trimOutPath)) {
        return NextResponse.json({ error: "Trim failed: output not created" }, { status: 500 });
      }
      workingPath = trimOutPath;
      workingDuration = trimDuration;
      trimAction = "trimmed";
      console.log(`[normalize-audio] Trimmed: ${(trimStart as number).toFixed(2)}s → ${(trimEnd as number).toFixed(2)}s (${trimDuration.toFixed(2)}s)`);
    }

    // ── Step 2: Normalize to target duration ──
    const diff = Math.abs(workingDuration - targetDuration);
    if (diff < 0.05) {
      // Already matches target
      const action = trimAction || "unchanged";
      // If we trimmed, return the trimmed file path
      if (trimAction) {
        const trimRelative = `audio/a2v_trimmed_${timestamp}.wav`;
        return NextResponse.json({
          audioFile: trimRelative,
          originalDuration,
          targetDuration,
          action,
        });
      }
      return NextResponse.json({
        audioFile,
        originalDuration,
        targetDuration,
        action: "unchanged",
      });
    }

    const outName = `a2v_normalized_${timestamp}.wav`;
    const outPath = path.join(audioDir, outName);
    const outRelative = `audio/${outName}`;

    if (workingDuration > targetDuration) {
      // CLIP: trim audio to target duration
      await execAsync(
        `"${ff}" -y -i "${workingPath}" -t ${targetDuration.toFixed(3)} -ar 44100 -ac 1 "${outPath}"`
      );

      if (!existsSync(outPath)) {
        return NextResponse.json({ error: "Clip failed: output not created" }, { status: 500 });
      }

      return NextResponse.json({
        audioFile: outRelative,
        originalDuration,
        targetDuration,
        action: trimAction ? "trimmed+clipped" : "clipped",
      });
    } else {
      // PAD: add silence to reach target duration
      const padDuration = targetDuration - workingDuration;
      // Use anullsrc to generate silence, then concatenate with original audio
      // Using the filter_complex approach for seamless concat
      await execAsync(
        `"${ff}" -y -i "${workingPath}" -f lavfi -t ${padDuration.toFixed(3)} -i anullsrc=r=44100:cl=mono -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[out]" -map "[out]" -ar 44100 -ac 1 "${outPath}"`
      );

      if (!existsSync(outPath)) {
        return NextResponse.json({ error: "Pad failed: output not created" }, { status: 500 });
      }

      return NextResponse.json({
        audioFile: outRelative,
        originalDuration,
        targetDuration,
        action: trimAction ? "trimmed+padded" : "padded",
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
