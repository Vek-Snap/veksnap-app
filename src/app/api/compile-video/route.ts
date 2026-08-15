import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import { createReadStream, existsSync, readFileSync } from "fs";
import path from "path";
import { getScratchDir } from "@/lib/scratch-dir";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";
const COMFYUI = COMFYUI_HTTP;
const COMFYUI_ROOT = path.resolve(process.cwd(), "..", "ComfyUI");
const TYPE_DIR_MAP: Record<string, string> = { output: "output", temp: "temp", input: "input" };
const DOWNLOAD_CONCURRENCY = 10; // parallel frame fetches

interface FrameInfo {
  filename: string;
  subfolder: string;
  type: string;
}

/** Download a single frame from ComfyUI and write to disk.
 *  Falls back to direct disk read if HTTP proxy fails (e.g. TinyWall blocking loopback). */
async function downloadFrame(
  f: FrameInfo,
  index: number,
  tmpDir: string
): Promise<void> {
  const paddedIndex = String(index).padStart(5, "0");
  const outPath = path.join(tmpDir, `frame_${paddedIndex}.png`);

  // Try HTTP proxy first
  try {
    const params = new URLSearchParams({
      filename: f.filename,
      subfolder: f.subfolder || "",
      type: f.type || "output",
    });
    const res = await fetch(`${COMFYUI}/view?${params.toString()}`);
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(outPath, buffer);
      return;
    }
  } catch { /* proxy failed, try disk */ }

  // Fallback: read directly from ComfyUI directory on disk
  const dir = TYPE_DIR_MAP[f.type || "output"] || "output";
  const diskPath = path.join(COMFYUI_ROOT, dir, f.subfolder || "", f.filename);
  if (existsSync(diskPath)) {
    const buffer = readFileSync(diskPath);
    await fs.writeFile(outPath, buffer);
    return;
  }
  throw new Error(`Failed to fetch frame: ${f.filename}`);
}

/** Run tasks with a concurrency limit */
async function parallelLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker() {
    while (next < tasks.length) {
      const idx = next++;
      results[idx] = await tasks[idx]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { frames, fps, format } = body as {
    frames: FrameInfo[];
    fps: number;
    format: "mp4" | "gif" | "webm";
  };

  if (!frames || frames.length === 0) {
    return NextResponse.json({ error: "No frames provided" }, { status: 400 });
  }

  // Install-local scratch, NOT os.tmpdir() (see src/lib/scratch-dir.ts), these are the
  // user's rendered frames. Swept by the `appScratch` cleanup category.
  const tmpDir = path.join(getScratchDir("compile-video"), String(Date.now()));
  const outputFile = path.join(tmpDir, "output." + format);

  try {
    await fs.mkdir(tmpDir, { recursive: true });

    // Download frames from ComfyUI in parallel (10 concurrent)
    const tasks = frames.map((f, i) => () => downloadFrame(f, i, tmpDir));
    await parallelLimit(tasks, DOWNLOAD_CONCURRENCY);

    // Build ffmpeg command based on format
    const inputPattern = path.join(tmpDir, "frame_%05d.png");
    const ff = getFFmpegPath();
    let cmd: string;

    switch (format) {
      case "mp4":
        cmd = `"${ff}" -y -framerate ${fps} -i "${inputPattern}" -c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium -movflags +faststart "${outputFile}"`;
        break;
      case "webm":
        cmd = `"${ff}" -y -framerate ${fps} -i "${inputPattern}" -c:v libvpx-vp9 -crf 30 -b:v 0 -pix_fmt yuv420p "${outputFile}"`;
        break;
      case "gif": {
        // Two-pass for high quality GIF with palette
        const paletteFile = path.join(tmpDir, "palette.png");
        const pass1 = `"${ff}" -y -framerate ${fps} -i "${inputPattern}" -vf "fps=${fps},scale=-1:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=diff" "${paletteFile}"`;
        const pass2 = `"${ff}" -y -framerate ${fps} -i "${inputPattern}" -i "${paletteFile}" -lavfi "fps=${fps},scale=-1:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=floyd_steinberg" -loop 0 "${outputFile}"`;
        await execAsync(pass1);
        cmd = pass2;
        break;
      }
      default:
        return NextResponse.json({ error: "Invalid format" }, { status: 400 });
    }

    await execAsync(cmd);

    // Stream the compiled video instead of buffering it all in memory
    const stat = await fs.stat(outputFile);
    const contentTypes: Record<string, string> = {
      mp4: "video/mp4",
      webm: "video/webm",
      gif: "image/gif",
    };

    const nodeStream = createReadStream(outputFile);
    const webStream = new ReadableStream({
      start(controller) {
        nodeStream.on("data", (chunk) => controller.enqueue(chunk as Uint8Array));
        nodeStream.on("end", () => {
          controller.close();
          // Clean up temp files after streaming completes
          fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        });
        nodeStream.on("error", (err) => {
          controller.error(err);
          fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        });
      },
    });

    return new Response(webStream, {
      status: 200,
      headers: {
        "Content-Type": contentTypes[format],
        "Content-Disposition": `attachment; filename="veksnap_output.${format}"`,
        "Content-Length": String(stat.size),
      },
    });
  } catch (err) {
    // Clean up on error
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : "Compilation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
