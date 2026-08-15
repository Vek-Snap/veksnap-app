/**
 * Movie Maker: Rewrite Scene Direction(s) to a Requested Camera Perspective
 *
 * Re-generates the [DIR] stage direction for ONE or MANY scenes so each matches a
 * chosen camera perspective (default / pov / ots / wide / closeup / aerial),
 * staying faithful to the dialogue and original action. Output is name-free and,
 * for POV, omits the chosen camera character. One model load handles the batch.
 *
 * POST /api/movie-maker/rewrite-scene
 * Body: {
 *   scenes: {
 *     index: number,                 // 1-based scene number (for matching back)
 *     dialogue?: string,             // the scene's dialogue lines (joined)
 *     currentDirection?: string,     // existing [DIR] text to rewrite
 *     perspective: ScenePerspective, // requested framing
 *     targetCharId?: string,         // character id for pov/ots
 *   }[],
 *   characters?: { id?: string, name?: string, age?: string, gender?: string, description?: string }[],
 *   setting?: string,
 *   style?: string,
 * }
 * Returns: { directions: { index: number, direction: string }[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { registerLlmProcess } from "@/lib/llm-process";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";
import { getOfflineEnv, resolvePromptLlm } from "@/lib/veksnap-settings";
import { apiLog } from "@/lib/api-logger";
import { evaluateContent, SAFETY_REFUSAL_MESSAGE } from "@/lib/safety-filter";
import { SCENE_PERSPECTIVE_OPTIONS, type ScenePerspective } from "@/lib/types";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

interface CharIn {
  id?: string;
  name?: string;
  age?: string;
  gender?: string;
  description?: string;
}

interface SceneIn {
  index: number;
  dialogue?: string;
  currentDirection?: string;
  perspective: ScenePerspective;
  targetCharId?: string;
}

function findPython(): string {
  const candidates = [
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

/** Brief, name-free physical reference for the {char} placeholder, e.g. "the 41-year-old husky man". */
function briefRef(c: CharIn): string {
  const age = (c.age || "").trim();
  const gender = (c.gender || "").trim().toLowerCase();
  const desc = (c.description || "").trim().replace(/[.\s]+$/, "");
  let noun = "person";
  if (/\b(male|man|boy|m)\b/.test(gender)) noun = "man";
  else if (/\b(female|woman|girl|f)\b/.test(gender)) noun = "woman";
  const agePart = age ? `${/^\d+$/.test(age) ? `${age}-year-old` : age} ` : "";
  const descPart = desc ? `${desc} ` : "";
  return `the ${agePart}${descPart}${noun}`.replace(/\s+/g, " ").trim();
}

export async function POST(req: NextRequest) {
  let tmpInput = "";
  try {
    const body = await req.json();
    const {
      scenes = [],
      characters = [],
      setting = "",
      style = "",
    } = body as {
      scenes?: SceneIn[];
      characters?: CharIn[];
      setting?: string;
      style?: string;
    };

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return NextResponse.json({ error: "No scenes provided" }, { status: 400 });
    }

    // Always-on child-safety gate (not user-configurable).
    const safety = evaluateContent({
      scenes: scenes.map((s) => [s?.dialogue, s?.currentDirection]),
      characters: characters.map((c) => [
        c?.name, c?.description, c?.gender, c?.age ? `aged ${c.age}` : "",
      ]),
      setting, style,
    });
    if (safety.action === "refuse") {
      return NextResponse.json(
        { error: safety.message ?? SAFETY_REFUSAL_MESSAGE, safety_refusal: true },
        { status: 403 }
      );
    }

    const modelPath = resolvePromptLlm();
    if (!fs.existsSync(modelPath)) {
      return NextResponse.json(
        { error: `LLM not found at: ${modelPath}. Place Qwen2.5-7B-Instruct there.` },
        { status: 404 }
      );
    }

    const python = findPython();
    const scriptPath = path.join(process.cwd(), "scripts", "rewrite-scene.py");
    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json({ error: `Script not found: ${scriptPath}` }, { status: 500 });
    }

    // Resolve each scene's perspective into a concrete instruction, substituting
    // the target character's brief description for the {char} placeholder.
    const charById = new Map<string, CharIn>();
    for (const c of characters) if (c.id) charById.set(c.id, c);

    const resolvedScenes = scenes.map((s) => {
      const opt = SCENE_PERSPECTIVE_OPTIONS.find((o) => o.id === s.perspective) || SCENE_PERSPECTIVE_OPTIONS[0];
      const target = s.targetCharId ? charById.get(s.targetCharId) : undefined;
      const charRef = target ? briefRef(target) : (opt.needsCharacter ? "the main character" : "");
      const instruction = opt.rewriteInstruction.replace(/\{char\}/g, charRef);
      return {
        index: s.index,
        dialogue: s.dialogue || "",
        current_direction: s.currentDirection || "",
        perspective_label: opt.label,
        perspective_instruction: instruction,
      };
    });

    tmpInput = path.join(process.cwd(), `_rewrite_scene_${Date.now()}.json`);
    fs.writeFileSync(tmpInput, JSON.stringify({
      scenes: resolvedScenes,
      characters,
      setting,
      style,
      model_path: modelPath,
    }));

    apiLog("movie_maker", `[rewrite-scene] Rewriting ${resolvedScenes.length} scene(s)`);

    // Free ComfyUI VRAM before loading the LLM (mirrors enrich-directions).
    try {
      await fetch(`${COMFYUI_HTTP}/free`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      });
    } catch { /* ComfyUI may not be running, fine */ }

    const localTmpInput = tmpInput;
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(python, [scriptPath, "--json-input", localTmpInput], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...getOfflineEnv() },
      });

      registerLlmProcess("rewrite-scene", child, "Scene Rewriter (Qwen2.5-7B)");

      let stdout = "";
      let stderrFull = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrFull += text;
        for (const line of text.split("\n").filter((l: string) => l.trim())) {
          if (line.startsWith("[rewrite-scene]")) apiLog("movie_maker", line);
        }
      });

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          apiLog("movie_maker", `[ERR] rewrite-scene stderr: ${stderrFull.slice(-1500)}`);
          reject(new Error(`Process exited with code ${code}. ${stderrFull.slice(-500)}`));
          return;
        }
        try {
          const lines = stdout.trim().split("\n");
          resolve(JSON.parse(lines[lines.length - 1]));
        } catch {
          reject(new Error(`Failed to parse output: ${stdout.slice(0, 200)}`));
        }
      });
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err) {
    apiLog("movie_maker", `[ERR] rewrite-scene: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scene rewrite failed" },
      { status: 500 }
    );
  } finally {
    if (tmpInput && fs.existsSync(tmpInput)) {
      try { fs.unlinkSync(tmpInput); } catch { /* ignore */ }
    }
  }
}
