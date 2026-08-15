import { NextResponse } from "next/server";
import { exec } from "child_process";
import { unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { COMFYUI_PORT } from "@/lib/comfyui-config";

export const dynamic = "force-dynamic";

/**
 * POST /api/shutdown-all
 *
 * Complete VekSnap Studio shutdown. Kills everything in the correct order:
 *   1. Backend services (ComfyUI) by port
 *   2. All VekSnap-related Python processes
 *   3. All VekSnap-related Node.js processes (including Next.js / launcher)
 *   4. The hidden launcher cmd.exe window
 *
 * This endpoint returns a response first, THEN schedules process termination
 * so the browser gets the OK before the server goes down.
 */
export async function POST() {
  const log: string[] = [];

  // ── Phase 1: Kill backend services by port ──
  const servicePorts = [COMFYUI_PORT]; // ComfyUI
  for (const port of servicePorts) {
    try {
      await execCmd(
        `for /f "tokens=5" %a in ('netstat -aon ^| findstr ":${port}.*LISTENING"') do @taskkill /PID %a /T /F`
      );
      log.push(`Killed service on port ${port}`);
    } catch {
      log.push(`Port ${port}: nothing to kill`);
    }
  }

  // ── Phase 2: Kill all VekSnap-related Python processes ──
  for (const pyExe of ["python.exe", "pythonw.exe"]) {
    try {
      const pythonPids = await findVekSnapProcesses(pyExe);
      for (const { pid } of pythonPids) {
        try {
          await execCmd(`taskkill /PID ${pid} /T /F`);
          log.push(`Killed ${pyExe} PID ${pid}`);
        } catch {
          log.push(`${pyExe} PID ${pid}: already dead`);
        }
      }
    } catch (e) {
      log.push(`${pyExe} scan error: ${(e as Error).message}`);
    }
  }

  // ── Phase 3: Schedule self-destruction ──
  // We need to kill the current Next.js process tree AND the launcher cmd.exe.
  // Schedule this AFTER we return the HTTP response so the client gets the OK.
  const currentPid = process.pid;

  // Find the launcher cmd.exe PID, it's our grandparent process typically,
  // but we can also find it by command line containing "launcher.mjs"
  let launcherPids: number[] = [];
  try {
    const launcherProcs = await findProcessesByName("cmd.exe");
    for (const { pid, cmd } of launcherProcs) {
      if (cmd.toLowerCase().includes("launcher") || cmd.toLowerCase().includes("veksnap")) {
        launcherPids.push(pid);
      }
    }
    // Also check for node.exe processes running launcher.mjs
    const nodeLauncherProcs = await findProcessesByName("node.exe");
    for (const { pid, cmd } of nodeLauncherProcs) {
      if (cmd.toLowerCase().includes("launcher.mjs") && pid !== currentPid) {
        launcherPids.push(pid);
      }
    }
  } catch {
    // Will still kill by process tree
  }

  // Find ALL VekSnap-related node.exe PIDs (including ourselves)
  let nodeKillPids: number[] = [];
  try {
    const nodeProcs = await findVekSnapProcesses("node.exe");
    nodeKillPids = nodeProcs.map((p) => p.pid);
  } catch {
    // Fallback: at least kill our own tree
    nodeKillPids = [currentPid];
  }

  // Combine all PIDs to kill (deduplicate)
  const allPids = [...new Set([...launcherPids, ...nodeKillPids, currentPid])];

  log.push(`Scheduled termination of ${allPids.length} process(es): ${allPids.join(", ")}`);

  // Write shutdown flag so Electron shell knows this is intentional (won't restart)
  const shutdownFlag = join(tmpdir(), "veksnap-shutdown.flag");
  try { writeFileSync(shutdownFlag, String(Date.now()), "utf8"); log.push("Shutdown flag written"); } catch {}

  // Clean up launcher temp files for a clean restart
  const lockFile = join(tmpdir(), "veksnap-launcher.lock");
  const serviceDefsFile = join(tmpdir(), "veksnap-service-defs.json");
  try { unlinkSync(lockFile); log.push("Removed launcher lock file"); } catch { /* doesn't exist */ }
  try { unlinkSync(serviceDefsFile); log.push("Removed service defs file"); } catch { /* doesn't exist */ }

  // Schedule the kill after 1.5s delay so the HTTP response can be sent
  setTimeout(() => {
    for (const pid of allPids) {
      try {
        exec(`taskkill /PID ${pid} /T /F`, { windowsHide: true, timeout: 5000 });
      } catch { /* best effort */ }
    }
    // If taskkill didn't get us, force exit
    setTimeout(() => process.exit(0), 3000);
  }, 1500);

  return NextResponse.json({
    ok: true,
    message: "The application is shutting down.",
    log,
    pidsToKill: allPids,
  });
}

// ── Helpers ──

function execCmd(cmd: string, timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { shell: "cmd.exe", timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/** Find VekSnap-related processes of a given executable name */
async function findVekSnapProcesses(exeName: string): Promise<{ pid: number; cmd: string }[]> {
  const raw = await new Promise<string>((resolve, reject) => {
    exec(
      `wmic process where "name='${exeName}'" get ProcessId,CommandLine /format:csv`,
      { timeout: 15000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });

  const results: { pid: number; cmd: string }[] = [];
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // CSV: Node,CommandLine,ProcessId
    const lastComma = line.lastIndexOf(",");
    if (lastComma < 0) continue;
    const pidStr = line.substring(lastComma + 1).trim();
    const pid = parseInt(pidStr);
    if (isNaN(pid)) continue;

    const firstComma = line.indexOf(",");
    const cmd = line.substring(firstComma + 1, lastComma).trim().toLowerCase();

    const isVekSnapRelated =
      cmd.includes("veksnap") ||
      cmd.includes("comfyui") ||
      cmd.includes("next-server") ||
      cmd.includes("next dev") ||
      cmd.includes("launcher.mjs");

    if (isVekSnapRelated) {
      results.push({ pid, cmd });
    }
  }
  return results;
}

/** Find all processes of a given executable name (not filtered by VekSnap) */
async function findProcessesByName(exeName: string): Promise<{ pid: number; cmd: string }[]> {
  const raw = await new Promise<string>((resolve, reject) => {
    exec(
      `wmic process where "name='${exeName}'" get ProcessId,CommandLine /format:csv`,
      { timeout: 15000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });

  const results: { pid: number; cmd: string }[] = [];
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const lastComma = line.lastIndexOf(",");
    if (lastComma < 0) continue;
    const pidStr = line.substring(lastComma + 1).trim();
    const pid = parseInt(pidStr);
    if (isNaN(pid)) continue;

    const firstComma = line.indexOf(",");
    const cmd = line.substring(firstComma + 1, lastComma).trim();

    results.push({ pid, cmd });
  }
  return results;
}
