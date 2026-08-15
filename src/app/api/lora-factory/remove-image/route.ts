import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DATASETS_DIR = path.resolve(process.cwd(), "..", "lora-factory", "datasets");

export async function POST(req: NextRequest) {
  try {
    const { datasetName, filename } = await req.json();
    if (!datasetName || !filename) {
      return NextResponse.json({ error: "datasetName and filename required" }, { status: 400 });
    }

    const filePath = path.join(DATASETS_DIR, datasetName, filename);
    const captionPath = filePath.replace(/\.[^.]+$/, ".txt");

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(captionPath)) fs.unlinkSync(captionPath);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
