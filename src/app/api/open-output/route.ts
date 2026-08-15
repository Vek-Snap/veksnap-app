import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

// Default renders directory: <install>/ComfyUI/output. Prefer the shell-provided
// install root (VEKSNAP_INSTALL_ROOT, set in shell/main.js) so this resolves
// correctly regardless of the server process cwd; fall back to cwd for dev.
function defaultOutputDir(): string {
  const root = process.env.VEKSNAP_INSTALL_ROOT;
  if (root && root.trim()) return path.join(root.trim(), "ComfyUI", "output");
  return path.resolve(process.cwd(), "..", "ComfyUI", "output");
}

export async function POST(req: NextRequest) {
  try {
    let outputDir: string;

    // Check if a custom directory was provided in the request body
    try {
      const body = await req.json();
      if (body.dir && typeof body.dir === "string" && body.dir.trim()) {
        outputDir = path.resolve(body.dir.trim());
      } else {
        outputDir = defaultOutputDir();
      }
    } catch {
      // No body or invalid JSON, use default
      outputDir = defaultOutputDir();
    }

    // Create it if it doesn't exist so Explorer always has a target.
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Open in Windows Explorer using the same detached spawn pattern as
    // /api/open-in-explorer. Passing the path as a discrete arg (no shell)
    // prevents command injection via body.dir. NOTE: do NOT set windowsHide,
    // CREATE_NO_WINDOW suppresses the Explorer window and nothing opens.
    if (process.platform === "win32") {
      spawn("explorer.exe", [outputDir], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [outputDir], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [outputDir], { detached: true, stdio: "ignore" }).unref();
    }
    return NextResponse.json({ ok: true, path: outputDir });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to open folder" },
      { status: 500 }
    );
  }
}
