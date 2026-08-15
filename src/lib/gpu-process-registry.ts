/**
 * Central registry of GPU-holding child processes spawned by VEK-SNAP.
 *
 * WHY THIS EXISTS
 * ComfyUI's `/free` endpoint only unloads models living inside the ComfyUI *process*. Any model
 * we run as our own subprocess (SeedVR2's `inference_cli.py` being the first and largest) is
 * completely invisible to it. The Flush VRAM / Flush RAM buttons therefore silently did nothing
 * for those, which is exactly the gap that made them look "broken": they were working perfectly,
 * on a scope that excluded half the app's GPU usage.
 *
 * RULE FOR ALL FUTURE MODEL FEATURES
 * If you spawn a process that touches the GPU, you MUST register it here and unregister it when
 * it exits. Otherwise it cannot be reclaimed, reported, or reaped, and it will orphan on a hard
 * app exit while holding VRAM.
 *
 * SAFETY
 * Reaping is deliberately narrow: we only ever kill PIDs *we* registered. A blanket
 * `taskkill python*` would terminate ComfyUI itself (and VisoMaster, and the LSP servers), so it
 * is never done. Processes belonging to a still-running job are reported, never killed, a flush
 * must not destroy work the user is waiting on.
 */

import { spawn } from "child_process";

export interface GpuProcessEntry {
  /** PID as returned by spawn(). With `shell: true` this is the shell wrapper, so always
   *  terminate with taskkill /T to catch the real worker beneath it. */
  pid: number;
  /** Human-readable owner, e.g. "SeedVR2 restore". Surfaced in flush reports. */
  label: string;
  /** True while the owning job is live. Active processes are never auto-reaped. */
  active: boolean;
  startedAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __vekGpuProcs: Map<number, GpuProcessEntry> | undefined;
}

// Module-level state is re-created on Next.js HMR, so it hangs off `global`, the same pattern
// `global.__restoreJob` already uses in the restore route.
function registry(): Map<number, GpuProcessEntry> {
  if (!global.__vekGpuProcs) global.__vekGpuProcs = new Map();
  return global.__vekGpuProcs;
}

export function registerGpuProcess(pid: number | undefined, label: string): void {
  if (!pid) return;
  registry().set(pid, { pid, label, active: true, startedAt: Date.now() });
}

/** Mark the owning job finished. The entry is dropped only if the process is genuinely gone;
 *  if it is still alive it stays as an orphan candidate for the next flush. */
export function releaseGpuProcess(pid: number | undefined): void {
  if (!pid) return;
  const entry = registry().get(pid);
  if (!entry) return;
  if (isProcessAlive(pid)) {
    entry.active = false;
  } else {
    registry().delete(pid);
  }
}

export function listGpuProcesses(): GpuProcessEntry[] {
  // Drop entries whose processes have already exited so reports stay truthful.
  for (const [pid] of registry()) {
    if (!isProcessAlive(pid)) registry().delete(pid);
  }
  return [...registry().values()];
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs an existence/permission check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Terminate a PID and its entire descendant tree. `shell: true` spawns put the real worker one
 *  or two levels below the PID we hold, so /T is mandatory rather than optional. */
export function killProcessTree(pid: number): void {
  try {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: true,
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    /* already dead */
  }
}

export interface ReapResult {
  reaped: GpuProcessEntry[];
  /** Live processes belonging to a running job. Reported so the caller can tell the user why
   *  VRAM is still occupied, instead of killing their in-flight work. */
  skippedActive: GpuProcessEntry[];
}

/**
 * Reclaim VRAM from registered subprocesses.
 *
 * @param includeActive Kill processes belonging to a running job too. Only ever set this from an
 *                      explicit, clearly-labelled user action: never from a background flush.
 */
export function reapGpuProcesses(includeActive = false): ReapResult {
  const result: ReapResult = { reaped: [], skippedActive: [] };
  for (const entry of listGpuProcesses()) {
    if (entry.active && !includeActive) {
      result.skippedActive.push(entry);
      continue;
    }
    killProcessTree(entry.pid);
    registry().delete(entry.pid);
    result.reaped.push(entry);
  }
  return result;
}

/**
 * Last-resort cleanup for process teardown. This is NOT a flush: it runs when the server itself
 * is going away, at which point leaving a 10 GB SeedVR2 process behind is strictly worse than
 * killing it. Registered once, on first import.
 */
let exitHooked = false;
export function installGpuProcessExitHook(): void {
  if (exitHooked) return;
  exitHooked = true;
  const teardown = () => {
    for (const [pid] of registry()) killProcessTree(pid);
    registry().clear();
  };
  process.once("exit", teardown);
  process.once("SIGINT", teardown);
  process.once("SIGTERM", teardown);
  // Windows console close / Ctrl-Break, which do NOT arrive as SIGTERM.
  process.once("SIGHUP", teardown);
  process.once("SIGBREAK", teardown);
}
