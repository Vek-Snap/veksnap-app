import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import path from "path";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const INSTALL_ROOT = path.resolve(process.cwd(), "..");
const COMFYUI_INPUT = path.join(INSTALL_ROOT, "ComfyUI", "input");

/**
 * POST /api/director/audio-analyze
 * Analyze a master audio file: extract waveform peaks + RMS energy per window.
 *
 * Body JSON:
 *   audioFile: string      - ComfyUI input/ filename
 *   peakBuckets?: number   - number of waveform peak buckets (default 800, for UI width)
 *   energyWindowMs?: number - RMS energy window size in ms (default 500)
 *
 * Returns: {
 *   duration: number,          // total duration in seconds
 *   sampleRate: number,
 *   peaks: number[],           // normalized 0–1 peak amplitudes (length = peakBuckets)
 *   energy: Array<{ time: number, rms: number }>,  // RMS energy per window
 *   beats: number[],           // estimated beat timestamps (seconds) via onset detection
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { audioFile, peakBuckets = 800, energyWindowMs = 500 } = body;

    if (!audioFile) {
      return NextResponse.json({ error: "Missing audioFile" }, { status: 400 });
    }

    const srcPath = path.join(COMFYUI_INPUT, audioFile);
    if (!existsSync(srcPath)) {
      return NextResponse.json({ error: `Audio file not found: ${audioFile}` }, { status: 404 });
    }

    const ffprobe = getFFprobePath();
    const ff = getFFmpegPath();

    // ── 1. Get duration + sample rate ──
    const { stdout: probeOut } = await execAsync(
      `"${ffprobe}" -v error -show_entries format=duration -show_entries stream=sample_rate -of json "${srcPath}"`
    );
    const probeData = JSON.parse(probeOut);
    const duration = parseFloat(probeData.format?.duration || "0");
    const sampleRate = parseInt(probeData.streams?.[0]?.sample_rate || "44100", 10);

    if (duration <= 0) {
      return NextResponse.json({ error: "Could not determine audio duration" }, { status: 500 });
    }

    // ── 2. Extract waveform peaks via astats metadata ──
    // Use astats filter with reset interval to get per-window peak data.
    // The metadata is printed to stderr (file=-), one line per window.
    const windowDuration = duration / peakBuckets;
    const resetFrames = Math.max(1, Math.round(windowDuration * sampleRate));
    const peakResult = await execAsync(
      `"${ff}" -v error -i "${srcPath}" -ac 1 -af "astats=metadata=1:reset=${resetFrames},ametadata=print:key=lavfi.astats.1.Peak_level:file=-" -f null -`
    );
    // ametadata print file=- outputs to stdout; some builds put filter logs in stderr
    const astatsOut = peakResult.stdout || peakResult.stderr;

    // Parse peak levels from astats metadata output
    const peaks: number[] = [];
    const peakRegex = /lavfi\.astats\.1\.Peak_level=(-?[\d.]+|[-]?inf)/g;
    let match;
    while ((match = peakRegex.exec(astatsOut)) !== null) {
      const db = parseFloat(match[1]);
      if (isNaN(db) || db === -Infinity || match[1] === "-inf") {
        peaks.push(0);
      } else {
        // Convert dB to linear 0–1 (dB range roughly -60 to 0)
        const linear = Math.pow(10, db / 20);
        peaks.push(Math.min(1, Math.max(0, linear)));
      }
    }

    // If we got more peaks than buckets, downsample; if fewer, that's ok
    let normalizedPeaks: number[];
    if (peaks.length > peakBuckets) {
      // Downsample by averaging
      normalizedPeaks = [];
      const ratio = peaks.length / peakBuckets;
      for (let i = 0; i < peakBuckets; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.floor((i + 1) * ratio);
        let sum = 0;
        for (let j = start; j < end && j < peaks.length; j++) sum += peaks[j];
        normalizedPeaks.push(sum / (end - start));
      }
    } else {
      normalizedPeaks = peaks;
    }

    // ── 3. Extract RMS energy per window ──
    const energyResetFrames = Math.max(1, Math.round((energyWindowMs / 1000) * sampleRate));
    const rmsResult = await execAsync(
      `"${ff}" -v error -i "${srcPath}" -ac 1 -af "astats=metadata=1:reset=${energyResetFrames},ametadata=print:key=lavfi.astats.1.RMS_level:file=-" -f null -`
    );
    const rmsOut = rmsResult.stdout || rmsResult.stderr;

    const energy: Array<{ time: number; rms: number }> = [];
    const rmsRegex = /lavfi\.astats\.1\.RMS_level=(-?[\d.]+|[-]?inf)/g;
    let rmsMatch;
    let windowIdx = 0;
    while ((rmsMatch = rmsRegex.exec(rmsOut)) !== null) {
      const db = parseFloat(rmsMatch[1]);
      const time = windowIdx * (energyWindowMs / 1000);
      if (isNaN(db) || db === -Infinity || rmsMatch[1] === "-inf") {
        energy.push({ time, rms: 0 });
      } else {
        const linear = Math.pow(10, db / 20);
        energy.push({ time, rms: Math.min(1, Math.max(0, linear)) });
      }
      windowIdx++;
    }

    // ── 4. Simple beat detection via energy peaks ──
    // Find local maxima in the energy array where RMS exceeds a threshold
    const beats: number[] = [];
    if (energy.length > 2) {
      // Compute mean and std of RMS values
      const rmsValues = energy.map((e) => e.rms).filter((v) => v > 0);
      const mean = rmsValues.reduce((a, b) => a + b, 0) / (rmsValues.length || 1);
      const std = Math.sqrt(
        rmsValues.reduce((a, b) => a + (b - mean) ** 2, 0) / (rmsValues.length || 1)
      );
      const threshold = mean + std * 0.5; // Detect onset above 0.5 std

      const minBeatGapWindows = Math.max(1, Math.floor(0.3 / (energyWindowMs / 1000))); // min 300ms between beats
      let lastBeatIdx = -minBeatGapWindows;

      for (let i = 1; i < energy.length - 1; i++) {
        const prev = energy[i - 1].rms;
        const curr = energy[i].rms;
        const next = energy[i + 1].rms;
        // Local maximum above threshold with rising edge
        if (curr > prev && curr >= next && curr > threshold && (i - lastBeatIdx) >= minBeatGapWindows) {
          beats.push(energy[i].time);
          lastBeatIdx = i;
        }
      }
    }

    return NextResponse.json({
      duration,
      sampleRate,
      peaks: normalizedPeaks,
      energy,
      beats,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
