import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DATASETS_DIR = path.resolve(process.cwd(), "..", "lora-factory", "datasets");

/**
 * POST /api/lora-factory/save-crop
 * Save a cropped or mask-extracted image back to the dataset.
 * FormData: { datasetName, sourceFilename, cropType, image (File) }
 * Returns: { filename, width, height }
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const datasetName = formData.get("datasetName") as string;
    const sourceFilename = formData.get("sourceFilename") as string;
    const cropType = formData.get("cropType") as string || "crop";
    const imageFile = formData.get("image") as File;

    if (!datasetName || !imageFile) {
      return NextResponse.json({ error: "datasetName and image are required" }, { status: 400 });
    }

    const datasetDir = path.join(DATASETS_DIR, datasetName);
    if (!fs.existsSync(datasetDir)) {
      return NextResponse.json({ error: "Dataset not found" }, { status: 404 });
    }

    const buffer = Buffer.from(await imageFile.arrayBuffer());
    const id = randomUUID().slice(0, 8);
    const baseName = sourceFilename
      ? path.basename(sourceFilename, path.extname(sourceFilename)).replace(/[^a-zA-Z0-9_-]/g, "_")
      : "image";
    const filename = `${baseName}_${cropType}_${id}.png`;
    const filePath = path.join(datasetDir, filename);

    fs.writeFileSync(filePath, buffer);

    // Get dimensions from the PNG header if possible
    let width = 0, height = 0;
    try {
      const sharp = require("sharp");
      const metadata = await sharp(buffer).metadata();
      width = metadata.width ?? 0;
      height = metadata.height ?? 0;
    } catch {
      // sharp not available
    }

    return NextResponse.json({ filename, width, height });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Save failed";
    console.error("[LoRA Factory] Save crop error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
