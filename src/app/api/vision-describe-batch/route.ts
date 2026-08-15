/**
 * Vision Describe Batch API: runs Qwen2.5-VL to describe multiple images in one model load.
 * Spawns a standalone Python process that loads the model, runs inference on ALL images,
 * outputs JSON array, then exits (freeing VRAM for LTX-2 generation).
 *
 * POST /api/vision-describe-batch
 * Body: { items: { imagePath: string, prompt?: string }[], modelPath?: string, maxTokens?: number }
 * Returns: { results: { description?: string, error?: string }[] } or { error: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { registerLlmProcess } from "@/lib/llm-process";
import { getOfflineEnv, getModelPath } from "@/lib/veksnap-settings";
import { apiLog } from "@/lib/api-logger";

export const maxDuration = 600; // batch can take a while
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
  let tmpJsonPath: string | null = null;
  try {
    const body = await req.json();
    const { items, modelPath, maxTokens } = body as {
      items: { imagePath: string; prompt?: string }[];
      modelPath?: string;
      maxTokens?: number;
    };

    if (!items || !Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: "items array is required and must not be empty" }, { status: 400 });
    }

    const resolvedModel = modelPath || getModelPath("Qwen2.5-VL-7B-Instruct");
    if (!fs.existsSync(resolvedModel)) {
      return NextResponse.json(
        { error: `Vision model not found at: ${resolvedModel}. Download Qwen2.5-VL-7B-Instruct to this path.` },
        { status: 404 }
      );
    }

    // Resolve image paths: ComfyUI input filenames → absolute paths
    const comfyInput = path.join(process.cwd(), "..", "ComfyUI", "input");
    const resolvedItems = items.map((item) => {
      let imgPath = item.imagePath;
      if (!path.isAbsolute(imgPath)) {
        imgPath = path.join(comfyInput, imgPath);
      }
      return { image_path: imgPath, prompt: item.prompt || null };
    });

    // Write batch JSON to temp file
    const timestamp = Date.now();
    tmpJsonPath = path.join(process.cwd(), `_vision_batch_${timestamp}.json`);
    const batchPayload = {
      model_path: resolvedModel,
      max_tokens: maxTokens || 120,
      items: resolvedItems,
    };
    fs.writeFileSync(tmpJsonPath, JSON.stringify(batchPayload), "utf-8");

    const python = findPython();
    const scriptPath = path.join(process.cwd(), "scripts", "vision-describe.py");
    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json({ error: `Script not found: ${scriptPath}` }, { status: 500 });
    }

    apiLog("ai_tools", `[vision-describe-batch] Processing ${items.length} images, tokens=${maxTokens || 120}`);
    console.log(`[vision-describe-batch] Processing ${items.length} images...`);

    const result = await new Promise<unknown>((resolve, reject) => {
      const child = spawn(python, [scriptPath, "--json-input", tmpJsonPath!], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...getOfflineEnv() },
      });

      registerLlmProcess("vision-describe-batch", child, `Vision Describe Batch (${items.length} images)`);

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        if (stderr) {
          apiLog("ai_tools", `[vision-describe-batch] ${stderr.slice(0, 1000)}`);
          console.log(`[vision-describe-batch] stderr: ${stderr.slice(0, 1000)}`);
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
          reject(new Error(`Failed to parse output: ${stdout.slice(0, 300)}`));
        }
      });
    });

    // result is either an array of {description} or a single {error}
    if (Array.isArray(result)) {
      return NextResponse.json({ results: result });
    } else if (result && typeof result === "object" && "error" in result) {
      return NextResponse.json({ error: (result as { error: string }).error }, { status: 500 });
    }

    return NextResponse.json({ results: result });
  } catch (err) {
    apiLog("ai_tools", `[ERR] vision-describe-batch: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[vision-describe-batch] Error:", err);
    const msg = err instanceof Error ? err.message : "Batch vision describe failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (tmpJsonPath && fs.existsSync(tmpJsonPath)) {
      try { fs.unlinkSync(tmpJsonPath); } catch { /* ignore */ }
    }
  }
}
