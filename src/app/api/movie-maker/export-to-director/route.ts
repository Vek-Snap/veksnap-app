/**
 * Movie Maker → Director Mode Pipeline
 *
 * Takes a Movie Maker script (with dialogue, SFX, direction annotations) and a
 * generated dialogue audio file, and converts them into a Director Mode config:
 *   - Parses script into scene segments based on # [DIR] annotations and dialogue grouping
 *   - Probes dialogue audio to get total duration
 *   - Slices audio into per-segment chunks (for A2V mode in Director)
 *   - Generates LTX2 prompts from [DIR] stage directions + character/scene context
 *   - Returns DirectorSegment[] ready for Director Mode pipeline
 *
 * POST /api/movie-maker/export-to-director
 * Body: {
 *   script: string,              // The full Movie Maker script
 *   dialogueAudioFile: string,   // Filename of generated dialogue WAV (in ComfyUI/output/)
 *   sfxAudioFiles?: string[],    // Optional SFX WAV filenames (in ComfyUI/output/)
 *   frameRate?: number,          // Target frame rate (default 24)
 *   width?: number,              // Video width (default 768)
 *   height?: number,             // Video height (default 512)
 *   segmentDuration?: number,    // Target segment duration in seconds (default: auto from script structure)
 *   characters?: { name: string, age?: string, gender?: string, description?: string }[], // Per-speaker records; names are stripped from LTX prompts and replaced with brief physical descriptions
 *   characterDescriptions?: string[], // Legacy: name-only list (fallback)
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { getFFmpegPath, getFFprobePath, execAsync } from "@/lib/ffmpeg-path";
import { apiLog } from "@/lib/api-logger";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const COMFYUI_OUTPUT = path.resolve(process.cwd(), "..", "ComfyUI", "output");
const COMFYUI_INPUT = path.resolve(process.cwd(), "..", "ComfyUI", "input");

interface ParsedScriptBlock {
  type: "dialogue" | "sfx" | "music" | "direction" | "narration";
  speaker?: number;
  text: string;
  rawLine: string;
  startTime?: number; // seconds (from script timestamps)
  endTime?: number;   // seconds (from script timestamps)
}

/**
 * Parse a timestamp string MM:SS.ms → seconds
 */
function parseTs(ts: string): number {
  const m = ts.match(/(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3]) / 100;
}

function parseScript(script: string): ParsedScriptBlock[] {
  const lines = script.split("\n").map((l) => l.trim()).filter(Boolean);
  const blocks: ParsedScriptBlock[] = [];

  // Regex for new timestamped format: # [MM:SS.ms - MM:SS.ms][TAG] text
  const tsPattern = /^#\s*\[(\d{2}:\d{2}\.\d{2})\s*-\s*(\d{2}:\d{2}\.\d{2})\]/;

  for (const line of lines) {
    // Try timestamped dialogue first: # [00:09.50 - 00:12.80][1]: text  OR  [00:09.50 - 00:12.80][1]: text
    const cleanLine = line.replace(/^#\s*/, "");
    const tsDlg = cleanLine.match(/^\[(\d{2}:\d{2}\.\d{2})\s*-\s*(\d{2}:\d{2}\.\d{2})\]\[(\d+)\]:\s*(.+)$/);
    if (tsDlg) {
      blocks.push({
        type: "dialogue",
        speaker: parseInt(tsDlg[3]),
        text: tsDlg[4].trim(),
        startTime: parseTs(tsDlg[1]),
        endTime: parseTs(tsDlg[2]),
        rawLine: line,
      });
      continue;
    }

    // Try timestamped annotation: # [MM:SS.ms - MM:SS.ms][TAG] text
    const tsMatch = line.match(tsPattern);
    let startTime: number | undefined;
    let endTime: number | undefined;
    let content = line;
    if (tsMatch) {
      startTime = parseTs(tsMatch[1]);
      endTime = parseTs(tsMatch[2]);
      // Strip the timestamp prefix from content for tag matching
      content = line.slice(tsMatch[0].length).trim();
      // content might still start with #, strip it
      content = content.replace(/^#\s*/, "");
    } else {
      // Legacy format: strip leading #
      content = line.replace(/^#\s*/, "");
    }

    // Match tags on content
    const sfxMatch = content.match(/^\[SFX\]\s*(.+)$/i);
    if (sfxMatch) {
      blocks.push({ type: "sfx", text: sfxMatch[1].trim(), startTime, endTime, rawLine: line });
      continue;
    }

    const musMatch = content.match(/^\[MUS\]\s*(.+)$/i);
    if (musMatch) {
      blocks.push({ type: "music", text: musMatch[1].trim(), startTime, endTime, rawLine: line });
      continue;
    }

    const dirMatch = content.match(/^\[DIR\]\s*(.+)$/i);
    if (dirMatch) {
      blocks.push({ type: "direction", text: dirMatch[1].trim(), startTime, endTime, rawLine: line });
      continue;
    }

    const narMatch = content.match(/^\[NAR\]\s*(.+)$/i);
    if (narMatch) {
      blocks.push({ type: "narration", text: narMatch[1].trim(), startTime, endTime, rawLine: line });
      continue;
    }

    // [N]: dialogue or Speaker N: dialogue (legacy without timestamp)
    const dialogueMatch = line.match(/^(?:\[(\d+)\]|Speaker\s+(\d+)):\s*(.+)$/i);
    if (dialogueMatch) {
      const speaker = parseInt(dialogueMatch[1] || dialogueMatch[2]);
      blocks.push({ type: "dialogue", speaker, text: dialogueMatch[3].trim(), startTime, endTime, rawLine: line });
      continue;
    }

    // Other # annotations: treat as direction
    if (line.startsWith("#")) {
      blocks.push({ type: "direction", text: line.replace(/^#+\s*/, ""), startTime, endTime, rawLine: line });
      continue;
    }
  }

  return blocks;
}

interface SfxEntry {
  index: number;    // Global SFX file index (maps to sfxAudioFiles array)
  cue: string;      // Description text
  startTime?: number; // Absolute start time from script (seconds)
  endTime?: number;   // Absolute end time from script (seconds)
}

interface SceneSegment {
  sceneIndex: number;
  dialogueLines: { speaker: number; text: string }[];
  directions: string[];
  sfxCues: string[];
  sfxEntries: SfxEntry[]; // SFX with timing info
  sfxIndices: number[]; // Which SFX file indices (0-based) belong to this scene
  musicCues: string[];
  narration: string[];
  // Timing (filled after audio analysis or from script timestamps)
  startTime: number;
  endTime: number;
  duration: number;
  // If script had timestamps on [DIR], use them directly
  scriptStartTime?: number;
  scriptEndTime?: number;
}

/**
 * Group script blocks into scene segments.
 * A new scene starts at each [DIR] annotation, or every N dialogue lines.
 */
function makeEmptyScene(index: number): SceneSegment {
  return {
    sceneIndex: index,
    dialogueLines: [],
    directions: [],
    sfxCues: [],
    sfxEntries: [],
    sfxIndices: [],
    musicCues: [],
    narration: [],
    startTime: 0,
    endTime: 0,
    duration: 0,
  };
}

function groupIntoScenes(blocks: ParsedScriptBlock[], maxLinesPerScene: number = 6): SceneSegment[] {
  const scenes: SceneSegment[] = [];
  let sfxCounter = 0; // Global SFX index, maps to sfxAudioFiles array
  let current: SceneSegment = makeEmptyScene(0);

  for (const block of blocks) {
    // [DIR] annotation starts a new scene (if current has dialogue)
    if (block.type === "direction" && current.dialogueLines.length > 0) {
      scenes.push(current);
      current = makeEmptyScene(scenes.length);
      current.directions.push(block.text);
      // Preserve script timestamps from DIR block for segment timing
      if (block.startTime != null && block.endTime != null) {
        current.scriptStartTime = block.startTime;
        current.scriptEndTime = block.endTime;
      }
      continue;
    }

    if (block.type === "direction") {
      current.directions.push(block.text);
      // First DIR in the scene sets the segment timing
      if (block.startTime != null && block.endTime != null && current.scriptStartTime == null) {
        current.scriptStartTime = block.startTime;
        current.scriptEndTime = block.endTime;
      }
    } else if (block.type === "dialogue") {
      current.dialogueLines.push({ speaker: block.speaker!, text: block.text });
      // Auto-split if too many lines in one scene
      if (current.dialogueLines.length >= maxLinesPerScene) {
        scenes.push(current);
        current = makeEmptyScene(scenes.length);
      }
    } else if (block.type === "sfx") {
      current.sfxCues.push(block.text);
      current.sfxIndices.push(sfxCounter);
      current.sfxEntries.push({
        index: sfxCounter,
        cue: block.text,
        startTime: block.startTime,
        endTime: block.endTime,
      });
      sfxCounter++;
    } else if (block.type === "music") {
      current.musicCues.push(block.text);
    } else if (block.type === "narration") {
      current.narration.push(block.text);
    }
  }

  // Push last scene
  if (current.dialogueLines.length > 0 || current.directions.length > 0) {
    scenes.push(current);
  }

  return scenes;
}

interface CharacterInfo {
  name: string;
  age?: string;
  gender?: string;
  description?: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a brief, name-free physical description for a character, e.g.
 * "a 41-year-old man with a husky build and tired eyes". The [DIR] text supplies
 * pose / frame location, so this stays short, just who the person is visually.
 */
function buildCharacterBrief(c: CharacterInfo): string {
  const age = (c.age || "").trim();
  const gender = (c.gender || "").trim().toLowerCase();
  const desc = (c.description || "").trim().replace(/[.\s]+$/, "");

  let noun = "person";
  if (/\b(male|man|boy|m)\b/.test(gender)) noun = "man";
  else if (/\b(female|woman|girl|f)\b/.test(gender)) noun = "woman";

  let head = "a";
  if (age) head = `a ${/^\d+$/.test(age) ? `${age}-year-old` : age}`;

  let brief = `${head} ${noun}`.replace(/\s+/g, " ").trim();
  if (desc) brief += ` with ${desc}`;
  return brief;
}

/** Generic name-free reference used when replacing a name mid-sentence. */
function genericNoun(c: CharacterInfo): string {
  const gender = (c.gender || "").trim().toLowerCase();
  if (/\b(male|man|boy|m)\b/.test(gender)) return "the man";
  if (/\b(female|woman|girl|f)\b/.test(gender)) return "the woman";
  return "the person";
}

/**
 * Replace every character name in `text` with a generic, name-free reference so
 * character names never reach LTX (which only needs visible appearance, frame
 * position, and current action: not story names).
 */
function stripCharacterNames(text: string, characters: CharacterInfo[]): string {
  let out = text;
  for (const c of characters) {
    const name = (c.name || "").trim();
    if (!name) continue;
    const esc = escapeRegex(name);
    const noun = genericNoun(c);
    out = out.replace(new RegExp(`\\b${esc}'s\\b`, "gi"), `${noun}'s`);
    out = out.replace(new RegExp(`\\b${esc}\\b`, "gi"), noun);
  }
  return out;
}

/**
 * Detect first-person / POV framing in a direction. POV only applies when the
 * direction itself frames the shot that way (the script writer's choice); if it
 * names the POV character we return that name so we can omit their self-description.
 */
function detectPov(text: string, characters: CharacterInfo[]): { isPov: boolean; povName: string | null } {
  const isPov = /\b(first[- ]person|point of view|pov|from .{0,40}?perspective|through .{0,30}?eyes)\b/i.test(text);
  if (!isPov) return { isPov: false, povName: null };
  for (const c of characters) {
    const name = (c.name || "").trim();
    if (!name) continue;
    const esc = escapeRegex(name);
    if (new RegExp(`from\\s+${esc}'?s?\\s+(perspective|pov|view|eyes)|${esc}'?s?\\s+(perspective|pov)`, "i").test(text)) {
      return { isPov: true, povName: name };
    }
  }
  return { isPov: true, povName: null };
}

/**
 * Generate a video prompt for LTX from scene context.
 * Names are stripped, speaking characters get a brief name-free physical
 * description (so LTX can separate them), and the POV character, when the
 * direction explicitly names one: is omitted because the camera is their eyes.
 */
function generateVideoPrompt(
  scene: SceneSegment,
  characters: CharacterInfo[],
  sfxAsAudioCues: boolean = false,
): string {
  const parts: string[] = [];

  const dirText = scene.directions.join(". ");
  const { isPov, povName } = detectPov(dirText, characters);

  // Direction annotations → primary visual guidance (character names removed)
  if (dirText) {
    parts.push(stripCharacterNames(dirText, characters));
  }

  // Brief, name-free physical descriptions for the speaking characters so LTX
  // can tell them apart. Skip the explicitly-named POV character.
  const speakersInScene = [...new Set(scene.dialogueLines.map((l) => l.speaker))];
  for (const speaker of speakersInScene) {
    const c = characters[speaker - 1]; // 1-indexed speakers
    if (!c || !(c.name || c.description || c.age || c.gender)) continue;
    if (isPov && povName && (c.name || "").trim().toLowerCase() === povName.toLowerCase()) continue;
    const brief = buildCharacterBrief(c);
    if (brief) parts.push(brief.charAt(0).toUpperCase() + brief.slice(1));
  }

  // Dialogue context → describe the conversation visually
  if (scene.dialogueLines.length > 0) {
    const speakerCount = speakersInScene.length;
    if (speakerCount === 1) {
      parts.push("A person speaking");
    } else {
      parts.push(`${speakerCount} people in conversation`);
    }
  }

  // SFX context → either visual cues or explicit audio/foley directions for LTX
  if (scene.sfxCues.length > 0) {
    const sfxText = stripCharacterNames(scene.sfxCues.join(", "), characters);
    parts.push(sfxAsAudioCues ? `Sound effects: ${sfxText}` : sfxText);
  }

  // Music context → mood guidance
  if (scene.musicCues.length > 0) {
    parts.push(`Mood: ${scene.musicCues.join(", ")}`);
  }

  return parts.join(". ") || "A cinematic scene";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      script,
      dialogueAudioFile,
      sfxAudioFiles = [],
      includeSfxDescriptions = false,
      frameRate = 24,
      width = 768,
      height = 512,
      characters = [],
      characterDescriptions = [], // legacy: array of names only
    } = body;

    if (!script?.trim()) {
      return NextResponse.json({ error: "Script is required" }, { status: 400 });
    }

    // Normalize characters: prefer full records; fall back to legacy name-only list.
    const characterInfos: CharacterInfo[] = (Array.isArray(characters) && characters.length)
      ? (characters as CharacterInfo[])
      : (characterDescriptions as string[]).map((name) => ({ name }));

    // Parse script
    const blocks = parseScript(script);
    const dialogueCount = blocks.filter((b) => b.type === "dialogue").length;
    if (dialogueCount === 0) {
      return NextResponse.json({ error: "No dialogue lines found in script" }, { status: 400 });
    }

    // Group into scenes
    const scenes = groupIntoScenes(blocks);
    apiLog("movie_maker", `[export-to-director] Parsed ${blocks.length} blocks → ${scenes.length} scenes`);

    // Probe dialogue audio for total duration
    let totalDuration = 0;
    let audioFilePath = "";

    if (dialogueAudioFile) {
      // Check in output/ first, then input/
      const outputPath = path.join(COMFYUI_OUTPUT, dialogueAudioFile);
      const inputPath = path.join(COMFYUI_INPUT, "audio", dialogueAudioFile);

      if (fs.existsSync(outputPath)) {
        audioFilePath = outputPath;
      } else if (fs.existsSync(inputPath)) {
        audioFilePath = inputPath;
      }

      if (audioFilePath) {
        try {
          const ffprobe = getFFprobePath();
          const { stdout } = await execAsync(
            `"${ffprobe}" -v error -show_entries format=duration -of csv=p=0 "${audioFilePath}"`
          );
          totalDuration = parseFloat(stdout.trim()) || 0;
        } catch {
          apiLog("movie_maker", "[export-to-director] Warning: could not probe audio duration");
        }
      }
    }

    // Distribute time across scenes: prefer script timestamps, fallback to proportional
    const hasScriptTiming = scenes.some((s) => s.scriptStartTime != null);

    if (hasScriptTiming) {
      // Use timestamps from the script [DIR] blocks
      for (const scene of scenes) {
        if (scene.scriptStartTime != null && scene.scriptEndTime != null) {
          scene.startTime = scene.scriptStartTime;
          scene.endTime = scene.scriptEndTime;
          scene.duration = scene.endTime - scene.startTime;
        } else {
          // Scene without timestamps: estimate from neighbors
          const prevEnd = scenes[scene.sceneIndex - 1]?.endTime || 0;
          const estDuration = Math.max(scene.dialogueLines.length, 1) * 3;
          scene.startTime = prevEnd;
          scene.endTime = prevEnd + estDuration;
          scene.duration = estDuration;
        }
      }
      // Update totalDuration from script
      if (totalDuration === 0) {
        totalDuration = Math.max(...scenes.map((s) => s.endTime));
      }
    } else {
      // Legacy: proportional distribution based on dialogue line count
      const totalLines = scenes.reduce((sum, s) => sum + Math.max(s.dialogueLines.length, 1), 0);
      let timeOffset = 0;

      for (const scene of scenes) {
        const weight = Math.max(scene.dialogueLines.length, 1) / totalLines;
        scene.duration = totalDuration > 0
          ? totalDuration * weight
          : Math.max(scene.dialogueLines.length, 1) * 3; // fallback: ~3s per line
        scene.startTime = timeOffset;
        scene.endTime = timeOffset + scene.duration;
        timeOffset = scene.endTime;
      }

      // If no audio was provided, estimate total from scene durations
      if (totalDuration === 0) {
        totalDuration = scenes.reduce((sum, s) => sum + s.duration, 0);
      }
    }

    // Slice audio into per-segment chunks (if audio exists)
    const ff = getFFmpegPath();
    const audioDir = path.join(COMFYUI_INPUT, "audio");
    fs.mkdirSync(audioDir, { recursive: true });
    const timestamp = Date.now();

    // Build Director segments
    const directorSegments = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const rawFrames = Math.round(scene.duration * frameRate);
      const numFrames = Math.max(9, Math.round((rawFrames - 1) / 8) * 8 + 1);

      // Slice dialogue audio for this segment
      let audioSliceFile = "";
      const sliceName = `mv_moviemaker_${timestamp}_${String(i).padStart(3, "0")}.wav`;
      const slicePath = path.join(audioDir, sliceName);

      if (audioFilePath && scene.duration > 0.1) {
        try {
          await execAsync(
            `"${ff}" -y -ss ${scene.startTime.toFixed(3)} -t ${scene.duration.toFixed(3)} -i "${audioFilePath}" -ar 48000 -ac 2 "${slicePath}"`
          );
          audioSliceFile = `audio/${sliceName}`;
        } catch (err) {
          apiLog("movie_maker", `[export-to-director] Warning: audio slice ${i} failed`);
        }
      }

      // Mix SFX audio files into this segment's audio slice with precise timing
      const sceneSfxFiles: { path: string; offsetMs: number }[] = [];
      for (const sfxEntry of scene.sfxEntries) {
        if (sfxEntry.index < sfxAudioFiles.length) {
          const sfxPath = path.join(COMFYUI_OUTPUT, sfxAudioFiles[sfxEntry.index]);
          if (fs.existsSync(sfxPath)) {
            // Calculate offset within this segment (ms)
            let offsetMs = 0;
            if (sfxEntry.startTime != null) {
              // Precise timing from script: offset = sfx_start - scene_start
              offsetMs = Math.max(0, Math.round((sfxEntry.startTime - scene.startTime) * 1000));
            }
            sceneSfxFiles.push({ path: sfxPath, offsetMs });
          }
        }
      }

      if (sceneSfxFiles.length > 0) {
        const mixedName = `mv_moviemaker_mix_${timestamp}_${String(i).padStart(3, "0")}.wav`;
        const mixedPath = path.join(audioDir, mixedName);
        try {
          // Build filter graph with adelay for precise SFX placement
          const inputArgs: string[] = [];
          const filterParts: string[] = [];
          let inputIdx = 0;

          if (audioSliceFile) {
            inputArgs.push(`-i "${slicePath}"`);
            filterParts.push(`[0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[dlg]`);
            inputIdx = 1;
          }

          for (let s = 0; s < sceneSfxFiles.length; s++) {
            const sfx = sceneSfxFiles[s];
            inputArgs.push(`-i "${sfx.path}"`);
            const idx = inputIdx + s;
            if (sfx.offsetMs > 0) {
              filterParts.push(`[${idx}]adelay=${sfx.offsetMs}|${sfx.offsetMs},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[sfx${s}]`);
            } else {
              filterParts.push(`[${idx}]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[sfx${s}]`);
            }
          }

          // Mix all streams together
          const mixInputs = audioSliceFile
            ? `[dlg]${sceneSfxFiles.map((_, s) => `[sfx${s}]`).join("")}`
            : sceneSfxFiles.map((_, s) => `[sfx${s}]`).join("");
          const n = (audioSliceFile ? 1 : 0) + sceneSfxFiles.length;
          const weights = audioSliceFile
            ? `2${" 1".repeat(sceneSfxFiles.length)}`
            : sceneSfxFiles.map(() => "1").join(" ");
          filterParts.push(`${mixInputs}amix=inputs=${n}:duration=longest:weights=${weights}[out]`);

          const filterGraph = filterParts.join(";");
          await execAsync(
            `"${ff}" -y ${inputArgs.join(" ")} -filter_complex "${filterGraph}" -map "[out]" -ar 48000 -ac 2 "${mixedPath}"`
          );
          audioSliceFile = `audio/${mixedName}`;
        } catch (err) {
          apiLog("movie_maker", `[export-to-director] Warning: SFX mix for scene ${i} failed: ${err instanceof Error ? err.message : err}`);
          // Fall back to dialogue-only slice (audioSliceFile stays as is)
        }
      }

      // Generate video prompt (sfxAsAudioCues = true when user wants LTX to generate foley)
      const prompt = generateVideoPrompt(scene, characterInfos, includeSfxDescriptions);

      // Collect dialogue text for this segment
      const dialogueText = scene.dialogueLines.map((l) => l.text).join(" ");

      directorSegments.push({
        id: `seg_mm_${timestamp}_${String(i).padStart(3, "0")}`,
        prompt,
        dialogue: dialogueText,
        numFrames,
        sourceImage: "",
        sourceImagePreview: "",
        endImage: "",
        endImagePreview: "",
        audioSliceFile,
        audioStartTime: scene.startTime,
        audioEndTime: scene.endTime,
        status: "pending",
        outputUrl: null,
        lastFrameFile: null,
        ttsOutputId: null,
        speechAudioUrl: null,
        error: null,
      });
    }

    apiLog("movie_maker", `[export-to-director] Generated ${directorSegments.length} Director segments, total ${totalDuration.toFixed(1)}s`);

    return NextResponse.json({
      ok: true,
      segments: directorSegments,
      totalDuration: Math.round(totalDuration * 10) / 10,
      sceneCount: scenes.length,
      dialogueLineCount: dialogueCount,
      config: {
        width,
        height,
        frameRate,
        audioMode: audioFilePath ? "joint" : "none",
        enableSpeech: false, // Speech already baked into dialogue audio
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Export failed";
    apiLog("movie_maker", `[ERR] export-to-director: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
