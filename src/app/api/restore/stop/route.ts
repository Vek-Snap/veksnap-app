import { NextResponse } from "next/server";
import { killProcessTree, releaseGpuProcess } from "@/lib/gpu-process-registry";

export async function POST() {
  try {
    const job = global.__restoreJob;

    if (!job) {
      return NextResponse.json({ ok: true, message: "No active job to stop" });
    }

    // Set cancelled flag so the pipeline stops at the next checkpoint
    job.cancelled = true;
    job.status = "error";
    job.error = "Cancelled by user";

    // Kill the currently running child process tree (if any). Routed through the shared registry
    // helper so the cancel path and the flush path cannot drift apart in behaviour, and so the
    // registry entry is dropped rather than lingering as a phantom orphan.
    if (job.pid) {
      killProcessTree(job.pid);
      releaseGpuProcess(job.pid);
      job.pid = null;
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to stop" },
      { status: 500 }
    );
  }
}
