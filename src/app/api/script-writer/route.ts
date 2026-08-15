/**
 * Script Writer API: runs Qwen3.5-9B to generate multi-segment video scripts
 * tailored for LTX-2.3 video generation.
 *
 * POST /api/script-writer
 * Body: { characters: string, scene: string, mood: string, duration: number, notes: string, modelPath?: string, maxTokens?: number }
 * Returns: { segments: [...], total_seconds: number } or { error: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { registerLlmProcess } from "@/lib/llm-process";
import { getOfflineEnv, resolvePromptLlm } from "@/lib/veksnap-settings";
import { apiLog } from "@/lib/api-logger";
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
  let tmpInput = "";
  try {
    const body = await req.json();
    const {
      characters,
      scene,
      mood,
      duration,
      notes,
      modelPath,
      maxTokens,
    } = body as {
      characters: string;
      scene: string;
      mood: string;
      duration: number;
      notes: string;
      modelPath?: string;
      maxTokens?: number;
    };

    if (!scene && !characters && !notes) {
      return NextResponse.json({ error: "At least one of characters, scene, or notes is required" }, { status: 400 });
    }

    // Always-on child-safety gate (not user-configurable).
    const safety = evaluateContent({ characters, scene, mood, notes });
    if (safety.action === "refuse") {
      return NextResponse.json(
        { error: safety.message ?? SAFETY_REFUSAL_MESSAGE, safety_refusal: true },
        { status: 403 }
      );
    }

    const resolvedModel = modelPath || resolvePromptLlm();
    if (!fs.existsSync(resolvedModel)) {
      return NextResponse.json(
        { error: `Script Writer LLM not found at: ${resolvedModel}. Download Qwen2.5-7B-Instruct to this path.` },
        { status: 404 }
      );
    }

    const python = findPython();
    const scriptPath = path.join(process.cwd(), "scripts", "script-writer.py");
    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json({ error: `Script not found: ${scriptPath}` }, { status: 500 });
    }

    const tokens = maxTokens || 2000;

    // Write input to a temp JSON file to avoid shell escaping issues on Windows
    tmpInput = path.join(process.cwd(), `_script_writer_${Date.now()}.json`);
    fs.writeFileSync(tmpInput, JSON.stringify({
      characters: characters || "",
      scene: scene || "",
      mood: mood || "",
      duration: duration || 10,
      notes: notes || "",
      model_path: resolvedModel,
      max_tokens: tokens,
    }));

    apiLog("ai_tools", `[script-writer] duration=${duration}s scene="${(scene || "").slice(0, 60)}..."`);
    console.log(`[script-writer] Generating ${duration}s script`);

    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(python, [scriptPath, "--json-input", tmpInput], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...getOfflineEnv() },
      });

      // Register for abort capability
      registerLlmProcess("script-writer", child, "Script Writer (Qwen3.5-9B)");

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        if (stderr) {
          apiLog("ai_tools", `[script-writer] ${stderr.slice(0, 1000)}`);
          console.log(`[script-writer] stderr: ${stderr.slice(0, 500)}`);
        }

        if (code !== 0 && code !== null) {
          reject(new Error(`Process exited with code ${code}. ${stderr.slice(0, 300)}`));
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
      return NextResponse.json({ error: result.error, raw_output: result.raw_output }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err) {
    apiLog("ai_tools", `[ERR] script-writer: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[script-writer] Error:", err);
    const msg = err instanceof Error ? err.message : "Script generation failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (tmpInput && fs.existsSync(tmpInput)) {
      try { fs.unlinkSync(tmpInput); } catch { /* ignore */ }
    }
  }
}
