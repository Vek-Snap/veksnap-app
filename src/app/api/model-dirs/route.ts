import { NextResponse } from "next/server";
import { resolveDir } from "@/lib/model-paths";

export const dynamic = "force-dynamic";

// Resolves model directories at RUNTIME (no hardcoded drive letters / paths) so
// the UI can prefill sensible defaults that work on any machine.
export async function GET() {
  return NextResponse.json({
    lorasDir: resolveDir("loras"),
    checkpointsDir: resolveDir("checkpoints"),
  });
}
