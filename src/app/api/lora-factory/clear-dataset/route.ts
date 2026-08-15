import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DATASETS_DIR = path.resolve(process.cwd(), "..", "lora-factory", "datasets");

export async function POST(req: NextRequest) {
  try {
    const { datasetName } = await req.json();
    if (!datasetName) {
      return NextResponse.json({ error: "datasetName required" }, { status: 400 });
    }

    const datasetDir = path.join(DATASETS_DIR, datasetName);
    if (fs.existsSync(datasetDir)) {
      fs.rmSync(datasetDir, { recursive: true, force: true });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
