import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getFFprobePath, execFileAsync } from "@/lib/ffmpeg-path";
import { getScratchDir } from "@/lib/scratch-dir";

// Timeline media upload.
// Browser-imported files only exist as blob: URLs, which ffmpeg cannot read.
// This persists the bytes to a working dir and returns the absolute path so the
// export + frame-preview routes have a real file to render. It also ffprobes the
// file so the editor can offer to match the project resolution/fps to the import.
//
// The working dir lives under the install-local scratch root (<install>/Temp),
// so the "Clear Temporary Files" cleaner's `appScratch` category, and the
// clear-on-exit sweep: wipe these mic recordings / imports automatically, and no
// user media is ever written to the world-readable OS temp dir. Previously this
// wrote to process.cwd()/timeline-uploads, which the cleaner never saw and which
// broke the privacy rule in scratch-dir.ts. See src/lib/scratch-dir.ts.
const UPLOAD_DIR = getScratchDir("timeline-uploads");

interface ProbeResult { width?: number; height?: number; fps?: number; duration?: number }

/** Probe a media file's first video stream for width/height/fps + duration. */
async function probeVideo(filePath: string): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync(getFFprobePath(), [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate:format=duration",
      "-of", "json",
      filePath,
    ]);
    const data = JSON.parse(stdout) as {
      streams?: { width?: number; height?: number; r_frame_rate?: string }[];
      format?: { duration?: string };
    };
    const s = data.streams?.[0];
    let fps: number | undefined;
    if (s?.r_frame_rate && s.r_frame_rate.includes("/")) {
      const [n, d] = s.r_frame_rate.split("/").map(Number);
      if (n && d) fps = Math.round((n / d) * 1000) / 1000;
    }
    return {
      width: s?.width,
      height: s?.height,
      fps,
      duration: data.format?.duration ? Number(data.format.duration) : undefined,
    };
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field" }, { status: 400 });
  }

  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const safe = (file.name || "media").replace(/[^\w.\-]+/g, "_").slice(-80);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2)}_${safe}`;
    const dest = path.join(UPLOAD_DIR, unique);
    const buf = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(dest, buf);
    const probe = (file.type.startsWith("video") || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(file.name))
      ? await probeVideo(dest)
      : {};
    return NextResponse.json({ path: dest, ...probe });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
