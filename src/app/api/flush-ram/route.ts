import { NextRequest, NextResponse } from "next/server";
import { COMFYUI_HTTP } from "@/lib/comfyui-config";
import { reapGpuProcesses } from "@/lib/gpu-process-registry";

const COMFYUI_URL = process.env.COMFYUI_URL || COMFYUI_HTTP;

/**
 * Memory flush.
 *
 * The original implementation only called ComfyUI's /free (plus a DramaBox special-case). That
 * covers models loaded INSIDE the ComfyUI process and nothing else, which is why the Flush
 * buttons appeared broken: our own model subprocesses (SeedVR2 restore being the largest) are
 * separate processes that /free has no knowledge of whatsoever.
 *
 * Body:
 *   includeActive?: boolean  when true, also terminates GPU subprocesses belonging to a job that is
 *                            still running. Off by default so a flush can never silently destroy
 *                            in-flight work.
 *   scope?: "vram" | "all"   "vram" frees GPU memory only (ComfyUI models + our GPU subprocesses).
 *                            "all" additionally clears host-side caches and trims working sets.
 *                            Defaults to "all" for backwards compatibility.
 */
export async function POST(req: NextRequest) {
  let includeActive = false;
  let scope: "vram" | "all" = "all";
  try {
    const body = await req.json();
    includeActive = body?.includeActive === true;
    if (body?.scope === "vram") scope = "vram";
  } catch {
    /* no body: safe defaults */
  }

  const report: string[] = [];

  try {
    // 1. Tell ComfyUI to unload models and free memory
    try {
      await fetch(`${COMFYUI_URL}/free`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
      });
      report.push("ComfyUI models unloaded");
    } catch {
      // ComfyUI might not be running
      report.push("ComfyUI not reachable");
    }

    // 1b. Reclaim VRAM from OUR OWN model subprocesses, the gap that made these buttons look
    // broken. Only PIDs we explicitly registered are touched; a blanket python kill would take
    // down ComfyUI, VisoMaster and the language servers with it.
    const reap = reapGpuProcesses(includeActive);
    if (reap.reaped.length > 0) {
      report.push(`Reclaimed ${reap.reaped.length} GPU process(es): ${reap.reaped.map((p) => p.label).join(", ")}`);
    }
    if (reap.skippedActive.length > 0) {
      // Reported rather than killed: the user needs to know WHY VRAM is still occupied.
      report.push(
        `Still running (not touched): ${reap.skippedActive.map((p) => p.label).join(", ")}: stop the job to release this memory`
      );
    }

    // 2. Flush DramaBox model caches (managed outside ComfyUI's model system)
    // DramaBox keeps models in module-level dicts that /free doesn't touch.
    // Queue a minimal DramaBoxUnload workflow to trigger cache cleanup.
    if (scope === "all") try {
      await fetch(`${COMFYUI_URL}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: {
            "1": {
              class_type: "DramaBoxUnload",
              inputs: { any: 0 },
            },
          },
        }),
      });
    } catch {
      // DramaBox node might not be installed or ComfyUI not running
    }

    // 3. Force Node.js garbage collection if exposed (--expose-gc flag)
    if (scope === "all" && global.gc) {
      global.gc();
    }

    // 4. Trim Python working set (releases unused pages back to OS)
    if (scope === "all") try {
      const { execSync } = require("child_process");
      execSync(
        `powershell -Command "Get-Process python* | ForEach-Object { $_.MinWorkingSet = 1MB }"`,
        { timeout: 5000, stdio: "ignore", windowsHide: true }
      );
    } catch {
      // Not critical if this fails
    }

    return NextResponse.json({
      success: true,
      message: report.join(" | ") || "Flush requested",
      reaped: reap.reaped.map((p) => p.label),
      stillRunning: reap.skippedActive.map((p) => p.label),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Flush failed" },
      { status: 500 }
    );
  }
}
