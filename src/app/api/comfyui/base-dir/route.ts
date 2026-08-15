import { NextResponse } from "next/server";
import path from "path";

export const dynamic = "force-dynamic";

/**
 * GET /api/comfyui/base-dir
 *
 * Returns the absolute path to the ComfyUI root directory.
 * All path resolution happens server-side, no hardcoded paths on the client.
 */
export async function GET() {
  const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
  return NextResponse.json({
    baseDir: comfyDir,
    inputDir: path.join(comfyDir, "input"),
    outputDir: path.join(comfyDir, "output"),
  });
}
