import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import sharp from "sharp";

const DATASETS_DIR = path.resolve(process.cwd(), "..", "lora-factory", "datasets");

// Camera RAW extensions we accept and convert server-side
const RAW_EXTENSIONS = new Set([
  ".cr2", ".cr3", ".nef", ".arw", ".orf", ".rw2", ".dng", ".raf", ".pef", ".srw",
]);

function isRawFile(filename: string): boolean {
  return RAW_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const datasetName = formData.get("datasetName") as string;
    if (!datasetName) {
      return NextResponse.json({ error: "datasetName is required" }, { status: 400 });
    }

    const datasetDir = path.join(DATASETS_DIR, datasetName);
    if (!fs.existsSync(datasetDir)) {
      fs.mkdirSync(datasetDir, { recursive: true });
    }

    const files = formData.getAll("images") as File[];
    if (files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    const images = [];
    const rawFiles: string[] = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const id = randomUUID();

      // Sanitize filename: keep original name but ensure uniqueness
      const ext = path.extname(file.name) || ".png";
      const baseName = path.basename(file.name, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
      const filename = `${baseName}_${id.slice(0, 8)}${ext}`;
      const filePath = path.join(datasetDir, filename);

      // Write the file
      fs.writeFileSync(filePath, buffer);

      if (isRawFile(file.name)) {
        // RAW file: track it for later conversion via smart-crop
        rawFiles.push(filename);
        images.push({
          id,
          filename,
          serverPath: filePath,
          caption: "",
          tags: [],
          width: 0,
          height: 0,
          sizeBytes: buffer.length,
          isRaw: true,
        });
      } else {
        // Regular image: get dimensions using sharp
        let width = 0, height = 0;
        try {
          const metadata = await sharp(buffer).metadata();
          width = metadata.width ?? 0;
          height = metadata.height ?? 0;
        } catch {
          // sharp failed: dimensions will be 0
        }

        images.push({
          id,
          filename,
          serverPath: filePath,
          caption: "",
          tags: [],
          width,
          height,
          sizeBytes: buffer.length,
          isRaw: false,
        });
      }
    }

    return NextResponse.json({ images, rawFiles });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Upload failed";
    console.error("[LoRA Factory] Upload error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
