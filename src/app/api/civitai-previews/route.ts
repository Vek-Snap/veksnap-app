import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { readVekSnapSettings } from "@/lib/veksnap-settings";
import { getDirsForSubKey, isInsideAllowedRoots } from "@/lib/model-paths";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Batch CivitAI preview-image fetch for LoRAs and generative checkpoints.
//
// For each model file that has no local preview yet, we hash the file (SHA-256),
// look it up on CivitAI by hash, pick a preview image (safest first), download
// it, and save it as `<stem>.preview.<ext>` next to the model, which the Library
// then auto-detects and shows on the card.
//
// Guardrails:
//   - Requires Allow Online (offline-first privacy shield must be opened).
//   - Uses the optional CivitAI API key from settings when present (higher rate
//     limits + gated content); works keyless otherwise.
//   - Every write is sandboxed to the configured model roots.
//   - Safety-aware selection: images are ordered by ascending content-safety
//     rating so the safest available preview is chosen. This is neutral plumbing
//     over the user's own files.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_EXTS = new Set([".safetensors", ".ckpt", ".pt", ".pth", ".sft", ".gguf"]);
const IMG_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const VIDEO_EXTS = [".mp4", ".webm"];
const MEDIA_EXTS = [...IMG_EXTS, ...VIDEO_EXTS];
const GENERATIVE_SUBKEYS = ["checkpoints", "diffusion_models", "unet"];
const LORA_SUBKEYS = ["loras"];
const DEFAULT_MEDIA_COUNT = 6;
const MAX_MEDIA_COUNT = 20;

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

interface CivitImage {
  url: string;
  // Content-safety rating from the CivitAI API (lower = safer). Used only to
  // prefer the safest available preview.
  safety?: number;
  type?: string;
}

interface MediaItem {
  url: string;
  kind: "image" | "video";
}

/** A CivitAI lookup result: preview media plus the ids that identify the source,
 *  which we persist to the sidecar so the link survives restarts / re-fetches. */
interface CivitResult {
  images: CivitImage[];
  versionId?: number;
  modelId?: number;
  /** CivitAI's designated trigger/activation words for this version. */
  trainedWords?: string[];
}

/** Classify a CivitAI media entry as image or video (many previews are short clips). */
function classifyKind(im: CivitImage): "image" | "video" {
  if ((im.type ?? "").toLowerCase() === "video") return "video";
  try {
    const ext = path.extname(new URL(im.url).pathname).toLowerCase();
    if (VIDEO_EXTS.includes(ext)) return "video";
  } catch { /* ignore malformed URL */ }
  return "image";
}

async function computeSHA256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

function civitaiHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function mapImages(data: unknown): CivitImage[] {
  const images = (data as { images?: unknown })?.images;
  if (!Array.isArray(images)) return [];
  return images.map((im: { url: string; type?: string; nsfwLevel?: number }) => ({
    url: im.url, type: im.type, safety: im.nsfwLevel,
  }));
}

/** Map a model-version API payload to images + its identifying ids + trigger words. */
function mapResult(data: unknown): CivitResult {
  const d = (data && typeof data === "object" ? data : {}) as { id?: unknown; modelId?: unknown; trainedWords?: unknown };
  const trainedWords = Array.isArray(d.trainedWords)
    ? d.trainedWords.filter((w): w is string => typeof w === "string" && w.trim().length > 0).map((w) => w.trim())
    : undefined;
  return {
    images: mapImages(data),
    versionId: typeof d.id === "number" ? d.id : undefined,
    modelId: typeof d.modelId === "number" ? d.modelId : undefined,
    trainedWords,
  };
}

/** Persist the CivitAI ids (and any trigger words) into the model's sidecar so
 *  the link + activation words are durable. Trigger words are merged with any the
 *  user already curated: CivitAI's designated words are added, never removed. */
function writeCivitaiIds(modelAbs: string, versionId?: number, modelId?: number, trainedWords?: string[]): void {
  if (!versionId && !modelId && !(trainedWords && trainedWords.length)) return;
  const dir = path.dirname(modelAbs);
  const stem = path.basename(modelAbs, path.extname(modelAbs));
  const sidecar = path.join(dir, stem + ".model-meta.json");
  if (!isInsideAllowedRoots(sidecar)) return;
  let obj: Record<string, unknown> = {};
  try {
    if (fs.existsSync(sidecar)) {
      const parsed = JSON.parse(fs.readFileSync(sidecar, "utf-8"));
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    }
  } catch { obj = {}; }
  if (versionId) obj.civitaiVersionId = versionId;
  if (modelId) obj.civitaiModelId = modelId;
  if (trainedWords && trainedWords.length) {
    const existing = Array.isArray(obj.triggerWords)
      ? (obj.triggerWords as unknown[]).filter((w): w is string => typeof w === "string")
      : [];
    // Case-insensitive de-dupe, preserving the user's existing order first.
    const seen = new Set(existing.map((w) => w.toLowerCase()));
    const merged = [...existing];
    for (const w of trainedWords) {
      if (!seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); merged.push(w); }
    }
    obj.triggerWords = merged;
  }
  obj.version = 1;
  obj.updatedAt = Date.now();
  try { fs.writeFileSync(sidecar, JSON.stringify(obj, null, 2) + "\n", "utf-8"); } catch { /* non-fatal */ }
}

async function queryByHash(hash: string, apiKey: string): Promise<CivitResult | null> {
  try {
    const res = await fetch(`https://civitai.com/api/v1/model-versions/by-hash/${hash}`, {
      headers: civitaiHeaders(apiKey),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return mapResult(await res.json());
  } catch {
    return null;
  }
}

/** Fetch a specific model-version's images by its CivitAI id (no hashing). */
async function queryByVersionId(id: number, apiKey: string): Promise<CivitResult | null> {
  try {
    const res = await fetch(`https://civitai.com/api/v1/model-versions/${id}`, {
      headers: civitaiHeaders(apiKey),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const result = mapResult(await res.json());
    if (!result.versionId) result.versionId = id;
    return result;
  } catch {
    return null;
  }
}

/** Resolve a model id to its most recent version id (for model-page URLs). */
async function latestVersionIdForModel(modelId: number, apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(`https://civitai.com/api/v1/models/${modelId}`, {
      headers: civitaiHeaders(apiKey),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const versions = Array.isArray(data.modelVersions) ? data.modelVersions : [];
    return versions.length && typeof versions[0].id === "number" ? versions[0].id : null;
  } catch {
    return null;
  }
}

/** Parse a CivitAI model-version reference from a URL, model URL, or bare id. */
function parseVersionRef(input: string): { versionId?: number; modelId?: number } {
  const s = input.trim();
  if (/^\d+$/.test(s)) return { versionId: parseInt(s, 10) };
  try {
    const u = new URL(s);
    const mv = u.searchParams.get("modelVersionId");
    if (mv && /^\d+$/.test(mv)) return { versionId: parseInt(mv, 10) };
    const versionMatch = u.pathname.match(/model-versions\/(\d+)/i);
    if (versionMatch) return { versionId: parseInt(versionMatch[1], 10) };
    const modelMatch = u.pathname.match(/models\/(\d+)/i);
    if (modelMatch) return { modelId: parseInt(modelMatch[1], 10) };
  } catch { /* not a URL */ }
  return {};
}

/** Resolve a user-supplied URL/ID to CivitAI images + ids, or null on failure. */
async function queryByVersionRef(input: string, apiKey: string): Promise<CivitResult | null> {
  const ref = parseVersionRef(input);
  let versionId = ref.versionId ?? null;
  if (!versionId && ref.modelId) versionId = await latestVersionIdForModel(ref.modelId, apiKey);
  if (!versionId) return null;
  const result = await queryByVersionId(versionId, apiKey);
  if (result && !result.modelId && ref.modelId) result.modelId = ref.modelId;
  return result;
}

/** Sibling preview media for a model: legacy `<stem>.preview.<ext>` and numbered
 *  `<stem>.preview.NN.<ext>` (images + videos). */
function listLocalPreviews(modelAbs: string): string[] {
  const dir = path.dirname(modelAbs);
  const stem = path.basename(modelAbs, path.extname(modelAbs));
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const re = new RegExp(`^${escapeRe(stem)}\\.preview(\\.\\d+)?(${MEDIA_EXTS.map(escapeRe).join("|")})$`, "i");
  return entries.filter((n) => re.test(n)).sort();
}

/** Whether any preview media already exists next to a model file. */
function hasLocalPreview(modelAbs: string): boolean {
  const dir = path.dirname(modelAbs);
  const stem = path.basename(modelAbs, path.extname(modelAbs));
  // A sibling image sharing the model's basename also counts (user-provided).
  for (const e of IMG_EXTS) {
    if (fs.existsSync(path.join(dir, stem + e))) return true;
  }
  return listLocalPreviews(modelAbs).length > 0;
}

/** Recursively gather model files under a directory (depth-capped). */
function walkModels(root: string, seen: Set<string>, out: string[], depth = 0): void {
  if (depth > 6 || !fs.existsSync(root)) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith("00_")) continue; // usage-notes convention
      walkModels(full, seen, out, depth + 1);
    } else if (e.isFile() && MODEL_EXTS.has(path.extname(e.name).toLowerCase())) {
      const abs = path.resolve(full);
      if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
    }
  }
}

function collectFiles(kind: string): string[] {
  const subKeys =
    kind === "loras" ? LORA_SUBKEYS
    : kind === "checkpoints" ? GENERATIVE_SUBKEYS
    : [...LORA_SUBKEYS, ...GENERATIVE_SUBKEYS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sk of subKeys) {
    for (const dir of getDirsForSubKey(sk)) {
      // Only walk directories that resolve inside an allowed model root
      // (bundled ComfyUI/models under the app root, or a base_path from
      // extra_model_paths.yaml). Never touch anything outside those.
      if (!isInsideAllowedRoots(dir)) continue;
      walkModels(dir, seen, out, 0);
    }
  }
  // Belt-and-suspenders: drop any file that somehow escaped the allowed roots.
  return out.filter(isInsideAllowedRoots);
}

/** Order CivitAI media safest-first, de-duped, capped to `count` (images + videos). */
function orderMedia(images: CivitImage[], count: number): MediaItem[] {
  const usable = images.filter((im) => !!im.url);
  usable.sort((a, b) => (a.safety ?? 0) - (b.safety ?? 0));
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const im of usable) {
    if (seen.has(im.url)) continue;
    seen.add(im.url);
    out.push({ url: im.url, kind: classifyKind(im) });
    if (out.length >= count) break;
  }
  return out;
}

/** Download one media item to `<stem>.preview.NN.<ext>`. Returns the saved filename or null. */
async function downloadMediaItem(item: MediaItem, modelAbs: string, index: number): Promise<string | null> {
  const res = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) return null;
  const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  let ext = CONTENT_TYPE_EXT[ct];
  if (!ext) {
    let urlExt = "";
    try { urlExt = path.extname(new URL(item.url).pathname).toLowerCase(); } catch { /* ignore */ }
    ext = MEDIA_EXTS.includes(urlExt) ? urlExt : (item.kind === "video" ? ".mp4" : ".jpg");
  }
  const dir = path.dirname(modelAbs);
  const stem = path.basename(modelAbs, path.extname(modelAbs));
  const dest = path.join(dir, `${stem}.preview.${pad2(index)}${ext}`);
  if (!isInsideAllowedRoots(dest)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return path.basename(dest);
}

/** Save up to `count` ordered media items next to a model. Returns saved count,
 *  0 if there was nothing usable, or -1 if the lookup itself failed / not found. */
async function saveMedia(result: CivitResult | null, abs: string, count: number): Promise<number> {
  if (!result) return -1;
  const media = orderMedia(result.images, count);
  if (media.length === 0) return 0;
  let saved = 0;
  for (let i = 0; i < media.length; i++) {
    const name = await downloadMediaItem(media[i], abs, i + 1);
    if (name) saved++;
    await new Promise((r) => setTimeout(r, 120)); // be gentle to the CDN
  }
  // Persist the source ids + trigger words so the association and activation
  // words survive restarts / re-fetches.
  if (saved > 0) writeCivitaiIds(abs, result.versionId, result.modelId, result.trainedWords);
  return saved;
}

/** Fetch (by file hash) + save up to `count` media items for one model. */
async function fetchModelMedia(abs: string, apiKey: string, count: number): Promise<number> {
  const hash = await computeSHA256(abs);
  return saveMedia(await queryByHash(hash, apiKey), abs, count);
}

export async function POST(req: Request) {
  const settings = readVekSnapSettings();
  if (!settings.allowOnline) {
    return NextResponse.json(
      { error: "Online access is disabled. Enable Network Access (Online) to fetch CivitAI previews." },
      { status: 403 }
    );
  }

  let body: { kind?: string; limit?: number; overwrite?: boolean; path?: string; count?: number; versionUrl?: string };
  try { body = await req.json(); } catch { body = {}; }
  const apiKeyEarly = settings.civitaiApiKey || "";
  // How many media items (images + short videos) to pull per model for the wall.
  const count = typeof body.count === "number" && body.count > 0
    ? Math.min(Math.round(body.count), MAX_MEDIA_COUNT)
    : DEFAULT_MEDIA_COUNT;

  // ── Single-file mode: fetch a preview for one specific model on demand. ──
  // This is the "scope individually" path: lets users avoid hashing giant
  // (45GB+) checkpoints unless they specifically pick one.
  if (typeof body.path === "string" && body.path.trim()) {
    const abs = path.resolve(body.path.trim());
    if (!isInsideAllowedRoots(abs)) {
      return NextResponse.json({ ok: false, error: "Path is outside the allowed model folders." }, { status: 400 });
    }
    if (!fs.existsSync(abs) || !MODEL_EXTS.has(path.extname(abs).toLowerCase())) {
      return NextResponse.json({ ok: false, error: "Not a model file." }, { status: 400 });
    }
    if (body.overwrite !== true && hasLocalPreview(abs)) {
      return NextResponse.json({ ok: true, fetched: 0, skipped: 1, notFound: 0, message: "A preview already exists." });
    }
    try {
      // Prefer a caller-supplied CivitAI URL / version-id: this skips hashing
      // entirely, which is the fast path for very large checkpoints.
      const useUrl = typeof body.versionUrl === "string" && body.versionUrl.trim();
      let saved: number;
      if (useUrl) {
        const result = await queryByVersionRef(body.versionUrl!.trim(), apiKeyEarly);
        if (result === null) {
          return NextResponse.json({ ok: false, error: "Could not resolve that CivitAI URL or model-version ID." }, { status: 400 });
        }
        saved = await saveMedia(result, abs, count);
      } else {
        saved = await fetchModelMedia(abs, apiKeyEarly, count);
      }
      if (saved < 0) return NextResponse.json({ ok: true, fetched: 0, skipped: 0, notFound: 1, message: "Not found on CivitAI." });
      if (saved === 0) return NextResponse.json({ ok: true, fetched: 0, skipped: 0, notFound: 1, message: "No usable preview media on CivitAI." });
      return NextResponse.json({ ok: true, fetched: saved, skipped: 0, notFound: 0, usedApiKey: !!apiKeyEarly });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  }

  const kind = body.kind === "loras" || body.kind === "checkpoints" ? body.kind : "all";
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 2000) : 500;
  const overwrite = body.overwrite === true;
  const apiKey = settings.civitaiApiKey || "";

  const files = collectFiles(kind);

  let fetched = 0, skipped = 0, notFound = 0, processed = 0;
  const errors: { file: string; error: string }[] = [];

  for (const abs of files) {
    if (processed >= limit) break;
    if (!overwrite && hasLocalPreview(abs)) { skipped++; continue; }
    processed++;
    try {
      const saved = await fetchModelMedia(abs, apiKey, count);
      if (saved < 0) { notFound++; }
      else if (saved === 0) { notFound++; }
      else { fetched += saved; }
      await new Promise((r) => setTimeout(r, 200)); // be gentle to the API
    } catch (e) {
      errors.push({ file: path.basename(abs), error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    kind,
    totalFiles: files.length,
    processed,
    fetched,
    skipped,
    notFound,
    errors,
    remaining: Math.max(0, files.length - skipped - processed),
    usedApiKey: !!apiKey,
  });
}
