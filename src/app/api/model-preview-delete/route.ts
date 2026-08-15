import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isInsideAllowedRoots } from "@/lib/model-paths";
import { MEDIA_EXTS } from "@/lib/model-media";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Remove a SINGLE preview image/clip that sits next to a model file, the
// intuitive "delete this preview" action for the Library. Only files whose
// extension is a known media type AND that live inside an allowed model root can
// be removed, so this can never touch the model weights or arbitrary files.
// Fully offline.
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { path?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.path !== "string" || !body.path.trim()) {
    return NextResponse.json({ ok: false, error: "A media path is required." }, { status: 400 });
  }
  const abs = path.resolve(body.path.trim());
  if (!isInsideAllowedRoots(abs)) {
    return NextResponse.json({ ok: false, error: "Path is outside the configured model directories." }, { status: 400 });
  }
  if (!MEDIA_EXTS.includes(path.extname(abs).toLowerCase())) {
    return NextResponse.json({ ok: false, error: "Not a preview media file." }, { status: 400 });
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return NextResponse.json({ ok: false, error: "File not found." }, { status: 404 });
  }

  try {
    fs.unlinkSync(abs);
    return NextResponse.json({ ok: true, removed: path.basename(abs) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
