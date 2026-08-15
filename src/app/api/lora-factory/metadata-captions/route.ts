import { NextRequest, NextResponse } from "next/server";
import { execFileSync } from "child_process";
import path from "path";
import { getPythonPath } from "@/lib/python-path";
import fs from "fs";

const LORA_FACTORY_DIR = path.resolve(process.cwd(), "..", "lora-factory");
const DATASETS_DIR = path.join(LORA_FACTORY_DIR, "datasets");
const SCRIPT = path.join(LORA_FACTORY_DIR, "metadata_captions.py");
const PYTHON_EXE = getPythonPath();

/**
 * POST /api/lora-factory/metadata-captions
 * Write or read captions to/from image metadata.
 * Body: { datasetName: string, action: "write" | "read" }
 */
export async function POST(req: NextRequest) {
  try {
    const { datasetName, action } = (await req.json()) as {
      datasetName: string;
      action: "write" | "read";
    };

    if (!datasetName) {
      return NextResponse.json({ error: "datasetName is required" }, { status: 400 });
    }
    if (!["write", "read"].includes(action)) {
      return NextResponse.json({ error: "action must be 'write' or 'read'" }, { status: 400 });
    }

    // Reduce to a bare folder name so datasetName can never traverse out of the
    // datasets root or smuggle shell metacharacters (belt-and-suspenders with the
    // shell-free execFileSync below).
    const safeName = path.basename(datasetName);
    const datasetDir = path.join(DATASETS_DIR, safeName);
    if (safeName !== datasetName || !fs.existsSync(datasetDir)) {
      return NextResponse.json({ error: "Dataset not found" }, { status: 404 });
    }

    // execFileSync with an argv array (no shell), user input is passed as a
    // discrete argument, so it can never be parsed as a command.
    const output = execFileSync(PYTHON_EXE, [SCRIPT, action, datasetDir], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });

    const results = JSON.parse(output.trim());
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Metadata caption operation failed";
    console.error("[LoRA Factory] Metadata captions error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
