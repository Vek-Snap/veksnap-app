import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { isInsideAllowedRoots } from "@/lib/model-paths";
import { listMediaBatch, listModelDetailsBatch } from "@/lib/model-media";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Batch preview-media lookup for the Library card grid.
//
// Given a list of model paths, returns each model's sibling preview media
// (images + short videos). Directories are read once and shared across all
// models in that folder, so a whole catalog resolves in a handful of readdirs.
// Every path is sandboxed to the configured model roots. Fully offline.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PATHS = 5000;

export async function POST(req: NextRequest) {
  let body: { paths?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.paths)) {
    return NextResponse.json({ ok: false, error: "`paths` must be an array." }, { status: 400 });
  }

  // Keep only strings that resolve inside an allowed model root.
  const safe = body.paths
    .filter((p): p is string => typeof p === "string" && !!p.trim())
    .slice(0, MAX_PATHS)
    .map((p) => path.resolve(p))
    .filter(isInsideAllowedRoots);

  const media = listMediaBatch(safe);
  const details = listModelDetailsBatch(safe);
  return NextResponse.json({ ok: true, media, details });
}
