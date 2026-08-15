import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DATASETS_DIR = path.resolve(process.cwd(), "..", "lora-factory", "datasets");

/**
 * GET /api/lora-factory/train-status?dataset=<name>
 * Poll training progress from the status JSON file written by train.py.
 */
export async function GET(req: NextRequest) {
  const dataset = req.nextUrl.searchParams.get("dataset");
  if (!dataset) {
    return NextResponse.json({ error: "dataset param required" }, { status: 400 });
  }

  const statusPath = path.join(DATASETS_DIR, dataset, "training_status.json");
  if (!fs.existsSync(statusPath)) {
    return NextResponse.json({
      status: "idle",
      epoch: 0, totalEpochs: 0,
      step: 0, totalSteps: 0,
      loss: 0, lossHistory: [],
      sampleImages: [],
      elapsedSec: 0, estimatedRemainingSec: 0,
    });
  }

  try {
    const raw = fs.readFileSync(statusPath, "utf-8");
    const status = JSON.parse(raw);
    return NextResponse.json(status);
  } catch {
    return NextResponse.json({ error: "Failed to read status" }, { status: 500 });
  }
}
