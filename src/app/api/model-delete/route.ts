import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isInsideAllowedRoots } from "@/lib/model-paths";
import { listMedia } from "@/lib/model-media";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Permanently delete a model FROM DISK: the model file, its sidecar metadata,
// and every downloaded preview image/clip next to it. Destructive, the client
// double-confirms before calling this. "Remove from list only" is handled purely
// client-side (a local hide set) and never reaches this route.
//
// Sandboxed to the configured model roots so nothing outside the user's model
// directories can ever be touched. Fully offline.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_EXTS = new Set([".safetensors", ".ckpt", ".pt", ".pth", ".sft", ".gguf"]);

export async function POST(req: NextRequest) {
  let body: { path?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.mode !== "disk") {
    return NextResponse.json({ ok: false, error: "Only disk deletion is handled server-side." }, { status: 400 });
  }
  if (typeof body.path !== "string" || !body.path.trim()) {
    return NextResponse.json({ ok: false, error: "A model path is required." }, { status: 400 });
  }

  const abs = path.resolve(body.path.trim());
  if (!isInsideAllowedRoots(abs)) {
    return NextResponse.json({ ok: false, error: "Path is outside the configured model directories." }, { status: 400 });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile() || !MODEL_EXTS.has(path.extname(abs).toLowerCase())) {
    return NextResponse.json({ ok: false, error: "Not a model file." }, { status: 400 });
  }

  const dir = path.dirname(abs);
  const stem = path.basename(abs, path.extname(abs));
  const removed: string[] = [];
  const errors: string[] = [];

  const tryUnlink = (p: string) => {
    if (!isInsideAllowedRoots(p)) return;
    try {
      if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(path.basename(p)); }
    } catch (e) {
      errors.push(`${path.basename(p)}: ${(e as Error).message}`);
    }
  };

  // Preview media (images + clips) first, then the sidecar, then the model file.
  for (const m of listMedia(abs)) tryUnlink(m.path);
  tryUnlink(path.join(dir, stem + ".model-meta.json"));
  tryUnlink(abs);

  if (errors.length && !removed.includes(path.basename(abs))) {
    return NextResponse.json({ ok: false, error: errors.join("; "), removed }, { status: 500 });
  }
  return NextResponse.json({ ok: true, removed, errors });
}
