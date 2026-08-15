import { NextRequest, NextResponse } from "next/server";
import { existsSync, readdirSync, statSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";
import path from "path";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 600;
export const dynamic = "force-dynamic";

/**
 * POST /api/director/assemble-directory
 * Scans the ComfyUI output directory (default: output/ltx2) for numbered video files,
 * sorts them sequentially, and concatenates them into one video.
 *
 * This is a "dumb" assembler, no tracking logic. It just looks at what's on disk.
 * Prefers "-audio" variants (muxed audio) over silent ones.
 *
 * Body JSON:
 *   subfolder?: string       - output subfolder to scan (default: "ltx2")
 *   prefix?: string          - filename prefix filter (default: "VekSnap_LTX2_Official_")
 *   preferAudio?: boolean    - prefer files with "-audio" suffix (default: true)
 *   frameRate?: number       - output frame rate for re-encode fallback (default: 24)
 *   trimOverlap?: boolean    - trim last frame from each segment except final (default: true)
 *
 * Returns: { outputUrl, files, meta: { count, duration } }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      subfolder = "ltx2",
      prefix = "VekSnap_LTX2_Official_",
      preferAudio = true,
      frameRate = 24,
      trimOverlap = true,
    } = body;

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const scanDir = path.join(comfyDir, "output", subfolder);

    if (!existsSync(scanDir)) {
      return NextResponse.json({ error: `Directory not found: output/${subfolder}` }, { status: 404 });
    }

    // Scan directory for matching files
    const allFiles = readdirSync(scanDir);
    const mp4Files = allFiles.filter(
      (f) => f.toLowerCase().endsWith(".mp4") && f.startsWith(prefix)
    );

    if (mp4Files.length === 0) {
      return NextResponse.json(
        { error: `No files found matching "${prefix}*.mp4" in output/${subfolder}` },
        { status: 404 }
      );
    }

    // Extract numeric portion and group by number
    // e.g. "VekSnap_LTX2_Official_00001-audio.mp4" → number = 1, hasAudioSuffix = true
    const parsed: { file: string; num: number; hasAudioSuffix: boolean }[] = [];
    const numRegex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)(-audio)?\\.mp4$`, "i");

    for (const f of mp4Files) {
      const match = f.match(numRegex);
      if (match) {
        parsed.push({
          file: f,
          num: parseInt(match[1], 10),
          hasAudioSuffix: !!match[2],
        });
      }
    }

    if (parsed.length === 0) {
      return NextResponse.json(
        { error: `No numbered files found matching pattern "${prefix}NNNNN[-audio].mp4"` },
        { status: 404 }
      );
    }

    // Group by number, pick best variant per number
    const byNum = new Map<number, typeof parsed>();
    for (const p of parsed) {
      if (!byNum.has(p.num)) byNum.set(p.num, []);
      byNum.get(p.num)!.push(p);
    }

    // Sort by number, pick preferred variant
    const sortedNums = [...byNum.keys()].sort((a, b) => a - b);
    const selectedFiles: string[] = [];
    const selectedNames: string[] = [];

    for (const num of sortedNums) {
      const variants = byNum.get(num)!;
      let pick: typeof parsed[0];
      if (preferAudio) {
        pick = variants.find((v) => v.hasAudioSuffix) || variants[0];
      } else {
        pick = variants.find((v) => !v.hasAudioSuffix) || variants[0];
      }
      selectedFiles.push(path.join(scanDir, pick.file));
      selectedNames.push(pick.file);
    }

    if (selectedFiles.length < 2) {
      return NextResponse.json(
        { error: `Only ${selectedFiles.length} segment(s) found: need at least 2 to assemble. Files: ${selectedNames.join(", ")}` },
        { status: 400 }
      );
    }

    // Verify all files exist and are non-empty
    for (const fp of selectedFiles) {
      if (!existsSync(fp)) {
        return NextResponse.json({ error: `File disappeared: ${path.basename(fp)}` }, { status: 404 });
      }
      const st = statSync(fp);
      if (st.size === 0) {
        return NextResponse.json({ error: `Empty file: ${path.basename(fp)}` }, { status: 400 });
      }
    }

    const ff = getFFmpegPath();
    const ffprobe = getFFprobePath();
    const outputDir = path.join(comfyDir, "output", "director");
    if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

    const timestamp = Date.now();
    const outputFilename = `Director_DirAssemble_${timestamp}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);
    const N = selectedFiles.length;

    console.log(`[dir-assemble] Found ${N} segments in output/${subfolder}: ${selectedNames.join(", ")}`);

    // Probe VIDEO stream duration for each file (not container duration:
    // audio & video streams can differ in length within the same file)
    const videoDurations: number[] = [];
    const audioDurations: number[] = [];
    const audioFlags: boolean[] = [];

    for (const fp of selectedFiles) {
      // Video stream duration
      try {
        const { stdout } = await execAsync(
          `"${ffprobe}" -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${fp}"`
        );
        videoDurations.push(parseFloat(stdout.trim()) || 4);
      } catch {
        videoDurations.push(4);
      }
      // Audio stream presence + duration
      try {
        const { stdout: codecOut } = await execAsync(
          `"${ffprobe}" -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${fp}"`
        );
        const hasAud = codecOut.trim().includes("audio");
        audioFlags.push(hasAud);
        if (hasAud) {
          const { stdout: durOut } = await execAsync(
            `"${ffprobe}" -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "${fp}"`
          );
          audioDurations.push(parseFloat(durOut.trim()) || videoDurations[videoDurations.length - 1]);
        } else {
          audioDurations.push(0);
        }
      } catch {
        audioFlags.push(false);
        audioDurations.push(0);
      }
    }

    const anyAudio = audioFlags.some(Boolean);
    const frameDur = 1 / frameRate;

    // Log the per-segment durations to help diagnose alignment
    for (let i = 0; i < N; i++) {
      const diff = audioFlags[i] ? (audioDurations[i] - videoDurations[i]) : 0;
      console.log(`[dir-assemble] Seg ${i}: video=${videoDurations[i].toFixed(6)}s, audio=${audioFlags[i] ? audioDurations[i].toFixed(6) : "none"}s, diff=${diff > 0 ? "+" : ""}${(diff * 1000).toFixed(1)}ms`);
    }

    // Always use filter_complex, even without trimOverlap, to align
    // audio precisely to video duration per segment. Without this, any
    // audio/video length mismatch inside each file accumulates across
    // segments, creating audible hiccups at boundaries.
    try {
      // Video chain
      let videoFilter = "";
      const vLabels: string[] = [];
      for (let i = 0; i < N; i++) {
        if (trimOverlap && i < N - 1) {
          // Trim last frame from non-final segments (I2V overlap removal)
          const trimEnd = Math.max(0, videoDurations[i] - frameDur);
          videoFilter += `[${i}:v]trim=0:${trimEnd.toFixed(6)},setpts=PTS-STARTPTS[tv${i}];`;
          vLabels.push(`[tv${i}]`);
        } else {
          vLabels.push(`[${i}:v]`);
        }
      }
      videoFilter += `${vLabels.join("")}concat=n=${N}:v=1:a=0[vout]`;

      // Audio chain: align each segment's audio to its video duration
      // so boundaries match exactly when concatenated.
      let audioFilter = "";
      let mapAudio = "";
      if (anyAudio) {
        const aLabels: string[] = [];
        for (let i = 0; i < N; i++) {
          // Target duration = this segment's video duration (after trim if applicable)
          const targetDur = (trimOverlap && i < N - 1)
            ? Math.max(0, videoDurations[i] - frameDur)
            : videoDurations[i];

          if (audioFlags[i]) {
            // atrim clips audio that's longer than video; apad extends if shorter.
            // Together they force audio to exactly match the video duration.
            audioFilter += `[${i}:a]atrim=0:${targetDur.toFixed(6)},asetpts=PTS-STARTPTS,apad=whole_dur=${targetDur.toFixed(6)}[ta${i}];`;
            aLabels.push(`[ta${i}]`);
          } else {
            audioFilter += `anullsrc=r=44100:cl=stereo[silraw${i}];[silraw${i}]atrim=0:${targetDur.toFixed(3)}[sil${i}];`;
            aLabels.push(`[sil${i}]`);
          }
        }
        audioFilter += `${aLabels.join("")}concat=n=${N}:v=0:a=1[aout];`;
        mapAudio = `-map "[aout]" -c:a aac -b:a 192k`;
      }

      const filterComplex = (audioFilter + videoFilter).replace(/;$/, "");
      const filterPath = path.join(outputDir, `_dirassemble_filter_${timestamp}.txt`);
      await writeFile(filterPath, filterComplex, "utf-8");
      console.log(`[dir-assemble] filter_complex:\n${filterComplex}`);

      const inputs = selectedFiles.map((p) => `-i "${p}"`).join(" ");
      const cmd = `"${ff}" -y ${inputs} -filter_complex_script "${filterPath}" -map "[vout]" ${mapAudio} -c:v libx264 -pix_fmt yuv420p -r ${frameRate} "${outputPath}"`;
      console.log(`[dir-assemble] cmd: ${cmd.slice(0, 300)}...`);

      try {
        await execAsync(cmd);
      } finally {
        try { await unlink(filterPath); } catch { /* ignore */ }
      }
    } catch (cmdErr) {
      console.error("[dir-assemble] FFmpeg error:", cmdErr);
      throw cmdErr;
    }

    if (!existsSync(outputPath)) {
      return NextResponse.json({ error: "Assembly failed: no output file produced" }, { status: 500 });
    }

    const { size } = statSync(outputPath);
    const totalDuration = videoDurations.reduce((sum: number, d: number) => sum + d, 0);
    console.log(`[dir-assemble] Output: ${outputFilename} (${(size / 1024 / 1024).toFixed(1)} MB, ${totalDuration.toFixed(1)}s, ${N} segments)`);

    const outputUrl = `/api/comfyui/view?filename=${encodeURIComponent(outputFilename)}&subfolder=director&type=output`;
    return NextResponse.json({
      outputUrl,
      files: selectedNames,
      meta: {
        count: N,
        duration: totalDuration,
        fileSize: size,
        trimOverlap,
      },
    });
  } catch (err) {
    console.error("[dir-assemble] Unexpected error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Directory assembly failed" },
      { status: 500 }
    );
  }
}
