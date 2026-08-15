import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { mkdir, writeFile, unlink } from "fs/promises";
import path from "path";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 600;
export const dynamic = "force-dynamic";

interface VideoMeta {
  width: number;
  height: number;
  fps: number;
  duration: number;
  hasAudio: boolean;
}

/** Probe video metadata */
async function probeVideo(ffprobe: string, filePath: string): Promise<VideoMeta> {
  const { stdout } = await execAsync(
    `"${ffprobe}" -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,duration -show_entries format=duration -of json "${filePath}"`
  );
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0] || {};
  const w = stream.width || 0;
  const h = stream.height || 0;

  // Parse fps from r_frame_rate (e.g. "24/1" or "24000/1001")
  let fps = 24;
  if (stream.r_frame_rate) {
    const parts = stream.r_frame_rate.split("/");
    fps = parts.length === 2 ? parseInt(parts[0]) / parseInt(parts[1]) : parseFloat(stream.r_frame_rate);
  }

  const duration = parseFloat(stream.duration) || parseFloat(info.format?.duration) || 0;

  // Check audio
  let hasAudio = false;
  try {
    const { stdout: audioOut } = await execAsync(
      `"${ffprobe}" -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${filePath}"`
    );
    hasAudio = audioOut.trim().includes("audio");
  } catch { /* no audio */ }

  return { width: w, height: h, fps: Math.round(fps * 100) / 100, duration, hasAudio };
}

/**
 * POST /api/director/combine-segments
 * Combines pre-rendered video segments into one video (hard-cut, no crossfade).
 *
 * Body JSON:
 *   files: Array<{ path: string }>  - absolute paths to video files
 *   OR
 *   videoUrls: string[]             - ComfyUI-style output URLs
 *
 * Returns: { outputUrl, meta: { width, height, fps, duration, segmentCount } }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { files, videoUrls } = body;

    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const outputDir = path.join(comfyDir, "output", "director");
    if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

    // Resolve paths from either absolute paths or ComfyUI URLs
    const videoPaths: string[] = [];
    if (files && Array.isArray(files) && files.length > 0) {
      for (const f of files) {
        const p = f.path || f;
        if (!existsSync(p)) {
          return NextResponse.json({ error: `File not found: ${p}` }, { status: 404 });
        }
        videoPaths.push(p);
      }
    } else if (videoUrls && Array.isArray(videoUrls) && videoUrls.length > 0) {
      for (const url of videoUrls) {
        try {
          const parsed = new URL(url, "http://localhost");
          const filename = parsed.searchParams.get("filename");
          const subfolder = parsed.searchParams.get("subfolder") || "";
          const type = parsed.searchParams.get("type") || "output";
          if (!filename) {
            return NextResponse.json({ error: `Could not parse filename from: ${url}` }, { status: 400 });
          }
          const vp = path.join(comfyDir, type, subfolder, filename);
          if (!existsSync(vp)) {
            return NextResponse.json({ error: `Video not found: ${vp}` }, { status: 404 });
          }
          videoPaths.push(vp);
        } catch {
          return NextResponse.json({ error: `Invalid URL: ${url}` }, { status: 400 });
        }
      }
    } else {
      return NextResponse.json({ error: "Provide 'files' or 'videoUrls' array" }, { status: 400 });
    }

    if (videoPaths.length < 2) {
      return NextResponse.json({ error: "Need at least 2 videos to combine" }, { status: 400 });
    }

    const ff = getFFmpegPath();
    const ffprobe = getFFprobePath();

    // Probe all videos
    const metas: VideoMeta[] = [];
    for (const vp of videoPaths) {
      metas.push(await probeVideo(ffprobe, vp));
    }

    // Validate matching resolution
    const refW = metas[0].width;
    const refH = metas[0].height;
    const refFps = metas[0].fps;
    for (let i = 1; i < metas.length; i++) {
      if (metas[i].width !== refW || metas[i].height !== refH) {
        return NextResponse.json({
          error: `Resolution mismatch: segment 1 is ${refW}×${refH} but segment ${i + 1} is ${metas[i].width}×${metas[i].height}`,
          mismatch: "resolution",
          details: metas.map((m, j) => ({ segment: j + 1, width: m.width, height: m.height, fps: m.fps }))
        }, { status: 422 });
      }
      // Allow ±1 fps tolerance (e.g. 23.98 vs 24)
      if (Math.abs(metas[i].fps - refFps) > 1.5) {
        return NextResponse.json({
          error: `Frame rate mismatch: segment 1 is ${refFps}fps but segment ${i + 1} is ${metas[i].fps}fps`,
          mismatch: "fps",
          details: metas.map((m, j) => ({ segment: j + 1, width: m.width, height: m.height, fps: m.fps }))
        }, { status: 422 });
      }
    }

    const anyAudio = metas.some(m => m.hasAudio);
    const N = videoPaths.length;
    const timestamp = Date.now();
    const outputFilename = `Director_Combined_${timestamp}.mp4`;
    const outputPath = path.join(outputDir, outputFilename);

    // Build concat demuxer file list (most reliable method for hard-cut)
    const concatListPath = path.join(outputDir, `concat_${timestamp}.txt`);
    const concatContent = videoPaths.map(p => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
    await writeFile(concatListPath, concatContent, "utf-8");

    try {
      // Use concat demuxer for clean hard-cut (preserves original encoding where possible)
      const audioMap = anyAudio ? "" : "-an";
      const cmd = `"${ff}" -y -f concat -safe 0 -i "${concatListPath}" -c copy ${audioMap} "${outputPath}"`;
      console.log(`[combine] cmd: ${cmd.slice(0, 300)}...`);

      try {
        await execAsync(cmd);
      } catch {
        // Fallback: re-encode if codec mismatch prevents stream copy
        console.log(`[combine] stream copy failed, falling back to re-encode...`);
        const inputs = videoPaths.map((p) => `-i "${p}"`).join(" ");
        const vLabels = videoPaths.map((_, i) => `[${i}:v]`).join("");
        let filterComplex = `${vLabels}concat=n=${N}:v=1:a=0[vout]`;

        let mapAudio = "";
        if (anyAudio) {
          const audioLabels: string[] = [];
          let audioSilenceFilters = "";
          for (let i = 0; i < N; i++) {
            if (metas[i].hasAudio) {
              audioLabels.push(`[${i}:a]`);
            } else {
              const silLabel = `[sil${i}]`;
              audioSilenceFilters += `anullsrc=r=44100:cl=stereo[silraw${i}];[silraw${i}]atrim=0:${metas[i].duration.toFixed(3)}${silLabel};`;
              audioLabels.push(silLabel);
            }
          }
          filterComplex = audioSilenceFilters + filterComplex + `;${audioLabels.join("")}concat=n=${N}:v=0:a=1[aout]`;
          mapAudio = `-map "[aout]" -c:a aac -b:a 192k`;
        }

        const reencodeCmd = `"${ff}" -y ${inputs} -filter_complex "${filterComplex}" -map "[vout]" ${mapAudio} -c:v libx264 -pix_fmt yuv420p -r ${Math.round(refFps)} "${outputPath}"`;
        console.log(`[combine] re-encode cmd: ${reencodeCmd.slice(0, 300)}...`);
        await execAsync(reencodeCmd);
      }
    } finally {
      // Clean up concat list
      try { await unlink(concatListPath); } catch { /* ignore */ }
    }

    if (!existsSync(outputPath)) {
      return NextResponse.json({ error: "Combine failed: no output file" }, { status: 500 });
    }

    const { size } = require("fs").statSync(outputPath);
    const totalDuration = metas.reduce((sum, m) => sum + m.duration, 0);
    console.log(`[combine] Output: ${outputFilename} (${(size / 1024 / 1024).toFixed(1)} MB, ${totalDuration.toFixed(1)}s, ${N} segments)`);

    const outputUrl = `/api/comfyui/view?filename=${encodeURIComponent(outputFilename)}&subfolder=director&type=output`;
    return NextResponse.json({
      outputUrl,
      meta: {
        width: refW,
        height: refH,
        fps: refFps,
        duration: totalDuration,
        segmentCount: N,
        fileSize: size,
      }
    });
  } catch (err) {
    console.error("[combine] Unexpected error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Combine failed" },
      { status: 500 }
    );
  }
}
