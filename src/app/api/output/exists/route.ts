import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/output/exists
//
// Reports which ComfyUI-produced output files still exist on disk. Used by the
// gallery's "Refresh" action to prune preview entries whose files were deleted
// or moved outside the app. Every path is resolved against the appropriate
// ComfyUI base dir and refused if it escapes that dir (traversal defence),
// mirroring the sibling delete route.
//
// Body:     { files: [{ filename, subfolder?, type? }] }
// Response: { ok: true, missing: [{ filename, subfolder, type }] }
// ─────────────────────────────────────────────────────────────────────────────

function baseDirFor(type: string): string {
  const comfy = path.resolve(process.cwd(), "..", "ComfyUI");
  if (type === "input") return path.join(comfy, "input");
  if (type === "temp") return path.join(comfy, "temp");
  return path.join(comfy, "output");
}

function resolveSafe(filename: string, subfolder: string, type: string): string | null {
  const base = path.resolve(baseDirFor(type || "output"));
  const abs = path.resolve(base, path.join(subfolder || "", filename || ""));
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const files = Array.isArray(body.files) ? body.files : [];
    const missing: Array<{ filename: string; subfolder: string; type: string }> = [];
    for (const f of files) {
      const filename = String(f?.filename ?? "");
      if (!filename) continue;
      const subfolder = String(f?.subfolder ?? "");
      const type = String(f?.type ?? "output");
      const abs = resolveSafe(filename, subfolder, type);
      // A path that fails the traversal check is treated as missing (unsafe to
      // keep referencing); a resolvable path is missing only if it isn't a file.
      const present = !!abs && fs.existsSync(abs) && fs.statSync(abs).isFile();
      if (!present) missing.push({ filename, subfolder, type });
    }
    return NextResponse.json({ ok: true, missing });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "exists check failed" }, { status: 500 });
  }
}
