import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { mkdirSync, existsSync, readFileSync, unlinkSync, rmSync } from "fs";
import { getScratchDir } from "@/lib/scratch-dir";
import { getFFmpegPath } from "@/lib/ffmpeg-path";
import { execAsync } from "@/lib/ffmpeg-path";

/**
 * POST /api/restore/preview
 * Extracts a single frame at a given timestamp, applies pre-processing
 * filters, and returns both the original and processed frame as base64.
 */
export async function POST(req: NextRequest) {
  // Install-local scratch, NOT os.tmpdir(): these are frames of the user's private video.
  // See src/lib/scratch-dir.ts; swept by the `appScratch` cleanup category.
  const previewDir = path.join(getScratchDir("restore"), "_preview");

  try {
    const body = await req.json();
    const {
      videoPath,
      timestamp = 0,
      denoiseEnabled = false,
      denoiseStrength = 8,
      brightnessAdjust = 0,
      contrastAdjust = 1.0,
    } = body;

    if (!videoPath || !existsSync(videoPath)) {
      return NextResponse.json({ error: "Video file not found" }, { status: 400 });
    }

    const ffmpeg = getFFmpegPath();

    // Clean and recreate preview directory
    if (existsSync(previewDir)) {
      rmSync(previewDir, { recursive: true, force: true });
    }
    mkdirSync(previewDir, { recursive: true });

    const originalFrame = path.join(previewDir, "original.png");
    const processedFrame = path.join(previewDir, "processed.png");

    // Extract single frame at timestamp
    await execAsync(
      `"${ffmpeg}" -ss ${timestamp} -i "${videoPath}" -frames:v 1 -qscale:v 1 "${originalFrame}" -y`
    );

    if (!existsSync(originalFrame)) {
      return NextResponse.json({ error: "Failed to extract frame" }, { status: 500 });
    }

    // Build filter chain (same logic as the main pipeline)
    const filters: string[] = [];
    if (denoiseEnabled) {
      filters.push(`nlmeans=s=${denoiseStrength}:p=7:r=15`);
    }
    if (brightnessAdjust !== 0 || contrastAdjust !== 1.0) {
      filters.push(`eq=brightness=${brightnessAdjust}:contrast=${contrastAdjust}`);
    }

    const hasFilters = filters.length > 0;

    if (hasFilters) {
      const filterStr = filters.join(",");
      await execAsync(
        `"${ffmpeg}" -i "${originalFrame}" -vf "${filterStr}" "${processedFrame}" -y`
      );
    }

    // Read frames and convert to base64
    const originalBuffer = readFileSync(originalFrame);
    const originalB64 = `data:image/png;base64,${originalBuffer.toString("base64")}`;

    let processedB64: string | null = null;
    if (hasFilters && existsSync(processedFrame)) {
      const processedBuffer = readFileSync(processedFrame);
      processedB64 = `data:image/png;base64,${processedBuffer.toString("base64")}`;
    }

    // Cleanup
    try {
      if (existsSync(originalFrame)) unlinkSync(originalFrame);
      if (existsSync(processedFrame)) unlinkSync(processedFrame);
    } catch { /* best-effort cleanup */ }

    return NextResponse.json({
      original: originalB64,
      processed: processedB64,
      timestamp,
      filtersApplied: hasFilters,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Preview generation failed" },
      { status: 500 }
    );
  }
}
