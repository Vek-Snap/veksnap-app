import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { getPythonPath } from "@/lib/python-path";
import fs from "fs";
import { getOfflineEnv } from "@/lib/veksnap-settings";

const execAsync = (cmd: string, opts?: object) =>
  promisify(exec)(cmd, { windowsHide: true, ...opts });
const LORA_FACTORY_DIR = path.resolve(process.cwd(), "..", "lora-factory");
const DATASETS_DIR = path.join(LORA_FACTORY_DIR, "datasets");
const SMART_CROP_SCRIPT = path.join(LORA_FACTORY_DIR, "smart_crop.py");
const PYTHON_EXE = getPythonPath();

/**
 * POST /api/lora-factory/smart-crop
 * Run smart auto-crop on all images in a dataset:
 *   1. Convert any CR2/RAW files to PNG
 *   2. Detect faces → generate face close-up, head-and-shoulders, upper-body crops
 * Body: { datasetName: string }
 * Returns: { crops: [...], rawConverted: [...] }
 */
export async function POST(req: NextRequest) {
  try {
    const { datasetName } = await req.json();
    if (!datasetName) {
      return NextResponse.json({ error: "datasetName is required" }, { status: 400 });
    }

    const datasetDir = path.join(DATASETS_DIR, datasetName);
    if (!fs.existsSync(datasetDir)) {
      return NextResponse.json({ error: "Dataset not found" }, { status: 404 });
    }

    const cmd = `"${PYTHON_EXE}" "${SMART_CROP_SCRIPT}" "${datasetDir}"`;
    console.log(`[LoRA Factory] Smart crop: ${cmd}`);

    // 5 minute timeout
    const { stdout, stderr } = await execAsync(cmd, { timeout: 300000, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, ...getOfflineEnv() } });

    if (stderr) {
      console.log(`[LoRA Factory] Smart crop log: ${stderr.slice(-500)}`);
    }

    let result;
    try {
      result = JSON.parse(stdout.trim());
    } catch {
      return NextResponse.json(
        { error: "Failed to parse smart crop output", stdout: stdout.slice(0, 500) },
        { status: 500 }
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Smart crop failed";
    console.error("[LoRA Factory] Smart crop error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
