/**
 * Movie Maker: Scene Image Prompt Generator (SSE Streaming)
 * Converts [DIR] visual directions into photorealistic image prompts
 * using Qwen3.5-9B, optimized for LTX2.3 I2V starter frames.
 *
 * POST /api/movie-maker/generate-scene-prompts
 * Body: {
 *   directions: { index: number, text: string, timestamp?: string }[],
 *   characters: { name: string, age?: string, gender?: string, description?: string, role?: string, personality?: string }[],
 * }
 * SSE Events:
 *   event: progress  - { type, message, phase, tokens?, percent?, eta?, ... }
 *   event: result     - { prompts: [...], output_file: string }
 *   event: error      - { error: string }
 *
 * DELETE /api/movie-maker/generate-scene-prompts
 *   Cancels active generation
 */

import { NextRequest, NextResponse } from "next/server";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { registerLlmProcess } from "@/lib/llm-process";
import { getOfflineEnv, resolvePromptLlm } from "@/lib/veksnap-settings";
import { apiLog } from "@/lib/api-logger";
import { evaluateContent, SAFETY_REFUSAL_MESSAGE } from "@/lib/safety-filter";

let activeChild: ChildProcess | null = null;

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

function cleanupTmp(p: string) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}

export async function POST(req: NextRequest) {
  let tmpInput = "";
  try {
    const body = await req.json();
    const {
      directions = [],
      characters = [],
    } = body as {
      directions?: { index: number; text: string; timestamp?: string }[];
      characters?: { name: string; age?: string; gender?: string; description?: string; role?: string; personality?: string }[];
    };

    if (!directions.length) {
      return NextResponse.json({ error: "No directions provided." }, { status: 400 });
    }

    // Always-on child-safety gate (not user-configurable). A numeric character
    // age is turned into a synthetic "aged N" phrase so the filter's own
    // under-18 threshold decides: combined with any sexual cue it refuses.
    const safety = evaluateContent({
      directions: directions.map((d) => d?.text),
      characters: characters.map((c) => [
        c?.name, c?.description, c?.role, c?.personality, c?.gender,
        c?.age ? `aged ${c.age}` : "",
      ]),
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
        { error: `LLM not found at: ${modelPath}` },
        { status: 404 }
      );
    }

    const python = findPython();
    const scriptPath = path.join(process.cwd(), "scripts", "scene-prompt-writer.py");
    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json({ error: `Script not found: ${scriptPath}` }, { status: 500 });
    }

    // Output file in ComfyUI output directory
    const comfyOutput = path.join(process.cwd(), "..", "ComfyUI", "output");
    const outputFile = path.join(comfyOutput, `moviemaker_scene_prompts_${Date.now()}.txt`);

    tmpInput = path.join(process.cwd(), `_scene_prompts_${Date.now()}.json`);
    fs.writeFileSync(tmpInput, JSON.stringify({
      directions,
      characters,
      model_path: modelPath,
      output_file: outputFile,
    }));

    apiLog("movie_maker", `[scene-prompts] Generating image prompts for ${directions.length} scenes`);

    const child = spawn(python, [scriptPath, "--json-input", tmpInput], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...getOfflineEnv() },
    });
    activeChild = child;
    registerLlmProcess("scene-prompt-writer", child, "Scene Prompt Writer (Qwen3.5-9B)");

    const localTmpInput = tmpInput;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        let stdout = "";
        let stderrBuf = "";

        child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

        child.stderr!.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          const lines = stderrBuf.split("\n");
          stderrBuf = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.type) { send("progress", parsed); continue; }
            } catch { /* not JSON */ }
            send("progress", { type: "status", message: trimmed, phase: "log" });
          }
        });

        child.on("error", (err) => {
          send("error", { error: err.message });
          controller.close();
          activeChild = null;
          cleanupTmp(localTmpInput);
        });

        child.on("close", (code) => {
          activeChild = null;
          if (stderrBuf.trim()) {
            try {
              const parsed = JSON.parse(stderrBuf.trim());
              if (parsed.type) send("progress", parsed);
            } catch {
              send("progress", { type: "status", message: stderrBuf.trim(), phase: "log" });
            }
          }

          if (code !== 0 && code !== null) {
            send("error", { error: `Process exited with code ${code}` });
            controller.close();
            cleanupTmp(localTmpInput);
            return;
          }

          try {
            const lines = stdout.trim().split("\n");
            const jsonLine = lines[lines.length - 1];
            const result = JSON.parse(jsonLine);
            if (result.error) {
              send("error", { error: result.error, raw_output: result.raw_output });
            } else {
              send("result", result);
            }
          } catch {
            send("error", { error: `Failed to parse output: ${stdout.slice(0, 200)}` });
          }

          controller.close();
          cleanupTmp(localTmpInput);
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    apiLog("movie_maker", `[ERR] scene-prompts: ${err instanceof Error ? err.message : String(err)}`);
    if (tmpInput) cleanupTmp(tmpInput);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Scene prompt generation failed" }, { status: 500 });
  }
}

export async function DELETE() {
  if (!activeChild) {
    return NextResponse.json({ status: "no_active_generation" });
  }
  try {
    activeChild.stdin?.write("CANCEL\n");
    const child = activeChild;
    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, 3000);
    return NextResponse.json({ status: "cancel_sent" });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
