import { NextResponse } from "next/server";
import { exec } from "child_process";
import { COMFYUI_PORT } from "@/lib/comfyui-config";

/**
 * POST /api/shutdown
 * Kills backend services (ComfyUI) by their listening
 * ports.  The web UI (loopback UI port) is intentionally left running so the user
 * can restart backends via "Cycle Services" without a full reboot.
 */
export async function POST() {
  const ports = [COMFYUI_PORT]; // ComfyUI
  const results: { port: number; status: string }[] = [];

  for (const port of ports) {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        exec(
          `for /f "tokens=5" %a in ('netstat -aon ^| findstr ":${port}.*LISTENING"') do @taskkill /PID %a /T /F`,
          { shell: "cmd.exe", timeout: 10000, windowsHide: true },
          (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
          }
        );
      });
      results.push({ port, status: out || "killed" });
    } catch (e) {
      results.push({ port, status: `error: ${(e as Error).message}` });
    }
  }

  return NextResponse.json({ ok: true, message: "Backends stopped", results });
}
