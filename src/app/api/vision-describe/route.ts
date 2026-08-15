/**
 * Vision Describe API: runs Qwen2.5-VL-7B to describe an uploaded image.
 * Spawns a standalone Python process that loads the model, runs inference,
 * outputs JSON, then exits (freeing VRAM for LTX-2 generation).
 *
 * POST /api/vision-describe
 * Body: { imagePath: string, modelPath?: string, maxTokens?: number, prompt?: string }
 * Returns: { description: string } or { error: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { registerLlmProcess } from "@/lib/llm-process";
import { getOfflineEnv, getModelPath } from "@/lib/veksnap-settings";
import { apiLog } from "@/lib/api-logger";

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
  let tempFile: string | null = null;
  try {
    const body = await req.json();
    const { imagePath, modelPath, maxTokens, prompt } = body as {
      imagePath: string;
      modelPath?: string;
      maxTokens?: number;
      prompt?: string;
    };

    if (!imagePath) {
      return NextResponse.json({ error: "imagePath is required" }, { status: 400 });
    }

    // Resolve image path: handle data URLs, absolute paths, and ComfyUI filenames
    let resolvedImage = imagePath;

    if (imagePath.startsWith("data:")) {
      const match = imagePath.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) {
        return NextResponse.json({ error: "Invalid data URL format" }, { status: 400 });
      }
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const buffer = Buffer.from(match[2], "base64");
      const tmpDir = path.join(process.cwd(), "..", "ComfyUI", "input");
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      tempFile = path.join(tmpDir, `_vision_describe_tmp_${Date.now()}.${ext}`);
      fs.writeFileSync(tempFile, buffer);
      resolvedImage = tempFile;
    } else if (!path.isAbsolute(imagePath)) {
      const comfyInput = path.join(process.cwd(), "..", "ComfyUI", "input");
      resolvedImage = path.join(comfyInput, imagePath);
    }

    if (!fs.existsSync(resolvedImage)) {
      return NextResponse.json({ error: `Image not found: ${resolvedImage}` }, { status: 404 });
    }

    const resolvedModel = modelPath || getModelPath("Qwen2.5-VL-7B-Instruct");
    if (!fs.existsSync(resolvedModel)) {
      return NextResponse.json(
        { error: `Vision model not found at: ${resolvedModel}. Download Qwen2.5-VL-7B-Instruct to this path.` },
        { status: 404 }
      );
    }

    const python = findPython();
    const scriptPath = path.join(process.cwd(), "scripts", "vision-describe.py");
    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json({ error: `Script not found: ${scriptPath}` }, { status: 500 });
    }

    const tokens = maxTokens || 180;
    apiLog("ai_tools", `[vision-describe] image="${resolvedImage}" tokens=${tokens}${prompt ? " (custom prompt)" : ""}`);
    console.log(`[vision-describe] Running: image="${resolvedImage}" tokens=${tokens}${prompt ? " (custom prompt)" : ""}`);

    const result = await new Promise<Record<string, string>>((resolve, reject) => {
      const args = [scriptPath, resolvedImage, resolvedModel, "--max-tokens", String(tokens)];
      if (prompt) args.push("--prompt", prompt);
      const child = spawn(python, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...getOfflineEnv() },
      });

      // Register for abort capability
      registerLlmProcess("vision-describe", child, "Vision Describe (Qwen2.5-VL-7B)");

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (err) => reject(err));

      child.on("close", (code) => {
        if (stderr) {
          apiLog("ai_tools", `[vision-describe] ${stderr.slice(0, 1000)}`);
          console.log(`[vision-describe] stderr: ${stderr.slice(0, 500)}`);
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
    apiLog("ai_tools", `[ERR] vision-describe: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[vision-describe] Error:", err);
    const msg = err instanceof Error ? err.message : "Vision describe failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }
}
