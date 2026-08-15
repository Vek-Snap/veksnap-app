import { NextRequest, NextResponse } from "next/server";
import { existsSync, statSync, readdirSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";
import path from "path";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 600;
export const dynamic = "force-dynamic";

// Maximum segments per batch.
// Since we use filter_complex_script (file-based) and concat demuxer (file-list),
// CLI length is not a concern. The limit is FFmpeg's open file handles (~500 on Windows).
const BATCH_SIZE = 200;

/** Probe duration of a video file in seconds */
async function probeDuration(ffprobe: string, filePath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`
    );
    return parseFloat(stdout.trim()) || 4;
  } catch {
    return 4;
  }
}

/**
 * Probe the duration of a SPECIFIC stream (video "v" or audio "a") in seconds.
 * Container/format duration is the max of all streams, but a muxed segment's audio
 * and video streams can differ in length (video grid = 1/frameRate; LTX audio grid =
 * a fixed 25 Hz / 40 ms, independent of fps). Trimming/locking against per-stream
 * durations, rather than the container max, prevents that per-segment mismatch from
 * accumulating across boundaries at frame rates other than 24. Returns 0 if unavailable.
 */
async function probeStreamDuration(ffprobe: string, filePath: string, stream: "v" | "a"): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `"${ffprobe}" -v error -select_streams ${stream}:0 -show_entries stream=duration -of csv=p=0 "${filePath}"`
    );
    const d = parseFloat(stdout.trim());
    if (isFinite(d) && d > 0) return d;
  } catch {
    /* fall through */
  }
  return 0;
}

/** Check if a video file has an audio stream */
async function hasAudio(ffprobe: string, filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `"${ffprobe}" -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${filePath}"`
    );
    return stdout.trim().includes("audio");
  } catch {
    return false;
  }
}

/**
 * Concatenate a batch of video files using FFmpeg concat demuxer (file-list based, no CLI limit).
 * Handles trimOverlap by trimming the last frame from all segments except the final one.
 */
async function concatBatch(
  ff: string,
  ffprobe: string,
  videoPaths: string[],
  outputPath: string,
  frameRate: number,
  trimOverlap: boolean,
  tempDir: string,
  batchId: string,
): Promise<void> {
  const N = videoPaths.length;
  if (N === 1) {
    // Single file: just copy
    const { copyFile } = require("fs/promises");
    await copyFile(videoPaths[0], outputPath);
    return;
  }

  const frameDur = 1 / frameRate;

  // Check if any input has audio
  const audioFlags: boolean[] = [];
  for (const vp of videoPaths) {
    audioFlags.push(await hasAudio(ffprobe, vp));
  }
  const anyAudio = audioFlags.some(Boolean);

  if (!trimOverlap) {
    // ── Simple concat demuxer (file list, no CLI length limit) ──
    const listPath = path.join(tempDir, `_concat_${batchId}.txt`);
    const listContent = videoPaths.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(listPath, listContent, "utf-8");

    const mapAudio = anyAudio ? "" : "-an";
    const cmd = `"${ff}" -y -f concat -safe 0 -i "${listPath}" -c copy ${mapAudio} -movflags +faststart "${outputPath}"`;
    try {
      await execAsync(cmd);
    } finally {
      try { await unlink(listPath); } catch { /* ignore */ }
    }
  } else {
    // ── Concat with per-segment audio-locked-to-video trim (filter_complex via script file) ──
    // Probe SEPARATE video and audio stream durations (not the container/format max):
    // an LTX segment's audio (fixed 25 Hz / 40 ms grid) and video (1/frameRate grid) can
    // differ in length, and using the container max caused that mismatch to accumulate
    // across boundaries at frame rates other than 24 (progressive A/V drift). Each
    // segment's audio is forced to exactly its own (optionally trimmed) video duration
    // via atrim + apad, which is correct at any frame rate.
    const videoDurations: number[] = [];
    for (const vp of videoPaths) {
      let vDur = await probeStreamDuration(ffprobe, vp, "v");
      if (vDur <= 0) vDur = await probeDuration(ffprobe, vp);
      videoDurations.push(vDur);
    }

    const shouldTrim = (i: number) => i < N - 1;
    // Target duration for a segment = its video duration, minus one frame for every
    // non-final segment (removes the duplicated guide frame at the boundary).
    const targetDurOf = (i: number) =>
      shouldTrim(i) ? Math.max(0, videoDurations[i] - frameDur) : videoDurations[i];

    let videoFilter = "";
    const trimmedVLabels: string[] = [];
    for (let i = 0; i < N; i++) {
      if (shouldTrim(i)) {
        videoFilter += `[${i}:v]trim=0:${targetDurOf(i).toFixed(6)},setpts=PTS-STARTPTS[tv${i}];`;
        trimmedVLabels.push(`[tv${i}]`);
      } else {
        trimmedVLabels.push(`[${i}:v]`);
      }
    }
    videoFilter += `${trimmedVLabels.join("")}concat=n=${N}:v=1:a=0[vout]`;

    let audioFilter = "";
    let mapAudio = "";
    if (anyAudio) {
      const audioLabels: string[] = [];
      for (let i = 0; i < N; i++) {
        const targetDur = targetDurOf(i);
        if (audioFlags[i]) {
          // atrim clips audio longer than the video; apad extends audio shorter than it.
          // Together they force this segment's audio to exactly match its video duration.
          audioFilter += `[${i}:a]atrim=0:${targetDur.toFixed(6)},asetpts=PTS-STARTPTS,apad=whole_dur=${targetDur.toFixed(6)}[ta${i}];`;
          audioLabels.push(`[ta${i}]`);
        } else {
          const silLabel = `[sil${i}]`;
          audioFilter += `anullsrc=r=44100:cl=stereo[silraw${i}];[silraw${i}]atrim=0:${targetDur.toFixed(3)}${silLabel};`;
          audioLabels.push(silLabel);
        }
      }
      audioFilter += `${audioLabels.join("")}concat=n=${N}:v=0:a=1[aout];`;
      mapAudio = `-map "[aout]" -c:a aac -b:a 192k`;
    }

    const filterComplex = (audioFilter + videoFilter).replace(/;$/, "");
    const filterPath = path.join(tempDir, `_filter_${batchId}.txt`);
    await writeFile(filterPath, filterComplex, "utf-8");

    const inputs = videoPaths.map((p) => `-i "${p}"`).join(" ");
    const cmd = `"${ff}" -y ${inputs} -filter_complex_script "${filterPath}" -map "[vout]" ${mapAudio} -c:v libx264 -pix_fmt yuv420p -r ${frameRate} -movflags +faststart "${outputPath}"`;

    try {
      await execAsync(cmd);
    } finally {
      try { await unlink(filterPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Recursively concatenate an array of video files in batches.
 * Each level merges groups of BATCH_SIZE into intermediate files,
 * then the next level merges those intermediates, until one file remains.
 */
async function batchedConcat(
  ff: string,
  ffprobe: string,
  videoPaths: string[],
  outputPath: string,
  frameRate: number,
  trimOverlap: boolean,
  tempDir: string,
  level: number = 0,
): Promise<string[]> {
  // Track temp files for cleanup
  const tempFiles: string[] = [];

  if (videoPaths.length <= BATCH_SIZE) {
    // Fits in one batch: concat directly to output
    await concatBatch(ff, ffprobe, videoPaths, outputPath, frameRate, trimOverlap, tempDir, `L${level}`);
    return tempFiles;
  }

  // Split into batches
  const batches: string[][] = [];
  for (let i = 0; i < videoPaths.length; i += BATCH_SIZE) {
    batches.push(videoPaths.slice(i, i + BATCH_SIZE));
  }

  console.log(`[concat] Level ${level}: splitting ${videoPaths.length} files into ${batches.length} batches of ≤${BATCH_SIZE}`);

  // Concat each batch to an intermediate file
  const intermediates: string[] = [];
  for (let b = 0; b < batches.length; b++) {
    const intermediatePath = path.join(tempDir, `_batch_L${level}_B${b}_${Date.now()}.mp4`);
    await concatBatch(ff, ffprobe, batches[b], intermediatePath, frameRate, trimOverlap, tempDir, `L${level}_B${b}`);
    intermediates.push(intermediatePath);
    tempFiles.push(intermediatePath);
  }

  // Recursively merge intermediates: MUST propagate trimOverlap because the last segment
  // in each batch retains its +1 frame (it's the "final" segment of that batch).
  // Without trimming at batch boundaries, there's a duplicate frame + audio discontinuity.
  const subTempFiles = await batchedConcat(ff, ffprobe, intermediates, outputPath, frameRate, trimOverlap, tempDir, level + 1);
  tempFiles.push(...subTempFiles);

  return tempFiles;
}

/**
 * Concatenate a batch with crossfade transitions.
 * Limited to BATCH_SIZE inputs per call (filter_complex grows with N).
 */
async function crossfadeBatch(
  ff: string,
  ffprobe: string,
  videoPaths: string[],
  outputPath: string,
  frameRate: number,
  crossfadeSec: number,
  tempDir: string,
  batchId: string,
): Promise<void> {
  const N = videoPaths.length;
  if (N === 1) {
    const { copyFile } = require("fs/promises");
    await copyFile(videoPaths[0], outputPath);
    return;
  }

  const durations: number[] = [];
  for (const vp of videoPaths) {
    durations.push(await probeDuration(ffprobe, vp));
  }

  const audioFlags: boolean[] = [];
  for (const vp of videoPaths) {
    audioFlags.push(await hasAudio(ffprobe, vp));
  }
  const anyAudio = audioFlags.some(Boolean);

  // Build video xfade chain
  let videoFilter = "";
  let prevVLabel = "[0:v]";
  let cumulativeDuration = durations[0];

  for (let i = 1; i < N; i++) {
    const offset = Math.max(0, cumulativeDuration - crossfadeSec);
    const outLabel = i === N - 1 ? "[vout]" : `[xv${i}]`;
    videoFilter += `${prevVLabel}[${i}:v]xfade=transition=fade:duration=${crossfadeSec}:offset=${offset.toFixed(3)}${outLabel};`;
    cumulativeDuration = offset + durations[i];
    prevVLabel = outLabel;
  }

  // Build audio concat chain
  let audioFilter = "";
  let mapAudio = "";
  if (anyAudio) {
    const audioLabels: string[] = [];
    for (let i = 0; i < N; i++) {
      if (audioFlags[i]) {
        audioLabels.push(`[${i}:a]`);
      } else {
        const silLabel = `[sil${i}]`;
        audioFilter += `anullsrc=r=44100:cl=stereo[silraw${i}];[silraw${i}]atrim=0:${durations[i].toFixed(3)}${silLabel};`;
        audioLabels.push(silLabel);
      }
    }
    audioFilter += `${audioLabels.join("")}concat=n=${N}:v=0:a=1[aout];`;
    mapAudio = `-map "[aout]" -c:a aac -b:a 192k`;
  }

  const filterComplex = (audioFilter + videoFilter).replace(/;$/, "");
  const filterPath = path.join(tempDir, `_xfade_${batchId}.txt`);
  await writeFile(filterPath, filterComplex, "utf-8");

  const inputs = videoPaths.map((p) => `-i "${p}"`).join(" ");
  const cmd = `"${ff}" -y ${inputs} -filter_complex_script "${filterPath}" -map "[vout]" ${mapAudio} -c:v libx264 -pix_fmt yuv420p -r ${frameRate} -movflags +faststart "${outputPath}"`;

  try {
    await execAsync(cmd);
  } finally {
    try { await unlink(filterPath); } catch { /* ignore */ }
  }
}

/**
 * POST /api/director/concatenate
 * Concatenates multiple ComfyUI output videos into one, with optional crossfade.
 * Uses batched recursive approach: handles unlimited segment counts (feature-film scale).
 *
 * Body JSON:
 *   videoUrls: string[]       - array of ComfyUI output URLs
 *   crossfadeFrames: number   - frames of crossfade between segments (0 = hard cut)
 *   frameRate: number         - output frame rate
 *   trimOverlap: boolean      - if true, drop last frame from every segment except the final one
 *                                to eliminate I2V chain boundary duplicates (default: true)
 *
 * Returns: { outputUrl: string } - ComfyUI-style URL to the final video
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { videoUrls, crossfadeFrames = 0, frameRate = 24, trimOverlap = true, segmentIndices } = body;
    const hasIndices = Array.isArray(segmentIndices) && segmentIndices.length === videoUrls?.length;

    if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length < 2) {
      return NextResponse.json({ error: "Need at least 2 videoUrls" }, { status: 400 });
    }

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const outputDir = path.join(comfyDir, "output", "director");
    if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

    // Resolve all video paths from ComfyUI-style URLs.
    // When a file is missing and segmentIndices are provided, try to find a fallback
    // file by scanning the output directory for a match on the expected segment number
    // (1-indexed, zero-padded to 5 digits). This handles re-renders where the user
    // renamed files to match the expected sequence but the save state still has the
    // old auto-incremented filename.
    const videoPaths: string[] = [];
    const skipped: string[] = [];
    const resolved: string[] = []; // fallback-resolved filenames for logging
    for (let urlIdx = 0; urlIdx < videoUrls.length; urlIdx++) {
      const url = videoUrls[urlIdx];
      try {
        const parsed = new URL(url, "http://localhost");
        const filename = parsed.searchParams.get("filename");
        const subfolder = parsed.searchParams.get("subfolder") || "";
        const type = parsed.searchParams.get("type") || "output";
        if (!filename) {
          console.warn(`[concat] Skipping unparseable URL: ${url}`);
          skipped.push(url);
          continue;
        }
        let vp = path.join(comfyDir, type, subfolder, filename);
        if (!existsSync(vp) && hasIndices) {
          // Fallback: scan the same directory for a file whose name contains the
          // expected segment number (e.g. "00002" for segment index 1).
          const segNum = String((segmentIndices[urlIdx] as number) + 1).padStart(5, "0");
          const dir = path.join(comfyDir, type, subfolder);
          try {
            const dirFiles = readdirSync(dir);
            const candidates = dirFiles.filter(
              (f) => f.includes(segNum) && f.toLowerCase().endsWith(".mp4")
            );
            // Prefer the "-audio" variant (has muxed audio track) over the silent one
            const match = candidates.find((f) => f.includes("-audio")) || candidates[0];
            if (match) {
              const fallback = path.join(dir, match);
              console.log(`[concat] Fallback: seg ${segNum} resolved ${filename} → ${match}`);
              resolved.push(`seg${segNum}: ${match}`);
              vp = fallback;
            }
          } catch { /* dir read failed, fall through */ }
        }
        if (!existsSync(vp)) {
          console.warn(`[concat] Skipping missing file: ${vp}`);
          skipped.push(filename);
          continue;
        }
        videoPaths.push(vp);
      } catch {
        console.warn(`[concat] Skipping invalid URL: ${url}`);
        skipped.push(url);
      }
    }

    if (skipped.length > 0) {
      console.log(`[concat] Skipped ${skipped.length} missing/invalid segment(s): ${skipped.join(", ")}`);
    }

    if (videoPaths.length < 2) {
      return NextResponse.json(
        { error: `Only ${videoPaths.length} valid video(s) found (need ≥2). Skipped: ${skipped.join(", ")}` },
        { status: 400 },
      );
    }

    const ff = getFFmpegPath();
    const ffprobe = getFFprobePath();
    const timestamp = Date.now();
    const outputFilename = `Director_${timestamp}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);
    const N = videoPaths.length;

    console.log(`[concat] ${N} segments, crossfade=${crossfadeFrames}f, trimOverlap=${trimOverlap}, batchSize=${BATCH_SIZE}`);

    const tempFiles: string[] = [];

    try {
      if (crossfadeFrames > 0) {
        // ── Crossfade: batch in groups then recursively merge ──
        const crossfadeSec = crossfadeFrames / frameRate;

        if (N <= BATCH_SIZE) {
          // Small enough for single pass
          await crossfadeBatch(ff, ffprobe, videoPaths, outputPath, frameRate, crossfadeSec, outputDir, `${timestamp}`);
        } else {
          // Batch crossfade: merge groups, then concat intermediates (hard-cut between batches)
          const batches: string[][] = [];
          for (let i = 0; i < N; i += BATCH_SIZE) {
            batches.push(videoPaths.slice(i, i + BATCH_SIZE));
          }

          console.log(`[concat] Crossfade: splitting ${N} files into ${batches.length} batches of ≤${BATCH_SIZE}`);

          const intermediates: string[] = [];
          for (let b = 0; b < batches.length; b++) {
            const intermediatePath = path.join(outputDir, `_xfbatch_${timestamp}_${b}.mp4`);
            await crossfadeBatch(ff, ffprobe, batches[b], intermediatePath, frameRate, crossfadeSec, outputDir, `${timestamp}_B${b}`);
            intermediates.push(intermediatePath);
            tempFiles.push(intermediatePath);
          }

          // Merge intermediates with crossfade too (recursive if needed)
          if (intermediates.length <= BATCH_SIZE) {
            await crossfadeBatch(ff, ffprobe, intermediates, outputPath, frameRate, crossfadeSec, outputDir, `${timestamp}_final`);
          } else {
            // Extremely large: hard-cut merge of crossfaded batches (edge case)
            const subTempFiles = await batchedConcat(ff, ffprobe, intermediates, outputPath, frameRate, false, outputDir);
            tempFiles.push(...subTempFiles);
          }
        }
      } else {
        // ── Hard-cut: batched recursive concat ──
        if (trimOverlap) {
          console.log(`[concat] Trimming last frame from ${N - 1} segments (1/${frameRate}s per cut)`);
        }
        const subTempFiles = await batchedConcat(ff, ffprobe, videoPaths, outputPath, frameRate, trimOverlap, outputDir);
        tempFiles.push(...subTempFiles);
      }
    } finally {
      // Clean up all intermediate/temp files
      for (const tf of tempFiles) {
        try { await unlink(tf); } catch { /* ignore */ }
      }
    }

    if (!existsSync(outputPath)) {
      return NextResponse.json({ error: "Concatenation failed: no output file" }, { status: 500 });
    }

    const { size } = statSync(outputPath);
    console.log(`[concat] Output: ${outputFilename} (${(size / 1024 / 1024).toFixed(1)} MB)`);

    // Return ComfyUI-style URL (must include /api/comfyui prefix to route through the proxy)
    const outputUrl = `/api/comfyui/view?filename=${encodeURIComponent(outputFilename)}&subfolder=director&type=output`;
    return NextResponse.json({ outputUrl, skippedCount: skipped.length, skipped });
  } catch (err) {
    console.error("[concat] Unexpected error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Concatenation failed" },
      { status: 500 }
    );
  }
}
