import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { getOfflineEnv } from "@/lib/veksnap-settings";
import { getPythonPath } from "@/lib/python-path";

export const dynamic = "force-dynamic";

const LTX2_DIR = path.resolve(process.cwd(), "..", "ltx2-studio");
const STATUS_FILE = path.join(LTX2_DIR, "status.json");
const PYTHON = getPythonPath();
const SCRIPT = path.join(LTX2_DIR, "generate.py");

/**
 * POST /api/ltx2/generate
 * Starts LTX-2 generation as a detached subprocess.
 * Body: LTX2Config JSON
 */
export async function POST(req: NextRequest) {
  try {
    const config = await req.json();

    // Ensure output directory exists
    if (!existsSync(LTX2_DIR)) mkdirSync(LTX2_DIR, { recursive: true });

    // Write initial status
    writeFileSync(
      STATUS_FILE,
      JSON.stringify({
        state: "loading",
        progress: 0,
        progressMax: 0,
        stage: "Starting pipeline...",
      }),
      "utf-8"
    );

    // Write config for the Python script
    const configPath = path.join(LTX2_DIR, "config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    // Spawn the generation script detached
    const child = spawn(PYTHON, [SCRIPT, configPath], {
      cwd: LTX2_DIR,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTORCH_CUDA_ALLOC_CONF: "expandable_segments:True",
        ...getOfflineEnv(),
      },
    });

    child.unref();

    return NextResponse.json({ started: true, pid: child.pid });
  } catch (err) {
    // Write error to status file so the UI can pick it up
    try {
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          state: "error",
          progress: 0,
          progressMax: 0,
          stage: "",
          error: err instanceof Error ? err.message : String(err),
        }),
        "utf-8"
      );
    } catch { /* ignore */ }

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to start generation" },
      { status: 500 }
    );
  }
}
