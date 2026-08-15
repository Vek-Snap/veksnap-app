/**
 * GET /api/sam/capabilities
 *
 * Reports which SAM backends are actually installed so the UI can hide/disable
 * features that depend on optional model downloads.
 *
 * SAM2 (Apache-2.0) is considered available when its package + a checkpoint are
 * present. (SAM 3 was removed, Meta's non-permissive SAM License.)
 *
 * Returns: { sam2: boolean, details: {...} }
 */

import { NextResponse } from "next/server";
import path from "path";
import { existsSync, readdirSync } from "fs";

export const dynamic = "force-dynamic";

const COMFY_DIR = path.resolve(process.cwd(), "..", "ComfyUI");
const RMBG_MODELS = path.join(COMFY_DIR, "custom_nodes", "ComfyUI-RMBG", "models");

function dirHasWeights(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false;
    return readdirSync(dir).some((f) => /\.(pt|pth|safetensors|bin)$/i.test(f));
  } catch {
    return false;
  }
}

export function GET() {
  try {
    // ── SAM2 ──
    const sam2Pkg = path.join(RMBG_MODELS, "sam2");
    const sam2ModelsDir = path.join(COMFY_DIR, "models", "sam2");
    const sam2PkgPresent = existsSync(sam2Pkg);
    const sam2CkptPresent = dirHasWeights(sam2ModelsDir) || dirHasWeights(path.join(RMBG_MODELS, "sam2"));
    const sam2 = sam2PkgPresent && sam2CkptPresent;

    return NextResponse.json({
      sam2,
      details: {
        sam2PkgPresent,
        sam2CkptPresent,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { sam2: false, error: String(err) },
      { status: 500 }
    );
  }
}
