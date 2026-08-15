/**
 * Movie Maker: Concat Segments (Recovery Endpoint)
 * 
 * Re-runs the FFmpeg concat step on already-generated segment files.
 * Use this to recover when generation succeeded but concat failed
 * (e.g., command line too long, FFmpeg error, etc.)
 *
 * POST /api/movie-maker/concat-segments
 * Body: {
 *   pattern?: string,        // glob prefix to match (default: "moviemaker_dramabox_line")
 *   files?: string[],        // explicit list of absolute paths (overrides pattern)
 *   silenceGapMs?: number,   // silence between segments (default: 400)
 *   sampleRate?: number,     // output sample rate (default: 24000)
 *   outputName?: string,     // custom output filename (optional)
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";
import { apiLog } from "@/lib/api-logger";

const COMFYUI_OUTPUT = path.resolve(process.cwd(), "..", "ComfyUI", "output");

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      pattern = "moviemaker_dramabox_line",
      files,
      silenceGapMs = 400,
      sampleRate = 24000,
      outputName,
    } = body as {
      pattern?: string;
      files?: string[];
      silenceGapMs?: number;
      sampleRate?: number;
      outputName?: string;
    };

    let segmentFiles: string[];

    if (files && files.length > 0) {
      // Explicit file list provided
      segmentFiles = files;
      // Verify all exist
      for (const f of segmentFiles) {
        if (!fs.existsSync(f)) {
          return NextResponse.json({ error: `File not found: ${f}` }, { status: 404 });
        }
      }
    } else {
      // Find segments by pattern in ComfyUI output dir
      if (!fs.existsSync(COMFYUI_OUTPUT)) {
        return NextResponse.json({ error: `Output directory not found: ${COMFYUI_OUTPUT}` }, { status: 404 });
      }

      const allFiles = fs.readdirSync(COMFYUI_OUTPUT);
      segmentFiles = allFiles
        .filter((f) => f.startsWith(pattern) && (f.endsWith(".wav") || f.endsWith(".flac") || f.endsWith(".mp3")))
        .sort() // Alphabetical sort ensures correct order (files are numbered)
        .map((f) => path.join(COMFYUI_OUTPUT, f));
    }

    if (segmentFiles.length === 0) {
      return NextResponse.json(
        { error: `No segment files found matching pattern "${pattern}" in ${COMFYUI_OUTPUT}` },
        { status: 404 }
      );
    }

    apiLog("movie_maker", `[concat-segments] Found ${segmentFiles.length} segments, silenceGap=${silenceGapMs}ms`);

    // Generate output filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const finalName = outputName || `moviemaker_recovered_${timestamp}.wav`;
    const finalOutput = path.join(COMFYUI_OUTPUT, finalName);

    if (segmentFiles.length === 1) {
      fs.copyFileSync(segmentFiles[0], finalOutput);
    } else {
      // Use file-list based concat (same as generate-dialogue)
      await concatAudioWithSilence(segmentFiles, finalOutput, silenceGapMs, sampleRate);
    }

    // Get duration
    let durationSeconds = 0;
    try {
      const ffprobe = getFFmpegPath().replace("ffmpeg", "ffprobe");
      const { stdout: probeOut } = await execAsync(
        `"${ffprobe}" -v quiet -show_entries format=duration -of csv=p=0 "${finalOutput}"`
      );
      durationSeconds = parseFloat(probeOut.trim()) || 0;
    } catch { /* ignore probe failure */ }

    return NextResponse.json({
      ok: true,
      output_path: finalOutput,
      duration_seconds: Math.round(durationSeconds * 10) / 10,
      sample_rate: sampleRate,
      segments_concatenated: segmentFiles.length,
    });
  } catch (err) {
    apiLog("movie_maker", `[ERR] concat-segments: ${err instanceof Error ? err.message : String(err)}`);
    const msg = err instanceof Error ? err.message : "Concat failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── File-list based audio concat (same logic as generate-dialogue) ──
async function concatAudioWithSilence(
  inputFiles: string[],
  outputPath: string,
  silenceGapMs: number = 400,
  sampleRate: number = 24000,
): Promise<void> {
  const ffmpeg = getFFmpegPath();
  const silenceDur = silenceGapMs / 1000;
  const tempDir = path.join(COMFYUI_OUTPUT, "_moviemaker_temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  try {
    // Generate silence WAV
    const silenceFile = path.join(tempDir, `silence_${silenceGapMs}ms.wav`);
    if (!fs.existsSync(silenceFile)) {
      const silCmd = `"${ffmpeg}" -y -f lavfi -i anullsrc=r=${sampleRate}:cl=mono -t ${silenceDur} -c:a pcm_s16le "${silenceFile}"`;
      await execAsync(silCmd);
    }

    // Normalize all input files to consistent format
    const normalizedFiles: string[] = [];
    for (let i = 0; i < inputFiles.length; i++) {
      const normFile = path.join(tempDir, `seg_${String(i).padStart(4, "0")}.wav`);
      const normCmd = `"${ffmpeg}" -y -i "${inputFiles[i]}" -ar ${sampleRate} -ac 1 -c:a pcm_s16le "${normFile}"`;
      await execAsync(normCmd);
      normalizedFiles.push(normFile);
    }

    // Write concat file list
    const concatListPath = path.join(tempDir, "_concat_list.txt");
    const lines: string[] = [];
    for (let i = 0; i < normalizedFiles.length; i++) {
      lines.push(`file '${normalizedFiles[i].replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
      if (i < normalizedFiles.length - 1) {
        lines.push(`file '${silenceFile.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
      }
    }
    fs.writeFileSync(concatListPath, lines.join("\n"), "utf-8");

    // Run concat demuxer
    const concatCmd = `"${ffmpeg}" -y -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}"`;
    await execAsync(concatCmd);
  } finally {
    // Cleanup temp files
    try {
      const tempFiles = fs.readdirSync(tempDir);
      for (const f of tempFiles) {
        fs.unlinkSync(path.join(tempDir, f));
      }
      fs.rmdirSync(tempDir);
    } catch { /* ignore cleanup errors */ }
  }
}
