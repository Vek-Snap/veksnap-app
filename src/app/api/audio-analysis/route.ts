/**
 * Audio Analysis API: analyzes audio files for energy, tempo, and frequency characteristics.
 * Used by AudioForVideo to generate audio-reactive prompt enhancements.
 * Ported from LoRA-Daddy's _analyse_audio() Python implementation.
 *
 * POST /api/audio-analysis
 * Body: { audioPath: string }  - path to audio file (absolute or ComfyUI input/ relative)
 * Returns: AudioAnalysis object with energy shape, tempo, frequency character, etc.
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { execFileAsync, getFFmpegPath, getFFprobePath } from "@/lib/ffmpeg-path";

/**
 * Spawn-based buffer exec: uses windowsHide:true to prevent console popups.
 * Returns stdout as a raw Buffer (for PCM extraction).
 */
function execFileBuffer(file: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // shell:false + argv array - the audio path is a discrete argument and can
    // never be parsed as a command (prevents injection via audioPath).
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === null) resolve(Buffer.concat(chunks));
      else reject(new Error(`Command failed (exit ${code}): ${stderr.slice(-1000)}`));
    });
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AudioAnalysis {
  durationS: number;
  energyShape: string;
  tempoFeel: string;
  freqCharacter: string;
  peakMoment: number;
  silenceRatio: number;
  summary: string;
}

// ─── Audio Analysis (pure Node.js, no numpy/scipy needed) ─────────────────────

function analyzeRawPcm(buffer: Buffer, sampleRate: number): AudioAnalysis {
  // Convert raw PCM f32le buffer to Float32Array
  const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  const nSamples = samples.length;
  const duration = nSamples / sampleRate;

  // ── RMS energy over 100ms windows ──
  const winSize = Math.floor(sampleRate * 0.1);
  const hop = Math.floor(winSize / 2);
  const rms: number[] = [];

  for (let i = 0; i <= nSamples - winSize; i += hop) {
    let sum = 0;
    for (let j = i; j < i + winSize; j++) {
      sum += samples[j] * samples[j];
    }
    rms.push(Math.sqrt(sum / winSize + 1e-9));
  }

  if (rms.length === 0) {
    return {
      durationS: Math.round(duration * 100) / 100,
      energyShape: "silent",
      tempoFeel: "no clear beat / ambient",
      freqCharacter: "silent",
      peakMoment: 0,
      silenceRatio: 1,
      summary: `Duration: ${(Math.round(duration * 100) / 100)}s. Audio appears silent.`,
    };
  }

  // RMS in dB
  const rmsDb = rms.map(v => 20 * Math.log10(v + 1e-9));

  // Peak moment
  let peakIdx = 0;
  let peakVal = rms[0];
  for (let i = 1; i < rms.length; i++) {
    if (rms[i] > peakVal) { peakVal = rms[i]; peakIdx = i; }
  }
  const peakMoment = Math.round((peakIdx * hop / sampleRate) * 100) / 100;

  // Silence ratio (absolute floor -50dB)
  const SILENCE_FLOOR_DB = -50.0;
  let silentCount = 0;
  for (const db of rmsDb) { if (db < SILENCE_FLOOR_DB) silentCount++; }
  const silenceRatio = Math.round((silentCount / rmsDb.length) * 100) / 100;

  // Energy shape: compare first third vs last third vs peak
  const third = Math.floor(rms.length / 3);
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const eStart = mean(rms.slice(0, third));
  const eMid = mean(rms.slice(third, 2 * third));
  const eEnd = mean(rms.slice(2 * third));
  const ePeak = peakVal;
  const eMean = mean(rms);

  let energyShape: string;
  if (ePeak > eMean * 2.5 && peakIdx > third) {
    energyShape = "builds to explosive peak";
  } else if (eStart > eEnd * 1.4) {
    energyShape = "loud then fading";
  } else if (eEnd > eStart * 1.4) {
    energyShape = "builds throughout";
  } else if (silenceRatio > 0.4) {
    energyShape = "sparse with long silences";
  } else {
    const std = Math.sqrt(mean(rms.map(v => (v - eMean) ** 2)));
    if (std / (eMean + 1e-9) < 0.3) {
      energyShape = "constant sustained energy";
    } else {
      energyShape = "varied dynamic range";
    }
  }

  // ── Tempo / beat detection via RMS onset strength ──
  const onsetEnv: number[] = [0];
  for (let i = 1; i < rms.length; i++) {
    onsetEnv.push(Math.max(0, rms[i] - rms[i - 1]));
  }
  const onsetMean = mean(onsetEnv);
  const minDist = Math.max(1, Math.floor(0.3 / (hop / sampleRate)));

  // Simple peak detection
  const peaks: number[] = [];
  for (let i = 1; i < onsetEnv.length - 1; i++) {
    if (onsetEnv[i] > onsetEnv[i - 1] && onsetEnv[i] > onsetEnv[i + 1] &&
        onsetEnv[i] > onsetMean * 1.2) {
      if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minDist) {
        peaks.push(i);
      }
    }
  }

  let tempoFeel: string;
  if (peaks.length > 2) {
    const intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push((peaks[i] - peaks[i - 1]) * hop / sampleRate);
    }
    intervals.sort((a, b) => a - b);
    const medianInterval = intervals[Math.floor(intervals.length / 2)];
    const avgBpm = 60.0 / medianInterval;

    if (avgBpm < 60) tempoFeel = `slow (${Math.round(avgBpm)} bpm)`;
    else if (avgBpm < 100) tempoFeel = `moderate (${Math.round(avgBpm)} bpm)`;
    else if (avgBpm < 140) tempoFeel = `fast (${Math.round(avgBpm)} bpm)`;
    else tempoFeel = `very fast (${Math.round(avgBpm)} bpm)`;
  } else {
    tempoFeel = "no clear beat / ambient";
  }

  // ── Frequency character via FFT ──
  // Simple DFT on a chunk of the audio (first 65536 samples)
  const fftSize = Math.min(nSamples, 65536);
  const fftInput = samples.slice(0, fftSize);

  // Compute magnitude spectrum using simple DFT bins (approximate with band energy)
  // For efficiency, compute band energies directly without full FFT
  const bandEnergy = computeBandEnergies(fftInput, sampleRate);

  let freqCharacter: string;
  if (bandEnergy.vocal > bandEnergy.bass * 1.5 && bandEnergy.vocal > bandEnergy.high * 1.2) {
    freqCharacter = "vocal dominant";
  } else if (bandEnergy.bass > bandEnergy.mid * 1.4 && bandEnergy.bass > bandEnergy.high * 2) {
    freqCharacter = "bass heavy";
  } else if (bandEnergy.high > bandEnergy.bass * 1.5 && bandEnergy.high > bandEnergy.mid) {
    freqCharacter = "bright / treble";
  } else {
    freqCharacter = "balanced full range";
  }

  // ── Build summary ──
  const parts: string[] = [];
  parts.push(`Duration: ${Math.round(duration * 100) / 100}s.`);
  parts.push(`Energy: ${energyShape}.`);
  if (tempoFeel) parts.push(`Rhythm: ${tempoFeel}.`);
  if (freqCharacter) parts.push(`Sound character: ${freqCharacter}.`);
  if (peakMoment && duration > 0) {
    const pct = Math.round((peakMoment / duration) * 100);
    parts.push(`Loudest moment at ${peakMoment}s (${pct}% through).`);
  }
  if (silenceRatio > 0.3) {
    parts.push(`Significant silence (${Math.round(silenceRatio * 100)}% of clip).`);
  }

  return {
    durationS: Math.round(duration * 100) / 100,
    energyShape,
    tempoFeel,
    freqCharacter,
    peakMoment,
    silenceRatio,
    summary: parts.join(" "),
  };
}

// Band energy computation using Goertzel algorithm (efficient for specific frequency bins)
function computeBandEnergies(samples: Float32Array, sampleRate: number) {
  const N = samples.length;

  // Define frequency bands
  const bands = {
    bass:  { lo: 20,  hi: 300 },
    mid:   { lo: 300, hi: 3000 },
    high:  { lo: 3000, hi: 8000 },
    vocal: { lo: 200, hi: 3400 },
  };

  const result: Record<string, number> = {};

  for (const [name, { lo, hi }] of Object.entries(bands)) {
    // Sample frequencies within the band using Goertzel
    const numBins = 20;
    let totalMag = 0;
    for (let b = 0; b < numBins; b++) {
      const freq = lo + (hi - lo) * b / numBins;
      const k = Math.round(freq * N / sampleRate);
      const w = (2 * Math.PI * k) / N;
      const coeff = 2 * Math.cos(w);
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = 0; i < N; i++) {
        s0 = samples[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const mag = Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
      totalMag += mag;
    }
    result[name] = totalMag / numBins;
  }

  return result as { bass: number; mid: number; high: number; vocal: number };
}

// ─── Prompt Enhancement from Audio Analysis ───────────────────────────────────

function buildAudioPromptDirectives(analysis: AudioAnalysis): string {
  const lines: string[] = [];

  // Energy-based directives
  if (analysis.energyShape === "builds to explosive peak" && analysis.peakMoment) {
    lines.push(
      `Audio builds and peaks at ${analysis.peakMoment}s: ` +
      "start restrained, escalate, let the visual peak land at the same moment."
    );
  } else if (analysis.energyShape === "sparse with long silences") {
    lines.push("Audio is sparse and quiet: slow camera, minimal action, let silence breathe.");
  } else if (analysis.energyShape === "constant sustained energy") {
    lines.push("Sustained consistent energy: maintain visual intensity evenly, no dramatic arc.");
  } else if (analysis.energyShape === "builds throughout") {
    lines.push("Energy grows start to finish: visuals should escalate progressively.");
  } else if (analysis.energyShape === "loud then fading") {
    lines.push("Audio starts loud and fades: open with energy, gradually calm the visuals.");
  }

  // Tempo-based directives
  if (analysis.tempoFeel.includes("very fast")) {
    lines.push("Fast tempo: kinetic camera movement and driven subject action.");
  } else if (analysis.tempoFeel.includes("slow")) {
    lines.push("Slow tempo: deliberate camera movement, held shots, unhurried action.");
  } else if (analysis.tempoFeel.includes("no clear beat")) {
    lines.push("Ambient / no beat: floating camera movement, atmospheric over kinetic.");
  }

  // Frequency-based directives
  if (analysis.freqCharacter === "bass heavy") {
    lines.push("Heavy bass presence: weight, physicality, low-frequency movement.");
  } else if (analysis.freqCharacter === "bright / treble") {
    lines.push("Bright treble character: light, crisp, airy visuals.");
  } else if (analysis.freqCharacter === "vocal dominant") {
    lines.push("Vocals are dominant: frame the speaker, sync lip movement if present.");
  }

  return lines.length > 0 ? `[Audio cues: ${lines.join(" ")}]` : "";
}

// ─── API Route ────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { audioPath } = await req.json();
    if (!audioPath) {
      return NextResponse.json({ error: "audioPath is required" }, { status: 400 });
    }

    // Resolve path: could be absolute or relative to ComfyUI input/
    let resolvedPath = audioPath;
    if (!path.isAbsolute(audioPath)) {
      const comfyInput = path.join(process.cwd(), "..", "ComfyUI", "input");
      resolvedPath = path.join(comfyInput, audioPath);
    }

    if (!fs.existsSync(resolvedPath)) {
      return NextResponse.json({ error: `Audio file not found: ${resolvedPath}` }, { status: 404 });
    }

    // Get duration via ffprobe (shell-free argv, resolvedPath can't inject).
    const { stdout: durationOut } = await execFileAsync(
      getFFprobePath(),
      ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", resolvedPath],
    );
    const fileDuration = parseFloat(durationOut.trim()) || 0;
    if (fileDuration <= 0) {
      return NextResponse.json({ error: "Could not determine audio duration" }, { status: 400 });
    }

    // Extract raw PCM f32le mono via ffmpeg (cap at 60s for analysis)
    const maxDur = Math.min(fileDuration, 60);
    const sampleRate = 16000; // 16kHz is sufficient for analysis
    const pcmData = await execFileBuffer(
      getFFmpegPath(),
      ["-i", resolvedPath, "-t", String(maxDur), "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "-v", "quiet", "pipe:1"],
    );

    const analysis = analyzeRawPcm(pcmData, sampleRate);
    const directives = buildAudioPromptDirectives(analysis);

    return NextResponse.json({
      ...analysis,
      directives,
    });
  } catch (err) {
    console.error("[audio-analysis] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Audio analysis failed" },
      { status: 500 }
    );
  }
}
