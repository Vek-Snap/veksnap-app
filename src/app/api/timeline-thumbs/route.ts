import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { createReadStream } from "fs";
import { spawn } from "child_process";
import path from "path";
import crypto from "crypto";
import { getScratchDir } from "@/lib/scratch-dir";
import { getFFmpegPath, getFFprobePath, execFileAsync } from "@/lib/ffmpeg-path";

export const dynamic = "force-dynamic";

// Timeline clip filmstrip thumbnails: industry-standard PERSISTENT media
// cache (not a per-view render).
//
// Model:
//   • Frames are decoded ONCE per source file, at a FIXED height and a fixed
//     time interval, and written to disk under <install>/Temp/timeline-thumbs/
//     <hash(path)>-<mtime>/ (f_0001.jpg …) alongside a meta.json.
//   • Because the cache is keyed by absolute path + mtime, it survives zoom
//     changes, track-height changes AND app restarts, nothing re-decodes.
//   • Display is resolution/zoom-INDEPENDENT: the client picks the nearest
//     cached frame per column and lets the browser/GPU scale it. Track-height
//     and zoom changes never touch the server.
//
// Endpoints:
//   POST  { src, srcDuration? }  → ensures the strip exists, returns metadata
//                                  { key, count, interval, height, duration }.
//   GET   ?key=…&i=N             → streams the Nth cached JPEG (immutable).
//
// The install-local "Clear Temporary Files" (appScratch) sweeps the whole tree;
// we also best-effort prune strips older than PRUNE_DAYS on each POST so the
// folder can't grow without bound.

const f3 = (n: number): string => Number(n).toFixed(3);

const THUMB_H = 120;        // fixed decode height (client scales for any lane height)
const MAX_FRAMES = 300;     // hard cap on frames per source (bounds disk + decode time)
const MIN_INTERVAL = 0.5;   // never denser than one frame / 0.5s
const PRUNE_DAYS = 14;      // auto-drop strips not touched in this many days
const KEY_RE = /^[a-f0-9]{16}-\d+$/;

interface StripMeta {
  key: string;
  count: number;
  interval: number;
  height: number;
  duration: number;
  createdMs: number;
}

// ── Concurrency: cap simultaneous ffmpeg decodes, and de-dupe concurrent
//    requests for the SAME strip so N clips of one file trigger ONE job. ──
let active = 0;
const waiters: Array<() => void> = [];
const MAX_ACTIVE = 2;
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) await new Promise<void>((res) => waiters.push(res));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}
const inflight = new Map<string, Promise<StripMeta>>();

// Live progress registry (key → frames written / total). Powers the bottom
// status bar: GET ?progress=1 aggregates this across all active + queued jobs,
// mirroring how professional editors surface background media caching.
interface Prog { total: number; done: number; }
const progress = new Map<string, Prog>();

// Runs ffmpeg and reports frames written via `-progress pipe:1` (frame=N lines).
function runFfmpegProgress(args: string[], onFrame: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getFFmpegPath(), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const m = /^frame=(\d+)/.exec(line.trim());
        if (m) onFrame(parseInt(m[1], 10));
      }
    });
    child.stderr.on("data", () => { /* discard */ });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 || code === null ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
}

const cacheRoot = (): string => getScratchDir("timeline-thumbs");

function stripDir(key: string): string {
  return path.join(cacheRoot(), key);
}

async function probeDuration(src: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(getFFprobePath(), [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", src,
    ]);
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

// Best-effort: remove strips whose meta.json is older than PRUNE_DAYS.
async function pruneOld(): Promise<void> {
  try {
    const root = cacheRoot();
    const cutoff = Date.now() - PRUNE_DAYS * 86_400_000;
    const dirs = await fs.readdir(root, { withFileTypes: true });
    await Promise.all(
      dirs.filter((d) => d.isDirectory()).map(async (d) => {
        const metaPath = path.join(root, d.name, "meta.json");
        try {
          const s = await fs.stat(metaPath);
          if (s.mtimeMs < cutoff) await fs.rm(path.join(root, d.name), { recursive: true, force: true });
        } catch {
          /* no meta.json (partial/failed strip) → drop it */
          await fs.rm(path.join(root, d.name), { recursive: true, force: true }).catch(() => {});
        }
      }),
    );
  } catch {
    /* best effort */
  }
}

async function ensureStrip(src: string, srcDurationHint: number, force = false): Promise<StripMeta> {
  const stat = await fs.stat(src);
  const hash = crypto.createHash("sha1").update(src.toLowerCase()).digest("hex").slice(0, 16);
  const key = `${hash}-${Math.round(stat.mtimeMs)}`;
  const dir = stripDir(key);
  const metaPath = path.join(dir, "meta.json");

  if (force) {
    // "Refresh previews": drop any cached/partial strip so we re-decode from
    // scratch (recovers a clip whose earlier decode was interrupted or failed).
    inflight.delete(key);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  } else {
    // Fast path: strip already on disk.
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as StripMeta;
      if (meta?.count > 0) return meta;
    } catch {
      /* not cached yet */
    }
  }

  // De-dupe concurrent generation of the same strip.
  const existing = inflight.get(key);
  if (existing) return existing;

  // Register immediately (total=0 = "queued") so the status bar counts files
  // still waiting on the concurrency semaphore, not just the one decoding.
  progress.set(key, { total: 0, done: 0 });

  const job = withSlot(async () => {
    const duration = srcDurationHint > 0 ? srcDurationHint : await probeDuration(src);
    const dur = Math.max(0.1, duration || 1);
    const interval = Math.max(MIN_INTERVAL, dur / MAX_FRAMES);
    const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(dur / interval)));

    const pr = progress.get(key);
    if (pr) pr.total = count;

    await fs.mkdir(dir, { recursive: true });
    // Single pass: sample one frame per `interval` seconds across the whole file,
    // relaying frames-written for the live progress bar.
    await runFfmpegProgress([
      "-i", src,
      "-vf", `fps=${f3(1 / interval)},scale=-2:${THUMB_H}`,
      "-frames:v", String(count),
      "-fps_mode", "vfr",
      "-q:v", "5",
      "-progress", "pipe:1", "-nostats",
      "-y", path.join(dir, "f_%04d.jpg"),
    ], (frame) => { const p = progress.get(key); if (p) p.done = Math.min(frame, p.total); });

    const actual = (await fs.readdir(dir)).filter((f) => f.endsWith(".jpg")).length;
    const meta: StripMeta = {
      key,
      count: actual || count,
      interval,
      height: THUMB_H,
      duration: dur,
      createdMs: Date.now(),
    };
    await fs.writeFile(metaPath, JSON.stringify(meta));
    return meta;
  });

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
    progress.delete(key);
  }
}

export async function POST(req: NextRequest) {
  let body: { src?: string; srcDuration?: number; force?: boolean };
  try {
    body = (await req.json()) as { src?: string; srcDuration?: number; force?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body?.src || body.src.startsWith("blob:")) {
    return NextResponse.json({ error: "Missing or non-renderable src" }, { status: 400 });
  }

  void pruneOld(); // fire-and-forget housekeeping

  try {
    const meta = await ensureStrip(body.src, Math.max(0, body.srcDuration || 0), !!body.force);
    return NextResponse.json(meta, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return NextResponse.json({ error: e.stderr || e.message || "Filmstrip render failed" }, { status: 500 });
  }
}

// Streams a single cached frame. Key embeds the source mtime, so the bytes are
// immutable for that key → cache aggressively in the browser.
export async function GET(req: NextRequest) {
  // Aggregate live progress across all active + queued strips (bottom status bar).
  if (req.nextUrl.searchParams.get("progress")) {
    let total = 0, done = 0, jobs = 0;
    for (const p of progress.values()) { jobs++; total += p.total; done += p.done; }
    // Cap at 99 while work remains so it only reads 100% once the jobs clear.
    const percent = total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0;
    return NextResponse.json({ jobs, percent }, { headers: { "Cache-Control": "no-store" } });
  }

  const key = req.nextUrl.searchParams.get("key") || "";
  const i = parseInt(req.nextUrl.searchParams.get("i") || "", 10);
  if (!KEY_RE.test(key) || !Number.isInteger(i) || i < 0) {
    return new Response("Bad request", { status: 400 });
  }
  const file = path.join(stripDir(key), `f_${String(i + 1).padStart(4, "0")}.jpg`);
  let size: number;
  try {
    const s = await fs.stat(file);
    if (!s.isFile()) return new Response("Not found", { status: 404 });
    size = s.size;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const node = createReadStream(file);
      node.on("data", (c) => controller.enqueue(c as Uint8Array));
      node.on("end", () => controller.close());
      node.on("error", (e) => controller.error(e));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
