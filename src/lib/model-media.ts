import fs from "fs";
import path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Shared, server-only helper for enumerating a model's sibling preview media.
//
// Matches a basename-sibling image, the legacy `<stem>.preview.<ext>`, and the
// numbered `<stem>.preview.NN.<ext>` scheme written by the CivitAI fetcher,
// including short videos (mp4/webm). Used by the model-meta route and the batch
// media route so the Library card grid can show a per-model carousel.
// ─────────────────────────────────────────────────────────────────────────────

export const IMG_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
export const VIDEO_EXTS = [".mp4", ".webm"];
export const MEDIA_EXTS = [...IMG_EXTS, ...VIDEO_EXTS];

export interface MediaRef {
  path: string;
  kind: "image" | "video";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All sibling preview media for a model, in stable numbered order. */
export function listMedia(modelAbsPath: string): MediaRef[] {
  const dir = path.dirname(modelAbsPath);
  const stem = path.basename(modelAbsPath, path.extname(modelAbsPath));
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const re = new RegExp(
    `^${escapeRe(stem)}(\\.preview)?(\\.\\d+)?(${MEDIA_EXTS.map(escapeRe).join("|")})$`,
    "i",
  );
  return entries
    .filter((n) => re.test(n))
    .sort()
    .map((n) => {
      const ext = path.extname(n).toLowerCase();
      return { path: path.join(dir, n), kind: VIDEO_EXTS.includes(ext) ? ("video" as const) : ("image" as const) };
    });
}

export interface ModelDetail {
  sizeBytes: number;
  mtimeMs: number;
  civitaiVersionId: number;
  civitaiModelId: number;
  category: string;
  mosaic: boolean;
  favorite: boolean;
}

/**
 * Key traits for many models at once: on-disk file size + modified time + the
 * persisted CivitAI link ids, category override and Privacy (mosaic) flag from
 * each model's `<stem>.model-meta.json` sidecar. Keyed by the exact input path.
 * Missing files / sidecars degrade gracefully to defaults.
 */
export function listModelDetailsBatch(modelAbsPaths: string[]): Record<string, ModelDetail> {
  const out: Record<string, ModelDetail> = {};
  for (const modelAbsPath of modelAbsPaths) {
    let sizeBytes = 0;
    let mtimeMs = 0;
    try { const st = fs.statSync(modelAbsPath); sizeBytes = st.size; mtimeMs = st.mtimeMs; } catch { /* missing → 0 */ }

    let civitaiVersionId = 0;
    let civitaiModelId = 0;
    let category = "";
    let mosaic = false;
    let favorite = false;
    const dir = path.dirname(modelAbsPath);
    const stem = path.basename(modelAbsPath, path.extname(modelAbsPath));
    const sidecar = path.join(dir, stem + ".model-meta.json");
    try {
      if (fs.existsSync(sidecar)) {
        const raw = JSON.parse(fs.readFileSync(sidecar, "utf-8")) as Record<string, unknown>;
        if (typeof raw.civitaiVersionId === "number") civitaiVersionId = raw.civitaiVersionId;
        if (typeof raw.civitaiModelId === "number") civitaiModelId = raw.civitaiModelId;
        if (typeof raw.category === "string") category = raw.category;
        if (raw.mosaic === true) mosaic = true;
        if (raw.favorite === true) favorite = true;
      }
    } catch { /* corrupt sidecar → leave defaults */ }

    out[modelAbsPath] = { sizeBytes, mtimeMs, civitaiVersionId, civitaiModelId, category, mosaic, favorite };
  }
  return out;
}

/**
 * Media for many models at once, grouped by directory so each folder is read
 * only once. Returns a map keyed by the exact input path.
 */
export function listMediaBatch(modelAbsPaths: string[]): Record<string, MediaRef[]> {
  const dirCache = new Map<string, string[]>();
  const out: Record<string, MediaRef[]> = {};
  for (const modelAbsPath of modelAbsPaths) {
    const dir = path.dirname(modelAbsPath);
    let entries = dirCache.get(dir);
    if (!entries) {
      try { entries = fs.readdirSync(dir); } catch { entries = []; }
      dirCache.set(dir, entries);
    }
    const stem = path.basename(modelAbsPath, path.extname(modelAbsPath));
    const re = new RegExp(
      `^${escapeRe(stem)}(\\.preview)?(\\.\\d+)?(${MEDIA_EXTS.map(escapeRe).join("|")})$`,
      "i",
    );
    out[modelAbsPath] = entries
      .filter((n) => re.test(n))
      .sort()
      .map((n) => {
        const ext = path.extname(n).toLowerCase();
        return { path: path.join(dir, n), kind: VIDEO_EXTS.includes(ext) ? ("video" as const) : ("image" as const) };
      });
  }
  return out;
}
