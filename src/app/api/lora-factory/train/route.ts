import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getPythonPath } from "@/lib/python-path";
import { apiLog, pipeToLog } from "@/lib/api-logger";
import { getOfflineEnv } from "@/lib/veksnap-settings";

const LORA_FACTORY_DIR = path.resolve(process.cwd(), "..", "lora-factory");
const DATASETS_DIR = path.join(LORA_FACTORY_DIR, "datasets");
const TRAIN_SCRIPT = path.join(LORA_FACTORY_DIR, "train.py");
const PYTHON_EXE = getPythonPath();

/**
 * POST /api/lora-factory/train
 * Start LoRA training as a background process.
 * Body: LoraTrainingConfig (from types.ts)
 * Returns immediately with { ok: true, configPath }
 */
export async function POST(req: NextRequest) {
  try {
    const config = await req.json();

    if (!config.datasetName) {
      return NextResponse.json({ error: "datasetName is required" }, { status: 400 });
    }
    // Z-Image trains from DiT/VAE/text-encoder files rather than a single checkpoint,
    // so it requires ditModel instead of baseModel.
    const isZImage = config.baseModelArch === "zimage";
    if (isZImage) {
      if (!config.ditModel) {
        return NextResponse.json({ error: "ditModel is required for Z-Image training" }, { status: 400 });
      }
    } else if (!config.baseModel) {
      return NextResponse.json({ error: "baseModel is required" }, { status: 400 });
    }

    const datasetDir = path.join(DATASETS_DIR, config.datasetName);
    if (!fs.existsSync(datasetDir)) {
      return NextResponse.json({ error: "Dataset not found" }, { status: 404 });
    }

    // Write config to a temp JSON file for the Python script
    const configPath = path.join(datasetDir, "training_config.json");
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    // Spawn training process in background, pipe output to persistent log
    const child = spawn(PYTHON_EXE, [TRAIN_SCRIPT, configPath], {
      cwd: LORA_FACTORY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
      env: { ...process.env, ...getOfflineEnv() },
    });

    apiLog("lora_training", `Training started (PID ${child.pid}) for dataset "${config.datasetName}"`);
    apiLog("lora_training", `Config: ${JSON.stringify({ baseModel: config.baseModel, epochs: config.epochs, lr: config.learningRate, rank: config.loraRank }, null, 0)}`);
    pipeToLog("lora_training", child);

    child.on("close", (code) => {
      apiLog("lora_training", `Training process exited with code ${code}`);
    });

    child.unref();

    console.log(`[LoRA Factory] Training started (PID ${child.pid}) for dataset "${config.datasetName}"`);

    return NextResponse.json({ ok: true, configPath, pid: child.pid });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to start training";
    console.error("[LoRA Factory] Train error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
