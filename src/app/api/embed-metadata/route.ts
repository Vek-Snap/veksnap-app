import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getScratchDir } from "@/lib/scratch-dir";
import { spawn } from "child_process";
import { getFFmpegPath } from "@/lib/ffmpeg-path";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/embed-metadata
//
// Writes the user-enabled metadata options INTO freshly-produced output files.
// Authoritative: for each enabled option we (re)write the tag; for each disabled
// option we STRIP it, so the toggles genuinely control what leaves the machine.
//
// Gated server-side by veksnap-settings.json (outputEmbedBasic / …Workflow /
// …Summary). All three default OFF. Best-effort per file, never fatal.
//
// Body: { files: [{filename, subfolder?, type?}], workflow?: object|null,
//         summary?: {model, seed, loras[]}|null }
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_PATH = path.resolve(process.cwd(), "veksnap-settings.json");

interface Flags { basic: boolean; workflow: boolean; summary: boolean }

function readFlags(): Flags {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    return { basic: !!s.outputEmbedBasic, workflow: !!s.outputEmbedWorkflow, summary: !!s.outputEmbedSummary };
  } catch {
    return { basic: false, workflow: false, summary: false };
  }
}

/** ComfyUI base dirs for the three file "types". */
function baseDirFor(type: string): string {
  const comfy = path.resolve(process.cwd(), "..", "ComfyUI");
  if (type === "input") return path.join(comfy, "input");
  if (type === "temp") return path.join(comfy, "temp");
  return path.join(comfy, "output");
}

/** Resolve a file ref to an absolute path, refusing anything outside its base. */
function resolveSafe(filename: string, subfolder: string, type: string): string | null {
  const base = baseDirFor(type || "output");
  const rel = path.join(subfolder || "", filename || "");
  const abs = path.resolve(base, rel);
  const baseResolved = path.resolve(base);
  if (abs !== baseResolved && !abs.startsWith(baseResolved + path.sep)) return null; // path-escape guard
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

// ── PNG tEXt handling ────────────────────────────────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// tEXt/iTXt keywords Vek-Snap manages (so a rewrite is authoritative, anything
// we don't add gets dropped when its option is off).
const MANAGED_KEYS = new Set(["workflow", "prompt", "parameters", "veksnap_summary", "Software", "Author", "Comment"]);

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeTextChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0x00]), Buffer.from(text, "latin1")]);
  const type = Buffer.from("tEXt", "latin1");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])), 0);
  return Buffer.concat([len, type, data, crc]);
}

/** Rewrite a PNG's managed tEXt chunks to exactly reflect the enabled options. */
function rewritePng(abs: string, flags: Flags, workflow: unknown, summaryStr: string | null): void {
  const buf = fs.readFileSync(abs);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return; // not a PNG (skip silently)

  const kept: Buffer[] = [];
  let iend: Buffer | null = null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const chunkEnd = off + 12 + len;
    if (chunkEnd > buf.length) break; // truncated, bail, keep original
    const chunk = buf.subarray(off, chunkEnd);
    if (type === "IEND") { iend = chunk; off = chunkEnd; continue; }
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      // keyword is up to the first NUL in the data section
      const dataStart = off + 8;
      const nul = buf.indexOf(0x00, dataStart);
      const keyword = nul > dataStart ? buf.toString("latin1", dataStart, nul) : "";
      if (MANAGED_KEYS.has(keyword)) { off = chunkEnd; continue; } // drop, we re-add if enabled
    }
    kept.push(chunk);
    off = chunkEnd;
  }
  if (!iend) return; // malformed, do not risk corrupting

  const added: Buffer[] = [];
  if (flags.basic) {
    added.push(makeTextChunk("Software", "Vek-Snap"));
    added.push(makeTextChunk("Author", "Vek-Snap"));
    added.push(makeTextChunk("Comment", "Made with Vek-Snap"));
  }
  if (flags.workflow && workflow && typeof workflow === "object") {
    const wf = JSON.stringify(workflow);
    // Store under both keys ComfyUI's PNGinfo reader recognises.
    added.push(makeTextChunk("prompt", wf));
    added.push(makeTextChunk("workflow", wf));
  }
  if (flags.summary && summaryStr) {
    added.push(makeTextChunk("veksnap_summary", summaryStr));
  }

  const out = Buffer.concat([PNG_SIG, ...kept, ...added, iend]);
  fs.writeFileSync(abs, out);
}

// ── Video / audio via ffmpeg (rewrite metadata authoritatively) ──────────────
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi"]);
const AUDIO_EXT = new Set([".flac", ".mp3", ".wav", ".m4a", ".ogg", ".opus", ".aac"]);

function runFfmpeg(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const ff = getFFmpegPath();
    if (!ff) { resolve(-1); return; }
    const child = spawn(ff, args, { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
  });
}

async function rewriteMedia(abs: string, flags: Flags, workflow: unknown, summaryStr: string | null): Promise<void> {
  // Install-local scratch, NOT os.tmpdir() (see src/lib/scratch-dir.ts). Doubly important
  // here: the old path leaked the user's ORIGINAL FILENAME into the world-readable shared
  // OS temp dir. Swept by the `appScratch` cleanup category.
  const tmp = path.join(getScratchDir("embed-metadata"), `${Date.now()}-${path.basename(abs)}`);
  // Start from a clean metadata slate (-map_metadata -1) then add only enabled tags.
  const meta: string[] = [];
  const commentParts: string[] = [];
  if (flags.basic) {
    meta.push("-metadata", "artist=Vek-Snap", "-metadata", "encoded_by=Vek-Snap");
    commentParts.push("Made with Vek-Snap");
  }
  if (flags.summary && summaryStr) {
    meta.push("-metadata", `VEKSNAP_SUMMARY=${summaryStr}`);
    commentParts.push(`summary=${summaryStr}`);
  }
  if (flags.workflow && workflow && typeof workflow === "object") {
    const wf = JSON.stringify(workflow);
    meta.push("-metadata", `VEKSNAP_WORKFLOW=${wf}`);
  }
  if (commentParts.length) meta.push("-metadata", `comment=${commentParts.join(" | ")}`);

  const args = ["-y", "-i", abs, "-map", "0", "-c", "copy", "-map_metadata", "-1", ...meta, tmp];
  const code = await runFfmpeg(args);
  if (code === 0 && fs.existsSync(tmp)) {
    try { fs.renameSync(tmp, abs); }
    catch { try { fs.copyFileSync(tmp, abs); fs.unlinkSync(tmp); } catch { /* ignore */ } }
  } else {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export async function POST(req: NextRequest) {
  try {
    const flags = readFlags();
    // Nothing enabled → no-op (keeps callers able to fire unconditionally).
    if (!flags.basic && !flags.workflow && !flags.summary) {
      return NextResponse.json({ ok: true, processed: 0, reason: "all options disabled" });
    }

    const body = await req.json().catch(() => ({}));
    const files = Array.isArray(body.files) ? body.files : [];
    const workflow = body.workflow ?? null;
    const summaryStr = body.summary ? JSON.stringify(body.summary) : null;

    let processed = 0;
    for (const f of files) {
      const abs = resolveSafe(String(f?.filename ?? ""), String(f?.subfolder ?? ""), String(f?.type ?? "output"));
      if (!abs) continue;
      const ext = path.extname(abs).toLowerCase();
      try {
        if (ext === ".png") { rewritePng(abs, flags, workflow, summaryStr); processed++; }
        else if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) { await rewriteMedia(abs, flags, workflow, summaryStr); processed++; }
        // Other formats (jpg/webp) have no lossless tEXt equivalent here, skipped.
      } catch { /* best-effort per file */ }
    }
    return NextResponse.json({ ok: true, processed });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "embed failed" }, { status: 500 });
  }
}
