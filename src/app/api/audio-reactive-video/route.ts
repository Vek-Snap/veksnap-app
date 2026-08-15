/**
 * POST /api/audio-reactive-video
 * Applies per-frame audio-reactive effects to a video using FFmpeg filter chains.
 *
 * Body: {
 *   videoPath: string,      // absolute path or ComfyUI output filename
 *   audioPath: string,      // absolute path or ComfyUI output/audio filename
 *   analysisData: { amplitude: number[], onsetStrength: number[], spectralCentroid: number[], beatFrames: number[] },
 *   effects: {
 *     zoomIntensity: number,     // 0-1: how much to zoom on beats/amplitude
 *     colorCycleSpeed: number,   // 0-1: hue rotation driven by spectral centroid
 *     blurOnset: number,         // 0-1: radial blur on onset peaks
 *     warpIntensity: number,     // 0-1: displacement warp on amplitude
 *     brightnessReactive: number // 0-1: brightness modulation on amplitude
 *   },
 *   fps?: number
 * }
 *
 * Returns: { outputPath: string, outputUrl: string }
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";
import { apiLog } from "@/lib/api-logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function resolveMediaPath(filePath: string): string | null {
  if (path.isAbsolute(filePath) && fs.existsSync(filePath)) return filePath;

  const comfyDir = path.resolve(process.cwd(), "..", "ComfyUI");
  const candidates = [
    path.join(comfyDir, "output", filePath),
    path.join(comfyDir, "output", "audio", filePath),
    path.join(comfyDir, "input", filePath),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { videoPath, audioPath, analysisData, effects, fps = 24 } = body;

    if (!videoPath || !audioPath || !analysisData) {
      return NextResponse.json(
        { error: "videoPath, audioPath, and analysisData are required" },
        { status: 400 }
      );
    }

    const resolvedVideo = resolveMediaPath(videoPath);
    const resolvedAudio = resolveMediaPath(audioPath);

    if (!resolvedVideo) {
      return NextResponse.json({ error: `Video not found: ${videoPath}` }, { status: 404 });
    }
    if (!resolvedAudio) {
      return NextResponse.json({ error: `Audio not found: ${audioPath}` }, { status: 404 });
    }

    const ffmpeg = getFFmpegPath();
    const {
      zoomIntensity = 0.3,
      colorCycleSpeed = 0.2,
      blurOnset = 0.2,
      warpIntensity = 0.2,
      brightnessReactive = 0.3,
    } = effects || {};

    const { amplitude = [], onsetStrength = [], spectralCentroid = [], beatFrames = [] } = analysisData;
    const numFrames = amplitude.length;

    if (numFrames === 0) {
      return NextResponse.json({ error: "No analysis frames provided" }, { status: 400 });
    }

    // Build per-frame FFmpeg filtergraph using sendcmd or zoompan with expressions
    // Strategy: Use zoompan for zoom + pan, eq for brightness/contrast, hue for color
    // The key insight: we encode the per-frame data into FFmpeg expressions using
    // interpolated keyframe values.

    // Generate a keyframes file for FFmpeg's sendcmd filter
    const comfyOutput = path.resolve(process.cwd(), "..", "ComfyUI", "output");
    const timestamp = Date.now();
    const outputFilename = `reactive_${timestamp}.mp4`;
    const outputPath = path.join(comfyOutput, outputFilename);

    // Build the complex filter
    const filterParts: string[] = [];

    // 1. Zoom effect driven by amplitude + beat hits
    if (zoomIntensity > 0) {
      // Create per-frame zoom values
      // Base zoom = 1.0, max additional zoom = zoomIntensity * 0.15 (so max 15% zoom at intensity=1)
      const maxZoom = 1.0 + zoomIntensity * 0.15;

      // Use zoompan with expression that cycles through frames
      // We'll encode amplitude into a step function using if() chains
      // For efficiency, use a simpler approach: smooth amplitude over time
      const zoomExpr = buildFrameExpression(amplitude, 1.0, maxZoom, numFrames, beatFrames, zoomIntensity * 0.05);

      filterParts.push(
        `zoompan=z='${zoomExpr}':d=1:s=iw:ih:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':fps=${fps}`
      );
    }

    // 2. Brightness/contrast reactive to amplitude
    if (brightnessReactive > 0) {
      // brightness range: -0.1 to +0.1 * intensity, contrast: 0.9 to 1.1 * intensity
      const brExpr = buildSimpleFrameExpr(amplitude, 0, brightnessReactive * 0.15, numFrames);
      const contrastExpr = buildSimpleFrameExpr(amplitude, 1.0, 1.0 + brightnessReactive * 0.2, numFrames);
      filterParts.push(`eq=brightness='${brExpr}':contrast='${contrastExpr}'`);
    }

    // 3. Hue rotation driven by spectral centroid
    if (colorCycleSpeed > 0) {
      // Rotate hue based on spectral centroid: 0-360 degrees * speed
      const hueExpr = buildSimpleFrameExpr(spectralCentroid, 0, colorCycleSpeed * 90, numFrames);
      filterParts.push(`hue=h='${hueExpr}'`);
    }

    // 4. Blur on onset peaks (use avgblur with variable radius)
    if (blurOnset > 0) {
      // Blur radius: 0 to maxBlur on onset peaks
      const maxBlur = Math.round(blurOnset * 8);
      if (maxBlur > 0) {
        const blurExpr = buildSimpleFrameExpr(onsetStrength, 0, maxBlur, numFrames);
        filterParts.push(`avgblur=sizeX='${blurExpr}':sizeY='${blurExpr}'`);
      }
    }

    // 5. Displacement warp effect driven by amplitude (using lenscorrection)
    if (warpIntensity > 0) {
      // Barrel distortion modulated by amplitude
      const k1Expr = buildSimpleFrameExpr(amplitude, 0, warpIntensity * 0.3, numFrames);
      filterParts.push(`lenscorrection=k1='${k1Expr}':k2=0`);
    }

    // Combine all filters
    const filterChain = filterParts.length > 0 ? filterParts.join(",") : "null";

    // Build FFmpeg command: apply filters to video, mux with audio
    const cmd = [
      `"${ffmpeg}"`,
      "-y",
      `-i "${resolvedVideo}"`,
      `-i "${resolvedAudio}"`,
      `-filter_complex "[0:v]${filterChain}[v]"`,
      `-map "[v]"`,
      `-map 1:a`,
      `-c:v libx264 -preset fast -crf 18`,
      `-c:a aac -b:a 192k`,
      `-shortest`,
      `"${outputPath}"`,
    ].join(" ");

    apiLog("ai_tools", `[audio-reactive] ${numFrames} frames, ${filterParts.length} effects, fps=${fps}`);
    console.log(`[audio-reactive-video] Running FFmpeg...`);
    console.log(`[audio-reactive-video] Filters: ${filterChain.slice(0, 200)}...`);

    await execAsync(cmd);
    apiLog("ai_tools", `[audio-reactive] Done → ${outputFilename}`);

    if (!fs.existsSync(outputPath)) {
      return NextResponse.json({ error: "FFmpeg produced no output" }, { status: 500 });
    }

    // Return ComfyUI-compatible output URL
    const outputUrl = `/api/comfyui/view?filename=${encodeURIComponent(outputFilename)}&subfolder=&type=output`;

    return NextResponse.json({
      outputPath,
      outputFilename,
      outputUrl,
    });
  } catch (err) {
    apiLog("ai_tools", `[ERR] audio-reactive: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[audio-reactive-video] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Audio-reactive video processing failed" },
      { status: 500 }
    );
  }
}

/**
 * Build an FFmpeg expression that maps frame number (n) to interpolated values
 * from a per-frame array. Uses a piecewise linear approach with keyframes
 * sampled every K frames for efficiency.
 */
function buildFrameExpression(
  values: number[],
  minVal: number,
  maxVal: number,
  numFrames: number,
  beatFrames: number[],
  beatBoost: number
): string {
  // Sample keyframes every 4 frames to keep expression manageable
  const step = 4;
  const keyframes: { frame: number; value: number }[] = [];
  const beatSet = new Set(beatFrames);

  for (let i = 0; i < numFrames; i += step) {
    let v = values[Math.min(i, values.length - 1)];
    // Add beat boost
    if (beatSet.has(i) || beatSet.has(i + 1) || beatSet.has(i - 1)) {
      v = Math.min(1.0, v + beatBoost / (maxVal - minVal));
    }
    const mapped = minVal + v * (maxVal - minVal);
    keyframes.push({ frame: i, value: mapped });
  }

  // Build nested if() expression for FFmpeg
  // if(lt(n,K1), V0, if(lt(n,K2), lerp(V0,V1,(n-K0)/(K1-K0)), ...))
  if (keyframes.length <= 1) {
    return String(keyframes[0]?.value || minVal);
  }

  // Simplify: use a compact expression with floor-based indexing
  // val = v[floor(n/step)] + (v[floor(n/step)+1] - v[floor(n/step)]) * (mod(n,step)/step)
  // Encode as: if(lt(n,step), lerp(v0,v1,n/step), if(lt(n,2*step), lerp(v1,v2,(n-step)/step), ...))
  let expr = String(keyframes[keyframes.length - 1].value.toFixed(4));

  for (let i = keyframes.length - 2; i >= 0; i--) {
    const kf = keyframes[i];
    const kfNext = keyframes[i + 1];
    const range = kfNext.frame - kf.frame;
    const v0 = kf.value.toFixed(4);
    const v1 = kfNext.value.toFixed(4);
    // Linear interpolation between keyframes
    const lerp = `(${v0}+(${v1}-${v0})*(n-${kf.frame})/${range})`;
    expr = `if(lt(n,${kfNext.frame}),${lerp},${expr})`;
  }

  return expr;
}

/**
 * Simpler version: maps values array to a min-max range per frame.
 */
function buildSimpleFrameExpr(
  values: number[],
  minVal: number,
  maxVal: number,
  numFrames: number
): string {
  const step = 4;
  const keyframes: { frame: number; value: number }[] = [];

  for (let i = 0; i < numFrames; i += step) {
    const v = values[Math.min(i, values.length - 1)];
    const mapped = minVal + v * (maxVal - minVal);
    keyframes.push({ frame: i, value: mapped });
  }

  if (keyframes.length <= 1) {
    return String(keyframes[0]?.value || minVal);
  }

  let expr = String(keyframes[keyframes.length - 1].value.toFixed(4));

  for (let i = keyframes.length - 2; i >= 0; i--) {
    const kf = keyframes[i];
    const kfNext = keyframes[i + 1];
    const range = kfNext.frame - kf.frame;
    const v0 = kf.value.toFixed(4);
    const v1 = kfNext.value.toFixed(4);
    const lerp = `(${v0}+(${v1}-${v0})*(n-${kf.frame})/${range})`;
    expr = `if(lt(n,${kfNext.frame}),${lerp},${expr})`;
  }

  return expr;
}
