import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { getOfflineEnv } from "@/lib/veksnap-settings";
import { getPythonPath } from "@/lib/python-path";

const execAsync = (cmd: string, opts?: object) =>
  promisify(exec)(cmd, { windowsHide: true, ...opts });
const DATASETS_DIR = path.resolve(process.cwd(), "..", "lora-factory", "datasets");
const TAGGER_SCRIPT = path.resolve(process.cwd(), "..", "lora-factory", "tagger.py");
const PYTHON_EXE = getPythonPath();

/**
 * POST /api/lora-factory/auto-tag
 * Run auto-captioning on all images in a dataset using Florence-2 or BLIP.
 * Body: { datasetName: string, mode?: "florence" | "blip" }
 * Returns: { captions: Array<{ filename, caption }> }
 */
export async function POST(req: NextRequest) {
  try {
    const { datasetName, mode, singleFile } = await req.json() as {
      datasetName: string;
      mode?: "florence" | "blip";
      singleFile?: string;
    };

    if (!datasetName) {
      return NextResponse.json({ error: "datasetName is required" }, { status: 400 });
    }

    const datasetDir = path.join(DATASETS_DIR, datasetName);
    if (!fs.existsSync(datasetDir)) {
      return NextResponse.json({ error: "Dataset not found" }, { status: 404 });
    }

    if (!fs.existsSync(TAGGER_SCRIPT)) {
      return NextResponse.json({ error: "Tagger script not found" }, { status: 404 });
    }

    if (!fs.existsSync(PYTHON_EXE)) {
      return NextResponse.json({ error: `Python not found at ${PYTHON_EXE}` }, { status: 404 });
    }

    const captionMode = mode || "florence";
    const fileArg = singleFile ? ` --file "${singleFile}"` : "";
    const cmd = `"${PYTHON_EXE}" "${TAGGER_SCRIPT}" "${datasetDir}" --mode ${captionMode}${fileArg}`;
    console.log(`[LoRA Factory] Auto-tag: ${cmd}`);

    // 10 minute timeout for large datasets
    const { stdout, stderr } = await execAsync(cmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, ...getOfflineEnv() } });

    if (stderr) {
      // Florence/BLIP log progress to stderr, not an error
      console.log(`[LoRA Factory] Tagger log: ${stderr.slice(-500)}`);
    }

    let captions;
    try {
      captions = JSON.parse(stdout.trim());
    } catch {
      return NextResponse.json(
        { error: "Failed to parse tagger output", stdout: stdout.slice(0, 500), stderr: stderr.slice(-500) },
        { status: 500 }
      );
    }

    return NextResponse.json({ captions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Auto-tagging failed";
    console.error("[LoRA Factory] Auto-tag error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
