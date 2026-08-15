import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function getVideoDuration(ff: string, videoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `"${ff}" -i "${videoPath}" -f null - 2>&1`
    );
    // Try parsing "Duration: HH:MM:SS.ss" from stderr (captured via 2>&1)
    const match = stdout.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (match) {
      const hours = parseInt(match[1]);
      const mins = parseInt(match[2]);
      const secs = parseFloat(match[3]);
      return (hours * 3600 + mins * 60 + secs).toFixed(3);
    }
  } catch (err) {
    // ffmpeg -f null returns non-zero; parse output from error
    const errStr = err instanceof Error ? (err as Error & { stderr?: string }).stderr || err.message : "";
    const match = errStr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (match) {
      const hours = parseInt(match[1]);
      const mins = parseInt(match[2]);
      const secs = parseFloat(match[3]);
      return (hours * 3600 + mins * 60 + secs).toFixed(3);
    }
  }
  return "999"; // Fallback: don't truncate
}

/**
 * POST /api/director/audio-transfer
 * Extracts audio from one or more "donor" videos (e.g. LTX-2 generated output)
 * and merges it into the original user-uploaded video.
 *
 * Body JSON:
 *   originalVideoPath: string   - filesystem path to the original uploaded video
 *   donorVideoUrl: string       - single ComfyUI output URL (legacy, still supported)
 *   donorVideoUrls: string[]    - array of ComfyUI output URLs (for chunked generation)
 *   audioPath: string           - (optional) pre-extracted audio file path, skips extraction, goes straight to merge
 *   mode: "replace" | "mix"     - replace original audio entirely, or mix donor audio under original
 *   mixVolume: number           - 0.0–1.0, volume of donor audio when mixing (default 0.8)
 *   denoise: boolean            - apply spectral noise reduction to donor audio (default false)
 *   audioOnly: boolean, if true, extract/concat audio and return WAV (no video merge)
 *
 * Returns:
 *   audioOnly=true  → WAV binary with X-Audio-Path header (file kept on disk for later denoise/merge)
 *   audioOnly=false  → merged MP4 as binary download
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { originalVideoPath, donorVideoUrl, donorVideoUrls, audioPath: preExtractedAudioPath, mode = "replace", mixVolume = 0.8, denoise = false, audioOnly = false } = body;

    // Denoise filter chain: highpass 80Hz → adaptive FFT noise reduction → lowpass 14kHz
    // No quotes around filter value, no spaces, and escaped quotes break Windows cmd.exe
    const denoiseFilter = denoise ? " -af highpass=f=80,afftdn=nr=30:nf=-30:tn=1,lowpass=f=14000" : "";

    // Support both single URL and array of URLs
    const urls: string[] = donorVideoUrls && Array.isArray(donorVideoUrls)
      ? donorVideoUrls
      : donorVideoUrl
        ? [donorVideoUrl]
        : [];

    // When audioPath is provided, skip extraction entirely and jump to merge
    if (preExtractedAudioPath) {
      if (!originalVideoPath) {
        return NextResponse.json({ error: "Missing originalVideoPath for merge" }, { status: 400 });
      }
      if (!existsSync(preExtractedAudioPath)) {
        return NextResponse.json({ error: `Audio file not found: ${preExtractedAudioPath}` }, { status: 404 });
      }
      if (!existsSync(originalVideoPath)) {
        return NextResponse.json({ error: `Original video not found: ${originalVideoPath}` }, { status: 404 });
      }

      const ff = getFFmpegPath();
      const mergeDir = path.join(path.resolve(process.cwd(), "..", "ComfyUI"), "output", "v2a");
      if (!existsSync(mergeDir)) await mkdir(mergeDir, { recursive: true });
      const timestamp = Date.now();
      const suffix = mode === "mix" ? "Mix" : "";
      const outputPath = path.join(mergeDir, `VekSnap_V2A_${suffix}${timestamp}.mp4`);

      if (mode === "mix") {
        await execAsync(
          `"${ff}" -y -i "${originalVideoPath}" -i "${preExtractedAudioPath}" ` +
          `-filter_complex "[0:a]volume=1.0[a0];[1:a]volume=${mixVolume}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
          `-map 0:v:0 -map "[aout]" -c:v copy -c:a aac -b:a 192k -t ${await getVideoDuration(ff, originalVideoPath)} "${outputPath}"`
        );
      } else {
        await execAsync(
          `"${ff}" -y -i "${originalVideoPath}" -i "${preExtractedAudioPath}" ` +
          `-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -t ${await getVideoDuration(ff, originalVideoPath)} "${outputPath}"`
        );
      }

      if (!existsSync(outputPath)) {
        return NextResponse.json({ error: "FFmpeg merge failed" }, { status: 500 });
      }

      const fileBuffer = await readFile(outputPath);
      try { await unlink(outputPath); } catch { /* ignore */ }

      return new NextResponse(fileBuffer, {
        status: 200,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="VekSnap_V2A_${suffix}${timestamp}.mp4"`,
          "Content-Length": fileBuffer.length.toString(),
        },
      });
    }

    if (!originalVideoPath && !audioOnly) {
      return NextResponse.json({ error: "Missing originalVideoPath" }, { status: 400 });
    }
    if (urls.length === 0) {
      return NextResponse.json(
        { error: "Missing donorVideoUrl(s)" },
        { status: 400 }
      );
    }

    // Resolve original video path (not needed for audioOnly)
    if (!audioOnly && !existsSync(originalVideoPath)) {
      return NextResponse.json(
        { error: `Original video not found: ${originalVideoPath}` },
        { status: 404 }
      );
    }

    // Resolve donor video paths from ComfyUI URLs
    const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
    const donorPaths: string[] = [];
    for (const url of urls) {
      let donorPath: string;
      try {
        const parsed = new URL(url, "http://localhost");
        const filename = parsed.searchParams.get("filename");
        const subfolder = parsed.searchParams.get("subfolder") || "";
        const type = parsed.searchParams.get("type") || "output";
        donorPath = filename ? path.join(comfyDir, type, subfolder, filename) : url;
      } catch {
        donorPath = url;
      }
      if (!existsSync(donorPath)) {
        return NextResponse.json(
          { error: `Donor video not found: ${donorPath}` },
          { status: 404 }
        );
      }
      donorPaths.push(donorPath);
    }

    const mergeDir = path.join(comfyDir, "output", "v2a");
    if (!existsSync(mergeDir)) await mkdir(mergeDir, { recursive: true });

    const timestamp = Date.now();
    const ff = getFFmpegPath();

    // Step 1: Extract audio from each donor and concatenate if multiple
    let concatenatedAudioPath: string;
    if (donorPaths.length === 1) {
      // Single donor: extract audio directly
      concatenatedAudioPath = path.join(mergeDir, `v2a_audio_${timestamp}.wav`);
      try {
        await execAsync(
          `"${ff}" -y -i "${donorPaths[0]}" -vn${denoiseFilter} -acodec pcm_s16le -ar 44100 "${concatenatedAudioPath}"`
        );
      } catch (e) {
        // Fallback: retry without denoise if filter failed
        if (denoiseFilter) {
          console.warn("[audio-transfer] Denoise filter failed, retrying without:", e);
          await execAsync(
            `"${ff}" -y -i "${donorPaths[0]}" -vn -acodec pcm_s16le -ar 44100 "${concatenatedAudioPath}"`
          );
        } else {
          throw e;
        }
      }
    } else {
      // Multiple donors: extract audio from each, then concatenate
      const audioSegments: string[] = [];
      for (let i = 0; i < donorPaths.length; i++) {
        const segPath = path.join(mergeDir, `v2a_seg_${timestamp}_${i}.wav`);
        try {
          await execAsync(
            `"${ff}" -y -i "${donorPaths[i]}" -vn${denoiseFilter} -acodec pcm_s16le -ar 44100 "${segPath}"`
          );
        } catch (e) {
          if (denoiseFilter) {
            console.warn(`[audio-transfer] Denoise failed for chunk ${i + 1}, retrying without:`, e);
            await execAsync(
              `"${ff}" -y -i "${donorPaths[i]}" -vn -acodec pcm_s16le -ar 44100 "${segPath}"`
            );
          } else {
            throw e;
          }
        }
        if (!existsSync(segPath)) {
          return NextResponse.json(
            { error: `Failed to extract audio from donor chunk ${i + 1}` },
            { status: 500 }
          );
        }
        audioSegments.push(segPath);
      }

      // Build ffmpeg concat list file
      const listPath = path.join(mergeDir, `v2a_concat_${timestamp}.txt`);
      const listContent = audioSegments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n");
      await writeFile(listPath, listContent, "utf-8");

      concatenatedAudioPath = path.join(mergeDir, `v2a_audio_${timestamp}.wav`);
      await execAsync(
        `"${ff}" -y -f concat -safe 0 -i "${listPath}" -c copy "${concatenatedAudioPath}"`
      );

      // Clean up segments and list file
      for (const seg of audioSegments) {
        try { await unlink(seg); } catch { /* ignore */ }
      }
      try { await unlink(listPath); } catch { /* ignore */ }
    }

    if (!existsSync(concatenatedAudioPath)) {
      return NextResponse.json({ error: "Audio extraction/concat failed" }, { status: 500 });
    }

    // audioOnly mode: return the extracted WAV without merging to video
    if (audioOnly) {
      const wavBuffer = await readFile(concatenatedAudioPath);
      // Keep the file on disk: client will reference audioPath for denoise/merge later
      return new NextResponse(wavBuffer, {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "X-Audio-Path": concatenatedAudioPath,
          "Content-Length": wavBuffer.length.toString(),
        },
      });
    }

    // Step 2: Merge concatenated audio with original video
    const suffix = mode === "mix" ? "Mix" : "";
    const outputPath = path.join(mergeDir, `VekSnap_V2A_${suffix}${timestamp}.mp4`);

    if (mode === "mix") {
      // Mix: keep original audio + add donor audio at specified volume
      await execAsync(
        `"${ff}" -y -i "${originalVideoPath}" -i "${concatenatedAudioPath}" ` +
        `-filter_complex "[0:a]volume=1.0[a0];[1:a]volume=${mixVolume}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]" ` +
        `-map 0:v:0 -map "[aout]" -c:v copy -c:a aac -b:a 192k -t ${await getVideoDuration(ff, originalVideoPath)} "${outputPath}"`
      );
    } else {
      // Replace: take video from original, audio from concatenated donors
      // Use -t to trim to original video duration (donor audio may be longer or shorter)
      await execAsync(
        `"${ff}" -y -i "${originalVideoPath}" -i "${concatenatedAudioPath}" ` +
        `-map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -t ${await getVideoDuration(ff, originalVideoPath)} "${outputPath}"`
      );
    }

    // Clean up concatenated audio
    try { await unlink(concatenatedAudioPath); } catch { /* ignore */ }

    if (!existsSync(outputPath)) {
      return NextResponse.json({ error: "FFmpeg merge failed" }, { status: 500 });
    }

    const fileBuffer = await readFile(outputPath);
    try { await unlink(outputPath); } catch { /* ignore */ }

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `attachment; filename="VekSnap_V2A_${suffix}${timestamp}.mp4"`,
        "Content-Length": fileBuffer.length.toString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Audio transfer failed" },
      { status: 500 }
    );
  }
}
