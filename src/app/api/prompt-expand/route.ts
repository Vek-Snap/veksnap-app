/**
 * Prompt Expand API: runs Qwen3.5-9B to expand a short user prompt
 * into a rich cinematic LTX-2 prompt.
 *
 * POST /api/prompt-expand
 * Body: { prompt: string, modelPath?: string, style?: string, sceneContext?: string, maxTokens?: number }
 * Returns: { expanded: string } or { error: string }
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
    const { prompt, modelPath, style, sceneContext, maxTokens, mode } = body as {
      prompt: string;
      modelPath?: string;
      style?: string;
      sceneContext?: string;
      maxTokens?: number;
      mode?: "image" | "video";
    };

    if (!prompt) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    // Always-on child-safety gate (not user-configurable).
    const safety = evaluateContent({ prompt, style, sceneContext });
    if (safety.action === "refuse") {
      return NextResponse.json(
        { error: safety.message ?? SAFETY_REFUSAL_MESSAGE, safety_refusal: true },
        { status: 403 }
      );
    }

    const resolvedModel = modelPath || resolvePromptLlm();
    if (!fs.existsSync(resolvedModel)) {
      return NextResponse.json(
        { error: `Prompt LLM not found at: ${resolvedModel}. Download Qwen2.5-7B-Instruct to this path.` },
        { status: 404 }
      );
    }

    const python = findPython();
    const scriptPath = path.join(process.cwd(), "scripts", "prompt-expand.py");
    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json({ error: `Script not found: ${scriptPath}` }, { status: 500 });
    }

    const tokens = maxTokens || 600;

    // Write input to a temp JSON file to avoid shell escaping issues on Windows
    tmpInput = path.join(process.cwd(), `_prompt_expand_${Date.now()}.json`);
    fs.writeFileSync(tmpInput, JSON.stringify({
      prompt,
      model_path: resolvedModel,
      style: style || "",
      scene_context: sceneContext || "",
      max_tokens: tokens,
      mode: mode || "video",
    }));

    // Do NOT log the prompt text, logs can be exported to us for support and
    // must never carry user content. Log only non-identifying metrics.
    apiLog("ai_tools", `[prompt-expand] prompt length=${prompt.length} tokens=${tokens}`);
    console.log(`[prompt-expand] Running: prompt length=${prompt.length} tokens=${tokens}`);

    const result = await new Promise<Record<string, string>>((resolve, reject) => {
      const child = spawn(python, [scriptPath, "--json-input", tmpInput], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...getOfflineEnv() },
      });

      // Register for abort capability
      registerLlmProcess("prompt-expand", child, "Prompt Expand (Qwen3.5-9B)");

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        if (stderr) {
          apiLog("ai_tools", `[prompt-expand] ${stderr.slice(0, 1000)}`);
          console.log(`[prompt-expand] stderr: ${stderr.slice(0, 500)}`);
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
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json(result);
  } catch (err) {
    apiLog("ai_tools", `[ERR] prompt-expand: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[prompt-expand] Error:", err);
    const msg = err instanceof Error ? err.message : "Prompt expansion failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (tmpInput && fs.existsSync(tmpInput)) {
      try { fs.unlinkSync(tmpInput); } catch { /* ignore */ }
    }
  }
}
