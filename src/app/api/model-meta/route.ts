import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isInsideAllowedRoots } from "@/lib/model-paths";
import { EMPTY_MODEL_META, type ModelMeta } from "@/lib/model-meta-types";
import { listMedia } from "@/lib/model-media";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────────────────────────────────────
// Read / write a model's sidecar metadata (`<model>.model-meta.json`).
//
// Fully offline. Every path is sandboxed to the configured model roots (see
// isInsideAllowedRoots) so a crafted `path` can never read or write outside the
// user's model directories.
// ─────────────────────────────────────────────────────────────────────────────

const SIDECAR_SUFFIX = ".model-meta.json";
const IMG_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

/** Sidecar path for a model file: same folder, basename without its extension. */
function sidecarPathFor(modelAbsPath: string): string {
  const dir = path.dirname(modelAbsPath);
  const ext = path.extname(modelAbsPath);
  const stem = path.basename(modelAbsPath, ext);
  return path.join(dir, stem + SIDECAR_SUFFIX);
}

/** Resolve a displayable preview image: the user-chosen one, else a sibling image. */
function detectPreview(modelAbsPath: string, meta: ModelMeta): string {
  const dir = path.dirname(modelAbsPath);
  if (meta.preview) {
    const p = path.join(dir, meta.preview);
    if (fs.existsSync(p)) return p;
  }
  const stem = path.basename(modelAbsPath, path.extname(modelAbsPath));
  for (const e of IMG_EXTS) {
    for (const cand of [stem + e, stem + ".preview" + e, stem + ".preview.01" + e]) {
      const p = path.join(dir, cand);
      if (fs.existsSync(p)) return p;
    }
  }
  // Fall back to the first sibling image reported by the media listing.
  const firstImage = listMedia(modelAbsPath).find((m) => m.kind === "image");
  return firstImage ? firstImage.path : "";
}

function readSidecar(sidecar: string): ModelMeta {
  try {
    if (fs.existsSync(sidecar)) {
      const raw = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
      return normalize(raw);
    }
  } catch { /* corrupt → treat as empty */ }
  return { ...EMPTY_MODEL_META };
}

/** Coerce arbitrary JSON into a valid ModelMeta (defensive against hand-edits). */
function normalize(raw: unknown): ModelMeta {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    version: typeof o.version === "number" ? o.version : 1,
    triggerWords: Array.isArray(o.triggerWords) ? o.triggerWords.filter((w) => typeof w === "string") as string[] : [],
    category: typeof o.category === "string" ? o.category : "",
    notes: typeof o.notes === "string" ? o.notes : "",
    favorite: o.favorite === true,
    preview: typeof o.preview === "string" ? o.preview : "",
    civitaiVersionId: typeof o.civitaiVersionId === "number" ? o.civitaiVersionId : 0,
    civitaiModelId: typeof o.civitaiModelId === "number" ? o.civitaiModelId : 0,
    mosaic: o.mosaic === true,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
  };
}

/** Validate a caller-supplied model path: must be an existing file inside a model root. */
function validateModelPath(p: unknown): { ok: true; abs: string } | { ok: false; error: string } {
  if (typeof p !== "string" || !p.trim()) return { ok: false, error: "A model path is required." };
  const abs = path.resolve(p);
  if (!isInsideAllowedRoots(abs)) return { ok: false, error: "Path is outside the configured model directories." };
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ok: false, error: "Model file not found." };
  return { ok: true, abs };
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams.get("path");
  const v = validateModelPath(p);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });
  const meta = readSidecar(sidecarPathFor(v.abs));
  return NextResponse.json({ ok: true, meta, previewPath: detectPreview(v.abs, meta), media: listMedia(v.abs) });
}

export async function POST(req: NextRequest) {
  let body: { path?: string; patch?: Partial<ModelMeta> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }
  const v = validateModelPath(body.path);
  if (!v.ok) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });

  const sidecar = sidecarPathFor(v.abs);
  const current = readSidecar(sidecar);
  const patch = (body.patch && typeof body.patch === "object" ? body.patch : {}) as Partial<ModelMeta>;

  const merged: ModelMeta = normalize({
    ...current,
    ...patch,
    // Never let the client rewrite bookkeeping fields.
    version: 1,
    updatedAt: Date.now(),
  });

  try {
    fs.writeFileSync(sidecar, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, meta: merged });
}
