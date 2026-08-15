import { NextResponse } from "next/server";
import path from "path";
import { existsSync, writeFileSync } from "fs";

export const dynamic = "force-dynamic";

const LTX2_DIR = path.resolve(process.cwd(), "..", "ltx2-studio");
const CANCEL_FILE = path.join(LTX2_DIR, "cancel.flag");
const STATUS_FILE = path.join(LTX2_DIR, "status.json");

/**
 * POST /api/ltx2/cancel
 * Signals the running generation script to stop.
 */
export async function POST() {
  try {
    // Write cancel flag: the Python script checks for this
    writeFileSync(CANCEL_FILE, "cancel", "utf-8");

    // Update status
    if (existsSync(STATUS_FILE)) {
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          state: "idle",
          progress: 0,
          progressMax: 0,
          stage: "Cancelled",
        }),
        "utf-8"
      );
    }

    return NextResponse.json({ cancelled: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cancel failed" },
      { status: 500 }
    );
  }
}
