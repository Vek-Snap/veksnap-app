/**
 * Movie Maker: Generate Multi-Speaker Dialogue
 * Uses DramaBox (ComfyUI) for per-line dialogue generation.
 *
 * POST /api/movie-maker/generate-dialogue
 * Body: {
 *   engine: "dramabox",
 *   script: string,           // "Speaker 0: Hello\nSpeaker 1: Hi there"
 *   voiceSamples: string[],   // paths to WAV files per speaker (ordered)
 *   seed?: number,
 *   cfgScale?: number,
 *   numSteps?: number,
 *   doSample?: boolean,
 *   temperature?: number,
 *   topK?: number,
 *   topP?: number,
 *   repetitionPenalty?: number,
 *   chunkBySpeaker?: boolean,
 *   // DramaBox-specific (optional, passed through from DramaBoxConfig defaults)
 *   dramabox?: {
 *     steps?: number,
 *     stgScale?: number,
 *     rescaleScale?: number,
 *     idGuidanceScale?: number,
 *     durationMultiplier?: number,
 *     speed?: number,
 *     negativePrompt?: string,
 *     generationMode?: string,
 *     modelPolicy?: string,
 *     textEncoder?: string,
 *     silenceGapMs?: number,
 *   }
 * }
 * Returns: { ok: true, output_path, duration_seconds, sample_rate, seed_used }
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";
import fs from "fs";
import { registerLlmProcess } from "@/lib/llm-process";
import { getOfflineEnv } from "@/lib/veksnap-settings";
import { apiLog } from "@/lib/api-logger";
import { getFFmpegPath, execAsync } from "@/lib/ffmpeg-path";
import { evaluateContent, SAFETY_REFUSAL_MESSAGE } from "@/lib/safety-filter";

function findPython(): string {
  const candidates = [
    process.env.VEKSNAP_PYTHON || "",
    path.join(process.cwd(), "..", "runtime", "venv", "Scripts", "python.exe"),
    path.join(process.cwd(), "..", "miniconda", "envs", "comfyui", "python.exe"),
    path.join(process.cwd(), "..", "miniconda", "python.exe"),
    "python",
  ];
  for (const c of candidates) {
    try {
      if (c !== "python" && fs.existsSync(c)) return c;
    } catch { /* skip */ }
  }
  return "python";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      engine = "dramabox",
      script,
      voiceSamples = [],
      seed = -1,
      cfgScale = 3.0,
      numSteps = 20,
      doSample = true,
      temperature = 0.9,
      topK = 50,
      topP = 0.95,
      repetitionPenalty = 1.0,
      chunkBySpeaker = true,
    } = body as {
      engine?: "dramabox";
      script: string;
      voiceSamples?: string[];
      seed?: number;
      cfgScale?: number;
      numSteps?: number;
      doSample?: boolean;
      temperature?: number;
      topK?: number;
      topP?: number;
      repetitionPenalty?: number;
      chunkBySpeaker?: boolean;
    };

    if (!script || !script.trim()) {
      return NextResponse.json({ error: "script is required" }, { status: 400 });
    }

    // Always-on child-safety gate. This route posts DIRECTLY to ComfyUI (bypassing
    // the /api/comfyui proxy gate), so the spoken text must be screened here.
    const safety = evaluateContent({ script });
    if (safety.action === "refuse") {
      return NextResponse.json(
        { error: safety.message ?? SAFETY_REFUSAL_MESSAGE, safety_refusal: true },
        { status: 403 }
      );
    }

    if (engine === "dramabox") {
      const dramabox = body.dramabox || {};
      return await handleDramaBox({
        script, voiceSamples, seed, cfgScale,
        steps: dramabox.steps ?? 30,
        stgScale: dramabox.stgScale ?? 1.5,
        rescaleScale: dramabox.rescaleScale ?? -1.0,
        idGuidanceScale: dramabox.idGuidanceScale ?? 3.0,
        durationMultiplier: dramabox.durationMultiplier ?? 1.1,
        speed: dramabox.speed ?? 1.0,
        negativePrompt: dramabox.negativePrompt ?? "worst quality, inconsistent, robotic, distorted, noise, static, muffled, unclear, unnatural, monotone",
        generationMode: dramabox.generationMode ?? "clip_loader",
        modelPolicy: dramabox.modelPolicy ?? "offload",
        textEncoder: dramabox.textEncoder ?? "gemma_3_12B_it_fp4_mixed.safetensors",
        silenceGapMs: dramabox.silenceGapMs ?? 400,
      });
    }

    return NextResponse.json(
      { error: `Unknown engine: ${engine}` },
      { status: 400 }
    );
  } catch (err) {
    apiLog("movie_maker", `[ERR] generate-dialogue: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[movie-maker/generate-dialogue] Error:", err);
    const msg = err instanceof Error ? err.message : "Dialogue generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── DramaBox Per-Line Stitch Engine ──
//
// How it works:
// 1. Parse script into individual lines: "Speaker 0: Hello" → { speaker: 0, text: "Hello" }
// 2. For each line, build a DramaBox ComfyUI workflow with that line's prompt
//    and the matching speaker's voice reference (from voiceSamples[speakerIdx]).
// 3. Queue the workflow to ComfyUI, poll /history/{id} until completion.
// 4. Collect each output WAV path from ComfyUI's output directory.
// 5. After all lines are generated, concatenate WAVs with silence gaps using FFmpeg.
// 6. Return the final stitched WAV path.

const COMFYUI = COMFYUI_HTTP;
const COMFYUI_OUTPUT = path.resolve(process.cwd(), "..", "ComfyUI", "output");

interface DramaBoxParams {
  script: string;
  voiceSamples: string[];
  seed: number;
  cfgScale: number;
  steps: number;
  stgScale: number;
  rescaleScale: number;
  idGuidanceScale: number;
  durationMultiplier: number;
  speed: number;
  negativePrompt: string;
  generationMode: string;
  modelPolicy: string;
  textEncoder: string;
  silenceGapMs: number;
}

interface ParsedLine {
  speaker: number;
  text: string;
}

function parseScriptLines(script: string): ParsedLine[] {
  const lines = script.split("\n").map((l) => l.trim()).filter(Boolean);
  const parsed: ParsedLine[] = [];
  for (const line of lines) {
    const match = line.match(/^Speaker\s+(\d+):\s*(.+)$/i);
    if (match) {
      parsed.push({ speaker: parseInt(match[1]), text: match[2].trim() });
    }
  }
  return parsed;
}

function buildDramaBoxLineWorkflow(
  lineText: string,
  voiceRefFile: string | undefined,
  seed: number,
  params: DramaBoxParams,
): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {};

  // Node 1: DramaBox Options
  nodes["1"] = {
    class_type: "DramaBoxOptions",
    inputs: {
      steps: params.steps,
      negative_prompt: params.negativePrompt,
      cfg_scale: params.cfgScale,
      stg_scale: params.stgScale,
      rescale_scale: params.rescaleScale,
      id_guidance_scale: params.idGuidanceScale,
      gen_duration: 0, // auto-estimate from text
      duration_multiplier: params.durationMultiplier,
      speed: params.speed,
      ref_duration: 10.0,
      post_generate_model_policy: params.modelPolicy,
      attention_policy: "auto",
      generation_mode: params.generationMode,
    },
  };

  // Node 2: DramaBox CLIP Loader
  if (params.generationMode === "clip_loader") {
    nodes["2"] = {
      class_type: "DramaBoxTextEncoderLoader",
      inputs: { gemma_model: params.textEncoder },
    };
  }

  // Node 3: DramaBox TTS
  const ttsInputs: Record<string, unknown> = {
    seed,
    use_prompt_input: false,
    text: lineText,
    options: ["1", 0],
  };
  if (params.generationMode === "clip_loader") {
    ttsInputs.dramabox_clip = ["2", 0];
  }
  if (voiceRefFile) {
    ttsInputs.voice_ref = ["10", 0];
  }
  nodes["3"] = { class_type: "DramaBoxTTS", inputs: ttsInputs };

  // Node 4: Save audio
  nodes["4"] = {
    class_type: "SaveAudio",
    inputs: {
      audio: ["3", 0],
      filename_prefix: "moviemaker_dramabox_line",
    },
  };

  // Node 10: Load voice reference
  if (voiceRefFile) {
    nodes["10"] = {
      class_type: "LoadAudio",
      inputs: { audio: voiceRefFile },
    };
  }

  return nodes;
}

async function comfyQueueAndWait(
  workflow: Record<string, unknown>,
  timeoutMs: number = 120_000,
): Promise<{ filename: string; subfolder: string }> {
  // Check ComfyUI is alive
  try {
    const stats = await fetch(`${COMFYUI}/system_stats`, { signal: AbortSignal.timeout(3000) });
    if (!stats.ok) throw new Error("ComfyUI not responding");
  } catch {
    throw new Error("ComfyUI is offline. Start it from the Services panel.");
  }

  // Queue
  const clientId = `moviemaker_${Date.now()}`;
  const queueRes = await fetch(`${COMFYUI}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!queueRes.ok) {
    const errBody = await queueRes.text().catch(() => "");
    throw new Error(`ComfyUI queue failed (${queueRes.status}): ${errBody.slice(0, 300)}`);
  }
  const { prompt_id } = await queueRes.json();

  // Poll for completion
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const histRes = await fetch(`${COMFYUI}/history/${prompt_id}`);
    if (!histRes.ok) continue;
    const histData = await histRes.json();
    const entry = histData?.[prompt_id];
    if (!entry) continue;

    // Check for error
    if (entry.status?.status_str === "error") {
      const messages = entry.status?.messages;
      const errNode = messages?.find((m: unknown[]) => m[0] === "execution_error");
      throw new Error(errNode ? JSON.stringify(errNode[1]).slice(0, 500) : "DramaBox execution failed");
    }

    // Check for audio output
    const outputs = entry.outputs || {};
    for (const nodeOut of Object.values(outputs)) {
      const audios = (nodeOut as Record<string, unknown[]>)?.audio;
      if (audios && audios.length > 0) {
        const audio = audios[0] as { filename: string; subfolder?: string };
        return { filename: audio.filename, subfolder: audio.subfolder || "" };
      }
    }
  }

  throw new Error("DramaBox generation timed out (120s)");
}

async function handleDramaBox(params: DramaBoxParams) {
  const lines = parseScriptLines(params.script);
  if (lines.length === 0) {
    return NextResponse.json({ error: "No valid dialogue lines found in script." }, { status: 400 });
  }

  apiLog("movie_maker", `[generate-dialogue] engine=dramabox lines=${lines.length} speakers=${new Set(lines.map(l => l.speaker)).size}`);
  console.log(`[movie-maker/dramabox] Generating ${lines.length} lines, stitching with ${params.silenceGapMs}ms gaps`);

  // Resolve voice sample ComfyUI-relative filenames
  // voiceSamples come in as absolute paths or ComfyUI input-relative paths
  const comfyInputDir = path.resolve(process.cwd(), "..", "ComfyUI", "input");

  function resolveVoiceRef(speakerIdx: number): string | undefined {
    const sample = params.voiceSamples[speakerIdx];
    if (!sample) return undefined;
    // If it's already a ComfyUI input-relative path (e.g. "movie_maker_voices/foo.wav"),
    // LoadAudio can use it directly. If absolute, check if it's inside ComfyUI/input/
    // and convert to relative, otherwise use as-is (LoadAudio may support absolute).
    if (sample.includes(":") || sample.startsWith("/") || sample.startsWith("\\")) {
      // Absolute path: check if inside ComfyUI input
      const norm = path.normalize(sample);
      const inputNorm = path.normalize(comfyInputDir);
      if (norm.startsWith(inputNorm)) {
        return path.relative(comfyInputDir, norm).replace(/\\/g, "/");
      }
      // Not in input dir: LoadAudio on some builds can handle absolute paths
      return sample;
    }
    return sample; // Already relative
  }

  // Generate each line sequentially
  const outputFiles: string[] = [];
  let lastSeed = params.seed;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const voiceRef = resolveVoiceRef(line.speaker);
    const lineSeed = params.seed < 0 || params.seed === -1
      ? Math.floor(Math.random() * 2147483647)
      : params.seed + i;

    apiLog("movie_maker", `[dramabox] Line ${i + 1}/${lines.length}: Speaker ${line.speaker}, seed=${lineSeed}, voiceRef=${voiceRef || "none"}`);

    // Build DramaBox prompt text: wrap in descriptive format
    // DramaBox expects natural-language prompts describing speech
    const promptText = `A person speaks clearly, "${line.text}"`;

    const workflow = buildDramaBoxLineWorkflow(promptText, voiceRef, lineSeed, params);
    const result = await comfyQueueAndWait(workflow);

    // Resolve output file path
    const outputFile = result.subfolder
      ? path.join(COMFYUI_OUTPUT, result.subfolder, result.filename)
      : path.join(COMFYUI_OUTPUT, result.filename);

    if (!fs.existsSync(outputFile)) {
      throw new Error(`DramaBox output file not found: ${outputFile}`);
    }

    outputFiles.push(outputFile);
    lastSeed = lineSeed;
  }

  // Stitch all output files with silence gaps using FFmpeg
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const finalOutput = path.join(COMFYUI_OUTPUT, `moviemaker_dramabox_${timestamp}.wav`);

  if (outputFiles.length === 1) {
    // Single line: just copy/rename
    fs.copyFileSync(outputFiles[0], finalOutput);
  } else {
    await concatAudioWithSilence(outputFiles, finalOutput, params.silenceGapMs);
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
    sample_rate: 24000,
    seed_used: lastSeed,
    lines_generated: outputFiles.length,
    engine: "dramabox",
  });
}

// ── File-list based audio concat (avoids Windows CLI length limits) ──
//
// Instead of passing 70+ -i args and a huge filter_complex on the command line,
// this approach:
// 1. Generates a short silence WAV file
// 2. Normalizes all input segments to consistent format (24kHz mono)
// 3. Writes an FFmpeg concat file list interleaving segments with silence
// 4. Runs concat demuxer which reads from the file, CLI stays short
//
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
    // Step 1: Generate a silence WAV file
    const silenceFile = path.join(tempDir, `silence_${silenceGapMs}ms.wav`);
    if (!fs.existsSync(silenceFile)) {
      const silCmd = `"${ffmpeg}" -y -f lavfi -i anullsrc=r=${sampleRate}:cl=mono -t ${silenceDur} -c:a pcm_s16le "${silenceFile}"`;
      await execAsync(silCmd);
    }

    // Step 2: Normalize all input files to consistent format
    const normalizedFiles: string[] = [];
    for (let i = 0; i < inputFiles.length; i++) {
      const normFile = path.join(tempDir, `seg_${String(i).padStart(4, "0")}.wav`);
      const normCmd = `"${ffmpeg}" -y -i "${inputFiles[i]}" -ar ${sampleRate} -ac 1 -c:a pcm_s16le "${normFile}"`;
      await execAsync(normCmd);
      normalizedFiles.push(normFile);
    }

    // Step 3: Write concat file list (interleave segments with silence)
    const concatListPath = path.join(tempDir, "_concat_list.txt");
    const lines: string[] = [];
    for (let i = 0; i < normalizedFiles.length; i++) {
      lines.push(`file '${normalizedFiles[i].replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
      if (i < normalizedFiles.length - 1) {
        lines.push(`file '${silenceFile.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
      }
    }
    fs.writeFileSync(concatListPath, lines.join("\n"), "utf-8");

    // Step 4: Run concat demuxer (CLI is just ~200 chars regardless of segment count)
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
