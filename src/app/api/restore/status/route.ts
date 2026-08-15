import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const job = global.__restoreJob;

    if (!job) {
      return NextResponse.json({ status: "idle", progress: 0, label: "No active job" });
    }

    return NextResponse.json({
      status: job.status,
      progress: job.progress,
      label: job.label,
      error: job.error,
      outputPath: job.outputPath,
      eta: job.eta ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get status" },
      { status: 500 }
    );
  }
}
