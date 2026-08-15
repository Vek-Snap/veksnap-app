import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DATASETS_DIR = path.resolve(process.cwd(), "..", "lora-factory", "datasets");

export async function POST(req: NextRequest) {
  try {
    const { datasetName, captions } = await req.json() as {
      datasetName: string;
      captions: Array<{ filename: string; caption: string }>;
    };

    if (!datasetName || !captions) {
      return NextResponse.json({ error: "datasetName and captions required" }, { status: 400 });
    }

    const datasetDir = path.join(DATASETS_DIR, datasetName);
    if (!fs.existsSync(datasetDir)) {
      return NextResponse.json({ error: "Dataset not found" }, { status: 404 });
    }

    // Write each caption as a .txt file alongside the image (standard kohya format)
    for (const { filename, caption } of captions) {
      const txtName = filename.replace(/\.[^.]+$/, ".txt");
      const txtPath = path.join(datasetDir, txtName);
      fs.writeFileSync(txtPath, caption, "utf-8");
    }

    return NextResponse.json({ ok: true, count: captions.length });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
