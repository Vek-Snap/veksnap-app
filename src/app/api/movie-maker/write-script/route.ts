/**
 * Movie Maker: Script Writer (SSE Streaming)
 * Uses Qwen3.5-9B to generate a tagged multi-character dialogue script
 * with SFX, music, and narrator annotations.
 *
 * POST /api/movie-maker/write-script
 * Body: {
 *   characters: { name: string, personality?: string }[],
 *   scenario: string,
 *   tone?: string,
 *   durationSeconds?: number,
 *   notes?: string,
 *   maxTokens?: number,
 * }
 * SSE Events:
 *   event: progress  - { type, message, phase, tokens?, percent?, eta?, ... }
 *   event: result     - { script, lines, stats }
 *   event: error      - { error: string }
 *
 * DELETE /api/movie-maker/write-script
 *   Cancels active script generation
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

export async function POST(req: NextRequest) {
  let tmpInput = "";
  try {
    const body = await req.json();
    const {
      characters = [],
      scenario = "",
      tone = "",
      durationSeconds = 60,
      notes = "",
      maxTokens = 0,
      maxSegmentDuration = 25,
      speakingPace = 2.5,
      povCharacter = "",
    } = body as {
      characters?: { name: string; personality?: string; role?: string; description?: string; age?: string; gender?: string }[];
      scenario?: string;
      tone?: string;
      durationSeconds?: number;
      notes?: string;
      maxTokens?: number;
      maxSegmentDuration?: number;
      speakingPace?: number;
      povCharacter?: string;
    };

    if (!scenario && !notes && characters.length === 0) {
      return NextResponse.json(
        { error: "Provide at least a scenario, notes, or characters." },
        { status: 400 }
      );
    }

    // Always-on child-safety gate (not user-configurable). Numeric character
    // ages become synthetic "aged N" phrases so the filter's threshold applies.
    const safety = evaluateContent({
      scenario, tone, notes, povCharacter,
      characters: characters.map((c) => [
        c?.name, c?.personality, c?.role, c?.description, c?.gender,
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
        { error: `Dialogue Writer LLM not found at: ${modelPath}. Place Qwen2.5-7B-Instruct there.` },
        { status: 404 }
      );
    }

    const python = findPython();
    const scriptPath = path.join(process.cwd(), "scripts", "dialogue-writer.py");
    if (!fs.existsSync(scriptPath)) {
      return NextResponse.json({ error: `Script not found: ${scriptPath}` }, { status: 500 });
    }

    // Write input to temp file (avoids shell-escaping issues on Windows)
    tmpInput = path.join(process.cwd(), `_dialogue_writer_${Date.now()}.json`);
    fs.writeFileSync(tmpInput, JSON.stringify({
      characters,
      scenario,
      tone,
      duration_seconds: durationSeconds,
      notes,
      model_path: modelPath,
      max_tokens: maxTokens,
      max_segment_duration: maxSegmentDuration,
      speaking_pace: speakingPace,
      pov_character: povCharacter || null,
    }));

    apiLog("movie_maker", `[write-script] scenario="${scenario.slice(0, 60)}..." chars=${characters.length} dur=${durationSeconds}s`);

    const child = spawn(python, [scriptPath, "--json-input", tmpInput], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...getOfflineEnv() },
    });
    activeChild = child;
    registerLlmProcess("dialogue-writer", child, "Dialogue Writer (Qwen3.5-9B)");

    const localTmpInput = tmpInput;

    // SSE streaming response
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };

        let stdout = "";

        child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

        // Parse stderr line-by-line for structured progress
        let stderrBuf = "";
        child.stderr!.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();
          const lines = stderrBuf.split("\n");
          stderrBuf = lines.pop() || "";  // keep incomplete line in buffer

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Try to parse structured progress JSON
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.type) {
                send("progress", parsed);
                continue;
              }
            } catch { /* not JSON, legacy log line */ }

            // Legacy stderr lines: forward as status
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
          // Flush remaining stderr
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
          } catch (e) {
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
    apiLog("movie_maker", `[ERR] write-script: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[movie-maker/write-script] Error:", err);
    const msg = err instanceof Error ? err.message : "Script generation failed";
    if (tmpInput) cleanupTmp(tmpInput);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE() {
  if (!activeChild) {
    return NextResponse.json({ status: "no_active_generation" });
  }
  try {
    // Try graceful stdin signal first
    activeChild.stdin?.write("CANCEL\n");
    // Force kill after 3s if still running
    const child = activeChild;
    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, 3000);
    return NextResponse.json({ status: "cancel_sent" });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function cleanupTmp(p: string) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
}
