import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";

export const dynamic = "force-dynamic";

/**
 * POST /api/comfyui/abs-input-path
 *
 * Convert a ComfyUI-input-relative path (e.g. "video/foo.mp4", returned by
 * ComfyUI's /upload/image endpoint) into the absolute filesystem path
 * (e.g. "<install>/ComfyUI/input/video/foo.mp4").
 *
 * Background: most ComfyUI nodes (LoadImage, etc.) accept the input-relative
 * form because they internally prepend ComfyUI's input directory. But
 * `VHS_LoadVideoPath` from ComfyUI-VideoHelperSuite calls `os.path.isfile()`
 * directly on the string and requires an absolute path, see
 * `ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite/videohelpersuite/utils.py:322`
 * (`validate_path` returns "Invalid file path: …" when the string can't be
 * stat'd from the cwd). Vek-Snap has to give that node an absolute path.
 *
 * Body: { relPath: string }   - e.g. "video/foo.mp4" or just "foo.mp4"
 * Returns: { absPath: string, exists: boolean }
 *
 * Path traversal is rejected: the resolved path must stay inside the
 * ComfyUI input directory.
 */

const INSTALL_ROOT = path.resolve(process.cwd(), "..");
const COMFYUI_INPUT = path.join(INSTALL_ROOT, "ComfyUI", "input");

export async function POST(req: NextRequest) {
  try {
    const { relPath } = (await req.json()) as { relPath?: string };
    if (!relPath || typeof relPath !== "string") {
      return NextResponse.json({ error: "relPath is required" }, { status: 400 });
    }

    // Resolve and confirm the result stays inside ComfyUI/input. Anything
    // that escapes (e.g. "../../etc/passwd") is rejected.
    const abs = path.resolve(COMFYUI_INPUT, relPath);
    const inputWithSep = COMFYUI_INPUT.endsWith(path.sep) ? COMFYUI_INPUT : COMFYUI_INPUT + path.sep;
    if (abs !== COMFYUI_INPUT && !abs.startsWith(inputWithSep)) {
      return NextResponse.json(
        { error: `Path traversal rejected: ${relPath} resolves outside ComfyUI/input/` },
        { status: 400 },
      );
    }

    return NextResponse.json({ absPath: abs, exists: fs.existsSync(abs) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
