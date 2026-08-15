import { NextResponse } from "next/server";
import path from "path";
import { existsSync, readFileSync } from "fs";

export const dynamic = "force-dynamic";

const LTX2_DIR = path.resolve(process.cwd(), "..", "ltx2-studio");
const STATUS_FILE = path.join(LTX2_DIR, "status.json");

/**
 * GET /api/ltx2/output
 * Returns the generated video file as a binary download.
 */
export async function GET() {
  try {
    if (!existsSync(STATUS_FILE)) {
      return NextResponse.json({ error: "No generation status found" }, { status: 404 });
    }

    const status = JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    const outputPath = status.outputPath;

    if (!outputPath || !existsSync(outputPath)) {
      return NextResponse.json({ error: "Output file not found" }, { status: 404 });
    }

    const fileBuffer = readFileSync(outputPath);
    const filename = path.basename(outputPath);

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Length": String(fileBuffer.length),
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read output" },
      { status: 500 }
    );
  }
}
