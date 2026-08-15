import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getScratchDir } from "@/lib/scratch-dir";
import { getFFmpegPath, execFileAsync } from "@/lib/ffmpeg-path";
import { effectsFfmpeg, type ClipEffect } from "@/lib/timeline/effects";

// Effect-preview frame cache (Phase 6).
// Renders a SINGLE frame of a clip through its effect chain so the editor can show
// an accurate, burned-in preview of effects (sharpen / glitch / vignette …) that the
// CSS approximation can't reproduce. This is the same render path the export uses,
// guaranteeing "what you preview is what you get".

const f3 = (n: number): string => Number(n).toFixed(3);

interface FrameRequest {
  src: string;
  /** In-clip timestamp (seconds) to grab. */
  t: number;
  /** Output frame size. */
  width: number;
  height: number;
  effects?: ClipEffect[];
  /** Image asset (no -ss seek into a still). */
  isImage?: boolean;
}

export async function POST(req: NextRequest) {
  let body: FrameRequest;
  try {
    body = (await req.json()) as FrameRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body?.src) return NextResponse.json({ error: "Missing src" }, { status: 400 });

  const W = Math.max(16, Math.round(body.width || 640));
  const H = Math.max(16, Math.round(body.height || 360));
  const t = Math.max(0, body.t || 0);

  const tmpDir = path.join(getScratchDir("frames"), Date.now() + "-" + Math.random().toString(36).slice(2));
  const outPath = path.join(tmpDir, "frame.jpg");

  const vf = [...effectsFfmpeg(body.effects), `scale=${W}:${H}:force_original_aspect_ratio=decrease`].join(",");

  const args: string[] = [];
  if (body.isImage) {
    args.push("-i", body.src);
  } else {
    // Seek before input for speed; one frame only.
    args.push("-ss", f3(t), "-i", body.src);
  }
  args.push("-frames:v", "1", "-vf", vf, "-q:v", "4", "-y", outPath);

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    await execFileAsync(getFFmpegPath(), args);
    const buf = await fs.readFile(outPath);
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  } catch (err) {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const e = err as { stderr?: string; message?: string };
    return NextResponse.json({ error: e.stderr || e.message || "Frame render failed" }, { status: 500 });
  }
}
