import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isInsideAllowedRoots } from "@/lib/model-paths";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ─────────────────────────────────────────────────────────────────────────────
// Assign a user-provided image / short clip as a model's preview media.
//
// The user browses to an image or video and we save it next to the model file as
// `<stem>.preview.<NN>.<ext>`: the SAME naming the CivitAI batch fetch uses, so
// the Library auto-detects it on the card with no new concepts. This lets users
// override creator previews they dislike, or supply their own for models that
// have none (or that they made themselves).
//
// Guardrails: every write is sandboxed to the configured/allowed model roots.
// ─────────────────────────────────────────────────────────────────────────────

const IMG_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const VIDEO_EXTS = [".mp4", ".webm"];
const MEDIA_EXTS = [...IMG_EXTS, ...VIDEO_EXTS];

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

/** Next free numbered preview index next to a model (so we add, never clobber). */
function nextPreviewIndex(modelAbs: string): number {
  const dir = path.dirname(modelAbs);
  const stem = path.basename(modelAbs, path.extname(modelAbs));
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return 1; }
  const re = new RegExp(`^${escapeRe(stem)}\\.preview\\.(\\d+)(${MEDIA_EXTS.map(escapeRe).join("|")})$`, "i");
  let max = 0;
  for (const n of entries) {
    const m = n.match(re);
    if (m) { const i = parseInt(m[1], 10); if (i > max) max = i; }
  }
  return max + 1;
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const modelPath = form.get("path");
    const file = form.get("file");

    if (typeof modelPath !== "string" || !modelPath.trim()) {
      return NextResponse.json({ ok: false, error: "Missing model path" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "No file provided" }, { status: 400 });
    }

    const modelAbs = path.resolve(modelPath);
    if (!isInsideAllowedRoots(modelAbs)) {
      return NextResponse.json({ ok: false, error: "Path is outside the allowed model roots" }, { status: 400 });
    }
    if (!fs.existsSync(modelAbs)) {
      return NextResponse.json({ ok: false, error: "Model file not found" }, { status: 404 });
    }

    // Resolve the extension from the file's content-type, falling back to its name.
    const ct = (file.type || "").split(";")[0].trim().toLowerCase();
    let ext = CONTENT_TYPE_EXT[ct] || "";
    if (!ext) {
      const nameExt = path.extname(file.name || "").toLowerCase();
      ext = MEDIA_EXTS.includes(nameExt) ? nameExt : "";
    }
    if (!ext || !MEDIA_EXTS.includes(ext)) {
      return NextResponse.json(
        { ok: false, error: "Unsupported file type (use PNG, JPG, WEBP, GIF, MP4, or WEBM)" },
        { status: 400 },
      );
    }

    const dir = path.dirname(modelAbs);
    const stem = path.basename(modelAbs, path.extname(modelAbs));
    const idx = nextPreviewIndex(modelAbs);
    const dest = path.join(dir, `${stem}.preview.${pad2(idx)}${ext}`);
    if (!isInsideAllowedRoots(dest)) {
      return NextResponse.json({ ok: false, error: "Destination is outside the allowed roots" }, { status: 400 });
    }

    const buf = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return NextResponse.json({ ok: true, saved: path.basename(dest) });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Assign failed" },
      { status: 500 },
    );
  }
}
