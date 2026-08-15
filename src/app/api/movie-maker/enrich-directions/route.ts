/**
 * Movie Maker: Enrich Script with Stage Directions
 *
 * Takes an existing dialogue script (with [1]:, [SFX], [MUS] lines) and sends it
 * to the LLM to generate visual scene descriptions (# [DIR] annotations).
 * The user can specify an environment/setting to guide the visual style.
 *
 * POST /api/movie-maker/enrich-directions
 * Body: {
 *   script: string,           // Existing script text
 *   setting?: string,         // Environment description (e.g., "noir detective office, 1940s")
 *   style?: string,           // Visual style (e.g., "cinematic, dark lighting, moody")
 *   characters?: { name: string; description?: string }[],
 * }
 * Returns: { enrichedScript: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { registerLlmProcess } from "@/lib/llm-process";
import { getOfflineEnv, resolvePromptLlm } from "@/lib/veksnap-settings";
import { apiLog } from "@/lib/api-logger";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";
import { evaluateContent, SAFETY_REFUSAL_MESSAGE } from "@/lib/safety-filter";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

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
  let tmpInput = "";
  try {
    const body = await req.json();
    const {
      script = "",
      setting = "",
      style = "",
      characters = [],
    } = body as {
      script?: string;
      setting?: string;
      style?: string;
      characters?: { name: string; description?: string }[];
    };

    if (!script.trim()) {
      return NextResponse.json({ error: "Script is empty" }, { status: 400 });
    }

    // Always-on child-safety gate (not user-configurable).
    const safety = evaluateContent({ script, setting, style, characters });
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
    const scriptPath = path.join(process.cwd(), "scripts", "enrich-directions.py");
    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json({ error: `Script not found: ${scriptPath}` }, { status: 500 });
    }

    // Write input to temp file
    tmpInput = path.join(process.cwd(), `_enrich_directions_${Date.now()}.json`);
    fs.writeFileSync(tmpInput, JSON.stringify({
      script,
      setting,
      style,
      characters,
      model_path: modelPath,
      max_tokens: 4000,
    }));

    apiLog("movie_maker", `[enrich-directions] setting="${(setting || "auto").slice(0, 60)}" script_lines=${script.split("\n").length}`);

    // Free ComfyUI VRAM before loading LLM (ComfyUI holds models in VRAM even when idle)
    try {
      await fetch(`${COMFYUI_HTTP}/free`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      });
      apiLog("movie_maker", `[enrich-directions] Freed ComfyUI VRAM`);
    } catch {
      // ComfyUI might not be running, that's fine, more VRAM for us
    }

    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(python, [scriptPath, "--json-input", tmpInput], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...getOfflineEnv() },
      });

      registerLlmProcess("enrich-directions", child, "Direction Enricher (Qwen3.5-9B)");

      let stdout = "";
      let stderrFull = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderrFull += text;
        // Stream progress lines to apiLog in real-time
        const lines = text.split("\n").filter((l: string) => l.trim());
        for (const line of lines) {
          if (line.startsWith("[enrich-directions]")) {
            apiLog("movie_maker", line);
          }
        }
      });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          apiLog("movie_maker", `[ERR] enrich-directions stderr: ${stderrFull.slice(-1500)}`);
          reject(new Error(`Process exited with code ${code}. ${stderrFull.slice(-500)}`));
          return;
        }

        try {
          const lines = stdout.trim().split("\n");
          const jsonLine = lines[lines.length - 1];
          resolve(JSON.parse(jsonLine));
        } catch (e) {
          reject(new Error(`Failed to parse output: ${stdout.slice(0, 200)}`));
        }
      });
    });

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err) {
    apiLog("movie_maker", `[ERR] enrich-directions: ${err instanceof Error ? err.message : String(err)}`);
    const msg = err instanceof Error ? err.message : "Enrichment failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (tmpInput && fs.existsSync(tmpInput)) {
      try { fs.unlinkSync(tmpInput); } catch { /* ignore */ }
    }
  }
}
