import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const DATASETS_DIR = path.resolve(process.cwd(), "..", "lora-factory", "datasets");

export async function GET(req: NextRequest) {
  const dataset = req.nextUrl.searchParams.get("dataset");
  const file = req.nextUrl.searchParams.get("file");

  if (!dataset || !file) {
    return NextResponse.json({ error: "dataset and file params required" }, { status: 400 });
  }

  // Prevent path traversal
  if (dataset.includes("..") || file.includes("..")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const filePath = path.join(DATASETS_DIR, dataset, file);
  // Defense-in-depth: the `..` string check above catches the common case; this
  // confirms the fully-resolved path never escapes the datasets root (covers
  // separators/absolute-segment tricks the substring check can miss).
  const resolved = path.resolve(filePath);
  if (resolved !== DATASETS_DIR && !resolved.startsWith(DATASETS_DIR + path.sep)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  // Only serve known image types, this endpoint exists solely for dataset
  // thumbnails, so refuse to read anything else (no arbitrary-file read).
  const ext = path.extname(file).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
  };
  if (!mimeMap[ext]) {
    return NextResponse.json({ error: "Unsupported media type" }, { status: 415 });
  }
  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const buffer = fs.readFileSync(resolved);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": mimeMap[ext],
      "Cache-Control": "public, max-age=3600",
    },
  });
}
