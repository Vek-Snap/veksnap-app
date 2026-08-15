import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/output/delete
//
// Permanently deletes ComfyUI-produced output files from disk. Used by the
// gallery's right-click "Delete from disk" action. Every path is resolved
// against the appropriate ComfyUI base dir and refused if it escapes that dir
// (defence against traversal via crafted filename/subfolder).
//
// Body: { files: [{ filename, subfolder?, type? }] }
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
    let deleted = 0;
    const failed: string[] = [];
    for (const f of files) {
      const filename = String(f?.filename ?? "");
      if (!filename) continue;
      const abs = resolveSafe(filename, String(f?.subfolder ?? ""), String(f?.type ?? "output"));
      if (!abs) { failed.push(filename); continue; }
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) { fs.unlinkSync(abs); deleted++; }
        else { deleted++; } // already gone → treat as success
      } catch {
        failed.push(filename);
      }
    }
    return NextResponse.json({ ok: failed.length === 0, deleted, failed });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "delete failed" }, { status: 500 });
  }
}
