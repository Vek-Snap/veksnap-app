import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/audio-concat
 * Concatenates two audio files (from ComfyUI output/audio/) into a single file.
 * Used by AceStep Extend mode to stitch original + newly generated section.
 *
 * Body JSON:
 *   file1: string  - filename of first audio (relative to ComfyUI output/audio/)
 *   file2: string  - filename of second audio (relative to ComfyUI output/audio/)
 *
 * Returns: { filename: string, subfolder: string }
 *   The combined audio in ComfyUI output/audio/
 */
export async function POST(req: NextRequest) {
  try {
    const { file1, file2 } = await req.json();

    if (!file1 || !file2) {
      return NextResponse.json({ error: "Missing file1 or file2" }, { status: 400 });
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const audioOutDir = path.join(comfyDir, "output", "audio");
    const inputDir = path.join(comfyDir, "input");

    // Resolve file paths: handle ComfyUI [output]/[input] annotations and audio/ subfolder prefix
    const resolve = (f: string): string | null => {
      let forceDir: string | null = null;
      if (f.endsWith("[output]")) {
        forceDir = path.join(comfyDir, "output");
        f = f.replace(/\s*\[output\]$/, "").trim();
      } else if (f.endsWith("[input]")) {
        forceDir = inputDir;
        f = f.replace(/\s*\[input\]$/, "").trim();
      }

      if (forceDir) {
        const p = path.join(forceDir, f);
        return existsSync(p) ? p : null;
      }

      // Default: check output/audio/ first, then output/, then input/
      const candidates = [
        path.join(audioOutDir, f),
        path.join(comfyDir, "output", f),
        path.join(inputDir, f),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      return null;
    };

    const path1 = resolve(file1);
    const path2 = resolve(file2);

    if (!path1) {
      return NextResponse.json({ error: `File not found: ${file1}` }, { status: 404 });
    }
    if (!path2) {
      return NextResponse.json({ error: `File not found: ${file2}` }, { status: 404 });
    }

    const ff = getFFmpegPath();
    const ts = Date.now();
    const outFilename = `VekSnap_AceStep_concat_${ts}.mp3`;
    const outPath = path.join(audioOutDir, outFilename);

    // Create a temporary concat list file for FFmpeg
    const listFile = path.join(audioOutDir, `_concat_list_${ts}.txt`);
    const listContent = `file '${path1.replace(/'/g, "'\\''")}'
file '${path2.replace(/'/g, "'\\''")}'
`;
    await writeFile(listFile, listContent, "utf-8");

    try {
      // FFmpeg concat demuxer: lossless for same-format files, re-encodes if formats differ
      await execAsync(
        `"${ff}" -y -f concat -safe 0 -i "${listFile}" -c:a libmp3lame -q:a 0 "${outPath}"`
      );
    } finally {
      // Clean up temp list file
      try {
        const { unlink } = await import("fs/promises");
        await unlink(listFile);
      } catch { /* ignore */ }
    }

    if (!existsSync(outPath)) {
      return NextResponse.json({ error: "Concatenation failed: output not created" }, { status: 500 });
    }

    return NextResponse.json({ filename: outFilename, subfolder: "audio" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Audio concatenation failed" },
      { status: 500 }
    );
  }
}
