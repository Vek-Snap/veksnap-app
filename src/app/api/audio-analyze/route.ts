/**
 * POST /api/audio-analyze
 * Runs the Python audio-analyze.py script to extract per-frame audio features
 * for the audio-reactive video pipeline.
 *
 * Body: { audioPath: string, fps?: number }
 * Returns: { sampleRate, duration, fps, numFrames, amplitude[], onsetStrength[], spectralCentroid[], beatFrames[] }
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { getScratchDir } from "@/lib/scratch-dir";
import { execAsync, getFFmpegPath } from "@/lib/ffmpeg-path";
import { getOfflineEnv } from "@/lib/veksnap-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function findPython(): string {
  const candidates = [
    path.join(process.cwd(), "..", "miniconda", "envs", "comfyui", "python.exe"),
    path.join(process.cwd(), "..", "miniconda", "python.exe"),
    "python",
  ];
  for (const c of candidates) {
    try {
      if (c !== "python" && fs.existsSync(c)) return c;
    } catch { /* skip */ }
  }
  return "python";
}

export async function POST(req: NextRequest) {
  try {
    const { audioPath, fps = 24 } = await req.json();
    if (!audioPath) {
      return NextResponse.json({ error: "audioPath is required" }, { status: 400 });
    }

    // Resolve path: absolute, or relative to ComfyUI output/audio/ or input/
    let resolvedPath = audioPath;
    if (!path.isAbsolute(audioPath)) {
      const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
      const candidates = [
        path.join(comfyDir, "output", "audio", audioPath),
        path.join(comfyDir, "output", audioPath),
        path.join(comfyDir, "input", audioPath),
      ];
      resolvedPath = candidates.find((p) => fs.existsSync(p)) || audioPath;
    }

    if (!fs.existsSync(resolvedPath)) {
      return NextResponse.json({ error: `Audio file not found: ${resolvedPath}` }, { status: 404 });
    }

    const python = findPython();
    const script = path.join(process.cwd(), "scripts", "audio-analyze.py");

    if (!fs.existsSync(script)) {
      return NextResponse.json({ error: "audio-analyze.py script not found" }, { status: 500 });
    }

    // Write output to temp file to avoid stdout buffer limits
    const tmpOut = path.join(getScratchDir("audio"), `analyze_${Date.now()}.json`);

    const ffmpeg = getFFmpegPath();
    const cmd = `"${python}" "${script}" --audio "${resolvedPath}" --fps ${fps} --output "${tmpOut}" --ffmpeg "${ffmpeg}"`;
    console.log(`[audio-analyze] Running: ${cmd}`);

    await execAsync(cmd, { env: getOfflineEnv() });

    // Read result
    if (!fs.existsSync(tmpOut)) {
      return NextResponse.json({ error: "Analysis produced no output" }, { status: 500 });
    }

    const resultJson = fs.readFileSync(tmpOut, "utf-8");
    const result = JSON.parse(resultJson);

    // Clean up
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }

    return NextResponse.json(result);
  } catch (err) {
    console.error("[audio-analyze] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Audio analysis failed" },
      { status: 500 }
    );
  }
}
