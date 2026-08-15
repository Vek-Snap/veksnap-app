/**
 * POST /api/sam/sam2-track
 *
 * Propagates a frame-0 mask across the source video using SAM2VideoPredictor
 * and writes the resulting grayscale mask MP4 into ComfyUI input/video/.
 *
 * Body (JSON or multipart):
 *   - sourceVideoFile: string  Absolute filesystem path OR ComfyUI input-relative
 *                              ("video/<filename>" or "<filename>"). Both forms
 *                              are accepted; absolute is preferred since the V2V
 *                              flow now standardizes on absolute paths for
 *                              VHS_LoadVideoPath compatibility.
 *   - maskFile: string         ComfyUI input/<filename> (frame-0 mask PNG)
 *   - model?: string           default "sam2.1_hiera_tiny"
 *   - device?: "cuda" | "cpu"  default "cuda"
 *   - maxFrames?: number       0 = entire video
 *
 * Returns: { ok, maskVideoFile, fps, nFrames, maxScore, model, checkpoint }
 *   - maskVideoFile: ABSOLUTE filesystem path to the produced mask MP4. Goes
 *     directly into VHS_LoadVideoPath without further resolution.
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { execAsync } from "@/lib/ffmpeg-path";
import { getOfflineEnv } from "@/lib/veksnap-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

function findPython(): string {
  const candidates = [
    process.env.VEKSNAP_PYTHON || "",
    path.join(process.cwd(), "..", "runtime", "venv", "Scripts", "python.exe"),
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

function comfyInputDir(): string {
  return path.resolve(process.cwd(), "..", "ComfyUI", "input");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const sourceVideoFile = String(body.sourceVideoFile ?? "").trim();
    const maskFile = String(body.maskFile ?? "").trim();
    const model = String(body.model ?? "sam2.1_hiera_tiny").trim();
    const device = String(body.device ?? "cuda").trim();
    const maxFrames = Math.max(0, Number(body.maxFrames ?? 0) || 0);

    if (!sourceVideoFile) {
      return NextResponse.json({ ok: false, error: "sourceVideoFile is required" }, { status: 400 });
    }
    if (!maskFile) {
      return NextResponse.json({ ok: false, error: "maskFile is required" }, { status: 400 });
    }

    const inputDir = comfyInputDir();
    if (!fs.existsSync(inputDir)) {
      return NextResponse.json({ ok: false, error: `ComfyUI input/ not found at ${inputDir}` }, { status: 500 });
    }

    // Resolve full path. Three forms accepted in priority order:
    //   1. Absolute filesystem path (preferred, what LTX2Studio sends now).
    //   2. ComfyUI-input-relative path with "video/" prefix (legacy form).
    //   3. Bare filename (legacy form, probed in input/ then input/video/).
    const videoCandidates = path.isAbsolute(sourceVideoFile)
      ? [sourceVideoFile]
      : [
          path.join(inputDir, sourceVideoFile),         // "video/foo.mp4" or "foo.mp4"
          path.join(inputDir, "video", sourceVideoFile), // bare "foo.mp4" in input/video/
        ];
    const videoPath = videoCandidates.find((p) => fs.existsSync(p));
    if (!videoPath) {
      return NextResponse.json(
        { ok: false, error: `Source video not found. Tried: ${videoCandidates.join(", ")}` },
        { status: 404 }
      );
    }

    const maskCandidates = [path.join(inputDir, maskFile), path.join(inputDir, "mask", maskFile)];
    const maskPath = maskCandidates.find((p) => fs.existsSync(p));
    if (!maskPath) {
      return NextResponse.json(
        { ok: false, error: `Mask file ${maskFile} not found in ComfyUI input/` },
        { status: 404 }
      );
    }

    // Output mask video into input/video/ so VHS_LoadVideoPath finds it
    const outputDir = path.join(inputDir, "video");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const ts = Date.now();
    const outputName = `sam2_mask_${ts}.mp4`;
    const outputPath = path.join(outputDir, outputName);

    const python = findPython();
    const script = path.join(process.cwd(), "scripts", "sam2_track.py");
    if (!fs.existsSync(script)) {
      return NextResponse.json({ ok: false, error: "sam2_track.py not found" }, { status: 500 });
    }

    const cmd = `"${python}" "${script}" --video "${videoPath}" --mask "${maskPath}" --output "${outputPath}" --model ${model} --device ${device}${maxFrames > 0 ? ` --max-frames ${maxFrames}` : ""}`;
    console.log(`[sam2-track] Running: ${cmd}`);

    const { stdout } = await execAsync(cmd, { env: getOfflineEnv() });

    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let result: Record<string, unknown> | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith("{") && line.endsWith("}")) {
        try { result = JSON.parse(line); break; } catch { /* keep scanning */ }
      }
    }
    if (!result) {
      return NextResponse.json(
        { ok: false, error: "SAM2 produced no parseable JSON output", raw: stdout.slice(-2000) },
        { status: 500 }
      );
    }
    if (result.ok !== true) {
      return NextResponse.json(
        { ok: false, error: String(result.error ?? "SAM2 failed"), needsSetup: !!result.needs_setup },
        { status: result.needs_setup ? 412 : 500 }
      );
    }
    if (!fs.existsSync(outputPath)) {
      return NextResponse.json({ ok: false, error: "SAM2 reported success but no output mp4 present" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      // VHS_LoadVideoPath validates with `os.path.isfile()` (see VideoHelperSuite
      // utils.py:322), which requires an absolute path. Return the absolute path
      // so the client can flow it directly into the workflow without a separate
      // path-resolution round-trip.
      maskVideoFile: outputPath,
      fps: result.fps ?? null,
      nFrames: result.n_frames ?? 0,
      maxScore: result.max_score ?? 0,
      model: result.model ?? model,
      checkpoint: result.checkpoint ?? null,
      device: result.device ?? device,
    });
  } catch (err) {
    console.error("[sam2-track] Error:", err);
    const message = err instanceof Error ? err.message : String(err);
    const needsSetup = /Could not locate|checkpoint|ffmpeg/i.test(message);
    return NextResponse.json({ ok: false, error: message, needsSetup }, { status: 500 });
  }
}
