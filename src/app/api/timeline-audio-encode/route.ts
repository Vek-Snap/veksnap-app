import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getFFmpegPath, getFFprobePath, execFileAsync } from "@/lib/ffmpeg-path";
import { getScratchDir } from "@/lib/scratch-dir";

// Timeline voice/audio recorder encode.
//
// The browser can only record via MediaRecorder, whose WebM/Opus output has NO
// duration header and is effectively non-seekable, which made recorded clips
// import with a bogus fallback length and behave like a "video" file. This route
// transcodes that recording into a REAL, seekable audio file (WAV or MP3, video
// stream stripped) written under the install-local scratch root (auto-cleaned by
// the "Clear Temporary Files" cleaner), and reports the exact duration.

const UPLOAD_DIR = getScratchDir("timeline-uploads");

const ENC: Record<string, { ext: string; mime: string; args: string[] }> = {
  // 16-bit PCM: lossless, universally seekable.
  wav: { ext: "wav", mime: "audio/wav", args: ["-c:a", "pcm_s16le"] },
  // VBR ~190 kbps: excellent for voice at a fraction of the size.
  mp3: { ext: "mp3", mime: "audio/mpeg", args: ["-c:a", "libmp3lame", "-q:a", "2"] },
};

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  const format = String(form.get("format") || "wav").toLowerCase();
  const enc = ENC[format] || ENC.wav;
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }

  const rand = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inPath = path.join(UPLOAD_DIR, `rec_${rand}.in`);
  const safe = (file.name || "Voice").replace(/\.[^.]+$/, "").replace(/[^\w.\-]+/g, "_").slice(-60) || "Voice";
  const outPath = path.join(UPLOAD_DIR, `${rand}_${safe}.${enc.ext}`);

  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(inPath, Buffer.from(await file.arrayBuffer()));
    // Strip any video track (`-vn`) so the result is unambiguously an audio file.
    await execFileAsync(getFFmpegPath(), ["-y", "-i", inPath, "-vn", ...enc.args, outPath]);
    await fs.rm(inPath, { force: true });

    // Probe the exact duration from the freshly-written file (it now has real headers).
    let duration = 0;
    try {
      const { stdout } = await execFileAsync(getFFprobePath(), [
        "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nokey=1:noprint_wrappers=1", outPath,
      ]);
      duration = parseFloat(stdout.trim()) || 0;
    } catch {
      /* best effort: client falls back to its measured elapsed time */
    }

    const bytes = await fs.readFile(outPath);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": enc.mime,
        "Content-Length": String(bytes.length),
        "X-File-Path": outPath,
        "X-Duration": String(duration),
      },
    });
  } catch (err) {
    await fs.rm(inPath, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : "Audio encode failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
